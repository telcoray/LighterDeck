"""Account fees with a fake Lighter: nothing leaves this process."""
import asyncio, os, sys, tempfile
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api

class Signer:
    def create_auth_token_with_expiry(self, api_key_index): return "tok", None
    async def close(self): pass

calls = []
async def run():
    shared = lighter_api.LighterAPI()
    api = lighter_api.UserAPI(shared, 7, 6)
    api.signer = Signer()
    limits = {"current_taker_fee_tick": 280, "current_maker_fee_tick": 40, "user_tier_name": "premium"}
    async def fake_get(path, params=None, headers=None):
        calls.append(path)
        if path == "/api/v1/account":
            return {"accounts": [{"collateral": "100", "available_balance": "50", "total_asset_value": "100", "positions": []}]}
        if path == "/api/v1/accountLimits":
            assert headers["authorization"] == "tok" and params["account_index"] == 7
            if limits is None: raise RuntimeError("401")
            return limits
        raise RuntimeError(path)
    api._get = fake_get
    a = await api.account()
    print("premium", a["fees"], "taker %", round(a["fees"]["taker"] * 100, 4))
    assert a["fees"]["taker"] == 0.00028 and a["fees"]["maker"] == 0.00004
    await api.account(); await api.account()
    n = calls.count("/api/v1/accountLimits"); print("limits asked", n); assert n == 1
    # an error keeps the account working and the last known fees
    api._fees = (a["fees"], 0); limits = None
    b = await api.account(); print("after error", b["fees"], b["total_value"]); assert b["fees"] == a["fees"] and b["total_value"] == 100
    # no signer: nothing asked, None
    api2 = lighter_api.UserAPI(shared, 7, 6); api2._get = fake_get
    print("no signer", await api2.fee_rates()); assert await api2.fee_rates() is None
asyncio.run(run()); print("ALL PASS")
