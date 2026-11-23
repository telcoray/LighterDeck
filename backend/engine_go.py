"""The order engine in Go (engine/, the ldengine binary), used instead of engine.py when ENGINE_GO=1.

This server starts ldengine, gives it a token made up at each start, sends it the keys (the deck's own and the
visitors' automation keys, decrypted here as before) and restarts it if it stops. ldengine runs every
automation: managed stops, scaled exits, chase and iceberg, event trades, Lighter's order book feed and the
signing of the orders it sends.

GoEngine stands in for engine.Engine with the same methods, so main.py and users.py use either one the same way.
What the site reads (armed, account, rules, logs) is a mirror kept current by a long poll on ldengine's
/v1/state; every change answers with the engine's new state too, so the mirror is current at once. The calls
that change something are short local HTTP requests (under a millisecond on the same machine).
"""
import asyncio
import http.client
import json
import logging
import os
import secrets
import sys
from pathlib import Path

import config
from i18n import lang

log = logging.getLogger("engine_go")

ENGINE_DIR = Path(__file__).resolve().parent.parent / "engine"
DEFAULT_BIN = ENGINE_DIR / "bin" / ("ldengine.exe" if sys.platform == "win32" else "ldengine")
RESTART_AFTER = 2.0


class EngineDown(RuntimeError):
    """ldengine isn't answering (starting, restarting)."""


