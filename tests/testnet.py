"""Real orders on Lighter's TESTNET, through the same code the deck trades with (backend/lighter_api.py and the
engine). No real money: it refuses to start on any address that isn't a testnet.

    python tests/testnet.py              every scenario
    python tests/testnet.py limit twap   only the ones named
    python tests/testnet.py --list       their names

It needs a testnet account with some test funds and an API key, read from data/testnet.env (git-ignored) or
from the environment:

    TESTNET_ACCOUNT_INDEX=...
    TESTNET_API_KEY_INDEX=...
    TESTNET_API_PRIVATE_KEY=...
    TESTNET_URL=https://testnet.zklighter.elliot.ai      (optional)

Orders are the smallest each market accepts. Everything on the account (orders, positions) is cancelled and
closed at the start, after each scenario and at the end; 'history' run alone only reads and touches nothing. PASS/FAIL are checks; INFO is a fact about how Lighter behaves
that the code can't decide for itself (how a leverage rounds, whether a batch is all-or-nothing).
"""
import asyncio
import math
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "data" / "testnet.env"


def read_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("TESTNET_URL", "TESTNET_ACCOUNT_INDEX", "TESTNET_API_KEY_INDEX", "TESTNET_API_PRIVATE_KEY"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = read_env()
URL = ENV.get("TESTNET_URL", "https://testnet.zklighter.elliot.ai")
if "testnet" not in URL.lower():
    sys.exit(f"Refusing to run: {URL} is not a testnet address.")

# the deck's own settings, pointed at the testnet; nothing of a real deck is read (own data folder, no real key)
for k in ("LIGHTER_ACCOUNT_INDEX", "LIGHTER_API_KEY_INDEX", "LIGHTER_API_PRIVATE_KEY", "PUBLIC_MODE", "MAX_NOTIONAL_USD", "MAX_ORDERS_PER_DAY"):
    os.environ.pop(k, None)
os.environ["LIGHTER_URL"] = URL
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="lighterdeck-testnet-")
sys.path.insert(0, str(ROOT / "backend"))

import config  # noqa: E402
import engine as engine_mod  # noqa: E402
import lighter_api  # noqa: E402

assert "testnet" in config.LIGHTER_URL.lower()

results = []  # (status, scenario, text)
current = ["setup"]


def say(status, text, detail=""):
    results.append((status, current[0], text))
    print(f"  {status:<4} {text}" + (f"  [{detail}]" if detail else ""), flush=True)


def check(text, cond, detail=""):
    say("PASS" if cond else "FAIL", text, "" if cond else str(detail))
    return bool(cond)


def info(text):
    say("INFO", text)


async def until(fn, timeout=20, every=1.0):
    """The first truthy answer of fn() within the time, else its last answer."""
    end = time.time() + timeout
    while True:
        got = await fn()
        if got or time.time() >= end:
            return got
        await asyncio.sleep(every)


class Feed:
    """The best bid and ask of the markets in use, read from the book (the deck's own feed is a websocket)."""

    def __init__(self, api):
        self.api, self.stats, self.updated_at = api, {}, 0.0

    async def refresh(self, mid):
        ob = await self.api.orderbook(mid)
        bid = ob["bids"][0][0] if ob["bids"] else None
        ask = ob["asks"][0][0] if ob["asks"] else None
        if bid and ask:
            self.stats[mid] = {"bid": bid, "ask": ask, "mark": (bid + ask) / 2, "last": (bid + ask) / 2}
            self.updated_at = time.time()
        return self.stats.get(mid)

    def mark(self, mid):
        s = self.stats.get(mid)
        return s["mark"] if s else None


