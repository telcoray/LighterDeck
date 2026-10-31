"""LighterDeck backend: serves the UI, market data, calendar, trading and automations."""
import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from econ import Calendar
from engine import Engine
from feed import PriceFeed
from lighter_api import LighterAPI
from logos import Logos
from risk import Blocked, RiskGuard
from i18n import L, set_lang

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

api = LighterAPI()
feed = PriceFeed()
calendar = Calendar()
risk = RiskGuard(api, feed)
logos = Logos()
engine = Engine(api, feed, calendar, risk)
clients = set()


async def broadcast_loop():
    """Push prices, account and automation log to every open UI once per second."""
    sent = 0
    while True:
        await asyncio.sleep(1)
        if not clients:
            continue
        new_logs = [l for l in engine.logs if l["seq"] > sent]
        sent = engine.log_seq
        msg = json.dumps({
            "type": "tick", "prices": feed.stats, "account": engine.account,
            "armed": engine.armed, "logs": new_logs, "stops": engine.market_stops(),
        })
        for ws in list(clients):
            try:
                await ws.send_text(msg)
            except Exception:
                clients.discard(ws)


@asynccontextmanager
async def lifespan(app):
    await api.start()
    feed.multipliers = {mid: m.multiplier for mid, m in api.markets.items()}
    tasks = [asyncio.create_task(t) for t in (feed.run(), calendar.run(), engine.run(), broadcast_loop())]
    yield
    for t in tasks:
        t.cancel()
    await api.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


def check_token(token):
    if config.DASH_TOKEN and token != config.DASH_TOKEN:
        raise HTTPException(401, "bad token")


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.headers.get("x-lang"):
        set_lang(request.headers["x-lang"])
    if request.url.path.startswith("/api/"):
        try:
            check_token(request.headers.get("x-token"))
        except HTTPException as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    response = await call_next(request)
    # always revalidate the UI files, so an update shows up on the next reload
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------- read ----------
@app.get("/api/info")
async def info():
    return {
        "trading": bool(api.signer), "account_index": config.ACCOUNT_INDEX, "armed": engine.armed,
        "credentials": config.CREDENTIALS_SOURCE if api.signer else None,
        "api_key_index": config.API_KEY_INDEX if api.signer else None,
        "network": "testnet" if "testnet" in config.LIGHTER_URL else "mainnet",
        "ws_url": config.LIGHTER_WS,
        "limits": {**risk.limits, "hard_cap_usd": config.MAX_NOTIONAL_USD,
                   "max_orders_per_day": config.MAX_ORDERS_PER_DAY},
        "markets": sorted((m.to_dict() for m in api.markets.values()), key=lambda m: -m["volume_usd"]),
    }


@app.get("/api/candles")
async def candles(market_id: int, resolution: str = "15m", count: int = 500):
    try:
        return await api.candles(market_id, resolution, min(count, 1000))
    except KeyError:
        raise HTTPException(400, "bad resolution")


@app.get("/api/calendar")
async def get_calendar():
    return calendar.listing()


ORDERS_TTL = 4  # seconds: chart lines and the Orders tab poll together without hammering Lighter
_orders_cache = {}


@app.get("/api/open_orders")
async def open_orders(market_ids: str = "", fresh: bool = False):
    out = []
    now = asyncio.get_running_loop().time()
    for mid in {int(x) for x in market_ids.split(",") if x.strip().isdigit()}:
        hit = _orders_cache.get(mid)
        if fresh or not hit or now - hit[0] > ORDERS_TTL:
            hit = _orders_cache[mid] = (now, await api.active_orders(mid))
        for o in hit[1]:
            out.append(dict(o, symbol=api.markets[mid].symbol if mid in api.markets else str(mid)))
    return out


@app.get("/api/orderbook")
async def orderbook(market_id: int):
    return await api.orderbook(market_id)


@app.get("/api/trades")
async def trades():
    positions = {p["market_id"]: p["size"] for p in (engine.account or {}).get("positions", [])}
    return await api.trades(positions=positions)


