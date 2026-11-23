"""The Go engine (engine/, ldengine) driven by the Python server as the site drives it, against a fake Lighter on
localhost (REST and websocket): nothing leaves this machine. Needs engine/bin/ldengine, built with
`go build -o bin/ldengine ./cmd/ldengine` in engine/ (skipped without it).

It checks the whole path: the Python server starts ldengine and sends it the deck's key; a managed stop set from
the site is placed on the fake Lighter; a new best bid on the fake order book moves it (and how many milliseconds
that takes); a chase goes out post-only; the mirror the site reads follows; ldengine killed is started again
with its key and its rules; a visitor's engine starts and stops."""
import asyncio, json, os, sys, tempfile, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(ROOT / "backend"))
from aiohttp import web, WSMsgType
import config
import engine_go

ok = []
def check(name, cond, extra=""):
    ok.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)

if not engine_go.DEFAULT_BIN.exists():
    print("SKIP: build engine/bin/ldengine first"); sys.exit(0)


class FakeLighter:
    """BTC (market 1, price decimals 1, size decimals 5); account 123456 long 0.01 BTC at 100,000."""

    def __init__(self):
        self.txs = []          # (time received, decoded tx_info)
        self.orders = {}       # coi -> order as accountActiveOrders lists it
        self.nonce = 0
        self.ws = set()
        self.book_nonce = 1
        self.bid, self.ask = 100000.0, 100000.5
        self.loop = None

    def app(self):
        a = web.Application()
        a.router.add_get("/api/v1/orderBookDetails", lambda r: web.json_response({"code": 200, "order_book_details": [
            {"market_id": 1, "symbol": "BTC", "market_type": "perp", "status": "active", "size_decimals": 5, "price_decimals": 1,
             "min_base_amount": "0.00020", "min_quote_amount": "10", "default_initial_margin_fraction": 500}]}))
        a.router.add_get("/api/v1/nextNonce", self.next_nonce)
        a.router.add_post("/api/v1/sendTx", self.send_tx)
        a.router.add_get("/api/v1/account", lambda r: web.json_response({"code": 200, "accounts": [{
            "collateral": "1000", "available_balance": "900", "total_asset_value": "1000", "cross_asset_value": "1000",
            "positions": [{"market_id": 1, "symbol": "BTC", "position": "0.01000", "sign": 1, "initial_margin_fraction": "20",
                           "margin_mode": 0, "avg_entry_price": "100000.0", "position_value": "1000", "unrealized_pnl": "0",
                           "realized_pnl": "0", "liquidation_price": "0", "allocated_margin": "0"}]}]}))
        a.router.add_get("/api/v1/accountLimits", lambda r: web.json_response({"code": 200, "current_taker_fee_tick": 280, "current_maker_fee_tick": 40}))
        a.router.add_get("/api/v1/accountActiveOrders", lambda r: web.json_response({"code": 200, "orders": list(self.orders.values())}))
        a.router.add_get("/api/v1/accountInactiveOrders", lambda r: web.json_response({"code": 200, "orders": []}))
        a.router.add_get("/stream", self.stream)
        return a

    async def next_nonce(self, r):
        self.nonce += 1
        return web.json_response({"code": 200, "nonce": self.nonce})

    async def send_tx(self, r):
        form = await r.post()
        tx = json.loads(form["tx_info"])
        self.txs.append((time.perf_counter(), tx))
        if "ClientOrderIndex" in tx:  # a new order rests on the book
            self.orders[tx["ClientOrderIndex"]] = {
                "order_index": 9000 + len(self.orders), "client_order_index": tx["ClientOrderIndex"], "market_index": 1,
                "is_ask": bool(tx["IsAsk"]), "type": "stop-loss" if tx["Type"] == 2 else "limit", "price": str(tx["Price"] / 10),
                "trigger_price": str(tx["TriggerPrice"] / 10), "remaining_base_amount": str(tx["BaseAmount"] / 1e5),
                "reduce_only": bool(tx["ReduceOnly"]), "status": "open"}
        return web.json_response({"code": 200, "tx_hash": "0x%x" % len(self.txs)})

    async def stream(self, r):
        ws = web.WebSocketResponse(heartbeat=None)
        await ws.prepare(r)
        self.ws.add(ws)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                m = json.loads(msg.data)
                if m.get("type") == "subscribe" and m["channel"] == "market_stats/all":
                    await ws.send_json({"type": "subscribed/market_stats", "channel": "market_stats:all", "market_stats": {"1": self.stats()}})
                    asyncio.ensure_future(self.stats_loop(ws))
                elif m.get("type") == "subscribe" and m["channel"] == "order_book/1":
                    self.book_nonce += 1
                    await ws.send_json({"type": "subscribed/order_book", "channel": "order_book:1", "order_book": {
                        "bids": [{"price": str(self.bid), "size": "1"}, {"price": str(self.bid - 1), "size": "2"}],
                        "asks": [{"price": str(self.ask), "size": "1"}], "nonce": self.book_nonce}})
        finally:
            self.ws.discard(ws)
        return ws

    def stats(self):
        return {"market_id": 1, "mark_price": str((self.bid + self.ask) / 2), "best_bid_price": str(self.bid), "best_ask_price": str(self.ask)}

    async def stats_loop(self, ws):
        while not ws.closed:
            await asyncio.sleep(0.3)
            try:
                await ws.send_json({"type": "update/market_stats", "channel": "market_stats:all", "market_stats": {"1": self.stats()}})
            except Exception:
                return

    async def _move(self, bid, ask):
        old_bid, old_ask = self.bid, self.ask
        self.bid, self.ask = bid, ask
        begin, self.book_nonce = self.book_nonce, self.book_nonce + 1
        t0 = time.perf_counter()
        for ws in list(self.ws):
            try:
                await ws.send_json({"type": "update/order_book", "channel": "order_book:1", "order_book": {
                    "bids": [{"price": str(old_bid), "size": "0"}, {"price": str(bid), "size": "1"}],
                    "asks": [{"price": str(old_ask), "size": "0"}, {"price": str(ask), "size": "1"}], "begin_nonce": begin, "nonce": self.book_nonce}})
            except Exception:
                pass
        return t0

    def move(self, bid, ask):
        """A new best bid and ask on the book; returns when it was sent."""
        return asyncio.run_coroutine_threadsafe(self._move(bid, ask), self.loop).result()


