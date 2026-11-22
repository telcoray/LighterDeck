"""The fast engine (ENGINE_FAST): the order book watch and the rules it wakes, with a fake Lighter.
Nothing leaves this process."""
import asyncio, json, os, sys, tempfile, time
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp(), ENGINE_FAST="1")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import engine as E
import feed as F

ok = []
def check(name, cond, extra=""):
    ok.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)

class WS:
    def __init__(self): self.sent = []
    async def send(self, m): self.sent.append(json.loads(m))

def snap(mid, bids, asks, nonce): return {"type": "subscribed/order_book", "channel": f"order_book:{mid}", "order_book": {"bids": bids, "asks": asks, "nonce": nonce}}
def upd(mid, bids, asks, begin, nonce): return {"type": "update/order_book", "channel": f"order_book:{mid}", "order_book": {"bids": bids, "asks": asks, "begin_nonce": begin, "nonce": nonce}}
L = lambda p, s: {"price": str(p), "size": str(s)}

class M:
    symbol = "BTC"; size_decimals = 4; min_base = 0.0002; min_quote = 10.0
    def round_price(self, p): return round(p, 1)

class Api:
    def __init__(self):
        self.markets = {1: M()}; self.signer = object(); self.orders = []; self.modifies = []; self.placed = []; self.lookups = 0
        self.entries = []; self.fail_modify = False; self.n = 0
    account_index = 1
    def _coi(self): self.n += 1; return self.n
    async def account(self): return self.acct
    async def active_orders(self, mid): self.lookups += 1; return list(self.orders)
    async def stop_order(self, mid, size, trigger, kind="sl"):
        coi = self._coi(); self.placed.append((size, trigger)); self.orders = [dict(order_index=500 + coi, client_order_index=coi, remaining=abs(size), price=trigger)]; return coi
    async def modify_stop(self, mid, oi, size, trigger):
        if self.fail_modify: raise RuntimeError("order not found")
        self.modifies.append((oi, trigger))
    async def cancel_order(self, mid, oi): self.orders = [o for o in self.orders if o["order_index"] != oi]
    async def candles(self, mid, tf, n): return [dict(time=int(time.time()) - 600 + 60 * i, high=101.0, low=99.0, close=100.0) for i in range(10)]
    async def entry(self, mid, size, kind, worst, sl, tp, slippage_pct=None): self.entries.append((size, worst))
    async def limit_order(self, mid, size, price, reduce_only=False, post_only=False, coi=None): self.orders.append(dict(order_index=900, client_order_index=coi, remaining=abs(size), price=price)); return coi
    async def modify_order(self, mid, oi, size, price): self.modifies.append((oi, price))
    async def order_outcome(self, mid, coi): return None

class Feed:
    def __init__(self): self.stats = {1: dict(mark=100.0, bid=99.9, ask=100.1)}; self.updated_at = time.time()
    def mark(self, mid): return self.stats[mid]["mark"]

class Risk:
    limits = {"slippage_bps_cap": 50}
    def quote(self, mid, side): return 100.0
    async def review(self, *a): return None

def fresh():
    api, feed, book = Api(), Feed(), F.BookWatch()
    book._subs = {1}
    eng = E.Engine(api, feed, None, Risk(), data_dir=Path(tempfile.mkdtemp()), book=book)
    eng.armed = True
    api.acct = eng.account = {"positions": [dict(market_id=1, size=1.0, entry=100.0, leverage=1)]}
    return eng, api, feed, book