# ---------- manual trading ----------
class TrailReq(BaseModel):
    mode: str = "pct"                 # "pct" | "price" | "atr"
    value: float                      # % of the best price, price distance, or ATR multiple
    activate_pct: float = 0           # start trailing once the position is this much in profit
    breakeven_at_pct: float | None = None


TRAIL_RANGES = {"pct": (0.05, 50), "price": (1e-9, 1e12), "atr": (0.1, 20)}


def trail_fields(t: TrailReq):
    """Validated managed-stop settings from the UI's trailing options."""
    if t.mode not in TRAIL_RANGES:
        raise Blocked(L("Tipo di trailing sconosciuto", "Unknown trailing type"))
    lo, hi = TRAIL_RANGES[t.mode]
    if not lo <= t.value <= hi:
        raise Blocked(L(f"Distanza del trailing fuori dai limiti ({lo:g}–{hi:g})", f"Trailing distance out of range ({lo:g}–{hi:g})")
                      if t.mode != "price" else L("La distanza del trailing deve essere maggiore di zero",
                                                    "The trailing distance must be above zero"))
    if not 0 <= t.activate_pct <= 100 or (t.breakeven_at_pct is not None and not 0 < t.breakeven_at_pct <= 100):
        raise Blocked(L("Attivazione e breakeven vanno tra 0 e 100%", "Activation and breakeven must be between 0 and 100%"))
    return {f"trail_{t.mode}": t.value, "trail_activate_pct": t.activate_pct, "breakeven_at_pct": t.breakeven_at_pct}


class OrderReq(BaseModel):
    market_id: int
    side: str                   # "buy" | "sell"
    kind: str = "market"        # "market" | "limit"
    size: float                 # interpreted by `unit`
    unit: str = "usd"           # "usd" | "base" | "equity_pct" | "risk_usd"
    price: float | None = None  # limit price
    reduce_only: bool = False
    post_only: bool = False
    sl_price: float | None = None
    tp_price: float | None = None
    slippage_bps: float | None = None
    trail: TrailReq | None = None     # managed stop to start once the order fills


async def plan_order(o: OrderReq):
    """Size, prices and risk checks for a ticket. Raises Blocked / ValueError."""
    m = api.markets.get(o.market_id)
    if not m:
        raise Blocked(L("Mercato sconosciuto", "Unknown market"))
    side = 1 if o.side == "buy" else -1
    if o.kind == "limit":
        if not o.price:
            raise Blocked(L("Gli ordini limit richiedono un prezzo", "Limit orders need a price"))
        ref = o.price
    else:
        ref = risk.quote(o.market_id, side)
    acc = engine.account
    if o.unit == "base":
        size = o.size
    elif o.unit == "risk_usd":
        if not o.sl_price or o.sl_price == ref:
            raise Blocked(L("La size a rischio fisso richiede uno stop-loss lontano dall'entrata",
                            "Risk sizing needs a stop-loss away from entry"))
        size = o.size / abs(ref - o.sl_price)
    elif o.unit == "equity_pct":
        if not acc or not 0 < o.size <= 100:
            raise Blocked(L("La % del capitale richiede l'account caricato e un valore tra 0 e 100",
                            "Equity % needs a loaded account and a value between 0 and 100"))
        size = acc["total_value"] * o.size / 100 / ref
    else:
        size = o.size / ref
    size = round(size, m.size_decimals)
    if size <= 0:
        raise Blocked(L("Size sotto la precisione del mercato", "Size is below market precision"))
    slip_bps = o.slippage_bps if o.slippage_bps is not None else risk.limits["slippage_bps_cap"]
    worst = ref if o.kind == "limit" else ref * (1 + side * slip_bps / 10000)
    if o.reduce_only and (o.sl_price or o.tp_price or o.trail):
        raise Blocked(L("Le chiusure reduce-only non possono avere SL/TP", "Reduce-only closes cannot attach SL/TP"))
    if o.trail:
        trail_fields(o.trail)
    mark = feed.mark(o.market_id) if o.kind == "market" else None
    await risk.review(acc, o.market_id, side, size, ref, o.sl_price, o.tp_price, slip_bps, o.reduce_only, mark)
    return {"size": size, "side": side, "ref": ref, "worst": m.round_price(worst), "notional": size * ref,
            "slippage_bps": slip_bps}