def serve(fake):
    """The fake Lighter in its own thread, so the test's blocking calls never hold it up."""
    ready = threading.Event()
    port = []

    def run():
        loop = asyncio.new_event_loop()
        fake.loop = loop
        runner = web.AppRunner(fake.app())
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, "127.0.0.1", 0)
        loop.run_until_complete(site.start())
        port.append(site._server.sockets[0].getsockname()[1])
        ready.set()
        loop.run_forever()

    threading.Thread(target=run, daemon=True).start()
    ready.wait(10)
    return port[0]


class Markets:
    markets = {1: object()}


class Calendar:
    def get(self, event_id):
        return {"country": "USD", "title": "CPI", "ts": time.time() + 3600} if event_id == "cpi" else None


async def wait_for(cond, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        await asyncio.sleep(0.01)
    return False


async def main():
    from lighter.signer_client import create_api_key
    fake = FakeLighter()
    port = serve(fake)
    config.LIGHTER_URL = f"http://127.0.0.1:{port}"
    host = engine_go.GoHost(Markets(), Calendar())
    await host.start()
    eng = host.deck
    try:
        key, _, _ = create_api_key()  # a throwaway key: the fake Lighter is the only place it goes
        host.set_deck_key(123456, 3, key)
        check("account mirrored from ldengine", await wait_for(lambda: eng.account and eng.account["positions"]), eng.account)
        check("settings keyed by market id", eng.account and 1 in eng.account["settings"], eng.account)
        eng.set_armed(True)
        check("armed", eng.armed)

        # ---- a managed stop from the ticket: placed on Lighter, 1% under the book
        rule = eng.set_market_stop(1, {"trail_pct": 1.0, "initial_stop_pct": 0})
        check("stop rule mirrored with its description", rule["id"] in eng.rules and "trail 1%" in eng.describe(rule), eng.rules)
        check("stop placed", await wait_for(lambda: any(tx.get("Type") == 2 for _, tx in fake.txs)), fake.txs)
        stop = next(tx for _, tx in fake.txs if tx.get("Type") == 2)
        mid = (100000.0 + 100000.5) / 2
        check("stop at the book's mid - 1%, reduce-only sell", stop["TriggerPrice"] == round(mid * 0.99 * 10) and stop["IsAsk"] == 1 and stop["ReduceOnly"] == 1 and stop["BaseAmount"] == 1000, stop)
        check("market_stops for the site", eng.market_stops().get(1, {}).get("trail_pct") == 1.0, eng.market_stops())
        await asyncio.sleep(1.2)  # the next pass learns the stop's order index; a stop moves at most once a second

        # ---- the price moves: the stop follows from the order book within milliseconds
        times = []
        for i, bid in enumerate((100500.0, 101000.0, 101500.0)):
            n = len(fake.txs)
            t0 = fake.move(bid, bid + 0.5)
            moved = await wait_for(lambda: any("Index" in tx and "ClientOrderIndex" not in tx for _, tx in fake.txs[n:]), 3)
            if moved:
                t1, tx = next((t, tx) for t, tx in fake.txs[n:] if "Index" in tx and "ClientOrderIndex" not in tx)
                times.append((t1 - t0) * 1000)
                check(f"move {i + 1}: modify to the new mid - 1%", tx["TriggerPrice"] == round((bid + 0.25) * 0.99 * 10), tx)
            else:
                check(f"move {i + 1}: stop modified", False, fake.txs[n:])
            await asyncio.sleep(1.1)
        if times:
            print(f"    book update -> modify received by Lighter: {', '.join(f'{t:.1f}' for t in times)} ms (nonce asked, signed, sent)")
        check("logs mirrored", any("stop ->" in l["msg"] for l in eng.logs), eng.logs[-5:])

        # ---- a chase from the ticket: post-only at the best bid
        n = len(fake.txs)
        eng.start_working("chase", 1, 1, 0.001, cap=None, until=None)
        check("chase sent post-only at the best bid", await wait_for(lambda: any(tx.get("TimeInForce") == 2 for _, tx in fake.txs[n:])), fake.txs[n:])
        ch = next(tx for _, tx in fake.txs[n:] if tx.get("TimeInForce") == 2)
        check("chase price and size", ch["Price"] == round(fake.bid * 10) and ch["BaseAmount"] == 100 and ch["IsAsk"] == 0, ch)
        # the mirror follows within milliseconds (the long poll answers at each change)
        check("working() for the site", await wait_for(lambda: any(w["kind"] == "chase" for w in eng.working().values()), 2), eng.working())

        # ---- rules from the automations page
        r = eng.add_rule({"type": "event_trade", "event_id": "cpi", "market_id": 1, "mode": "long", "size_usd": 50})
        check("event trade gets the calendar's title", r["event_title"] == "USD CPI" and r["status"] == "waiting", r)
        try:
            eng.add_rule({"type": "event_trade", "event_id": "nope", "market_id": 1, "mode": "long", "size_usd": 50})
            check("unknown event refused", False)
        except ValueError:
            check("unknown event refused", True)
        try:
            eng.add_rule({"type": "managed_stop", "market_id": 99})
            check("unknown market refused (400 -> ValueError)", False)
        except ValueError:
            check("unknown market refused (400 -> ValueError)", True)
        p = eng.update_rule(r["id"], {"enabled": False})
        check("patch", p["enabled"] is False and eng.rules[r["id"]]["enabled"] is False, p)
        eng.delete_rule(r["id"])
        check("delete", r["id"] not in eng.rules)
        eng.note("manual order from the site", "warning")
        check("a note from the site in the engine's log", eng.logs[-1]["msg"] == "manual order from the site")

        # ---- ldengine stops: started again with its key and its rules
        before = set(eng.rules)
        old = host.proc
        old.kill()
        back = await wait_for(lambda: host.proc is not old and host.addr is not None, 20)
        await asyncio.sleep(0.5)
        check("ldengine started again", back)
        st = await asyncio.to_thread(host.call, "GET", "/v1/state?since=-1")
        deck = st["engines"]["deck"]
        check("its key sent again, rules and Auto from the files", deck["has_key"] and deck["armed"] and {x["id"] for x in deck["rules"]} == before, deck)

        # ---- a visitor's engine
        vkey, _, _ = create_api_key()
        v = await host.start_user(777, 5, vkey, Path(os.environ["DATA_DIR"]) / "users" / "777")
        check("visitor engine mirrored", "777" in host.engines and v.api.api_key_index == 5)
        v.set_armed(True)
        check("visitor armed, deck unaffected", v.armed and host.deck.armed)
        await host.stop_user(777)
        st = await asyncio.to_thread(host.call, "GET", "/v1/state?since=-1")
        check("visitor engine stopped", "777" not in st["engines"], list(st["engines"]))
    finally:
        await host.close()
    check("ldengine stopped with the server", host.proc.returncode is not None)
    print("ALL PASS" if all(ok) else f"{ok.count(False)} FAILED")

asyncio.run(main())
sys.exit(0 if all(ok) else 1)
