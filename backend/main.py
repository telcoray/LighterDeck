"""LighterDeck backend: serves the UI, market data, calendar, trading and automations."""
import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import og
from econ import Calendar
from engine import Engine
from feed import PriceFeed
from lighter_api import LighterAPI
from logos import Logos
from risk import Blocked, RiskGuard, sltp_trigger_error
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
            "armed": engine.armed, "logs": new_logs, "stops": engine.market_stops(), "exits": engine.exit_plans(),
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
    calendar.stock_symbols = lambda: {m.symbol for m in api.markets.values() if "STOCK" in m.categories}
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
        if config.PUBLIC_MODE and request.method not in ("GET", "HEAD"):
            return JSONResponse({"detail": L("Questa è la versione pubblica in sola lettura di LighterDeck",
                                             "This is the public read-only version of LighterDeck")}, status_code=403)
    response = await call_next(request)
    # always revalidate the UI files, so an update shows up on the next reload
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------- read ----------
@app.get("/api/info")
async def info(request: Request):
    return {
        "public": config.PUBLIC_MODE,
        "referral_url": config.REFERRAL_URL, "github_url": config.GITHUB_URL,
        # Cloudflare's visitor country, so the public site can show the page for excluded countries
        "blocked_country": config.PUBLIC_MODE and request.headers.get("cf-ipcountry", "") in config.BLOCKED_COUNTRIES,
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


class CustomEventReq(BaseModel):
    title: str
    ts: int                   # unix seconds
    markets: list[str]        # Lighter symbols the event moves
    impact: str = "High"


@app.post("/api/custom_events")
async def add_custom_event(r: CustomEventReq):
    unknown = [s for s in r.markets if s.strip().upper() not in {m.symbol for m in api.markets.values()}]
    if unknown or not r.markets:
        raise HTTPException(400, L(f"Mercato sconosciuto: {', '.join(unknown) or '—'}", f"Unknown market: {', '.join(unknown) or '—'}"))
    if not time.time() - 86400 * 35 <= r.ts <= time.time() + 86400 * 800:
        raise HTTPException(400, L("Data fuori dall'intervallo", "Date out of range"))
    try:
        return calendar.add_custom(r.title, r.ts, r.markets, r.impact)
    except ValueError:
        raise HTTPException(400, L("Titolo da 1 a 80 caratteri e impatto alto, medio o basso",
                                   "Title of 1 to 80 characters and impact high, medium or low"))


@app.delete("/api/custom_events/{event_id}")
async def delete_custom_event(event_id: str):
    try:
        calendar.delete_custom(event_id)
    except KeyError:
        raise HTTPException(404, L("Evento non trovato", "Event not found"))
    return {"ok": True}


# ---------- account page ----------
_account_cache = {}  # (kind, args) -> (fetched at, result)


async def _cached(key, ttl, fn):
    hit = _account_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = await fn()
    _account_cache[key] = (time.time(), value)
    return value


def _pnl_of(p):     # cumulative trading PnL (perpetuals + spot)
    return float(p["trade_pnl"]) + float(p.get("trade_spot_pnl") or 0)


def _flows_of(p):   # cumulative deposits minus withdrawals
    return (float(p["inflow"]) - float(p["outflow"]) + float(p.get("spot_inflow") or 0)
            - float(p.get("spot_outflow") or 0))


def _need_key():
    if not api.signer:
        raise HTTPException(400, L("Collega un'API key per vedere l'account", "Connect an API key to see the account"))


async def _year_fills():
    """The year's fills with realized PnL, shared by every period and by the calendar's days (2 min)."""
    async def fetch():
        positions = {p["market_id"]: p["size"] for p in (engine.account or {}).get("positions", [])}
        return await api.trades(positions=positions, since_ms=(int(time.time()) - 365 * 86400) * 1000)
    return await _cached(("fills",), 120, fetch)


@app.get("/api/account_stats")
async def account_stats(days: int = 30):
    """Equity and PnL over a period, daily PnL for the calendar and the period's stats: from Lighter's
    PnL series alone (two fast requests). PnL excludes deposits and withdrawals, so the curve shows
    trading alone. The per-market figures come from /api/account_markets, which is slower."""
    _need_key()
    days = max(1, min(days, 365))
    now = int(time.time())
    start = now - days * 86400
    try:
        year = await _cached(("pnl", "1d"), 60, lambda: api.pnl_points(now - 365 * 86400, now, "1d"))
        pts = (await _cached(("pnl", "1h"), 60, lambda: api.pnl_points(now - 7 * 86400, now, "1h")) if days <= 7
               else [p for p in year if p["timestamp"] >= start - 86400])
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    pts = [p for p in pts if p["timestamp"] >= start - 3600] if days <= 7 else pts
    if not pts:
        return {"series": [], "flows": [], "days": [], "stats": None}
    p0, f0 = _pnl_of(pts[0]), _flows_of(pts[0])
    series = [{"t": p["timestamp"], "equity": _pnl_of(p) + _flows_of(p), "pnl": _pnl_of(p) - p0} for p in pts]
    # a deposit or withdrawal shows on the point after it; "at" is the start of the interval it happened in
    flows = [{"t": b["timestamp"], "at": a["timestamp"], "usd": _flows_of(b) - _flows_of(a)}
             for a, b in zip(pts, pts[1:]) if abs(_flows_of(b) - _flows_of(a)) >= 1]
    # daily PnL (UTC days, as Lighter's calendar): each 00:00 point to the next one (the last is live)
    daily = [{"day": time.strftime("%Y-%m-%d", time.gmtime(a["timestamp"])), "pnl": _pnl_of(b) - _pnl_of(a)}
             for a, b in zip(year, year[1:])]
    in_period = [d for d in daily if d["day"] >= time.strftime("%Y-%m-%d", time.gmtime(start))]
    peak, drawdown = float("-inf"), 0.0
    for x in series:
        peak = max(peak, x["pnl"])
        drawdown = max(drawdown, peak - x["pnl"])
    e0, net_flows = series[0]["equity"], _flows_of(pts[-1]) - f0
    # return on the average capital in the account (the points where it held money), so deposits and
    # withdrawals during the period, or an empty account at its start, don't distort it
    funded = [x["equity"] for x in series if x["equity"] >= 50]
    base = sum(funded) / len(funded) if funded else 0
    stats = {
        "pnl": series[-1]["pnl"], "return_pct": series[-1]["pnl"] / base * 100 if base > 0 else None,
        "max_drawdown": drawdown, "net_flows": net_flows, "start_equity": e0,
        "best_day": max(in_period, key=lambda d: d["pnl"], default=None),
        "worst_day": min(in_period, key=lambda d: d["pnl"], default=None),
        "green_days": sum(d["pnl"] > 0.005 for d in in_period), "red_days": sum(d["pnl"] < -0.005 for d in in_period),
    }
    return {"series": series, "flows": flows, "days": daily, "stats": stats}


@app.get("/api/account_markets")
async def account_markets(days: int = 30):
    """Realized PnL, funding received/paid, fills and volume per market over a period. The year's fills
    are cached and shared; funding is fetched alongside them."""
    _need_key()
    days = max(1, min(days, 365))
    start = int(time.time()) - days * 86400
    try:
        fills, (funding, complete) = await asyncio.gather(
            _year_fills(), _cached(("funding", days), 300, lambda: api.funding_paid(start)))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    per = {}

    def row(mid, symbol):
        return per.setdefault(mid, {"market_id": mid, "symbol": symbol, "realized": 0.0, "fills": 0, "volume": 0.0, "funding": 0.0})
    for f in fills:
        if f["ts"] < start * 1000:
            continue
        r = row(f["market_id"], f["symbol"])
        r["fills"] += 1
        r["volume"] += f["usd"]
        r["realized"] += f["pnl"] or 0.0
    for mid, usd in funding.items():
        m = api.markets.get(mid)
        row(mid, m.symbol if m else str(mid))["funding"] += usd
    markets = sorted(per.values(), key=lambda r: -abs(r["realized"] + r["funding"]))
    return {"markets": markets, "volume": sum(r["volume"] for r in markets), "funding_complete": complete}


@app.get("/api/fills")
async def fills_between(start: int, end: int):
    """Fills between two unix times (s), newest first, with realized PnL: one day of the PnL calendar."""
    if not api.signer:
        return []
    if start >= time.time() - 365 * 86400:
        rows = await _year_fills()
    else:
        positions = {p["market_id"]: p["size"] for p in (engine.account or {}).get("positions", [])}
        rows = await _cached(("fills", start), 120, lambda: api.trades(positions=positions, since_ms=start * 1000))
    return [r for r in rows if start * 1000 <= r["ts"] < end * 1000]


_funding_cache = {}  # (market, days) -> (fetched at, rows); funding changes once an hour


@app.get("/api/funding")
async def funding(market_id: int, days: int = 7):
    days = max(1, min(days, 31))  # Lighter returns at most 750 hourly points
    hit = _funding_cache.get((market_id, days))
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    try:
        rows = await api.fundings(market_id, days * 24)
    except Exception as e:
        raise HTTPException(502, str(e))
    _funding_cache[(market_id, days)] = (time.time(), rows)
    return rows


@app.get("/api/calendar")
async def get_calendar():
    return calendar.listing(days_back=35)  # past weeks too, for the event dots on the charts


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


_book_cache = {}  # market -> (fetched at, book): many visitors, one request a second to Lighter


@app.get("/api/orderbook")
async def orderbook(market_id: int):
    hit = _book_cache.get(market_id)
    if hit and time.time() - hit[0] < 1:
        return hit[1]
    book = await api.orderbook(market_id)
    _book_cache[market_id] = (time.time(), book)
    return book


@app.get("/api/trades")
async def trades(market_id: int | None = None):
    """Latest fills: all markets, or one market's (the chart's fill marks)."""
    positions = {p["market_id"]: p["size"] for p in (engine.account or {}).get("positions", [])}
    if market_id is not None:
        positions = {k: v for k, v in positions.items() if k == market_id}
    return await api.trades(positions=positions, market_id=market_id)


# ---------- manual trading ----------
class TrailReq(BaseModel):
    mode: str = "pnl"                 # "pnl" (PnL % on margin) | "pct" (price %) | "price" | "atr"
    value: float                      # % of the best price, price distance, or ATR multiple
    activate_pct: float = 0           # start trailing once the position's PnL % (on margin) reaches this
    breakeven_at_pct: float | None = None


TRAIL_RANGES = {"pnl": (0.1, 1000), "pct": (0.05, 50), "price": (1e-9, 1e12), "atr": (0.1, 20)}


def trail_fields(t: TrailReq):
    """Validated managed-stop settings from the UI's trailing options."""
    if t.mode not in TRAIL_RANGES:
        raise Blocked(L("Tipo di trailing sconosciuto", "Unknown trailing type"))
    lo, hi = TRAIL_RANGES[t.mode]
    if not lo <= t.value <= hi:
        raise Blocked(L(f"Distanza del trailing fuori dai limiti ({lo:g}–{hi:g})", f"Trailing distance out of range ({lo:g}–{hi:g})")
                      if t.mode != "price" else L("La distanza del trailing deve essere maggiore di zero",
                                                    "The trailing distance must be above zero"))
    if not 0 <= t.activate_pct <= 1000 or (t.breakeven_at_pct is not None and not 0 < t.breakeven_at_pct <= 1000):
        raise Blocked(L("Attivazione e breakeven vanno tra 0 e 1000% di PnL", "Activation and breakeven must be between 0 and 1000% PnL"))
    return {f"trail_{t.mode}": t.value, "trail_activate_pct": t.activate_pct, "breakeven_at_pct": t.breakeven_at_pct}


class TpLevel(BaseModel):
    price: float | None = None
    pct: float                  # share of the order's size this level closes


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
    tp_levels: list[TpLevel] | None = None   # scaled exits instead of tp_price: 2 to 5 levels
    be_after_tp1: bool = True                # with tp_levels: stop to breakeven once TP1 fills


def exit_levels(o: OrderReq, m, size, side, ref, mark, check_sides):
    """Scaled exits: each level's price and size. The last one takes what is left when they add up to 100%."""
    lv = o.tp_levels
    if not 2 <= len(lv) <= 5:
        raise Blocked(L("Da 2 a 5 livelli di take-profit", "From 2 to 5 take-profit levels"))
    total = sum(l.pct for l in lv)
    if any(l.pct <= 0 for l in lv) or total > 100.0001:
        raise Blocked(L("Le quote dei TP vanno sopra lo 0% e in totale fino al 100%",
                        "TP shares must be above 0% and add up to 100% at most"))
    out = []
    for i, l in enumerate(lv):
        name = f"TP{i + 1}"
        if not l.price and check_sides:
            raise Blocked(L(f"{name}: inserisci il prezzo", f"{name}: enter the price"))
        price = m.round_price(l.price) if l.price else ref
        if l.price and check_sides:
            err = sltp_trigger_error(side, ref, mark, None, price)
            if err:
                raise Blocked(f"{name}: {err}")
        last = i == len(lv) - 1 and total > 99.9999
        qty = round(size - sum(x["qty"] for x in out) if last else size * l.pct / 100, m.size_decimals)
        if qty < m.min_base or qty * price < m.min_quote:
            q, mb = f"{qty:.{m.size_decimals}f}", f"{m.min_base:.{m.size_decimals}f}"
            raise Blocked(L(f"{name}: {q} {m.symbol} è sotto il minimo dell'exchange ({mb} {m.symbol} o {m.min_quote:g} USD). Usa meno livelli o una size più grande.",
                            f"{name}: {q} {m.symbol} is below the exchange minimum ({mb} {m.symbol} or {m.min_quote:g} USD). Use fewer levels or a larger size."))
        out.append({"price": price, "qty": qty})
    return out


async def plan_order(o: OrderReq, check_sides=True):
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
    if o.reduce_only and (o.sl_price or o.tp_price or o.trail or o.tp_levels):
        raise Blocked(L("Le chiusure reduce-only non possono avere SL/TP", "Reduce-only closes cannot attach SL/TP"))
    if o.trail:
        trail_fields(o.trail)
    mark = feed.mark(o.market_id) if o.kind == "market" else None
    if o.tp_levels and o.tp_price:
        raise Blocked(L("Usa un solo take-profit o i livelli, non entrambi", "Use one take-profit or the levels, not both"))
    levels = exit_levels(o, m, size, side, ref, mark, check_sides) if o.tp_levels else None
    await risk.review(acc, o.market_id, side, size, ref, o.sl_price, o.tp_price, slip_bps, o.reduce_only, mark,
                      check_sides=check_sides)
    return {"size": size, "side": side, "ref": ref, "worst": m.round_price(worst), "notional": size * ref,
            "slippage_bps": slip_bps, **({"tp_levels": levels} if levels else {})}


@app.post("/api/preview")
async def preview(o: OrderReq, live: bool = False):
    """live: the ticket while it is being filled in, so a half-typed SL/TP isn't flagged yet."""
    try:
        plan = await plan_order(o, check_sides=not live)
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
    if plan.get("tp_levels"):
        held = (engine._position(o.market_id) or {}).get("size", 0.0)
        rule = engine.set_exit_plan(o.market_id, plan["tp_levels"], o.be_after_tp1, before=held, size=signed)
        if o.kind == "market":  # filled already: the take-profits go now, Auto or not
            try:
                await engine.place_exits(rule, held + signed)
            except Exception as e:
                engine.note(f"{m.symbol} scaled TPs not all placed: {e} (Auto retries)", "error", rule)
            engine.save()
    return {"ok": True, "size": plan["size"], "armed": engine.armed}


# ---------- pair trade: both legs of a spread ----------
class PairReq(BaseModel):
    long_id: int
    short_id: int
    size_usd: float                   # total value, half on each leg
    slippage_bps: float | None = None


@app.post("/api/pair_order")
async def pair_order(r: PairReq):
    """Buy one market and sell the other for the same dollar value, each with a market order. Both legs are
    planned and checked first (margin for the two together too); if the second one fails, the first stays
    open and the answer says so, so the UI can offer to close it."""
    if r.long_id == r.short_id:
        raise HTTPException(400, L("Scegli due mercati diversi", "Pick two different markets"))
    legs = [OrderReq(market_id=mid, side=side, kind="market", size=r.size_usd / 2, unit="usd", slippage_bps=r.slippage_bps)
            for mid, side in ((r.long_id, "buy"), (r.short_id, "sell"))]
    try:
        plans = [await plan_order(o) for o in legs]
    except (Blocked, ValueError) as e:
        raise HTTPException(400, str(e))
    acc = engine.account
    if acc:
        lev = lambda mid: (acc.get("settings", {}).get(mid, {}).get("leverage") or api.markets[mid].default_leverage or 1)
        need = sum(p["notional"] / lev(o.market_id) for o, p in zip(legs, plans))
        if need > acc["available"]:
            raise HTTPException(400, L(f"Margine insufficiente per le due gambe: servono {need:,.2f} USD, disponibili {acc['available']:,.2f}",
                                       f"Not enough margin for both legs: {need:,.2f} USD needed, {acc['available']:,.2f} available"))
    done = []
    for o, plan in zip(legs, plans):
        m = api.markets[o.market_id]
        try:
            await api.entry(o.market_id, plan["size"] * plan["side"], "market", plan["worst"], None, None,
                            slippage_pct=plan["slippage_bps"] / 100)
        except Exception as e:
            engine.note(f"pair order: {m.symbol} leg failed: {e}", "error")
            if not done:
                raise HTTPException(400, str(e))
            return {"ok": False, "error": str(e), "filled": done, "failed": {"market_id": o.market_id, "symbol": m.symbol}}
        done.append({"market_id": o.market_id, "symbol": m.symbol, "side": o.side, "size": plan["size"], "price": plan["ref"]})
    engine.note(f"manual pair: long {done[0]['size']} {done[0]['symbol']} / short {done[1]['size']} {done[1]['symbol']}", "warning")
    _add_pair(r.long_id, r.short_id, done[0]["size"], done[1]["size"], done[0]["price"], done[1]["price"])
    return {"ok": True, "legs": done}


# Pairs: Lighter keeps one position per market, so a pair's leg can be part of a bigger position (a WTI
# long already open, plus the pair's WTI). LighterDeck records each pair's own quantities and entry prices;
# a pair shrinks when its market's position gets smaller than its leg, and ends when a leg is gone or flips.
PAIRS_FILE = config.DATA_DIR / "pairs.json"


def _pairs():
    try:
        return json.loads(PAIRS_FILE.read_text())
    except (OSError, ValueError):
        return []


def _save_pairs(pairs):
    PAIRS_FILE.write_text(json.dumps(pairs, indent=1))


def _add_pair(long_id, short_id, long_qty, short_qty, long_entry, short_entry):
    pairs = _pairs()
    pairs.append({"id": f"{long_id}-{short_id}-{int(time.time() * 1000)}", "long_id": long_id, "short_id": short_id,
                  "long_qty": long_qty, "short_qty": short_qty, "long_entry": long_entry, "short_entry": short_entry,
                  "at": time.time()})
    _save_pairs(pairs)


async def _legs_from_fills(p, positions):
    """A pair recorded without its quantities (before they were kept): its legs are the fills on each market
    in the 20 seconds before it was recorded (both legs go out within a second or two); without them, the whole position."""
    for key, mid, side in (("long", p["long_id"], "buy"), ("short", p["short_id"], "sell")):
        qty = cost = 0.0
        try:
            for f in await api.trades(market_id=mid):
                if f["side"] == side and p["at"] * 1000 - 20000 <= f["ts"] <= p["at"] * 1000 + 5000:
                    qty += f["size"]
                    cost += f["size"] * f["price"]
        except Exception as e:
            log.info("pair %s: fills not read: %s", p["id"], e)
        pos = positions.get(mid) or {}
        p[f"{key}_qty"] = qty or abs(pos.get("size", 0))
        p[f"{key}_entry"] = cost / qty if qty else pos.get("entry", 0)


@app.get("/api/pairs")
async def get_pairs():
    pairs = _pairs()
    if engine.account is None:
        return pairs
    positions = {p["market_id"]: p for p in engine.account.get("positions", [])}
    # what each position still has for the pairs, oldest pair first: two pairs never count the same units
    free = {mid: abs(p["size"]) for mid, p in positions.items()}
    out, changed = [], False
    for p in pairs:
        if "long_qty" not in p:
            await _legs_from_fills(p, positions)
            changed = True
        lp, sp = positions.get(p["long_id"]), positions.get(p["short_id"])
        lq = min(p["long_qty"], free.get(p["long_id"], 0)) if lp and lp["size"] > 0 else 0
        sq = min(p["short_qty"], free.get(p["short_id"], 0)) if sp and sp["size"] < 0 else 0
        if lq <= 1e-12 or sq <= 1e-12:
            changed = True
            continue
        if (lq, sq) != (p["long_qty"], p["short_qty"]):
            p["long_qty"], p["short_qty"] = lq, sq
            changed = True
        free[p["long_id"]] -= lq
        free[p["short_id"]] -= sq
        out.append(p)
    if changed:
        _save_pairs(out)
    return out


class PairGroupReq(BaseModel):
    long_id: int
    short_id: int


@app.post("/api/pairs")
async def group_pair(r: PairGroupReq):
    """Group a long and a short position already open into a pair: what each has outside other pairs, at
    their entry prices."""
    positions = {p["market_id"]: p for p in (engine.account or {}).get("positions", [])}
    lp, sp = positions.get(r.long_id), positions.get(r.short_id)
    if not (lp and lp["size"] > 0 and sp and sp["size"] < 0):
        raise HTTPException(400, L("Serve una posizione long e una short aperte", "It needs an open long and an open short position"))
    taken = {}
    for p in await get_pairs():
        taken[p["long_id"]] = taken.get(p["long_id"], 0) + p["long_qty"]
        taken[p["short_id"]] = taken.get(p["short_id"], 0) + p["short_qty"]
    lq, sq = lp["size"] - taken.get(r.long_id, 0), -sp["size"] - taken.get(r.short_id, 0)
    if lq <= 1e-12 or sq <= 1e-12:
        raise HTTPException(400, L("Queste posizioni sono già tutte in coppia", "These positions are already all in pairs"))
    _add_pair(r.long_id, r.short_id, lq, sq, lp["entry"], sp["entry"])
    return await get_pairs()


@app.delete("/api/pairs/{pair_id}")
async def ungroup_pair(pair_id: str):
    _save_pairs([p for p in _pairs() if p["id"] != pair_id])
    return await get_pairs()


@app.post("/api/pairs/{pair_id}/close")
async def close_pair(pair_id: str, fraction: float = 1.0):
    """Close a share of the pair: a reduce-only market order on each leg for that share of the pair's own
    quantity, so the rest of a bigger position on the same market stays open."""
    pairs = await get_pairs()
    p = next((x for x in pairs if x["id"] == pair_id), None)
    if not p:
        raise HTTPException(400, L("Coppia non trovata", "Pair not found"))
    f = min(max(fraction, 0.0), 1.0)
    errors = []
    for key, mid, sign in (("long", p["long_id"], 1), ("short", p["short_id"], -1)):
        m = api.markets[mid]
        size = round(p[f"{key}_qty"] * f, m.size_decimals)
        if size <= 0:
            continue
        try:
            try:
                ref = risk.quote(mid, -sign)
            except Blocked:
                ref = feed.mark(mid)
            await api.market_order(mid, -sign * size, ref, reduce_only=True)
            p[f"{key}_qty"] = round(p[f"{key}_qty"] - size, m.size_decimals)
        except Exception as e:
            errors.append(f"{m.symbol}: {e}")
    keep = [x for x in pairs if x["id"] != pair_id] + ([p] if p["long_qty"] > 0 and p["short_qty"] > 0 and f < 0.999 else [])
    _save_pairs(keep)
    engine.note(f"manual close {int(f * 100)}% of pair {api.markets[p['long_id']].symbol}/{api.markets[p['short_id']].symbol}"
                + (f" ({'; '.join(errors)})" if errors else ""), "warning" if not errors else "error")
    if errors:
        raise HTTPException(400, "; ".join(errors))
    return {"ok": True}


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
    daily = await risk.daily_pnl() if risk.limits["on"].get("daily_loss_pct") else None
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
    if risk.limits["on"].get("leverage_cap") and leverage > risk.limits["leverage_cap"]:
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


@app.post("/api/reverse")
async def reverse_position(market_id: int):
    """Close the position and open the opposite one of the same size in one market order, like Lighter's
    Reverse. The old SL/TP and managed stop end with it: the new position starts without protection."""
    pos = engine._position(market_id)
    if not pos:
        raise HTTPException(400, L("Nessuna posizione", "No position"))
    m = api.markets[market_id]
    size = pos["size"]
    # the reduce-only triggers that close the old side would sit on the wrong side after the flip
    old = [o for o in await api.active_orders(market_id) if o["reduce_only"] and o["trigger_price"]]
    try:
        try:
            ref = risk.quote(market_id, -1 if size > 0 else 1)
        except Blocked:
            ref = feed.mark(market_id)
        await api.market_order(market_id, -2 * size, ref, reduce_only=False)
    except Exception as e:
        raise HTTPException(400, str(e))
    engine.set_market_stop(market_id, None)
    for o in old:
        try:
            await api.cancel_order(market_id, o["order_index"])
        except Exception as e:  # position-tied SL/TP are already gone with the flip
            log.info("reverse: order %s not cancelled: %s", o["order_index"], e)
    _orders_cache.pop(market_id, None)
    engine.note(f"manual reverse {pos['symbol']}: {size} -> {-size}", "warning")
    return {"ok": True, "size": -size}


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


class PositionStopReq(BaseModel):
    market_id: int
    kind: str                        # "sl" | "tp"
    price: float | None = None       # new trigger; empty removes the order
    order_index: int | None = None   # the position's current SL/TP, if it has one


@app.post("/api/position_sltp")
async def position_sltp(r: PositionStopReq):
    """Set, move or remove a position's SL/TP from the positions table."""
    if not api.signer or r.market_id not in api.markets:
        raise HTTPException(400, L("Trading non attivo", "Trading is not enabled"))
    if r.order_index is not None:
        if r.price:
            return await move_order(MoveReq(market_id=r.market_id, order_index=r.order_index, price=r.price))
        try:
            await api.cancel_order(r.market_id, r.order_index)
        except Exception as e:
            raise HTTPException(400, str(e))
        _orders_cache.pop(r.market_id, None)
        return {"ok": True}
    pos = engine._position(r.market_id)
    if not pos:
        raise HTTPException(400, L("Nessuna posizione", "No position"))
    m = api.markets[r.market_id]
    price = m.round_price(r.price or 0)
    if price <= 0:
        raise HTTPException(400, L("Prezzo non valido", "Invalid price"))
    is_sl = r.kind == "sl"
    below = is_sl == (pos["size"] > 0)  # a long's SL and a short's TP sit below the price
    mark = feed.mark(r.market_id)
    if mark and ((price >= mark) if below else (price <= mark)):
        what = L("Lo stop-loss", "The stop-loss") if is_sl else L("Il take-profit", "The take-profit")
        raise HTTPException(400, L(f"{what} deve stare {'sotto' if below else 'sopra'} il prezzo mark ({mark:g}), altrimenti scatterebbe subito",
                                   f"{what} must be {'below' if below else 'above'} the mark price ({mark:g}), or it would trigger at once"))
    try:
        # reduce-only trigger order for the position's current size
        await api.stop_order(r.market_id, pos["size"], price, "sl" if is_sl else "tp")
    except Exception as e:
        raise HTTPException(400, str(e))
    _orders_cache.pop(r.market_id, None)
    engine.note(f"{m.symbol} {r.kind.upper()} set at {price:g} from the positions table")
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


# Pages have their own addresses (lighterdeck.xyz/trade/WTI, /calendar, /account…): they all load the
# same page, which reads the path and opens that view and market.
PAGES = ("trade", "markets", "calendar", "account", "automations", "activity")


def _market_by_symbol(symbol):
    return next((m for m in api.markets.values() if m.symbol.upper() == symbol.upper()), None)


def _market_quote(m):
    """Display price and 24h change of a market, from the price feed."""
    st = feed.stats.get(m.id) or {}
    price = st.get("last") or st.get("mark")
    return (f"{price:,.{m.price_decimals}f}" if price else None), st.get("change")


def _set_meta(html, key, value):
    """Replace the content of <meta property|name="key"> in the page."""
    value = value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    return re.sub(rf'(<meta (?:property|name)="{re.escape(key)}" content=")[^"]*(")', lambda mo: mo.group(1) + value + mo.group(2), html, count=1)


@app.get("/trade/{symbol}", include_in_schema=False)
async def trade_page(symbol: str):
    """The app, with a link preview of its own for the market (title, price, change, chart image)."""
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    m = _market_by_symbol(symbol)
    if not m:
        return Response(html, media_type="text/html")
    price, change = _market_quote(m)
    title = f"{m.symbol} · LighterDeck"
    quote = ", ".join(x for x in (price, f"{change:+.2f}% in 24h" if change is not None else None) if x)
    desc = f"{m.name if m.name != m.symbol else m.symbol} · {quote}." if quote else f"{m.name} on Lighter."
    nxt = calendar.next_for(m.symbol, m.categories)
    if nxt:  # the next event that moves it, from the calendar (UTC, for readers anywhere)
        when = time.strftime("%a %d %b", time.gmtime(nxt["ts"]))
        if nxt.get("approx"):
            when += f", {nxt['when']}"
        elif nxt["ts"] % 300 == 0:  # a real release time (all-day items come with odd minutes)
            when += time.strftime(" %H:%M UTC", time.gmtime(nxt["ts"]))
        desc += f" Next: {(nxt['country'] + ' ') if nxt['country'] and not nxt.get('assets') else ''}{nxt['title']}, {when}."
    url = f"{config.SITE_URL}/trade/{m.symbol}"
    html = html.replace("<title>LighterDeck</title>", f"<title>{title}</title>", 1)
    for key, value in (("og:title", title), ("twitter:title", title), ("og:description", desc), ("twitter:description", desc),
                       ("description", desc), ("og:url", url), ("og:image", f"{config.SITE_URL}/og/{m.symbol}.png"),
                       ("twitter:image", f"{config.SITE_URL}/og/{m.symbol}.png"), ("og:image:alt", f"{m.symbol} on LighterDeck, 4h chart")):
        html = _set_meta(html, key, value)
    return Response(html, media_type="text/html")


_og_cache = {}  # symbol -> (made at, png)


@app.get("/og/{symbol}.png", include_in_schema=False)
async def og_image(symbol: str):
    """Link preview image of a market, redrawn at most every 10 minutes."""
    m = _market_by_symbol(symbol)
    if not m:
        raise HTTPException(404, "unknown market")
    hit = _og_cache.get(m.symbol)
    if not hit or time.time() - hit[0] > 600:
        try:
            bars = await api.candles(m.id, "4h", 56)
        except Exception:
            bars = []
        price, change = _market_quote(m)
        png = await asyncio.to_thread(og.card, m.symbol, m.name, price, change, bars,
                                      f"{config.SITE_URL.split('//')[-1]}/trade/{m.symbol}")
        hit = _og_cache[m.symbol] = (time.time(), png)
    return Response(hit[1], media_type="image/png", headers={"Cache-Control": "public, max-age=600"})


for _page in PAGES:
    app.add_api_route(f"/{_page}", lambda: FileResponse(FRONTEND / "index.html"), methods=["GET"], include_in_schema=False)

app.mount("/", StaticFiles(directory=FRONTEND), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, workers=1, log_level="info")