@app.post("/api/preview")
async def preview(o: OrderReq):
    try:
        plan = await plan_order(o)
        return {"ok": True, **plan}
    except (Blocked, ValueError) as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/order")
async def place_order(o: OrderReq):
    try:
        plan = await plan_order(o)
    except (Blocked, ValueError) as e:
        raise HTTPException(400, str(e))
    m = api.markets[o.market_id]
    signed = plan["size"] * plan["side"]
    try:
        if o.reduce_only:
            if o.kind == "limit":
                await api.limit_order(o.market_id, signed, o.price, reduce_only=True, post_only=o.post_only)
            else:
                await api.market_order(o.market_id, signed, plan["ref"], reduce_only=True,
                                       slippage_pct=plan["slippage_bps"] / 100)
        else:
            await api.entry(o.market_id, signed, o.kind, plan["worst"], o.sl_price, o.tp_price,
                            slippage_pct=plan["slippage_bps"] / 100, post_only=o.post_only)
    except Exception as e:
        engine.note(f"manual order failed: {e}", "error")
        raise HTTPException(400, str(e))
    engine.note(f"manual {o.kind} {o.side} {plan['size']} {m.symbol} @ ~{plan['ref']}"
                + (f" SL {o.sl_price}" if o.sl_price else "") + (f" TP {o.tp_price}" if o.tp_price else ""), "warning")
    if o.trail:
        rule = engine.set_market_stop(o.market_id, trail_fields(o.trail))
        engine.note(f"{engine.describe(rule)} (from the ticket)", "warning")
    return {"ok": True, "size": plan["size"], "armed": engine.armed}


# ---------- trailing stop on an open position ----------
@app.put("/api/trail/{market_id}")
async def set_trail(market_id: int, t: TrailReq):
    if market_id not in api.markets:
        raise HTTPException(400, L("Mercato sconosciuto", "Unknown market"))
    try:
        rule = engine.set_market_stop(market_id, trail_fields(t))
    except Blocked as e:
        raise HTTPException(400, str(e))
    engine.note(f"{engine.describe(rule)} (from the position)", "warning")
    return {"stops": engine.market_stops(), "armed": engine.armed}


@app.delete("/api/trail/{market_id}")
async def delete_trail(market_id: int):
    engine.set_market_stop(market_id, None)
    return {"stops": engine.market_stops()}


@app.get("/api/limits")
async def get_limits():
    risk.convert_usd_limits(engine.account)
    equity = (engine.account or {}).get("total_value")
    daily = await risk.daily_pnl()
    # what each % is worth right now (the daily loss is measured on the equity at 00:00 UTC)
    return {"limits": risk.limits, "hard_cap_usd": config.MAX_NOTIONAL_USD, "daily_pnl": daily,
            "equity": equity, "day_start_equity": equity - daily if equity and daily is not None else equity}


@app.patch("/api/limits")
async def patch_limits(patch: dict):
    try:
        limits = risk.update(patch)
    except (Blocked, ValueError) as e:
        raise HTTPException(400, str(e))
    engine.note(f"risk limits updated: {patch}", "warning")
    return limits


# ---------- API key added from the UI ----------
class CredentialsReq(BaseModel):
    account_index: int
    api_key_index: int
    private_key: str


@app.get("/api/accounts_for_address")
async def accounts_for_address(address: str):
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address.strip()):
        raise HTTPException(400, L("Indirizzo non valido: deve essere 0x seguito da 40 caratteri", "Invalid address: it must be 0x followed by 40 characters"))
    try:
        return await api.accounts_for_address(address.strip())
    except RuntimeError:
        raise HTTPException(404, L("Nessun account Lighter per questo indirizzo", "No Lighter account for this address"))