class Run:
    def __init__(self):
        self.api = lighter_api.LighterAPI()
        self.feed = Feed(self.api)
        self.mids = []  # the markets used, most liquid first

    # ---------- helpers ----------
    def size(self, mid, times=1.0):
        """The smallest order the market takes, with a little room, times `times`."""
        m, price = self.api.markets[mid], self.feed.mark(mid)
        step = 10 ** -m.size_decimals
        return round(math.ceil(max(m.min_base, m.min_quote / price) * 1.25 * times / step) * step, m.size_decimals)

    async def position(self, mid):
        acc = await self.api.account()
        return next((p["size"] for p in acc["positions"] if p["market_id"] == mid), 0.0)

    async def orders(self, mid):
        return await self.api.active_orders(mid)

    async def order(self, mid, coi):
        return next((o for o in await self.orders(mid) if o["client_order_index"] == coi), None)

    async def flatten(self):
        """Nothing resting, nothing held, on every market in use."""
        try:
            if any([await self.orders(mid) for mid in self.mids]):
                await self.api.cancel_all()
                await until(lambda: self._no_orders(), 15)
            acc = await self.api.account()
            for p in acc["positions"]:
                mid = p["market_id"]
                if mid not in self.api.markets:
                    continue
                s = await self.feed.refresh(mid)
                if not s:
                    continue
                await self.api.market_order(mid, -p["size"], s["bid"] if p["size"] > 0 else s["ask"], reduce_only=True, slippage_pct=3)
            left = await until(lambda: self._flat(), 20)
            if not left:
                print("  !    could not close everything: check the testnet account", flush=True)
        except Exception as e:
            print(f"  !    cleanup: {e}", flush=True)

    async def _no_orders(self):
        return not any([await self.orders(mid) for mid in self.mids])

    async def _flat(self):
        return not (await self.api.account())["positions"]

    # ---------- start ----------
    async def start(self):
        missing = [k for k in ("TESTNET_ACCOUNT_INDEX", "TESTNET_API_KEY_INDEX", "TESTNET_API_PRIVATE_KEY") if not ENV.get(k)]
        if missing:
            sys.exit(f"Missing {', '.join(missing)}: put them in {ENV_FILE} (see the top of this file).")
        await self.api.start()
        try:
            await self.api.connect(int(ENV["TESTNET_ACCOUNT_INDEX"]), int(ENV["TESTNET_API_KEY_INDEX"]), ENV["TESTNET_API_PRIVATE_KEY"])
        except ValueError as e:
            sys.exit(f"The testnet did not accept the API key: {e}")
        acc = await self.api.account()
        print(f"Testnet {URL}\nAccount #{acc['index']}, value ${acc['total_value']:.2f}, available ${acc['available']:.2f}\n", flush=True)
        if acc["available"] < 50:
            sys.exit("The testnet account needs at least $50 of test funds available.")
        # two markets with a real book, the usual names first
        want = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"]
        ranked = sorted(self.api.markets.values(), key=lambda m: (want.index(m.symbol) if m.symbol in want else len(want), -m.volume_usd))
        for m in ranked[:12]:
            s = await self.feed.refresh(m.id)
            if s and (s["ask"] - s["bid"]) / s["mark"] < 0.01:
                self.mids.append(m.id)
            if len(self.mids) == 2:
                break
        if not self.mids:
            sys.exit("No testnet market has a usable order book right now.")
        print("Markets: " + ", ".join(self.api.markets[i].symbol for i in self.mids) + "\n", flush=True)

    # ---------- scenarios ----------
    async def account(self):
        """The account's figures, the ones the account card shows"""
        a = await self.api.account()
        check("account read, with Lighter's cross margin figures", a["cross_value"] is not None and a["initial"] is not None and a["maintenance"] is not None, a)
        check("nothing open: available is close to the value", abs(a["available"] - a["total_value"]) <= max(1.0, a["total_value"] * 0.02), (a["available"], a["total_value"]))
        fees = await self.api.fee_rates()
        check("the account's own fee rates are read", bool(fees) and "taker" in fees, fees)

    async def leverage(self):
        """Leverage with a decimal, and how a value near the maximum is stored"""
        mid = self.mids[0]
        m = self.api.markets[mid]

        async def stored():
            return ((await self.api.account())["settings"].get(mid) or {}).get("leverage")

        for lev in (3.3, 10.5):
            if m.max_leverage and lev > m.max_leverage:
                continue
            await self.api.set_leverage(mid, lev, True)
            got = await until(lambda: self._is(stored, lev), 15)
            check(f"{lev}x is stored as {lev}x", got, await stored())
        if m.max_leverage and m.max_leverage > 12:
            ask = round(m.max_leverage - 0.1, 1)
            await self.api.set_leverage(mid, ask, True)
            await asyncio.sleep(4)
            info(f"asked {ask}x (maximum {m.max_leverage}x): Lighter stores {await stored()}x")
        await self.api.set_leverage(mid, min(10, m.max_leverage or 10), True)

    async def _is(self, fn, want):
        return await fn() == want

    async def margin_mode(self):
        """Cross / isolated with nothing open, with an order resting, with a position"""
        mid = self.mids[0]
        lev = min(10, self.api.markets[mid].max_leverage or 10)

        async def cross():
            return ((await self.api.account())["settings"].get(mid) or {}).get("cross")

        await self.api.set_leverage(mid, lev, False)
        check("isolated with nothing open", await until(lambda: self._is(cross, False), 15), await cross())
        await self.api.set_leverage(mid, lev, True)
        check("back to cross", await until(lambda: self._is(cross, True), 15), await cross())
        s = await self.feed.refresh(mid)
        coi = await self.api.limit_order(mid, self.size(mid), s["bid"] * 0.97, post_only=True)
        await until(lambda: self.order(mid, coi), 15)
        try:
            await self.api.set_leverage(mid, lev, False)
            await asyncio.sleep(4)
            info(f"with an order resting, switching to isolated is accepted (now {'cross' if await cross() else 'isolated'})")
        except Exception as e:
            info(f"with an order resting, switching to isolated is refused: {e}")
        await self.flatten()
        await self.api.set_leverage(mid, lev, True)
        await until(lambda: self._is(cross, True), 15)
        await self.api.market_order(mid, self.size(mid), s["ask"], slippage_pct=2)
        await until(lambda: self.position(mid), 20)
        try:
            await self.api.set_leverage(mid, lev, False)
            await asyncio.sleep(4)
            info(f"with a position open, switching to isolated is accepted (now {'cross' if await cross() else 'isolated'}): the ticket locks it")
        except Exception as e:
            check("with a position open, switching is refused (the ticket locks the button)", True)
            info(f"Lighter's words: {e}")

    async def limit(self):
        """A limit order: placed, moved, cancelled, and how it ended"""
        mid = self.mids[0]
        m = self.api.markets[mid]
        s = await self.feed.refresh(mid)
        size = self.size(mid)
        coi = await self.api.limit_order(mid, size, s["bid"] * 0.96, post_only=True)
        o = await until(lambda: self.order(mid, coi), 15)
        if not check("post-only limit rests on the book", o, "not listed"):
            return
        check("size and side as sent", abs(o["remaining"] - size) < 1e-9 and not o["is_ask"], o)
        new = m.round_price(s["bid"] * 0.97)
        await self.api.modify_order(mid, o["order_index"], size, new)

        async def moved():
            x = await self.order(mid, coi)
            return x and abs(x["price"] - new) < 1e-9

        check("moved to the new price, same order", await until(moved, 15), await self.order(mid, coi))
        await self.api.cancel_order(mid, o["order_index"])

        async def gone():
            return not await self.order(mid, coi)

        check("cancelled", await until(gone, 15))
        out = await until(lambda: self.api.order_outcome(mid, coi), 15)
        check("its end is read back: cancelled, nothing filled", out and "cancel" in out["status"] and out["filled"] == 0, out)

    async def entry(self):
        """Market entry with SL and TP attached, the stop moved, the position closed"""
        mid = self.mids[0]
        m = self.api.markets[mid]
        s = await self.feed.refresh(mid)
        size = self.size(mid)
        sl, tp = m.round_price(s["mark"] * 0.9), m.round_price(s["mark"] * 1.1)
        await self.api.entry(mid, size, "market", m.round_price(s["ask"] * 1.01), sl=sl, tp=tp)
        pos = await until(lambda: self.position(mid), 20)
        if not check("the position opens", abs(pos - size) < 1e-9, pos):
            return

        async def protections():
            got = [o for o in await self.orders(mid) if o["trigger_price"]]
            return got if len(got) == 2 else None

        prot = await until(protections, 20)
        if check("SL and TP are on the book, reduce-only", prot and all(o["reduce_only"] and o["is_ask"] for o in prot), await self.orders(mid)):
            triggers = sorted(o["trigger_price"] for o in prot)
            check("at the prices asked", abs(triggers[0] - sl) < 1e-9 and abs(triggers[1] - tp) < 1e-9, triggers)
            stop = min(prot, key=lambda o: o["trigger_price"])
            new = m.round_price(s["mark"] * 0.92)
            await self.api.modify_stop(mid, stop["order_index"], pos, new)

            async def moved():
                return any(abs(o["trigger_price"] - new) < 1e-9 for o in await self.orders(mid))

            check("the stop moves, same order", await until(moved, 15), await self.orders(mid))
        s = await self.feed.refresh(mid)
        await self.api.market_order(mid, -pos, s["bid"], reduce_only=True, slippage_pct=2)

        async def closed():
            return not await self.position(mid)

        check("closed with a reduce-only market order", await until(closed, 20), await self.position(mid))

        async def clean():
            return not await self.orders(mid)

        if await until(clean, 20):
            check("Lighter removes the SL and TP of a closed position", True)
        else:
            info(f"SL/TP still listed 20s after the close: {[(o['type'], o['status']) for o in await self.orders(mid)]}")

    async def limit_exits(self):
        """Market entry with SL and TP as stop-limit orders (a trigger and a limit price), in the same send"""
        mid = self.mids[0]
        m = self.api.markets[mid]
        s = await self.feed.refresh(mid)
        size = self.size(mid)
        sl, tp = m.round_price(s["mark"] * 0.9), m.round_price(s["mark"] * 1.1)
        sl_lim, tp_lim = m.round_price(sl * 0.995), m.round_price(tp * 0.995)
        try:
            await self.api.entry(mid, size, "market", m.round_price(s["ask"] * 1.01), sl=sl, tp=tp,
                                 sl_limit_price=sl_lim, tp_limit_price=tp_lim)
        except Exception as e:
            return check("Lighter accepts stop-limit SL and TP attached to the entry", False, e)
        pos = await until(lambda: self.position(mid), 20)
        if not check("the position opens", abs(pos - size) < 1e-9, pos):
            return

        async def protections():
            got = [o for o in await self.orders(mid) if o["trigger_price"]]
            return got if len(got) == 2 else None

        prot = await until(protections, 20)
        if not check("SL and TP are on the book, reduce-only", prot and all(o["reduce_only"] and o["is_ask"] for o in prot), await self.orders(mid)):
            return
        info(f"listed as types {sorted(o['type'] for o in prot)}")
        by_trig = {round(o["trigger_price"], m.price_decimals): o for o in prot}
        o_sl, o_tp = by_trig.get(sl), by_trig.get(tp)
        check("the SL keeps its trigger and its limit price", o_sl and abs(o_sl["price"] - sl_lim) < 1e-9, o_sl)
        check("the TP keeps its trigger and its limit price", o_tp and abs(o_tp["price"] - tp_lim) < 1e-9, o_tp)
        check("both are limit types, not market", all("limit" in o["type"] for o in prot), [o["type"] for o in prot])
        s = await self.feed.refresh(mid)
        await self.api.market_order(mid, -pos, s["bid"], reduce_only=True, slippage_pct=2)

        async def clean():
            return not await self.position(mid) and not await self.orders(mid)

        if await until(clean, 20):
            check("closing the position takes the stop-limits away too", True)
        else:
            info(f"stop-limits still listed 20s after the close: {[(o['type'], o['status']) for o in await self.orders(mid)]}")

    async def conditional(self):
        """Conditional orders that OPEN a position (not reduce-only), market and limit"""
        mid = self.mids[0]
        m = self.api.markets[mid]
        s = await self.feed.refresh(mid)
        size = self.size(mid)
        trig = m.round_price(s["mark"] * 1.05)
        coi = await self.api.conditional_order(mid, size, True, trig, m.round_price(trig * 1.005))
        o = await until(lambda: self.order(mid, coi), 15)
        check("stop-market buy above the price waits, not reduce-only", o and abs(o["trigger_price"] - trig) < 1e-9 and not o["reduce_only"], o)
        await asyncio.sleep(1)  # the client order index is the clock
        trig2 = m.round_price(s["mark"] * 0.95)
        coi2 = await self.api.conditional_order(mid, size, False, trig2, trig2, limit=True)
        o2 = await until(lambda: self.order(mid, coi2), 15)
        check("limit buy that waits for a lower price", o2 and abs(o2["trigger_price"] - trig2) < 1e-9 and abs(o2["price"] - trig2) < 1e-9, o2)
        check("neither opened anything", not await self.position(mid))

    async def twap(self):
        """Lighter's TWAP with a price limit"""
        mid = self.mids[0]
        m = self.api.markets[mid]
        s = await self.feed.refresh(mid)
        size = self.size(mid, 6)
        coi = await self.api.twap_order(mid, size, m.round_price(s["ask"] * 1.01), 10)
        o = await until(lambda: self.order(mid, coi), 20)
        if check("the TWAP is accepted and listed", o, "not listed"):
            info(f"listed as type '{o['type']}', status '{o['status']}', remaining {o['remaining']} of {size}")
            await self.api.cancel_order(mid, o["order_index"])

            async def gone():
                return not await self.order(mid, coi)

            check("cancelled while running", await until(gone, 20))
        info(f"filled before the cancel: {await self.position(mid)}")

    async def basket(self):
        """Several markets in one batch, and what happens when one of them can't fill"""
        if len(self.mids) < 2:
            return say("SKIP", "needs two markets with a book")
        a, b = self.mids
        sa, sb = await self.feed.refresh(a), await self.feed.refresh(b)
        ma, mb = self.api.markets[a], self.api.markets[b]
        qa, qb = self.size(a), self.size(b)
        await self.api.basket_orders([(a, qa, ma.round_price(sa["ask"] * 1.01)), (b, -qb, mb.round_price(sb["bid"] * 0.99))])

        async def both():
            return abs(await self.position(a) - qa) < 1e-9 and abs(await self.position(b) + qb) < 1e-9

        check("a buy and a sell on two markets both fill", await until(both, 20), (await self.position(a), await self.position(b)))
        await self.flatten()
        sa, sb = await self.feed.refresh(a), await self.feed.refresh(b)
        try:
            # the second can't fill: a buy whose worst price is far under the market
            await self.api.basket_orders([(a, qa, ma.round_price(sa["ask"] * 1.01)), (b, qb, mb.round_price(sb["bid"] * 0.7))])
            await asyncio.sleep(6)
            pa, pb = await self.position(a), await self.position(b)
            info(f"one leg that can't fill: the other {'still fills (not all-or-nothing)' if pa else 'does not fill either'} [{ma.symbol} {pa}, {mb.symbol} {pb}]")
        except Exception as e:
            info(f"one leg that can't fill: the whole batch is refused ({e})")

    async def _engine(self):
        eng = engine_mod.Engine(self.api, self.feed, None, None, data_dir=Path(tempfile.mkdtemp(prefix="lighterdeck-testnet-")))
        eng.armed = True
        return eng

    async def _work(self, eng, mid, seconds, done):
        end = time.time() + seconds
        while time.time() < end:
            await self.feed.refresh(mid)
            await eng.work()
            if await done():
                return True
            await asyncio.sleep(1)
        return False

    async def chase(self):
        """Chase Limit on the engine: at the best bid, then ended by cancelling the order"""
        mid = self.mids[0]
        eng = await self._engine()
        size = self.size(mid)
        rule = eng.start_working("chase", mid, 1, size, cap=None)

        async def resting():
            return bool(eng.working()) and any(str(o["client_order_index"]) in eng.working() for o in await self.orders(mid))

        async def ended():
            return rule["id"] not in eng.rules

        if await self._work(eng, mid, 20, resting):
            coi = int(next(iter(eng.working())))
            o = await self.order(mid, coi)
            bid = self.feed.stats[mid]["bid"]
            check("a post-only order rests at the best bid", o and not o["is_ask"] and abs(o["price"] - bid) / bid < 0.002, (o, bid))
            await self.api.cancel_order(mid, o["order_index"])
            check("cancelling the order by hand ends the chase", await self._work(eng, mid, 45, ended), eng.rules)
            sent = len([x for x in await self.orders(mid)])
            check("and nothing else is sent", sent == 0, sent)
        elif await ended() and await self.position(mid):
            check("the chase filled at once and ended", True)
        else:
            check("the chase puts an order on the book", False, (eng.working(), rule.get("state")))

    async def iceberg(self):
        """Iceberg on the engine: one slice showing, ended by cancelling it"""
        mid = self.mids[0]
        eng = await self._engine()
        s = await self.feed.refresh(mid)
        total = self.size(mid, 4)
        rule = eng.start_working("iceberg", mid, 1, total, price=self.api.markets[mid].round_price(s["bid"] * 0.97), slice_pct=50, post_only=True)

        async def resting():
            return bool(eng.working()) and any(str(o["client_order_index"]) in eng.working() for o in await self.orders(mid))

        async def ended():
            return rule["id"] not in eng.rules

        if not check("the first slice rests on the book", await self._work(eng, mid, 20, resting), rule.get("state")):
            return
        mine = await self.orders(mid)
        check("one slice only, smaller than the whole", len(mine) == 1 and mine[0]["remaining"] < total, mine)
        await self.api.cancel_order(mid, mine[0]["order_index"])
        check("cancelling the slice by hand ends the iceberg", await self._work(eng, mid, 45, ended), eng.rules)
        check("and no further slice is sent", not await self.orders(mid), await self.orders(mid))

    async def rfq(self):
        """RFQ: asked, read back, closed"""
        mid = self.mids[0]
        try:
            r = await self.api.rfq_create(mid, True, self.size(mid))
        except Exception as e:
            return info(f"the testnet refuses the request: {e}")
        check("the request is accepted", r.get("id") is not None, r)
        got = await self.api.rfq_get(r["id"])
        check("read back: same market and side", got["market_id"] == mid and got["side"] == "buy", got)
        info(f"status '{got['status']}', {len(got['responses'])} answers")
        try:
            closed = await self.api.rfq_update(r["id"], "closed")
            check("closed by hand", closed["status"] != got["status"] or closed["status"] == "closed", closed)
        except Exception as e:
            info(f"closing by hand is refused: {e}")

    async def history(self):
        """Trades, funding history and the PnL series, and the unit of the funding rate"""
        now = int(time.time())
        trades = await self.api.trades(limit=50)
        check("trades read, with realized PnL", isinstance(trades, list) and all("pnl" in t for t in trades), trades[:1])
        info(f"{len(trades)} fills listed")
        pts = await self.api.pnl_points(now - 7 * 86400, now, "1h")
        check("PnL series read", isinstance(pts, list), pts[:1])
        paid, complete = await self.api.funding_paid(now - 30 * 86400)
        check("funding per market read", isinstance(paid, dict), paid)
        rows = await self.api.funding_history()
        check("funding history read", isinstance(rows, list), rows[:1])
        row = next((r for r in rows if r["size"] and r["rate"] and r["change"] and r["market_id"] in self.api.markets), None)
        if not row:
            return info("no funding payment on this account yet: hold a position across a full hour, then run 'history' again to check the rate's unit")
        s = await self.feed.refresh(row["market_id"])
        if s:
            implied = abs(row["change"]) / (row["size"] * s["mark"]) * 100
            ratio = implied / abs(row["rate"])
            info(f"funding rate {row['rate']} against {implied:.6f}% worked out from the payment at today's price (ratio {ratio:.2f})")
            check("the rate is a % per hour, as the table shows it", 0.2 < ratio < 5, ratio)


