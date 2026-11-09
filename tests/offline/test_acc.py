"""The server's account() passes on Lighter's margin figures. Made-up response, nothing leaves this process."""
import asyncio, os, sys, tempfile
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api

api = lighter_api.LighterAPI.__new__(lighter_api.LighterAPI)
api.markets = {}
type(api).account_index = property(lambda self: 1)
base = {"available_balance": "10", "collateral": "100", "total_asset_value": "100", "positions": []}
async def fees(): return None
api.fee_rates = fees
for extra, want in (({"cross_asset_value": "90", "cross_initial_margin_requirement": "80", "cross_maintenance_margin_requirement": "20"}, (90.0, 80.0, 20.0)), ({}, (None, None, None))):
    async def get(path, params=None, d={**base, **extra}): return {"accounts": [d]}
    api._get = get
    a = asyncio.run(api.account())
    got = (a["cross_value"], a["initial"], a["maintenance"])
    print("PASS" if got == want else f"FAIL {got}")