@app.post("/api/credentials")
async def set_credentials(req: CredentialsReq):
    if config.CREDENTIALS_SOURCE == "env":
        raise HTTPException(409, L("L'API key è impostata nel file env del server: cambiala lì", "The API key is set in the server env file: change it there"))
    key = req.private_key.strip().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-fA-F]{40,128}", key):
        raise HTTPException(400, L("La chiave privata deve essere in esadecimale", "The private key must be hexadecimal"))
    if not 0 <= req.api_key_index <= 254 or req.account_index < 0:
        raise HTTPException(400, L("Indice account o API key non valido", "Invalid account or API key index"))
    try:
        await api.connect(req.account_index, req.api_key_index, key)
    except ValueError as e:
        raise HTTPException(400, L(f"Lighter non accetta questa chiave: {e}", f"Lighter does not accept this key: {e}"))
    # owner-only file in data/ (git-ignored); never sent back to the browser
    fd = os.open(config.CREDENTIALS_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"account_index": req.account_index, "api_key_index": req.api_key_index, "private_key": key}, f)
    config.CREDENTIALS_SOURCE = "ui"
    engine.note(f"API key {req.api_key_index} added for account {req.account_index}", "warning")
    return await info()


@app.delete("/api/credentials")
async def delete_credentials():
    if config.CREDENTIALS_SOURCE == "env":
        raise HTTPException(409, L("L'API key è impostata nel file env del server: rimuovila lì", "The API key is set in the server env file: remove it there"))
    engine.set_armed(False)
    await api.disconnect()
    engine.account = None
    config.CREDENTIALS_FILE.unlink(missing_ok=True)
    config.CREDENTIALS_SOURCE = None
    engine.note("API key removed: read-only", "warning")
    return await info()


@app.post("/api/leverage")
async def set_leverage(market_id: int, leverage: int, cross: bool = True):
    m = api.markets.get(market_id)
    if not m or leverage < 1 or (m.max_leverage and leverage > m.max_leverage):
        raise HTTPException(400, L("Leva fuori dai limiti del mercato", "Leverage outside the market's range"))
    if leverage > risk.limits["leverage_cap"]:
        raise HTTPException(400, L(f"Leva oltre il tuo limite ({risk.limits['leverage_cap']}x)",
                                   f"Leverage above your limit ({risk.limits['leverage_cap']}x)"))
    try:
        await api.set_leverage(market_id, leverage, cross)
    except Exception as e:
        raise HTTPException(400, str(e))
    engine.note(f"{m.symbol} leverage set to {leverage}x {'cross' if cross else 'isolated'}", "warning")
    return {"ok": True}


@app.post("/api/close")
async def close_position(market_id: int, fraction: float = 1.0):
    pos = engine._position(market_id)
    if not pos:
        raise HTTPException(400, L("Nessuna posizione", "No position"))
    m = api.markets[market_id]
    size = pos["size"] if fraction >= 1 else round(pos["size"] * fraction, m.size_decimals)
    try:
        try:
            ref = risk.quote(market_id, -1 if size > 0 else 1)
        except Blocked:
            ref = feed.mark(market_id)
        await api.market_order(market_id, -size, ref, reduce_only=True)
    except Exception as e:
        raise HTTPException(400, str(e))
    engine.note(f"manual close {int(fraction * 100)}% {pos['symbol']} ({size})", "warning")
    return {"ok": True}


class MoveReq(BaseModel):
    market_id: int
    order_index: int
    price: float  # new level: the trigger of a SL/TP, the price of a limit order