SCENARIOS = ["account", "leverage", "margin_mode", "limit", "entry", "limit_exits", "conditional", "twap", "basket", "chase", "iceberg", "rfq", "history"]
READS = {"history"}  # these only read: run alone, they leave the account's orders and positions as they are


async def main(names):
    run = Run()
    await run.start()
    trades = any(n not in READS for n in names)
    if trades:
        await run.flatten()
    try:
        for name in names:
            fn = getattr(run, name)
            current[0] = name
            print(f"{name}: {fn.__doc__}", flush=True)
            try:
                await fn()
            except Exception as e:
                say("FAIL", f"stopped by an error: {type(e).__name__}: {e}")
            if trades:
                await run.flatten()
            print(flush=True)
    finally:
        if trades:
            await run.flatten()
        await run.api.close()
    count = {s: sum(1 for r in results if r[0] == s) for s in ("PASS", "FAIL", "INFO", "SKIP")}
    print(f"{count['PASS']} passed, {count['FAIL']} failed, {count['INFO']} notes" + (f", {count['SKIP']} skipped" if count["SKIP"] else ""))
    for status, scenario, text in results:
        if status in ("FAIL", "INFO"):
            print(f"  {status} {scenario}: {text}")
    return 1 if count["FAIL"] else 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--list" in sys.argv:
        run = Run()
        for n in SCENARIOS:
            print(f"{n:<12} {getattr(run, n).__doc__}")
        sys.exit(0)
    unknown = [a for a in args if a not in SCENARIOS]
    if unknown:
        sys.exit(f"Unknown: {', '.join(unknown)}. Known: {', '.join(SCENARIOS)}")
    sys.exit(asyncio.run(main(args or SCENARIOS)))
