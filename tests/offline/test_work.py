"""Chase and iceberg on the engine, with a fake Lighter: nothing leaves this process."""
import asyncio, os, sys, tempfile, time
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import engine as E

class M:
    symbol = "BTC"; size_decimals = 4; min_base = 0.0002; min_quote = 10.0
    def round_price(self, p): return round(p, 1)

class Api:
    def __init__(self):
        self.markets = {1: M()}; self.signer = object(); self.book = {}; self.done = {}; self.sent = []; self.moves = []; self.cancels = []; self.market = []; self.n = 0; self.fail = 0
    account_index = 1
    def _coi(self): self.n += 1; return self.n
    async def limit_order(self, mid, size, price, reduce_only=False, post_only=False, coi=None):
        if self.fail: self.fail -= 1; raise RuntimeError("no answer")
        self.sent.append(dict(size=size, price=price, post=post_only, coi=coi, reduce=reduce_only))
        self.book[coi] = dict(order_index=coi + 100, client_order_index=coi, remaining=abs(size), price=price)
        return coi
    async def active_orders(self, mid): return list(self.book.values())
    async def order_outcome(self, mid, coi): return self.done.get(coi)
    async def modify_order(self, mid, oi, size, price): self.moves.append(price); next(o for o in self.book.values() if o["order_index"] == oi)["price"] = price
    async def cancel_order(self, mid, oi):
        self.cancels.append(oi)
        for c, o in list(self.book.items()):
            if o["order_index"] == oi: self.done[c] = dict(status="canceled", filled=0.0); del self.book[c]
    async def market_order(self, mid, size, ref, reduce_only=False): self.market.append((size, ref))
    def end(self, coi, status, filled): del self.book[coi]; self.done[coi] = dict(status=status, filled=filled)

class Feed:
    def __init__(self): self.stats = {1: dict(bid=100.0, ask=100.5)}; self.updated_at = time.time()

ok = []
def check(name, cond, extra=""):
    ok.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
def fresh():
    api, feed = Api(), Feed()
    eng = E.Engine(api, feed, None, None, data_dir=Path(tempfile.mkdtemp()))
    eng.armed = True
    return eng, api, feed
async def step(eng, r=None):
    """One pass, as if the check interval had gone by."""
    if r is not None and r["id"] in eng.rules: r["state"]["checked"] = 0; r["state"]["moved"] = 0
    await eng.work()