class GoHost:
    def __init__(self, api, calendar, binary=None):
        self.api, self.calendar = api, calendar
        self.binary = Path(binary or config.ENGINE_GO_BIN or DEFAULT_BIN)
        self.token = secrets.token_hex(24)
        self.addr = None  # (host, port) once ldengine has said where it listens
        self.proc = None
        self.version = 0
        self.engines = {}  # "deck" or account number (str) -> GoEngine
        self.deck = GoEngine(self, "deck", api, calendar)
        self.engines["deck"] = self.deck
        self._deck_key = None   # (account, key index, private key), sent again after a restart
        self._user_keys = {}    # account -> (key index, private key, folder)
        self._tasks = []
        self._closing = False

    # ---------- the process ----------
    async def start(self):
        if not self.binary.exists():
            raise RuntimeError(f"ENGINE_GO=1 but {self.binary} is missing: build it with `go build -o bin/ldengine ./cmd/ldengine` in engine/")
        await self._spawn()
        self._tasks += [asyncio.create_task(self._supervise()), asyncio.create_task(self._mirror())]

    async def _spawn(self):
        env = {**os.environ, "ENGINE_TOKEN": self.token, "ENGINE_STDIN_WATCH": "1", "DATA_DIR": str(config.DATA_DIR),
               "LIGHTER_URL": config.LIGHTER_URL, "MAX_SLIPPAGE_PCT": str(config.MAX_SLIPPAGE_PCT),
               "MAX_NOTIONAL_USD": str(config.MAX_NOTIONAL_USD or 0), "MAX_ORDERS_PER_DAY": str(config.MAX_ORDERS_PER_DAY or 0)}
        env.pop("LIGHTER_API_PRIVATE_KEY", None)  # keys go over the local connection, never in its environment
        self.proc = await asyncio.create_subprocess_exec(
            str(self.binary), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env, cwd=str(ENGINE_DIR))
        self._tasks.append(asyncio.create_task(self._relay(self.proc.stderr)))
        # it loads the markets first: on a slow start Lighter may take a while
        line = await asyncio.wait_for(self.proc.stdout.readline(), 120)
        text = line.decode().strip()
        if not text.startswith("LISTEN "):
            raise RuntimeError(f"ldengine didn't start: {text!r}")
        host, port = text.split(" ", 1)[1].rsplit(":", 1)
        self.addr = (host, int(port))
        log.info("ldengine listening on %s:%s", host, port)
        await self._resend_keys()

    async def _relay(self, stream):
        """ldengine's log lines into this server's log."""
        while True:
            line = await stream.readline()
            if not line:
                return
            log.info("%s", line.decode(errors="replace").rstrip())

    async def _supervise(self):
        while not self._closing:
            code = await self.proc.wait()
            if self._closing:
                return
            self.addr = None
            log.error("ldengine stopped (exit %s): starting it again", code)
            await asyncio.sleep(RESTART_AFTER)
            try:
                await self._spawn()
            except Exception as e:
                log.error("ldengine not started: %s", e)
                await asyncio.sleep(10)

    async def _resend_keys(self):
        if self._deck_key:
            await asyncio.to_thread(self.call, "POST", "/v1/deck/key", dict(zip(("account_index", "api_key_index", "private_key"), self._deck_key)))
        for account, (key_index, key, folder) in list(self._user_keys.items()):
            try:
                await asyncio.to_thread(self.call, "POST", f"/v1/users/{account}/start", {"api_key_index": key_index, "private_key": key, "dir": folder})
            except Exception as e:
                log.warning("#%s automations not restarted in ldengine: %s", account, e)

    async def close(self):
        self._closing = True
        for t in self._tasks:
            t.cancel()
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.close()  # it stops when its input closes
                await asyncio.wait_for(self.proc.wait(), 5)
            except Exception:
                self.proc.kill()

    # ---------- calls ----------
    def call(self, method, path, body=None, timeout=15):
        """One request to ldengine; ValueError for a request it refuses (400), EngineDown when it isn't there."""
        if not self.addr:
            raise EngineDown("the order engine is starting, try again in a moment")
        conn = http.client.HTTPConnection(*self.addr, timeout=timeout)
        try:
            conn.request(method, path, body=json.dumps(body) if body is not None else None,
                         headers={"X-Engine-Token": self.token, "X-Lang": lang(), "Content-Type": "application/json"})
            r = conn.getresponse()
            data = json.loads(r.read() or b"null")
        except (OSError, http.client.HTTPException) as e:
            raise EngineDown(f"the order engine isn't answering: {e}")
        finally:
            conn.close()
        if r.status == 400:
            raise ValueError(data.get("error", "refused"))
        if r.status != 200:
            raise RuntimeError(data.get("error") if isinstance(data, dict) else f"ldengine: {r.status}")
        return data

    async def _mirror(self):
        """Keeps every GoEngine's mirror current: answered at once when something changed, else within 20 s."""
        while not self._closing:
            try:
                data = await asyncio.to_thread(self.call, "GET", f"/v1/state?since={self.version}&wait=20", None, 30)
            except Exception:
                await asyncio.sleep(0.5)
                continue
            self.version = data["version"]
            for key, snap in data["engines"].items():
                eng = self.engines.get(key)
                if eng:
                    eng._apply(snap)

    # ---------- keys ----------
    def set_deck_key(self, account, key_index, private_key):
        """The deck's own key (None removes it): checked with Lighter by the caller."""
        self._deck_key = (account, key_index, private_key) if private_key else None
        self.call("POST", "/v1/deck/key", {"account_index": account or 0, "api_key_index": key_index or 0, "private_key": private_key or ""})

    async def start_user(self, account, key_index, private_key, folder):
        self._user_keys[account] = (key_index, private_key, str(folder))
        await asyncio.to_thread(self.call, "POST", f"/v1/users/{account}/start", {"api_key_index": key_index, "private_key": private_key, "dir": str(folder)})
        eng = GoEngine(self, str(account), VisitorApi(self.api, key_index), self.calendar)
        self.engines[str(account)] = eng
        snap = await asyncio.to_thread(self.call, "GET", "/v1/state?since=-1")
        if str(account) in snap["engines"]:
            eng._apply(snap["engines"][str(account)])
        return eng

    async def stop_user(self, account):
        self._user_keys.pop(account, None)
        self.engines.pop(str(account), None)
        try:
            await asyncio.to_thread(self.call, "POST", f"/v1/users/{account}/stop", {})
        except EngineDown:
            pass


class VisitorApi:
    """What main.py reads of a visitor engine's api: the key index and the markets."""

    def __init__(self, shared, key_index):
        self.shared, self.api_key_index = shared, key_index

    @property
    def markets(self):
        return self.shared.markets

    async def close(self):
        pass


def _fix_account(acc):
    """JSON object keys are strings: the settings are keyed by market id, as the Python engine keeps them."""
    if acc and isinstance(acc.get("settings"), dict):
        acc["settings"] = {int(k): v for k, v in acc["settings"].items()}
    return acc


