"""Thin layer over Lighter: public REST, authenticated reads and signed orders.

Prices and sizes travel as floats inside the deck and are scaled to Lighter's
integers here only (size * 10^size_decimals, price * 10^price_decimals).

Markets can have a `multiplier`: values on the wire are "real" units, what people
see are "display" units (display size = real size x multiplier, display price =
real price / multiplier). Everything above this module works in display units;
conversion happens here, as in Lighter's own frontend (lighter-ts, utils/multiplier.ts).
Today every perp has multiplier 1, so both are the same number.
"""
import asyncio
import logging
import math
import time

import aiohttp

import candles as candles_mod
import config

log = logging.getLogger("lighter")


def realized_pnl(fills, positions):
    """Realized PnL of each fill (None for fills that only open or add), in USD, before fees and funding.

    Lighter's fills stopped carrying their PnL, but each still has the position size and entry
    value (avg entry x size) just before it. The size has no sign, so the direction is found by
    walking back from the current positions: newest fill first, position before = after - side x size.
    `fills` are newest first in real units; `positions` maps market id -> signed real size now."""
    after = dict(positions)
    out = []
    for f in fills:
        side, size, before = f["side"], f["size"], f["before"]
        signed = after.get(f["market_id"], 0.0) - side * size
        if abs(abs(signed) - before) > max(1e-9, before * 1e-6):  # chain broken (page edge, fill racing the account)
            signed = math.copysign(before, signed or -side)
        after[f["market_id"]] = signed
        if f["self_trade"] or before <= 0 or signed * side > 0:  # opens or adds to the position
            out.append(None)
            continue
        closed = min(size, before)  # a flip closes the old position, the rest opens a new one
        entry = f["entry_quote"] / before
        out.append(round((1 if signed > 0 else -1) * closed * (f["price"] - entry), 6))
    return out


class Market:
    def __init__(self, d):
        self.id = d["market_id"]
        self.symbol = d["symbol"]
        self.multiplier = float(d.get("multiplier") or 1) or 1.0
        self.real_size_decimals = d["size_decimals"]
        self.real_price_decimals = d["price_decimals"]
        # display precision gains a digit when the multiplier shifts values (lighter-ts getDisplayDecimals)
        self.size_decimals = self.real_size_decimals + (1 if self.multiplier < 1 else 0)
        self.price_decimals = self.real_price_decimals + (1 if self.multiplier > 1 else 0)
        self.min_base = self.disp_size(float(d["min_base_amount"]))
        self.min_quote = float(d["min_quote_amount"])
        # margin fractions arrive in basis points (500 = 5%); fees as percent strings
        self.imf = float(d.get("default_initial_margin_fraction") or 0) / 10000
        self.mmf = float(d.get("maintenance_margin_fraction") or 0) / 10000
        self.taker_fee = float(d.get("taker_fee") or 0) / 100
        self.maker_fee = float(d.get("maker_fee") or 0) / 100
        self.last_price = float(d.get("last_trade_price") or 0)
        self.volume_usd = float(d.get("daily_quote_token_volume") or 0)
        imf_bps = float(d.get("default_initial_margin_fraction") or 0)  # basis points
        self.default_leverage = round(10000 / imf_bps, 1) if imf_bps else None
        min_imf = float(d.get("min_initial_margin_fraction") or 0)
        self.max_leverage = round(10000 / min_imf, 1) if min_imf else None
        self.created_at = int(d.get("created_at") or 0)
        self.name = self.symbol
        self.asset_type = "CRYPTO"
        self.categories = []
        self.logo = ""
        self.logo_ext = ""

    def apply_token(self, t):
        """Display metadata from Lighter's tokenlist (name, crypto/RWA, categories)."""
        self.name = t.get("name") or self.symbol
        self.asset_type = t.get("asset_type") or "CRYPTO"
        self.categories = t.get("categories") or []
        self.logo = t.get("logo") or ""
        self.logo_ext = t.get("logo_extension") or ""

    # ---- unit conversion: real (wire) <-> display ----
    def disp_price(self, real):
        return float(real) / self.multiplier

    def disp_size(self, real):
        return float(real) * self.multiplier

    def size_int(self, size):
        """Display size -> signed-less integer base amount for the signer."""
        return int(round(abs(size) / self.multiplier * 10 ** self.real_size_decimals))

    def price_int(self, price):
        """Display price -> integer price for the signer."""
        return int(round(price * self.multiplier * 10 ** self.real_price_decimals))

    def round_price(self, price):
        return round(price, self.price_decimals)

    def to_dict(self):
        return {
            "id": self.id,
            "symbol": self.symbol,
            "size_decimals": self.size_decimals,
            "price_decimals": self.price_decimals,
            "min_base": self.min_base,
            "min_quote": self.min_quote,
            "multiplier": self.multiplier,
            "imf": self.imf,
            "mmf": self.mmf,
            "taker_fee": self.taker_fee,
            "maker_fee": self.maker_fee,
            "volume_usd": self.volume_usd,
            "default_leverage": self.default_leverage,
            "max_leverage": self.max_leverage,
            "name": self.name,
            "asset_type": self.asset_type,
            "categories": self.categories,
            "has_logo": bool(self.logo),
            "created_at": self.created_at,
        }