async def main():
    # ---- refused with Auto off
    eng, api, feed = fresh(); eng.armed = False
    try: eng.start_working("chase", 1, 1, 1.0); check("Auto off refused", False)
    except ValueError: check("Auto off refused", True)
    r = None
    # ---- chase: follows the bid, maker only, and ends when filled
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0, cap=None)
    await step(eng, r)
    check("chase: post-only at the best bid", api.sent == [dict(size=1.0, price=100.0, post=True, coi=1, reduce=False)], api.sent)
    check("chase: the UI sees it", eng.working().get("1", {}).get("kind") == "chase", eng.working())
    feed.stats[1]["bid"] = 101.0
    await step(eng, r)
    check("chase: moves with the bid, no second order", api.moves == [101.0] and len(api.sent) == 1, (api.moves, api.sent))
    await step(eng, r)
    check("chase: no move while already there", api.moves == [101.0], api.moves)
    api.book[1]["remaining"] = 0.6
    feed.stats[1]["bid"] = 102.0
    await step(eng, r)
    check("chase: partial fill keeps going", api.moves[-1] == 102.0 and r["id"] in eng.rules, api.moves)
    api.end(1, "filled", 1.0)
    await step(eng, r)
    check("chase: filled ends it", r["id"] not in eng.rules and len(api.sent) == 1, eng.rules)
    # ---- cap
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0, cap=100.5)
    await step(eng, r); feed.stats[1]["bid"] = 103.0; await step(eng, r)
    check("chase: stops at the cap", api.moves == [100.5], api.moves)
    eng2, api2, feed2 = fresh()
    r2 = eng2.start_working("chase", 1, -1, 1.0, cap=99.0)
    await step(eng2, r2)
    check("chase sell: at the ask, sell side", api2.sent[0]["size"] == -1.0 and api2.sent[0]["price"] == 100.5, api2.sent)
    feed2.stats[1]["ask"] = 98.0; await step(eng2, r2)
    check("chase sell: stops at the cap", api2.moves == [99.0], api2.moves)
    # ---- the post-only bounced: goes again for what's left, only what's left
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0)
    await step(eng, r); api.end(1, "canceled-post-only", 0.25); await step(eng, r); await step(eng, r)
    check("chase: bounced post-only goes again for the rest", len(api.sent) == 2 and api.sent[1]["size"] == 0.75, api.sent)
    # ---- cancelled by hand ends it, nothing more goes out
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0)
    await step(eng, r); api.end(1, "canceled", 0.0); await step(eng, r); await step(eng, r)
    check("chase: cancelled by hand ends it", r["id"] not in eng.rules and len(api.sent) == 1, api.sent)
    # ---- time up
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0, until=time.time() - 1, then_market=True)
    await step(eng, r); api.book[1]["remaining"] = 1.0
    await step(eng, r); await step(eng, r)
    check("chase: time up sends the rest at market", api.cancels == [101] and api.market == [(1.0, 100.5)] and r["id"] not in eng.rules, (api.cancels, api.market))
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0, until=time.time() - 1)
    await step(eng, r); await step(eng, r); await step(eng, r)
    check("chase: time up cancels", api.cancels == [101] and not api.market and r["id"] not in eng.rules, (api.cancels, api.market))
    # ---- stale prices: nothing
    eng, api, feed = fresh(); feed.updated_at = time.time() - 60
    r = eng.start_working("chase", 1, 1, 1.0)
    await step(eng, r)
    check("chase: stale prices send nothing", not api.sent, api.sent)
    # ---- answer lost: looks for it, never sends twice
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0)
    api.fail = 1
    await step(eng, r)
    for _ in range(E.MISSING_LIMIT + 2): await step(eng, r)
    check("chase: lost answer never sends again, and stops", not api.sent and r["id"] not in eng.rules, (api.sent, eng.rules))
    # ---- disarmed: waits
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0)
    await step(eng, r); eng.armed = False; feed.stats[1]["bid"] = 110.0; await step(eng, r)
    check("chase: Auto off freezes it", not api.moves and r["id"] in eng.rules, api.moves)
    # ---- iceberg: one slice at a time, adds up exactly
    eng, api, feed = fresh()
    r = eng.start_working("iceberg", 1, -1, 1.0, price=105.0, slice_pct=10, post_only=True)
    seen_two = False
    for _ in range(60):
        await step(eng, r)
        if r["id"] not in eng.rules: break
        if len(api.book) > 1: seen_two = True
        for coi in list(api.book): api.end(coi, "filled", api.book[coi]["remaining"])
    total = sum(-s["size"] for s in api.sent)
    check("iceberg: adds up exactly", abs(total - 1.0) < 1e-9 and r["id"] not in eng.rules, (total, api.sent))
    check("iceberg: one at a time, all at its price, as sells", not seen_two and all(s["price"] == 105.0 and s["size"] < 0 and s["post"] for s in api.sent), api.sent)
    sizes = [-s["size"] for s in api.sent]
    check("iceberg: slices about 10% and not all the same", 8 <= len(sizes) <= 13 and len(set(sizes)) > 1 and all(s <= 0.2 for s in sizes), sizes)
    # ---- partly filled, then cancelled by hand: stops, counted right
    eng, api, feed = fresh()
    r = eng.start_working("iceberg", 1, 1, 1.0, price=95.0, slice_pct=25)
    await step(eng, r); first = api.sent[0]["size"]; api.end(1, "filled", first); await step(eng, r); await step(eng, r)
    n = len(api.sent); api.end(2, "canceled", 0.0); await step(eng, r); await step(eng, r)
    check("iceberg: cancelled by hand ends it", r["id"] not in eng.rules and len(api.sent) == n == 2, api.sent)
    # ---- post-only that would cross waits and retries
    eng, api, feed = fresh()
    r = eng.start_working("iceberg", 1, 1, 1.0, price=101.0, slice_pct=25, post_only=True)
    await step(eng, r); api.end(1, "canceled-post-only", 0.0); await step(eng, r); await step(eng, r)
    waited = len(api.sent) == 1 and r["id"] in eng.rules
    r["state"]["retry"] = 0; await step(eng, r)
    check("iceberg: bounced post-only waits, then retries", waited and len(api.sent) == 2, api.sent)
    # ---- a small last piece joins the last slice, never under the minimum
    eng, api, feed = fresh()
    r = eng.start_working("iceberg", 1, 1, 0.5, price=100.0, slice_pct=20)
    for _ in range(40):
        await step(eng, r)
        if r["id"] not in eng.rules: break
        for coi in list(api.book): api.end(coi, "filled", api.book[coi]["remaining"])
    check("iceberg: no slice under the exchange minimum", all(abs(s["size"]) * 100 >= 10 for s in api.sent) and abs(sum(s["size"] for s in api.sent) - 0.5) < 1e-9, api.sent)
    # ---- restart: comes back from the file and carries on
    eng, api, feed = fresh()
    r = eng.start_working("chase", 1, 1, 1.0); await step(eng, r)
    again = E.Engine(api, feed, None, None, data_dir=eng.rules_file.parent); again.armed = True
    feed.stats[1]["bid"] = 104.0
    rr = next(iter(again.rules.values())); await step(again, rr)
    check("restart: same order, moved", len(api.sent) == 1 and api.moves == [104.0], (api.sent, api.moves))
    print("ALL PASS" if all(ok) else f"{ok.count(False)} FAILED")

asyncio.run(main())