class GoEngine:
    """engine.Engine's interface over ldengine."""

    def __init__(self, host, key, api, calendar=None):
        self.host, self.key, self.api, self.calendar = host, key, api, calendar
        self.armed = False
        self._account = None
        self.rules = {}
        self.logs = []
        self.log_seq = 0
        self.fast = True

    # ---------- the mirror ----------
    def _apply(self, snap):
        self.armed = snap["armed"]
        self._account = _fix_account(snap["account"])
        self.rules = {r["id"]: r for r in snap["rules"]}
        self.logs = snap["logs"]
        self.log_seq = snap["log_seq"]

    def _op(self, op, body):
        res = self.host.call("POST", f"/v1/e/{self.key}/{op}", body)
        self._apply(res["state"])
        return res["result"]

    @property
    def account(self):
        return self._account

    @account.setter
    def account(self, acc):
        """The site read the account itself (after a basket) or dropped it (key removed)."""
        self._account = acc
        try:
            self._op("account", {"account": acc})
        except EngineDown:
            pass

    async def run(self):
        """ldengine runs the loop; nothing to do here (main.py starts every engine's run())."""

    def save(self):
        """ldengine saves after every change."""

    # ---------- engine.Engine's methods ----------
    def note(self, msg, level="info", rule=None):
        try:
            self._op("note", {"msg": msg, "level": level, "rule": (rule or {}).get("id", "")})
        except EngineDown:
            log.info("%s%s", "" if self.key == "deck" else f"#{self.key} ", msg)

    def set_armed(self, armed):
        self._op("armed", {"armed": bool(armed)})

    def add_rule(self, rule):
        rule = dict(rule)
        if rule.get("type") == "event_trade":
            ev = self.calendar.get(rule.get("event_id")) if self.calendar else None
            if not ev:
                raise ValueError("unknown event")
            rule["event_title"] = f"{ev['country']} {ev['title']}"
            rule["event_ts"] = ev["ts"]
        return self._op("rules", rule)

    def update_rule(self, rule_id, patch):
        res = self.host.call("PATCH", f"/v1/e/{self.key}/rules/{rule_id}", patch)
        self._apply(res["state"])
        return res["result"]

    def delete_rule(self, rule_id):
        res = self.host.call("DELETE", f"/v1/e/{self.key}/rules/{rule_id}")
        self._apply(res["state"])

    def market_stop(self, market_id):
        return next((r for r in self.rules.values() if r["type"] == "managed_stop" and r["market_id"] == market_id), None)

    def set_market_stop(self, market_id, fields):
        return self._op("stop", {"market_id": market_id, "fields": fields})

    def market_stops(self):
        from engine import STOP_FIELDS
        return {r["market_id"]: {"id": r["id"], "enabled": r.get("enabled", True), "stop": r["state"].get("stop"),
                                 "best": r["state"].get("best"), "note": r.get("note"),
                                 **{k: r[k] for k in STOP_FIELDS if r.get(k)}}
                for r in self.rules.values() if r["type"] == "managed_stop"}

    def describe(self, r):
        if r.get("id") in self.rules and r.get("description"):
            return r["description"]
        return self._op("describe", {k: v for k, v in r.items() if k != "description"})

    def set_exit_plan(self, market_id, levels, be_after_tp1, before=0.0, size=0.0):
        return self._op("exits", {"market_id": market_id, "levels": [{"price": l["price"], "qty": l["qty"]} for l in levels],
                                  "be_after_tp1": bool(be_after_tp1), "before": before, "size": size})

    def exit_plans(self):
        return {r["market_id"]: {"levels": [{"price": l["price"], "qty": l["qty"], "done": bool(l.get("done"))} for l in r["levels"]],
                                 "be_after_tp1": r.get("be_after_tp1", False), "placed": bool(r["state"].get("placed"))}
                for r in self.rules.values() if r["type"] == "exit_plan"}

    async def place_exits(self, r, pos_size):
        res = await asyncio.to_thread(self.host.call, "POST", f"/v1/e/{self.key}/place_exits", {"rule": r["id"], "pos_size": pos_size}, 60)
        self._apply(res["state"])

    def start_working(self, kind, market_id, side, qty, **fields):
        return self._op("working", {"kind": kind, "market_id": market_id, "side": side, "qty": qty,
                                    "fields": {k: v for k, v in fields.items() if v is not None}})

    def working(self):
        return {str(r["state"]["coi"]): {"kind": r["type"], "qty": r["qty"], "filled": r["state"].get("filled", 0.0), "rule": r["id"]}
                for r in self.rules.values() if r["type"] in ("chase", "iceberg") and r["state"].get("coi")}

    def _position(self, market_id):
        for p in (self._account or {}).get("positions", []):
            if p["market_id"] == market_id:
                return p
        return None

    def book_fresh(self, market_id):
        return True
