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

    def mark(self, market_id):
        s = self.stats.get(market_id)
        return s["mark"] if s else None

    async def run(self):
        while True:
            try:
                async with websockets.connect(config.LIGHTER_WS, ping_interval=20, max_size=None) as ws:
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