async def main():
    # ---- the book watch
    book, ws, heard = F.BookWatch(), WS(), []
    book._subs = {1}; book.listen(heard.append)
    await book._on(ws, snap(1, [L(99.9, 1), L(99.8, 2)], [L(100.1, 1), L(100.2, 3)], 10))
    check("book: best bid/ask from the snapshot", book.quote(1) == (99.9, 100.1), book.quote(1))
    check("book: listener told", heard == [1], heard)
    await book._on(ws, upd(1, [], [L(100.2, 5)], 10, 11))
    check("book: no new best, nobody woken", heard == [1], heard)
    await book._on(ws, upd(1, [L(99.9, 0)], [], 11, 12))
    check("book: a level removed moves the best bid", book.quote(1) == (99.8, 100.1) and heard == [1, 1], (book.quote(1), heard))
    await book._on(ws, upd(1, [L(99.95, 1)], [], 99, 100))
    check("book: a nonce gap resubscribes and drops the quote", book.quote(1) is None and [m["type"] for m in ws.sent[-2:]] == ["unsubscribe", "subscribe"], ws.sent)
    await book._on(ws, snap(2, [L(1, 1)], [L(2, 1)], 1))
    check("book: a market not subscribed is ignored", 2 not in book.quotes)
    await book._on(ws, snap(1, [L(99.9, 1)], [L(100.1, 1)], 200))
    book.quotes[1] = (99.9, 100.1, time.time() - 5)
    check("book: a stale quote counts as none", book.quote(1) is None)
    # the best kept level by level matches a full scan, also when the best leaves and a worse one comes in one message
    import random
    rnd, rb, wsr, wrong = random.Random(7), F.BookWatch(), WS(), 0
    rb._subs = {5}
    await rb._on(wsr, snap(5, [L(100 - i * 0.1, 1) for i in range(20)], [L(100.1 + i * 0.1, 1) for i in range(20)], 0))
    for k in range(3000):
        side = rnd.choice(("bids", "asks"))
        cur = rb.books[5][side]
        lv = []
        if cur and rnd.random() < 0.5:
            lv.append(L(rnd.choice(list(cur)), 0))  # a level leaves (often the best)
            if rnd.random() < 0.5: lv.append(L(max(cur) if side == "bids" else min(cur), 0))
        base = 100 if side == "bids" else 100.1
        lv.append(L(round(base + (rnd.uniform(-3, 0) if side == "bids" else rnd.uniform(0, 3)), 1), rnd.choice((0, 1, 2))))
        await rb._on(wsr, upd(5, lv if side == "bids" else [], lv if side == "asks" else [], k, k + 1))
        bk = rb.books[5]
        if bk["bids"] and bk["asks"] and (bk["best_bids"] != max(bk["bids"]) or bk["best_asks"] != min(bk["asks"])): wrong += 1
    check("book: best kept per level matches a full scan (3000 random updates)", wrong == 0, wrong)
    book.want("a", {1, 3}); book.want("b", {3, 4})
    check("book: wanted is the union", book.wanted == {1, 3, 4}, book.wanted)
    book.want("a", ())
    check("book: an owner with nothing drops out", book.wanted == {3, 4}, book.wanted)
    ws2 = WS(); book._subs = {1, 3}
    await book._sync(ws2)
    check("book: sync subscribes and unsubscribes", {(m["type"], m["channel"]) for m in ws2.sent} == {("subscribe", "order_book/4"), ("unsubscribe", "order_book/1")} and book._subs == {3, 4}, ws2.sent)

    # ---- the price the rules follow
    eng, api, feed, book = fresh()
    book.quotes[1] = (100.4, 100.6, time.time())
    check("price: the book's mid while tight", eng._price(1) == 100.5, eng._price(1))
    book.quotes[1] = (99.0, 101.0, time.time())
    check("price: the mark when the spread is wide", eng._price(1) == 100.0, eng._price(1))
    book.quotes.pop(1)
    check("price: the mark without a book", eng._price(1) == 100.0)

    # ---- managed stop: first placement, then moves straight from the book, at most once a second
    eng, api, feed, book = fresh()
    r = eng.add_rule({"type": "managed_stop", "market_id": 1, "trail_pct": 1.0})
    check("watched: a managed stop's market", eng._watched() == {1}, eng._watched())
    book.quotes[1] = (100.9, 101.1, time.time())
    await eng.react({1}, time.time())
    check("stop: placed at best - 1%", api.placed == [(1.0, 100.0)], api.placed)
    r["state"]["sent"] = 0
    book.quotes[1] = (101.9, 102.1, time.time())
    await eng.react({1}, time.time())  # the first move looks the order up once, then knows it
    check("stop: first move looks the order up and learns its index", api.modifies == [(501, 101.0)] and r["state"].get("oi") == 501 and api.lookups == 1, (api.modifies, r["state"], api.lookups))
    r["state"]["sent"] = 0
    book.quotes[1] = (102.4, 102.6, time.time())
    await eng.react({1}, time.time())
    check("stop: next moves go straight, no look-up", api.modifies[-1] == (501, 101.5) and api.lookups == 1, (api.modifies, api.lookups))
    book.quotes[1] = (101.9, 102.1, time.time())
    book.quotes[1] = (102.9, 103.1, time.time())
    await eng.react({1}, time.time())
    check("stop: not twice within a second", len(api.modifies) == 2, api.modifies)
    r["state"]["sent"] -= 1.1
    await eng.react({1}, time.time())
    check("stop: moves again after a second, to the best so far", api.modifies[-1] == (501, 102.0), api.modifies)
    r["state"]["sent"] = 0; api.fail_modify = True
    book.quotes[1] = (104.9, 105.1, time.time())
    await eng.react({1}, time.time())
    check("stop: a failed modify forgets the order index", r["state"].get("oi") is None, r["state"])
    api.fail_modify = False
    await eng.react({1}, time.time())
    check("stop: then looks it up and moves it", api.modifies[-1] == (501, 104.0), api.modifies)
    book.quotes[1] = (100.0, 100.2, time.time())
    r["state"]["sent"] = 0
    await eng.react({1}, time.time())
    check("stop: never loosened when the price falls back", api.modifies[-1] == (501, 104.0), api.modifies)
    other = len(api.modifies)
    book.quotes[1] = (109.9, 110.1, time.time())
    await eng.react({2}, time.time())
    check("stop: another market's price doesn't touch it", len(api.modifies) == other)

    # ---- event breakout: enters on the book's price, between ticks
    eng, api, feed, book = fresh()
    api.acct = eng.account = {"positions": []}
    eng.calendar = type("C", (), {"get": lambda self, i: {"country": "USD", "title": "CPI", "ts": time.time() - 1}})()
    r = eng.add_rule({"type": "event_trade", "event_id": "x", "market_id": 1, "mode": "breakout", "size_usd": 100, "range_minutes": 15, "buffer_pct": 0.05})
    check("watched: an event trade near its time", eng._watched() == {1}, eng._watched())
    book.quotes[1] = (100.4, 100.6, time.time())
    await eng.react({1}, time.time())
    check("event: range read at the release", r["status"] == "window" and r["state"]["high"] == 101.0, r)
    await eng.react({1}, time.time())
    check("event: no entry inside the range", api.entries == [], api.entries)
    book.quotes[1] = (101.2, 101.3, time.time())
    await eng.react({1}, time.time())
    check("event: long on the breakout above the range", r["status"] == "done" and len(api.entries) == 1 and api.entries[0][0] > 0, (r["status"], api.entries))

    # ---- chase: the book's best bid
    eng, api, feed, book = fresh()
    book.quotes[1] = (99.5, 99.7, time.time())
    eng.start_working("chase", 1, 1, 0.5, cap=None)
    await eng.work()
    check("chase: at the book's best bid", api.orders and api.orders[-1]["price"] == 99.5, api.orders)

    # ---- nothing watched with Auto off
    eng, api, feed, book = fresh()
    eng.add_rule({"type": "managed_stop", "market_id": 1, "trail_pct": 1.0})
    eng.armed = False
    check("watched: nothing with Auto off", eng._watched() == set())

    # ---- the whole loop: a new best price reaches the stop within milliseconds
    eng, api, feed, book = fresh()
    r = eng.add_rule({"type": "managed_stop", "market_id": 1, "trail_pct": 1.0})
    book.quotes[1] = (100.9, 101.1, time.time())
    task = asyncio.create_task(eng.run_fast())
    await asyncio.sleep(0.4)  # first pass: account, stop placed, market watched
    await eng.react({1}, time.time())  # learns the order index
    r["state"]["sent"] = 0
    check("loop: it asked for the market's book", book._wants.get(id(eng)) == {1}, book._wants)
    t0 = time.perf_counter()
    book.quotes[1] = (101.9, 102.1, time.time())
    eng._on_quote(1)
    while not api.modifies and time.perf_counter() - t0 < 1:
        await asyncio.sleep(0.001)
    took = (time.perf_counter() - t0) * 1000
    check(f"loop: stop moved {took:.1f} ms after the price", api.modifies and api.modifies[-1] == (501, 101.0) and took < 50, (api.modifies, took))
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass
    check("loop: stopping lets go of the book", id(eng) not in book._wants and eng._on_quote not in book._listeners)

asyncio.run(main())
sys.exit(0 if all(ok) else 1)
