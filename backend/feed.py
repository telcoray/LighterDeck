"""Live prices for every market from Lighter's `market_stats/all` websocket channel."""
import asyncio
import json
import logging
import time

import websockets

import config

log = logging.getLogger("feed")


PRICE_FIELDS = {"mark", "last", "bid", "ask", "index", "high", "low"}  # real -> display: / multiplier


class PriceFeed:
    def __init__(self):
        self.stats = {}  # market_id -> {mark, last, bid, ask, funding, change}
        self.updated_at = 0.0
        self.multipliers = {}  # market_id -> multiplier, set by main once markets are loaded
        self.ws = None  # the open connection: its keepalive pings measure the round trip to Lighter

    @property
    def latency_ms(self):
        """Round trip of the last keepalive ping to Lighter, in ms (None before the first one)."""
        lat = getattr(self.ws, "latency", 0) if self.ws else 0
        return round(lat * 1000, 1) if lat else None

    def mark(self, market_id):
        s = self.stats.get(market_id)
        return s["mark"] if s else None

    async def run(self):
        while True:
            try:
                async with websockets.connect(config.LIGHTER_WS, ping_interval=10, max_size=None) as ws:
                    self.ws = ws
                    await ws.send(json.dumps({"type": "subscribe", "channel": "market_stats/all"}))
                    log.info("price feed connected")
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") == "ping":
                            await ws.send(json.dumps({"type": "pong"}))
                            continue
                        if "market_stats" in msg:
                            self._merge(msg["market_stats"])
            except Exception as e:  # reconnect on any drop
                self.ws = None
                log.warning("price feed dropped: %s; reconnecting", e)
                await asyncio.sleep(3)

    def _merge(self, payload):
        fields = {"mark": "mark_price", "last": "last_trade_price", "bid": "best_bid_price",
                  "ask": "best_ask_price", "funding": "current_funding_rate", "change": "daily_price_change",
                  "index": "index_price", "volume": "daily_quote_token_volume", "high": "daily_price_high",
                  "low": "daily_price_low", "oi": "open_interest_usd"}
        for key, s in payload.items():
            cur = self.stats.setdefault(int(s.get("market_id", key)), dict.fromkeys(fields, 0.0))
            mult = self.multipliers.get(int(s.get("market_id", key)), 1.0)
            for ours, theirs in fields.items():
                if s.get(theirs) not in (None, ""):
                    v = float(s[theirs])
                    cur[ours] = v / mult if ours in PRICE_FIELDS else v
        self.updated_at = time.time()


class BookWatch:
    """Best bid and ask of the markets the engines are watching, from Lighter's `order_book/{id}` channel:
    an update every few milliseconds on a busy market, where `market_stats` brings one a second.

    Engines say which markets they need (`want`); the watch subscribes to those and drops the others. A
    listener hears a market only when its best bid or ask changes. A gap in the book's nonces resubscribes
    for a fresh snapshot, and a quote older than STALE seconds counts as none."""

    STALE = 2.0

    def __init__(self):
        self.books = {}        # market_id -> {"bids": {price: size}, "asks": {...}, "nonce": int | None}
        self.quotes = {}       # market_id -> (bid, ask, at)
        self.multipliers = {}  # market_id -> multiplier, set by main once markets are loaded
        self._wants = {}       # owner -> set of market ids
        self._subs = set()
        self._listeners = []
        self._kick = None      # set when the wanted markets change

    # ---------- for the engines ----------
    def listen(self, fn):
        self._listeners.append(fn)

    def unlisten(self, fn):
        if fn in self._listeners:
            self._listeners.remove(fn)

    def want(self, owner, market_ids):
        ids = set(market_ids)
        if self._wants.get(owner, set()) == ids:
            return
        if ids:
            self._wants[owner] = ids
        else:
            self._wants.pop(owner, None)
        if self._kick:
            self._kick.set()

    @property
    def wanted(self):
        return set().union(*self._wants.values()) if self._wants else set()

    def quote(self, market_id):
        """(bid, ask) while fresh, else None."""
        q = self.quotes.get(market_id)
        return (q[0], q[1]) if q and time.time() - q[2] < self.STALE else None

    # ---------- the connection ----------
    async def run(self):
        self._kick = asyncio.Event()
        while True:
            try:
                async with websockets.connect(config.LIGHTER_WS, ping_interval=20, max_size=None) as ws:
                    self._subs, self.books, self.quotes = set(), {}, {}
                    log.info("book watch connected")
                    syncer = asyncio.create_task(self._syncer(ws))
                    try:
                        async for raw in ws:
                            await self._on(ws, json.loads(raw))
                    finally:
                        syncer.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # reconnect on any drop
                log.warning("book watch dropped: %s; reconnecting", e)
            self.quotes = {}
            await asyncio.sleep(3)

    async def _syncer(self, ws):
        while True:
            await self._sync(ws)
            await self._kick.wait()
            self._kick.clear()

    async def _sync(self, ws):
        wanted = self.wanted
        for mid in wanted - self._subs:
            await ws.send(json.dumps({"type": "subscribe", "channel": f"order_book/{mid}"}))
            self._subs.add(mid)
        for mid in self._subs - wanted:
            await ws.send(json.dumps({"type": "unsubscribe", "channel": f"order_book/{mid}"}))
            self._subs.discard(mid)
            self.books.pop(mid, None)
            self.quotes.pop(mid, None)

    async def _on(self, ws, msg):
        kind = msg.get("type", "")
        if kind == "ping":
            await ws.send(json.dumps({"type": "pong"}))
            return
        if not kind.endswith("order_book") or "order_book" not in msg:
            return
        try:
            mid = int(str(msg.get("channel", "")).split(":")[-1])
        except ValueError:
            return
        if mid not in self._subs:
            return
        ob = msg["order_book"]
        book = self.books.setdefault(mid, {"bids": {}, "asks": {}, "nonce": None})
        if kind == "subscribed/order_book":
            book.update(bids={}, asks={}, best_bids=None, best_asks=None)
        elif book["nonce"] is not None and ob.get("begin_nonce") is not None and ob["begin_nonce"] != book["nonce"]:
            # an update went missing: start over from a fresh snapshot
            self.books.pop(mid, None)
            self.quotes.pop(mid, None)
            await ws.send(json.dumps({"type": "unsubscribe", "channel": f"order_book/{mid}"}))
            await ws.send(json.dumps({"type": "subscribe", "channel": f"order_book/{mid}"}))
            return
        mult = self.multipliers.get(mid, 1.0)
        # the best of each side is kept as levels come and go; only when the best one leaves is the side
        # scanned again (a busy book has thousands of levels and an update every few milliseconds)
        for side, better in (("bids", max), ("asks", min)):
            levels, key = book[side], "best_" + side
            best, lost = book.get(key), False
            for lvl in ob.get(side) or []:
                price, size = float(lvl["price"]) / mult, float(lvl["size"]) * mult
                if size > 0:
                    levels[price] = size
                    if not lost and (best is None or better(price, best) == price):
                        best = price
                else:
                    levels.pop(price, None)
                    lost = lost or price == best
            if lost:  # the best level left: whatever came in the same message, scan the side again
                best = better(levels) if levels else None
            book[key] = best
        book["nonce"] = ob.get("nonce")
        bid, ask = book.get("best_bids"), book.get("best_asks")
        if bid is None or ask is None:
            return
        old = self.quotes.get(mid)
        self.quotes[mid] = (bid, ask, time.time())
        if not old or old[0] != bid or old[1] != ask:
            for fn in list(self._listeners):
                fn(mid)
