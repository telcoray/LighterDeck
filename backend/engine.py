"""Automation engine: managed stops (initial / breakeven / trailing) and event-driven entries.

Every rule lives in data/rules.json. The engine only sends orders while `armed` is true;
disarming is the kill switch for all automations (manual orders from the UI still work).
"""
import asyncio
import json
import logging
import time
import uuid
from collections import deque

import config

log = logging.getLogger("engine")

RULES_FILE = config.DATA_DIR / "rules.json"
STATE_FILE = config.DATA_DIR / "state.json"
TICK_SECONDS = 3
MIN_STOP_STEP_PCT = 0.05   # don't send a modify for moves smaller than this
VERIFY_EVERY = 60          # re-check that each stop order still exists
ATR_TF, ATR_LEN, ATR_TTL = "15m", 14, 300  # trailing by volatility: ATR(14) on 15m candles, refreshed every 5 min
STOP_FIELDS = ("initial_stop_pct", "breakeven_at_pct", "trail_pnl", "trail_pct", "trail_price", "trail_atr", "trail_activate_pct",
               "be_now")  # be_now: stop at breakeven right away (set when TP1 of a scaled exit fills)


class Engine:
    def __init__(self, api, feed, calendar, risk):
        self.api, self.feed, self.calendar, self.risk = api, feed, calendar, risk
        self.rules = {}
        self.armed = False
        self.account = None
        self.logs = deque(maxlen=300)
        self.log_seq = 0
        self._atr_cache = {}  # market_id -> (fetched_at, atr)
        self._load()

    # ---------- persistence ----------
    def _load(self):
        if RULES_FILE.exists():
            self.rules = {r["id"]: r for r in json.loads(RULES_FILE.read_text())}
        if STATE_FILE.exists():
            self.armed = json.loads(STATE_FILE.read_text()).get("armed", False)

    def save(self):
        RULES_FILE.write_text(json.dumps(list(self.rules.values()), indent=1))
        STATE_FILE.write_text(json.dumps({"armed": self.armed}))

    def note(self, msg, level="info", rule=None):
        if rule is not None:
            rule["note"] = msg
        self.log_seq += 1
        self.logs.append({"seq": self.log_seq, "ts": time.time(), "level": level, "msg": msg})
        getattr(log, "warning" if level == "error" else level)(msg)

    # ---------- public API used by main.py ----------
    def set_armed(self, armed):
        self.armed = bool(armed)
        self.save()
        self.note("automations ARMED" if armed else "automations DISARMED (kill switch)", "warning")

    def add_rule(self, rule):
        rule = dict(rule)
        rule["id"] = uuid.uuid4().hex[:8]
        rule.setdefault("enabled", True)
        rule["created"] = time.time()
        rule["state"] = {}
        if rule["type"] == "event_trade":
            ev = self.calendar.get(rule["event_id"])
            if not ev:
                raise ValueError("unknown event")
            rule["event_title"] = f"{ev['country']} {ev['title']}"
            rule["event_ts"] = ev["ts"]
            rule["status"] = "waiting"
        elif rule["type"] not in ("managed_stop", "exit_plan"):
            raise ValueError("unknown rule type")
        if int(rule["market_id"]) not in self.api.markets:
            raise ValueError("unknown market")
        rule["market_id"] = int(rule["market_id"])
        self.rules[rule["id"]] = rule
        self.save()
        self.note(f"rule {rule['id']} added: {self.describe(rule)}")
        return rule

    def update_rule(self, rule_id, patch):
        r = self.rules[rule_id]
        for k, v in patch.items():
            if k not in ("id", "type", "state", "created"):
                r[k] = v
        self.save()
        return r

    def delete_rule(self, rule_id):
        self.rules.pop(rule_id, None)
        self.save()

    # ---------- one managed stop per market, set from the ticket or the position row ----------
    def market_stop(self, market_id):
        return next((r for r in self.rules.values() if r["type"] == "managed_stop" and r["market_id"] == market_id), None)

    def set_market_stop(self, market_id, fields):
        """Replace the market's managed stops with these settings (None removes them). The tracking
        state and the stop order already on Lighter carry over, so the order is modified, not doubled."""
        old = [r for r in self.rules.values() if r["type"] == "managed_stop" and r["market_id"] == market_id]
        state = next((dict(r["state"]) for r in old if r.get("state", {}).get("coi")), {})
        if fields is not None and any(r.get("be_now") for r in old):
            fields = {**fields, "be_now": True}  # a breakeven already reached by TP1 stays when the trailing changes
        for r in old:
            self.rules.pop(r["id"], None)
        if fields is None:
            self.save()
            if old:
                self.note(f"{self.api.markets[market_id].symbol} managed stop removed (the stop already placed stays on Lighter)")
            return None
        rule = self.add_rule({"type": "managed_stop", "market_id": market_id, "auto_remove": True,
                              **{k: v for k, v in fields.items() if k in STOP_FIELDS and v}})
        if state:
            state["stop"] = None  # new settings: recompute the level, keep modifying the same order
            rule["state"] = state
            self.save()
        return rule

    def market_stops(self):
        """Managed stop per market for the UI: settings plus the level currently on Lighter."""
        return {r["market_id"]: {"id": r["id"], "enabled": r.get("enabled", True), "stop": r["state"].get("stop"),
                                 "best": r["state"].get("best"), "note": r.get("note"),
                                 **{k: r[k] for k in STOP_FIELDS if r.get(k)}}
                for r in self.rules.values() if r["type"] == "managed_stop"}

    def describe(self, r):
        sym = self.api.markets[r["market_id"]].symbol
        if r["type"] == "managed_stop":
            parts = []
            if r.get("initial_stop_pct"):
                parts.append(f"SL {r['initial_stop_pct']}%")
            if r.get("breakeven_at_pct"):
                parts.append(f"BE at PnL +{r['breakeven_at_pct']}%")
            if r.get("be_now"):
                parts.append("BE after TP1")
            trail = (f"{r['trail_pnl']:g}% PnL" if r.get("trail_pnl") else f"{r['trail_pct']}%" if r.get("trail_pct") else f"${r['trail_price']:g}" if r.get("trail_price")
                     else f"{r['trail_atr']:g}x ATR" if r.get("trail_atr") else None)
            if trail:
                parts.append(f"trail {trail} from PnL +{r.get('trail_activate_pct', 0)}%")
            return f"{sym} managed stop: " + ", ".join(parts or ["(empty)"])
        if r["type"] == "exit_plan":
            return (f"{sym} scaled exits: " + ", ".join(f"TP{i + 1} {l['qty']:g} @ {l['price']:g}" for i, l in enumerate(r["levels"]))
                    + (", BE after TP1" if r.get("be_after_tp1") else ""))
        return f"{sym} {r['mode']} on {r['event_title']} ${r['size_usd']}"

    # ---------- main loop ----------
    async def run(self):
        while True:
            try:
                await self.tick()
            except Exception as e:
                self.note(f"engine tick error: {e}", "error")
            await asyncio.sleep(TICK_SECONDS)

    async def tick(self):
        if config.ACCOUNT_INDEX is not None:
            try:
                self.account = await self.api.account()
            except Exception as e:
                self.note(f"account fetch failed: {e}", "error")
                return
        if not self.armed or not self.api.signer:
            return
        changed = False
        for r in list(self.rules.values()):
            if not r.get("enabled"):
                continue
            try:
                if r["type"] == "managed_stop":
                    changed |= await self._managed_stop(r)
                elif r["type"] == "exit_plan":
                    changed |= await self._exit_plan(r)
                else:
                    changed |= await self._event_trade(r)
            except Exception as e:
                self.note(f"rule {r['id']}: {e}", "error", r)
                changed = True
        if changed:
            self.save()

    def _position(self, market_id):
        for p in (self.account or {}).get("positions", []):
            if p["market_id"] == market_id:
                return p
        return None

    # ---------- managed stop ----------
    async def _atr(self, market_id):
        at, value = self._atr_cache.get(market_id, (0, None))
        if time.time() - at < ATR_TTL and value:
            return value
        bars = (await self.api.candles(market_id, ATR_TF, ATR_LEN + 2))[-(ATR_LEN + 1):]
        ranges = [max(b["high"], a["close"]) - min(b["low"], a["close"]) for a, b in zip(bars, bars[1:])]
        if not ranges:
            raise RuntimeError("no candles for ATR")
        value = sum(ranges) / len(ranges)
        self._atr_cache[market_id] = (time.time(), value)
        return value

    async def _trail_distance(self, r, best, leverage=1):
        """Price distance the trailing stop keeps from the best price: a PnL % (on margin), a price %,
        a fixed amount or N x ATR."""
        if r.get("trail_pnl"):
            return best * r["trail_pnl"] / 100 / (leverage or 1)
        if r.get("trail_pct"):
            return best * r["trail_pct"] / 100
        if r.get("trail_price"):
            return r["trail_price"]
        if r.get("trail_atr"):
            return r["trail_atr"] * await self._atr(r["market_id"])
        return None

    async def _managed_stop(self, r):
        st = r["state"]
        mid = r["market_id"]
        pos = self._position(mid)
        mark = self.feed.mark(mid)
        if not pos or not mark:
            if st.get("size"):
                self.note(f"{self.describe(r)}: position closed", rule=r)
                r["state"] = {}
                if r.get("auto_remove"):
                    self.rules.pop(r["id"], None)
                return True
            return False

        side = 1 if pos["size"] > 0 else -1
        entry = pos["entry"]
        if st.get("side") != side or st.get("entry") != entry:
            # new position (or flipped): restart tracking, keep the old order to be re-used/modified
            st.update({"side": side, "entry": entry, "best": mark, "stop": None})
        st["best"] = max(st["best"], mark) if side > 0 else min(st["best"], mark)
        # activation and breakeven are PnL % on margin, as the positions table shows it: price move x leverage
        best_profit = (st["best"] - entry) / entry * 100 * side * (pos.get("leverage") or 1)

        candidates = []
        if r.get("initial_stop_pct"):
            candidates.append(entry * (1 - side * r["initial_stop_pct"] / 100))
        if r.get("be_now") or (r.get("breakeven_at_pct") and best_profit >= r["breakeven_at_pct"]):
            candidates.append(entry * (1 + side * r.get("breakeven_offset_pct", 0.05) / 100))
        if best_profit >= r.get("trail_activate_pct", 0):
            dist = await self._trail_distance(r, st["best"], pos.get("leverage") or 1)
            if dist:
                candidates.append(st["best"] - side * dist)
        if not candidates:
            return False
        desired = max(candidates) if side > 0 else min(candidates)
        if st.get("stop") is not None:  # never loosen
            desired = max(desired, st["stop"]) if side > 0 else min(desired, st["stop"])
        desired = self.api.markets[mid].round_price(desired)

        size_changed = st.get("size") != pos["size"]
        moved = st.get("stop") is None or abs(desired - st["stop"]) / st["stop"] * 100 >= MIN_STOP_STEP_PCT
        due_check = time.time() - st.get("checked", 0) > VERIFY_EVERY
        if not (size_changed or moved or due_check):
            return False

        order = None
        if st.get("coi"):
            orders = await self.api.active_orders(mid)
            order = next((o for o in orders if o["client_order_index"] == st["coi"]), None)
        st["checked"] = time.time()

        if order and not size_changed:
            if moved:
                await self.api.modify_stop(mid, order["order_index"], pos["size"], desired)
                self.note(f"{self.api.markets[mid].symbol} stop -> {desired} (best {st['best']})", rule=r)
        else:
            if order:
                await self.api.cancel_order(mid, order["order_index"])
            st["coi"] = await self.api.stop_order(mid, pos["size"], desired, "sl")
            self.note(f"{self.api.markets[mid].symbol} stop placed @ {desired} for {pos['size']}", rule=r)
        st["stop"] = desired
        st["size"] = pos["size"]
        return True

    # ---------- scaled exits: TP1, TP2... each a reduce-only order for part of the position ----------
    def set_exit_plan(self, market_id, levels, be_after_tp1, before=0.0, size=0.0):
        """One plan per market. levels: [{price, qty}]; before: signed position when the order was sent;
        size: the order's signed size. The TP orders go out once the order has filled."""
        for r in [r for r in self.rules.values() if r["type"] == "exit_plan" and r["market_id"] == market_id]:
            self.rules.pop(r["id"], None)
        if not levels:
            self.save()
            return None
        rule = self.add_rule({"type": "exit_plan", "market_id": market_id, "levels": [dict(l) for l in levels],
                              "be_after_tp1": bool(be_after_tp1), "before": before, "size": size})
        return rule

    def exit_plans(self):
        """Scaled exits per market for the UI: each level and whether it has filled."""
        return {r["market_id"]: {"levels": [{"price": l["price"], "qty": l["qty"], "done": bool(l.get("done"))} for l in r["levels"]],
                                 "be_after_tp1": r.get("be_after_tp1", False), "placed": bool(r["state"].get("placed"))}
                for r in self.rules.values() if r["type"] == "exit_plan"}

    async def place_exits(self, r, pos_size):
        """Send the take-profit order of every level not placed yet; pos_size is the signed position."""
        mid, sign = r["market_id"], (1 if pos_size > 0 else -1)
        sym = self.api.markets[mid].symbol
        for i, l in enumerate(r["levels"]):
            if l.get("coi"):
                continue
            l["coi"] = await self.api.stop_order(mid, sign * l["qty"], l["price"], "tp")
            self.note(f"{sym} TP{i + 1} placed @ {l['price']:g} for {l['qty']:g}", rule=r)
        if not r["state"].get("placed"):
            r["state"].update({"placed": True, "side": sign, "start": abs(pos_size), "size": abs(pos_size), "checked": time.time()})

    def _breakeven_now(self, market_id):
        r = self.market_stop(market_id)
        if r:
            r["be_now"] = True
            r["state"]["checked"] = 0
        else:
            self.add_rule({"type": "managed_stop", "market_id": market_id, "auto_remove": True, "be_now": True})
        self.note(f"{self.api.markets[market_id].symbol} TP1 filled: stop to breakeven", "warning")

    async def _exit_plan(self, r):
        st, mid = r["state"], r["market_id"]
        pos = self._position(mid)
        now = time.time()
        if not st.get("placed"):
            # waiting for the entry to fill (a limit): the position has to grow by the whole order
            held = pos["size"] if pos else 0.0
            if r.get("size") and (held - r.get("before", 0)) * (1 if r["size"] > 0 else -1) >= abs(r["size"]) * 0.999:
                await self.place_exits(r, held)
                return True
            if now - st.get("checked", 0) < VERIFY_EVERY:
                return False
            st["checked"] = now
            side_ask = r.get("size", 0) < 0
            if not any(not o["reduce_only"] and o["is_ask"] == side_ask for o in await self.api.active_orders(mid)):
                self.note(f"{self.describe(r)}: the entry order is gone, plan removed", rule=r)
                self.rules.pop(r["id"], None)
                return True
            return False

        if not pos or (1 if pos["size"] > 0 else -1) != st["side"]:
            # position closed or flipped: the take-profits left over go with it
            for l in r["levels"]:
                if l.get("coi") and not l.get("done"):
                    try:
                        order = next((o for o in await self.api.active_orders(mid) if o["client_order_index"] == l["coi"]), None)
                        if order:
                            await self.api.cancel_order(mid, order["order_index"])
                    except Exception as e:
                        log.info("exit plan: TP not cancelled: %s", e)
            self.note(f"{self.describe(r)}: position closed", rule=r)
            self.rules.pop(r["id"], None)
            return True

        if any(not l.get("coi") for l in r["levels"]):  # a take-profit that failed to go out at entry
            await self.place_exits(r, pos["size"])
            return True
        size = abs(pos["size"])
        if size == st.get("size") and now - st.get("checked", 0) < VERIFY_EVERY:
            return False
        st["size"], st["checked"] = size, now
        active = {o["client_order_index"] for o in await self.api.active_orders(mid)}
        changed = False
        for l in r["levels"]:
            if l.get("done") or l["coi"] in active:
                continue
            l["done"] = True  # gone: filled if the position shrank, cancelled by hand otherwise
            l["filled"] = size < st["start"] - 1e-12
            changed = True
        first = r["levels"][0]
        if r.get("be_after_tp1") and first.get("filled") and not st.get("be_done"):
            st["be_done"] = True
            self._breakeven_now(mid)
            changed = True
        return changed

    # ---------- event trade ----------
    async def _event_trade(self, r):
        if r["status"] not in ("waiting", "window"):
            return False
        now = time.time()
        ts = r["event_ts"]
        mid = r["market_id"]
        m = self.api.markets[mid]
        mark = self.feed.mark(mid)

        if r["mode"] in ("long", "short"):
            if now < ts + r.get("delay_s", 0):
                return False
            if now > ts + r.get("delay_s", 0) + 120:
                r["status"] = "expired"
                self.note(f"{self.describe(r)}: missed entry window", "warning", r)
                return True
            return await self._enter(r, 1 if r["mode"] == "long" else -1, mark)

        # breakout: range of the last N minutes before the event, then wait for a break
        if now < ts:
            return False
        st = r["state"]
        if "high" not in st:
            minutes = int(r.get("range_minutes", 15))
            candles = await self.api.candles(mid, "1m", minutes + 5)
            pre = [c for c in candles if ts - minutes * 60 <= c["time"] < ts]
            if not pre:
                raise RuntimeError("no candles for pre-event range")
            st["high"] = max(c["high"] for c in pre)
            st["low"] = min(c["low"] for c in pre)
            r["status"] = "window"
            self.note(f"{m.symbol} pre-event range {st['low']} - {st['high']}", rule=r)
            return True
        if now > ts + r.get("window_minutes", 30) * 60:
            r["status"] = "expired"
            self.note(f"{self.describe(r)}: no breakout, expired", rule=r)
            return True
        buf = r.get("buffer_pct", 0.05) / 100
        if mark > st["high"] * (1 + buf):
            return await self._enter(r, 1, mark)
        if mark < st["low"] * (1 - buf):
            return await self._enter(r, -1, mark)
        return False

    async def _enter(self, r, side, mark):
        mid = r["market_id"]
        m = self.api.markets[mid]
        if self._position(mid):
            r["status"] = "skipped"
            self.note(f"{self.describe(r)}: position already open, skipped", "warning", r)
            return True
        try:
            ref = self.risk.quote(mid, side)
            size = round(r["size_usd"] / ref, m.size_decimals)
            sl = m.round_price(ref * (1 - side * r["stop_pct"] / 100)) if r.get("stop_pct") else None
            tp = m.round_price(ref * (1 + side * r["tp_pct"] / 100)) if r.get("tp_pct") else None
            await self.risk.review(self.account, mid, side, size, ref, sl, tp)
        except ValueError as e:  # risk.Blocked: refused by the risk guard, never retried
            r["status"] = "blocked"
            self.note(f"{self.describe(r)}: blocked by risk check: {e}", "error", r)
            return True
        r["status"] = "done"  # set before sending: never fire twice
        self.save()
        slip = self.risk.limits["slippage_bps_cap"] / 10000
        worst = m.round_price(ref * (1 + side * slip))
        await self.api.entry(mid, size * side, "market", worst, sl, tp, slippage_pct=slip * 100)
        self.note(f"{m.symbol} {'LONG' if side > 0 else 'SHORT'} {size} @ ~{ref} ({r['event_title']})"
                  + (f" SL {sl}" if sl else "") + (f" TP {tp}" if tp else ""), "warning", r)

        # the native SL protects the position; trailing / breakeven tighten it from here
        if r.get("trail_pct") or r.get("breakeven_at_pct"):
            self.add_rule({
                "type": "managed_stop", "market_id": mid, "auto_remove": True,
                "trail_pct": r.get("trail_pct"), "trail_activate_pct": r.get("trail_activate_pct", 0),
                "breakeven_at_pct": r.get("breakeven_at_pct"),
            })
        return True