class LighterAPI:
    def __init__(self):
        self.http = None
        self.markets = {}  # market_id -> Market
        self.signer = None
        self._auth = (None, 0)  # (token, expires_at)
        self._orders_today = (time.strftime("%Y-%m-%d"), 0)
        self._send_lock = asyncio.Lock()
        self._candle_cache = {}  # (market, timeframe, count) -> (fetched_at, bars)

    async def start(self):
        self.http = aiohttp.ClientSession(base_url=config.LIGHTER_URL, timeout=aiohttp.ClientTimeout(total=15))
        await self.load_markets()
        if config.TRADING_ENABLED:
            try:
                await self.connect(config.ACCOUNT_INDEX, config.API_KEY_INDEX, config.API_PRIVATE_KEY)
            except ValueError as e:
                if config.CREDENTIALS_SOURCE == "env":
                    raise RuntimeError(f"API key check failed: {e}")
                log.error("saved API key rejected, running read-only: %s", e)

    # the account this API trades for: the deck's own (config); a visitor's on the public site (UserAPI)
    @property
    def account_index(self):
        return config.ACCOUNT_INDEX

    @property
    def api_key_index(self):
        return config.API_KEY_INDEX

    @staticmethod
    async def make_signer(account_index, api_key_index, private_key):
        """A signer for this key, checked against the key registered on Lighter.
        Raises ValueError when Lighter does not accept it."""
        import lighter  # heavy import (signer .so), only when trading

        try:
            signer = lighter.SignerClient(url=config.LIGHTER_URL, account_index=account_index,
                                          api_private_keys={api_key_index: private_key})
        except Exception as e:
            raise ValueError(str(e))
        err = await asyncio.to_thread(signer.check_client)
        if err:
            await signer.close()
            raise ValueError(err)
        return signer

    async def connect(self, account_index, api_key_index, private_key):
        """Build a signer for this key and check it against the key registered on Lighter.
        Raises ValueError (and keeps the current signer) when Lighter does not accept it."""
        signer = await self.make_signer(account_index, api_key_index, private_key)
        await self.disconnect()
        self.signer = signer
        config.ACCOUNT_INDEX, config.API_KEY_INDEX, config.API_PRIVATE_KEY = account_index, api_key_index, private_key
        log.info("trading enabled for account %s (api key %s)", account_index, api_key_index)

    async def disconnect(self):
        if self.signer:
            await self.signer.close()
        self.signer = None
        self._auth = (None, 0)
        config.ACCOUNT_INDEX = config.API_KEY_INDEX = config.API_PRIVATE_KEY = None

    async def accounts_for_address(self, address):
        """Account indexes (main and sub-accounts) owned by an L1 wallet address."""
        data = await self._get("/api/v1/accountsByL1Address", {"l1_address": address})
        return [{"index": a["index"], "collateral": float(a.get("collateral") or 0)} for a in data.get("sub_accounts", [])]

    async def close(self):
        if self.signer:
            await self.signer.close()
        if self.http:
            await self.http.close()

    # ---------- public data ----------
    async def _get(self, path, params=None, headers=None):
        async with self.http.get(path, params=params, headers=headers) as r:
            data = await r.json(content_type=None)
            if r.status != 200 or data.get("code", 200) != 200:
                raise RuntimeError(f"{path}: {r.status} {data}")
            return data

    async def load_markets(self):
        data = await self._get("/api/v1/orderBookDetails")
        markets = {}
        for d in data["order_book_details"]:
            if d.get("market_type") == "perp" and d.get("status") == "active":
                markets[d["market_id"]] = Market(d)
        try:
            tokens = (await self._get("/api/v1/tokenlist")).get("tokens", [])
            by_symbol = {}
            for t in tokens:
                if t.get("market") == "PERPS":
                    by_symbol[t["symbol"]] = t
                    if t.get("backend_symbol"):
                        by_symbol[t["backend_symbol"]] = t
            for m in markets.values():
                if m.symbol in by_symbol:
                    m.apply_token(by_symbol[m.symbol])
        except Exception as e:  # metadata is cosmetic; trading works without it
            log.warning("tokenlist unavailable: %s", e)
        self.markets = markets
        log.info("loaded %d markets", len(markets))

    async def _native_candles(self, market_id, resolution, count):
        """Up to `count` most recent candles of a timeframe Lighter serves, paging back 500 at a time."""
        secs = candles_mod.NATIVE[resolution]
        m = self.markets.get(market_id)
        dp = m.disp_price if m else float
        ds = m.disp_size if m else float
        end = int(time.time())
        out = []
        for _ in range(min(8, -(-count // candles_mod.PAGE))):
            n = min(candles_mod.PAGE, count - len(out))
            data = await self._get("/api/v1/candles", {
                "market_id": market_id, "resolution": resolution,
                "start_timestamp": end - secs * n, "end_timestamp": end, "count_back": n,
            })
            page = [{"time": c["t"] // 1000, "open": dp(c["o"]), "high": dp(c["h"]), "low": dp(c["l"]),
                     "close": dp(c["c"]), "volume": ds(c["v"])} for c in data.get("c", [])]
            page = [c for c in page if not out or c["time"] < out[0]["time"]]
            if not page:
                break  # reached the start of the market's history
            out = page + out
            if len(out) >= count:
                break
            end = out[0]["time"] - 1
        return out[-count:]

    async def candles(self, market_id, resolution, count=500):
        """OHLCV bars; merged timeframes (3m, 2h, 8h, 3d, 1w, 1M) are built from smaller ones."""
        key = (market_id, resolution, count)
        hit = self._candle_cache.get(key)
        if resolution in candles_mod.NATIVE:  # a few seconds: the live bar comes from the price stream
            if hit and time.time() - hit[0] < 5:
                return hit[1]
            bars = await self._native_candles(market_id, resolution, count)
            self._candle_cache[key] = (time.time(), bars)
            return bars
        src, bucket = candles_mod.DERIVED[resolution]  # KeyError -> unknown timeframe
        if hit and time.time() - hit[0] < 30:
            return hit[1]
        _, need = candles_mod.source_needed(resolution, count)
        rows = await self._native_candles(market_id, src, min(need, 4000))
        bars = candles_mod.merge(rows, bucket)[-count:]
        self._candle_cache[key] = (time.time(), bars)
        return bars

    async def fundings(self, market_id, hours):
        """Hourly funding of a market, oldest first: unix seconds and % per hour, positive when longs pay."""
        now = int(time.time())
        data = await self._get("/api/v1/fundings", {"market_id": market_id, "resolution": "1h",
                                                    "start_timestamp": now - hours * 3600, "end_timestamp": now,
                                                    "count_back": 0})
        return [{"t": f["timestamp"], "rate": float(f["rate"]) * (1 if f["direction"] == "long" else -1)}
                for f in data.get("fundings", [])]

    async def account(self):
        if self.account_index is None:
            return None
        data = await self._get("/api/v1/account", {"by": "index", "value": self.account_index})
        acc = data["accounts"][0]
        positions = []
        settings = {}  # market_id -> leverage/margin mode, also for markets without a position
        for p in acc.get("positions", []):
            size = float(p["position"]) * (1 if p["sign"] >= 0 else -1)
            imf = float(p.get("initial_margin_fraction") or 0)  # percent
            if imf:
                settings[p["market_id"]] = {"leverage": round(100 / imf, 1), "cross": p.get("margin_mode", 0) == 0}
            if size == 0:
                continue
            m = self.markets.get(p["market_id"])
            dp = m.disp_price if m else float
            positions.append({
                "market_id": p["market_id"], "symbol": p["symbol"], "size": m.disp_size(size) if m else size,
                "entry": dp(p["avg_entry_price"]), "value": float(p["position_value"]),
                "upnl": float(p["unrealized_pnl"]), "rpnl": float(p.get("realized_pnl") or 0),
                "liq": dp(p["liquidation_price"] or 0), "margin": float(p.get("allocated_margin") or 0),
                "leverage": round(100 / imf, 1) if imf else None,
                "cross": p.get("margin_mode", 0) == 0,
            })
        return {
            "index": self.account_index,
            "collateral": float(acc.get("collateral") or 0),
            "available": float(acc.get("available_balance") or 0),
            "total_value": float(acc.get("total_asset_value") or 0),
            "positions": positions,
            "settings": settings,
        }

    async def orderbook(self, market_id, depth=14):
        data = await self._get("/api/v1/orderBookOrders", {"market_id": market_id, "limit": 100})
        m = self.markets[market_id]

        def levels(orders, reverse):
            agg = {}
            for o in orders:
                p = m.disp_price(o["price"])
                agg[p] = agg.get(p, 0) + m.disp_size(o["remaining_base_amount"])
            return [[p, s] for p, s in sorted(agg.items(), reverse=reverse)][:depth]

        return {"asks": levels(data.get("asks", []), False), "bids": levels(data.get("bids", []), True),
                "ts": time.time()}

    async def trades(self, limit=100, positions=None, since_ms=None, max_pages=40, market_id=None):
        """Fills, newest first: the latest `limit`, or (since_ms) every fill back to that time, 100 a page.
        `positions` ({market_id: signed display size}) anchors the realized PnL worked out by realized_pnl()."""
        if not self.signer:
            return []
        raw, cursor = [], None
        for _ in range(max_pages if since_ms else 1):
            params = {"account_index": self.account_index, "sort_by": "timestamp", "limit": 100 if since_ms else limit}
            if market_id is not None:
                params["market_id"] = market_id
            if cursor:
                params["cursor"] = cursor
            data = await self._get("/api/v1/trades", params, headers={"authorization": await self._auth_token()})
            page = data.get("trades", [])
            raw += page
            cursor = data.get("next_cursor")
            if not since_ms or not page or not cursor or page[-1]["timestamp"] < since_ms:
                break
        out, fills = [], []
        for t in raw:
            is_buyer = t["bid_account_id"] == self.account_index
            m = self.markets.get(t["market_id"])
            maker = t["is_maker_ask"] != is_buyer  # we were the ask and the ask was maker, or vice versa
            role = "maker" if maker else "taker"
            out.append({
                "ts": t["timestamp"], "market_id": t["market_id"], "symbol": m.symbol if m else str(t["market_id"]),
                "order_id": t["bid_id"] if is_buyer else t["ask_id"],
                "side": "buy" if is_buyer else "sell",
                "size": m.disp_size(t["size"]) if m else float(t["size"]),
                "price": m.disp_price(t["price"]) if m else float(t["price"]),
                "usd": float(t["usd_amount"]), "role": role,
            })
            fills.append({
                "market_id": t["market_id"], "side": 1 if is_buyer else -1, "size": float(t["size"]),
                "price": float(t["price"]), "before": float(t.get(f"{role}_position_size_before") or 0),
                "entry_quote": float(t.get(f"{role}_entry_quote_before") or 0),
                "self_trade": t["bid_account_id"] == t["ask_account_id"],
            })
        real_positions = {mid: size / self.markets[mid].multiplier if mid in self.markets else size
                          for mid, size in (positions or {}).items()}
        for row, pnl in zip(out, realized_pnl(fills, real_positions)):
            row["pnl"] = pnl
        return [r for r in out if not since_ms or r["ts"] >= since_ms]

    async def pnl_points(self, start, end, resolution="1d"):
        """Account PnL series (cumulative trade PnL, deposits and withdrawals); the last point is live."""
        data = await self._get("/api/v1/pnl", {
            "by": "index", "value": self.account_index, "resolution": resolution,
            "start_timestamp": int(start), "end_timestamp": int(end), "count_back": 0,
        }, headers={"authorization": await self._auth_token()})
        return data.get("pnl") or []

    async def funding_paid(self, since, max_pages=30):
        """Funding the account received (+) or paid (-) since `since` (unix s), per market id."""
        out, cursor = {}, None
        complete = False
        for _ in range(max_pages):
            params = {"account_index": self.account_index, "limit": 100}
            if cursor:
                params["cursor"] = cursor
            data = await self._get("/api/v1/positionFunding", params, headers={"authorization": await self._auth_token()})
            rows = data.get("position_fundings", [])
            for f in rows:
                if f["timestamp"] >= since:
                    out[f["market_id"]] = out.get(f["market_id"], 0.0) + float(f["change"])
            cursor = data.get("next_cursor")
            if not rows or not cursor or rows[-1]["timestamp"] < since:
                complete = True
                break
        return out, complete

    async def daily_pnl(self):
        """PnL since 00:00 UTC, closed trades and open positions together (fees and funding included).

        Read from Lighter's account PnL series: hourly points plus a live last point. Fills no longer
        carry their own PnL, so they can't be summed. None when the midnight point is missing."""
        if not self.signer:
            return 0.0
        now = int(time.time())
        midnight = now // 86400 * 86400
        data = await self._get("/api/v1/pnl", {
            "by": "index", "value": self.account_index, "resolution": "1h",
            "start_timestamp": midnight, "end_timestamp": now, "count_back": 0,
        }, headers={"authorization": await self._auth_token()})
        points = data.get("pnl") or []
        start = next((p for p in points if p["timestamp"] == midnight), None)
        if start is None:
            return None
        return float(points[-1]["trade_pnl"]) - float(start["trade_pnl"])

    async def _auth_token(self):
        token, exp = self._auth
        if token and time.time() < exp - 60:
            return token
        token, err = self.signer.create_auth_token_with_expiry(api_key_index=self.api_key_index)
        if err:
            raise RuntimeError(f"auth token: {err}")
        self._auth = (token, time.time() + 600)
        return token

    async def active_orders(self, market_id):
        if not self.signer:
            return []
        data = await self._get("/api/v1/accountActiveOrders",
                               {"account_index": self.account_index, "market_id": market_id},
                               headers={"authorization": await self._auth_token()})
        m = self.markets[market_id]
        out = []
        for o in data.get("orders", []):
            out.append({
                "order_index": o["order_index"], "client_order_index": o["client_order_index"],
                "market_id": o["market_index"], "is_ask": o["is_ask"], "type": o["type"],
                "price": m.disp_price(o["price"]), "trigger_price": m.disp_price(o.get("trigger_price") or 0),
                "remaining": m.disp_size(o["remaining_base_amount"]), "reduce_only": o["reduce_only"],
                "status": o["status"],
            })
        return out

    # ---------- signed actions ----------
    def _check_limits(self, notional):
        if not self.signer:
            raise RuntimeError("trading disabled: no API key configured")
        if config.MAX_NOTIONAL_USD and notional > config.MAX_NOTIONAL_USD:
            raise RuntimeError(f"order ${notional:.0f} exceeds MAX_NOTIONAL_USD ${config.MAX_NOTIONAL_USD:.0f}")
        day, n = self._orders_today
        today = time.strftime("%Y-%m-%d")
        if day != today:
            day, n = today, 0
        if config.MAX_ORDERS_PER_DAY and n >= config.MAX_ORDERS_PER_DAY:
            raise RuntimeError(f"MAX_ORDERS_PER_DAY ({config.MAX_ORDERS_PER_DAY}) reached")
        self._orders_today = (day, n + 1)

    @staticmethod
    def _coi():
        # client order index: unique-ish 48-bit integer
        return int(time.time() * 1000) % (2 ** 47)

    async def _send(self, coro_fn, what):
        async with self._send_lock:
            tx, resp, err = await coro_fn()
        if err:
            raise RuntimeError(f"{what}: {err}")
        log.info("%s ok: %s", what, getattr(resp, "tx_hash", resp))
        return tx, resp

    async def market_order(self, market_id, size, ref_price, reduce_only=False, slippage_pct=None):
        """size > 0 buys, size < 0 sells. ref_price = current mark; worst price = ref +/- slippage."""
        m = self.markets[market_id]
        slip = (slippage_pct if slippage_pct is not None else config.MAX_SLIPPAGE_PCT) / 100
        is_ask = size < 0
        worst = m.round_price(ref_price * (1 - slip if is_ask else 1 + slip))
        if not reduce_only:
            self._check_limits(abs(size) * ref_price)
        elif not self.signer:
            raise RuntimeError("trading disabled")
        coi = self._coi()
        await self._send(lambda: self.signer.create_market_order(
            market_index=market_id, client_order_index=coi, base_amount=m.size_int(size),
            avg_execution_price=m.price_int(worst), is_ask=is_ask, reduce_only=reduce_only,
            api_key_index=self.api_key_index,
        ), f"market {'sell' if is_ask else 'buy'} {abs(size)} {m.symbol}")
        return coi

    async def limit_order(self, market_id, size, price, reduce_only=False, post_only=False):
        """Good-till-time limit order; size > 0 buys, size < 0 sells."""
        import lighter

        m = self.markets[market_id]
        if not reduce_only:
            self._check_limits(abs(size) * price)
        elif not self.signer:
            raise RuntimeError("trading disabled")
        tif = (lighter.SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY if post_only
               else lighter.SignerClient.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME)
        coi = self._coi()
        await self._send(lambda: self.signer.create_order(
            market_index=market_id, client_order_index=coi, base_amount=m.size_int(size),
            price=m.price_int(m.round_price(price)), is_ask=size < 0,
            order_type=lighter.SignerClient.ORDER_TYPE_LIMIT, time_in_force=tif, reduce_only=reduce_only,
            api_key_index=self.api_key_index,
        ), f"limit {'sell' if size < 0 else 'buy'} {abs(size)} {m.symbol} @ {price}")
        return coi

    async def entry(self, market_id, size, kind, price, sl=None, tp=None, slippage_pct=None, post_only=False):
        """Opening order with exchange-native protection attached (OTO / OTOCO).

        size > 0 buys. For market orders `price` is the worst acceptable fill price;
        for limit orders the limit price. SL/TP are position-tied (BaseAmount 0) and
        are cancelled by the exchange when the position closes or flips.
        """
        import lighter
        from lighter.signer_client import CreateOrderTxReq

        S = lighter.SignerClient
        m = self.markets[market_id]
        self._check_limits(abs(size) * price)
        is_ask = size < 0
        tif = (S.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL if kind == "market"
               else S.ORDER_TIME_IN_FORCE_POST_ONLY if post_only else S.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME)
        coi = self._coi()
        orders = [CreateOrderTxReq(
            MarketIndex=market_id, ClientOrderIndex=coi, BaseAmount=m.size_int(size),
            Price=m.price_int(m.round_price(price)), IsAsk=int(is_ask),
            Type=S.ORDER_TYPE_MARKET if kind == "market" else S.ORDER_TYPE_LIMIT, TimeInForce=tif,
            ReduceOnly=0, TriggerPrice=0, OrderExpiry=0 if kind == "market" else -1,
        )]
        slip = (slippage_pct if slippage_pct is not None else config.MAX_SLIPPAGE_PCT) / 100
        for trigger, order_type in ((tp, S.ORDER_TYPE_TAKE_PROFIT), (sl, S.ORDER_TYPE_STOP_LOSS)):
            if not trigger:
                continue
            # closing side: a long exits by selling, so accept down to trigger*(1-slip)
            worst = trigger * (1 - slip) if not is_ask else trigger * (1 + slip)
            orders.append(CreateOrderTxReq(
                MarketIndex=market_id, ClientOrderIndex=coi + len(orders), BaseAmount=0,
                Price=m.price_int(m.round_price(worst)), IsAsk=int(not is_ask), Type=order_type,
                TimeInForce=S.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL, ReduceOnly=1,
                TriggerPrice=m.price_int(m.round_price(trigger)), OrderExpiry=-1,
            ))
        label = f"{kind} {'sell' if is_ask else 'buy'} {abs(size)} {m.symbol} @ {price}" + (
            f" sl {sl}" if sl else "") + (f" tp {tp}" if tp else "")
        if len(orders) == 1:
            o = orders[0]
            await self._send(lambda: self.signer.create_order(
                market_index=market_id, client_order_index=coi, base_amount=o.BaseAmount, price=o.Price,
                is_ask=is_ask, order_type=o.Type, time_in_force=tif, reduce_only=False,
                order_expiry=0 if kind == "market" else S.DEFAULT_28_DAY_ORDER_EXPIRY,
                api_key_index=self.api_key_index,
            ), label)
        else:
            grouping = (S.GROUPING_TYPE_ONE_TRIGGERS_A_ONE_CANCELS_THE_OTHER if len(orders) == 3
                        else S.GROUPING_TYPE_ONE_TRIGGERS_THE_OTHER)
            await self._send(lambda: self.signer.create_grouped_orders(
                grouping_type=grouping, orders=orders, api_key_index=self.api_key_index,
            ), label)
        return coi

    async def set_leverage(self, market_id, leverage, cross=True):
        import lighter

        S = lighter.SignerClient
        await self._send(lambda: self.signer.update_leverage(
            market_index=market_id, margin_mode=S.CROSS_MARGIN_MODE if cross else S.ISOLATED_MARGIN_MODE,
            leverage=leverage, api_key_index=self.api_key_index,
        ), f"leverage {self.markets[market_id].symbol} {leverage}x {'cross' if cross else 'isolated'}")

    async def stop_order(self, market_id, position_size, trigger, kind="sl", slippage_pct=None):
        """Reduce-only trigger order that closes `position_size` (signed position) at `trigger`."""
        import lighter

        m = self.markets[market_id]
        slip = (slippage_pct if slippage_pct is not None else config.MAX_SLIPPAGE_PCT) / 100
        is_ask = position_size > 0  # closing a long sells
        worst = m.round_price(trigger * (1 - slip if is_ask else 1 + slip))
        order_type = lighter.SignerClient.ORDER_TYPE_STOP_LOSS if kind == "sl" else lighter.SignerClient.ORDER_TYPE_TAKE_PROFIT
        if not self.signer:
            raise RuntimeError("trading disabled")
        coi = self._coi()
        await self._send(lambda: self.signer.create_order(
            market_index=market_id, client_order_index=coi, base_amount=m.size_int(position_size),
            price=m.price_int(worst), is_ask=is_ask, order_type=order_type,
            time_in_force=lighter.SignerClient.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=True, trigger_price=m.price_int(m.round_price(trigger)),
            api_key_index=self.api_key_index,
        ), f"{kind} {m.symbol} @ {trigger}")
        return coi

    async def modify_stop(self, market_id, order_index, position_size, trigger, slippage_pct=None):
        m = self.markets[market_id]
        slip = (slippage_pct if slippage_pct is not None else config.MAX_SLIPPAGE_PCT) / 100
        is_ask = position_size > 0
        worst = m.round_price(trigger * (1 - slip if is_ask else 1 + slip))
        await self._send(lambda: self.signer.modify_order(
            market_index=market_id, order_index=order_index, base_amount=m.size_int(position_size),
            price=m.price_int(worst), trigger_price=m.price_int(m.round_price(trigger)),
            api_key_index=self.api_key_index,
        ), f"move stop {m.symbol} -> {trigger}")

    async def modify_order(self, market_id, order_index, size, price, trigger=0.0):
        """Move an open order: new limit/worst price and, for SL/TP, new trigger. Size in display units."""
        m = self.markets[market_id]
        await self._send(lambda: self.signer.modify_order(
            market_index=market_id, order_index=order_index, base_amount=m.size_int(size),
            price=m.price_int(m.round_price(price)),
            trigger_price=m.price_int(m.round_price(trigger)) if trigger else 0,
            api_key_index=self.api_key_index,
        ), f"move {m.symbol} order {order_index} -> {trigger or price}")

    async def cancel_order(self, market_id, order_index):
        await self._send(lambda: self.signer.cancel_order(
            market_index=market_id, order_index=order_index, api_key_index=self.api_key_index,
        ), f"cancel {market_id}/{order_index}")

    async def cancel_all(self):
        import lighter

        await self._send(lambda: self.signer.cancel_all_orders(
            time_in_force=lighter.SignerClient.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0,
            api_key_index=self.api_key_index,
        ), "cancel all")


class UserAPI(LighterAPI):
    """A visitor's account on the public site, for the automations they turned on: its own signer and
    indexes; markets, HTTP session and candles come from the deck's API. No env caps: those are the
    deck owner's own limits."""

    def __init__(self, shared, account_index, api_key_index):
        self.shared = shared
        super().__init__()
        self._account, self._key_index = account_index, api_key_index

    # shared with the deck's API (load_markets replaces its dict, so always read through it)
    http = property(lambda self: self.shared.http, lambda self, v: None)
    markets = property(lambda self: self.shared.markets, lambda self, v: None)
    _candle_cache = property(lambda self: self.shared._candle_cache, lambda self, v: None)

    @property
    def account_index(self):
        return self._account

    @property
    def api_key_index(self):
        return self._key_index

    async def connect(self, private_key):
        self.signer = await self.make_signer(self._account, self._key_index, private_key)

    async def disconnect(self):
        if self.signer:
            await self.signer.close()
        self.signer = None
        self._auth = (None, 0)

    async def close(self):
        await self.disconnect()

    def _check_limits(self, notional):
        if not self.signer:
            raise RuntimeError("automations are off: no API key on the server")