@app.post("/api/move_order")
async def move_order(r: MoveReq):
    """Drag an order line on the chart: checked here so a drop can't fire or fill the order by mistake."""
    if not api.signer or r.market_id not in api.markets:
        raise HTTPException(400, L("Trading non attivo", "Trading is not enabled"))
    m = api.markets[r.market_id]
    order = next((o for o in await api.active_orders(r.market_id) if o["order_index"] == r.order_index), None)
    if not order:
        raise HTTPException(400, L("Ordine non trovato: forse è già stato eseguito o annullato",
                                   "Order not found: it may have filled or been cancelled"))
    managed = (engine.market_stop(r.market_id) or {}).get("state", {})
    if managed.get("coi") and managed["coi"] == order["client_order_index"]:
        raise HTTPException(400, L("È lo stop del trailing: cambialo dal bottone Trailing della posizione",
                                   "This is the trailing stop: change it from the position's Trailing button"))
    stats = feed.stats.get(r.market_id) or {}
    price = m.round_price(r.price)
    if price <= 0:
        raise HTTPException(400, L("Prezzo non valido", "Invalid price"))
    if order["trigger_price"]:
        is_sl = "stop" in order["type"]
        closes_long = order["is_ask"]  # a reduce-only sell closes a long
        below = is_sl == closes_long    # a long's SL and a short's TP sit below the price
        mark = stats.get("mark")
        if mark and ((price >= mark) if below else (price <= mark)):
            what = L("Lo stop-loss", "The stop-loss") if is_sl else L("Il take-profit", "The take-profit")
            raise HTTPException(400, L(f"{what} deve stare {'sotto' if below else 'sopra'} il prezzo mark ({mark:g}), altrimenti scatterebbe subito",
                                       f"{what} must be {'below' if below else 'above'} the mark price ({mark:g}), or it would trigger at once"))
        # keep the order's own gap between trigger and worst fill price
        worst = order["price"] * price / order["trigger_price"] if order["price"] else price
        await api.modify_order(r.market_id, r.order_index, order["remaining"], worst, price)
    else:
        bid, ask = stats.get("bid"), stats.get("ask")
        if (not order["is_ask"] and ask and price >= ask) or (order["is_ask"] and bid and price <= bid):
            raise HTTPException(400, L("Il limite attraverserebbe il prezzo e verrebbe eseguito subito",
                                       "The limit would cross the price and fill at once"))
        await api.modify_order(r.market_id, r.order_index, order["remaining"], price)
    _orders_cache.pop(r.market_id, None)
    engine.note(f"{m.symbol} order {r.order_index} moved to {price:g}")
    return {"ok": True, "price": price}


@app.post("/api/cancel_order")
async def cancel_order(market_id: int, order_index: int):
    try:
        await api.cancel_order(market_id, order_index)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/cancel_all")
async def cancel_all():
    try:
        await api.cancel_all()
    except Exception as e:
        raise HTTPException(400, str(e))
    engine.note("cancelled all open orders", "warning")
    return {"ok": True}


# ---------- automations ----------
@app.get("/api/rules")
async def list_rules():
    return [dict(r, description=engine.describe(r)) for r in engine.rules.values()]


@app.post("/api/rules")
async def add_rule(rule: dict):
    try:
        return engine.add_rule(rule)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


@app.patch("/api/rules/{rule_id}")
async def patch_rule(rule_id: str, patch: dict):
    if rule_id not in engine.rules:
        raise HTTPException(404)
    return engine.update_rule(rule_id, patch)


@app.delete("/api/rules/{rule_id}")
async def delete_rule(rule_id: str):
    engine.delete_rule(rule_id)
    return {"ok": True}


@app.post("/api/armed")
async def set_armed(armed: bool):
    engine.set_armed(armed)
    return {"armed": engine.armed}


@app.get("/api/logs")
async def logs():
    return list(engine.logs)


# ---------- live push ----------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    if config.DASH_TOKEN and token != config.DASH_TOKEN:
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients.discard(ws)


@app.get("/logo/{symbol}")
async def logo(symbol: str):
    m = next((m for m in api.markets.values() if m.symbol == symbol), None)
    found = await logos.get(m) if m else None
    if not found:
        return Response(status_code=404, headers={"Cache-Control": "max-age=86400"})
    body, ctype = found
    return Response(body, media_type=ctype, headers={
        "Cache-Control": "max-age=604800",
        # logos are images only: an SVG opened directly must not run scripts on our origin
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
    })


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, workers=1, log_level="info")
