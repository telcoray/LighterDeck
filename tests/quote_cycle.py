"""One bounded two-sided quote cycle shared by the exchange smoke tests."""
import asyncio
import math
import time

from lighter_api import CancelQuote, ModifyQuote, PlaceQuote


async def until(fn, timeout, every):
    deadline = time.monotonic() + timeout
    while True:
        result = await fn()
        if result or time.monotonic() >= deadline:
            return result
        await asyncio.sleep(every)


async def quote_cycle(api, mid, size, position, info, check, *,
                      max_notional=None, preview=False, order_lifetime=None):
    market = api.markets[mid]
    first_id = api._coi()
    client_ids = (first_id, first_id + 1)

    async def quotes(offset):
        book = await api.orderbook(mid)
        if not book["bids"] or not book["asks"]:
            raise RuntimeError("market has no two-sided book")
        bid, ask = book["bids"][0][0], book["asks"][0][0]
        prices = market.round_price(bid * (1 - offset)), market.round_price(ask * (1 + offset))
        if not 0 < prices[0] < bid <= ask < prices[1]:
            raise RuntimeError("book or tick size cannot support the test quotes")
        return prices

    def check_notional(prices):
        total = size * sum(prices)
        if size < market.min_base or size * min(prices) < market.min_quote:
            raise RuntimeError("quote size is below the market minimum at these prices")
        if max_notional is not None and total > max_notional:
            raise RuntimeError(f"combined quote notional {total:.4f} exceeds cap {max_notional:g}")
        return total

    async def resting(prices):
        orders = {order["client_order_index"]: order for order in await api.active_orders(mid)}
        pair = [orders.get(coi) for coi in client_ids]
        if all(order and market.price_int(order["price"]) == market.price_int(price)
               and market.size_int(order["remaining"]) == market.size_int(size)
               and order["is_ask"] == bool(side)
               for side, (order, price) in enumerate(zip(pair, prices))):
            return pair

    async def submit(label, actions, confirm):
        start = time.perf_counter()
        hashes = await api.send_quote_batch(actions)
        ack = time.perf_counter()
        confirmed = await until(confirm, 15, every=1)
        info(f"{label}: {len(hashes)} hashes in {(ack - start) * 1000:.0f} ms, "
             f"order state {'observed' if confirmed else 'unconfirmed'} after "
             f"{(time.perf_counter() - start) * 1000:.0f} ms")
        if not confirmed:
            raise RuntimeError(f"{label} not confirmed")
        check(label, True)
        return confirmed

    async def canceled():
        outcomes = [await api.order_outcome(mid, coi) for coi in client_ids]
        return all(out and "cancel" in out["status"] and out["filled"] == 0 for out in outcomes)

    prices = await quotes(0.03)
    if size is None:
        minimum = max(market.min_base, market.min_quote / prices[0])
        scale = 10 ** market.size_decimals
        size = math.ceil(minimum * scale) / scale
    total = check_notional(prices)
    info(f"{market.symbol}: bid {prices[0]:g}, ask {prices[1]:g}, size {size:g} each, combined notional {total:.4f}")
    if preview:
        return
    if await position(mid) or await api.active_orders(mid):
        raise RuntimeError("quote_batch requires a flat market with no active orders")
    expiry = int((time.time() + order_lifetime) * 1000) if order_lifetime is not None else None
    info(f"client order IDs: {client_ids[0]}, {client_ids[1]}")
    try:
        orders = await submit("both quotes resting", [
            PlaceQuote(mid, client_ids[0], size, prices[0], expiry),
            PlaceQuote(mid, client_ids[1], -size, prices[1], expiry),
        ], lambda: resting(prices))
        moved = await quotes(0.02)
        if any(market.price_int(old) == market.price_int(new) for old, new in zip(prices, moved)):
            moved = await quotes(0.04)
        if any(market.price_int(old) == market.price_int(new) for old, new in zip(prices, moved)):
            raise RuntimeError("book movement did not produce two distinct new quote prices")
        check_notional(moved)
        await submit("both quote prices updated", [
            ModifyQuote(mid, order["order_index"], size, price)
            for order, price in zip(orders, moved)
        ], lambda: resting(moved))
        await submit("both quotes canceled without fills", [
            CancelQuote(mid, order["order_index"]) for order in orders
        ], canceled)
    finally:
        async def live_quotes():
            return [order for order in await api.active_orders(mid) if order["client_order_index"] in client_ids]

        remaining = await live_quotes()
        for order in remaining:
            await api.cancel_order(mid, order["order_index"])
        if remaining:
            async def gone():
                return not await live_quotes()

            if not await until(gone, 15, every=1):
                raise RuntimeError(f"cleanup not confirmed for client order IDs {client_ids}")
