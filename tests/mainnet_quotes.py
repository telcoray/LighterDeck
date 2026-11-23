"""Preview or explicitly run one post-only quote cycle on Lighter mainnet.

    python tests/mainnet_quotes.py BTC
    python tests/mainnet_quotes.py BTC --execute --max-notional 30

Execution uses MAINNET_QUOTE_ACCOUNT_INDEX, MAINNET_QUOTE_API_KEY_INDEX,
and MAINNET_QUOTE_API_PRIVATE_KEY from the environment.
"""
import argparse
import asyncio
import math
import os
import sys
import tempfile
from pathlib import Path

MAINNET = "https://mainnet.zklighter.elliot.ai"


async def run(args):
    credentials = ()
    if args.execute:
        names = ("MAINNET_QUOTE_ACCOUNT_INDEX", "MAINNET_QUOTE_API_KEY_INDEX", "MAINNET_QUOTE_API_PRIVATE_KEY")
        values = [os.environ.get(name) for name in names]
        if not all(values):
            raise RuntimeError("execution requires " + ", ".join(names))
        credentials = (int(values[0]), int(values[1]), values[2])

    with tempfile.TemporaryDirectory(prefix="lighterdeck-mainnet-quotes-") as scratch:
        for name in ("LIGHTER_ACCOUNT_INDEX", "LIGHTER_API_KEY_INDEX", "LIGHTER_API_PRIVATE_KEY"):
            os.environ.pop(name, None)
        os.environ.update(LIGHTER_URL=MAINNET, DATA_DIR=scratch)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        from lighter_api import LighterAPI
        from quote_cycle import quote_cycle

        api = LighterAPI()
        try:
            await api.start()
            matches = [m.id for m in api.markets.values() if m.symbol.upper() == args.market.upper()]
            if len(matches) != 1:
                raise RuntimeError(f"{args.market}: expected exactly one market, found {len(matches)}")
            mid = matches[0]
            if args.execute:
                await api.connect(*credentials)

            async def position(market_id):
                account = await api.account()
                return next((p["size"] for p in account["positions"] if p["market_id"] == market_id), 0)

            print(f"Lighter mainnet | {'execution' if args.execute else 'read-only preview'}", flush=True)
            await quote_cycle(api, mid, None, position, print, lambda label, _: print(f"PASS {label}"),
                              max_notional=args.max_notional, preview=not args.execute, order_lifetime=90)
        finally:
            await api.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("market", help="exact symbol, e.g. BTC")
    parser.add_argument("--execute", action="store_true", help="submit real orders")
    parser.add_argument("--max-notional", type=float, help="combined bid and ask notional cap in USD")
    args = parser.parse_args()
    if args.max_notional is not None and (not math.isfinite(args.max_notional) or args.max_notional <= 0):
        parser.error("--max-notional must be finite and positive")
    if args.execute and args.max_notional is None:
        parser.error("--execute requires --max-notional")
    try:
        asyncio.run(run(args))
    except Exception as exc:
        sys.exit(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
