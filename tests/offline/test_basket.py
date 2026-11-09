"""The basket on the server with a fake signer: nothing leaves this process."""
import asyncio, json, os, sys, tempfile, time
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api, main
from fastapi.testclient import TestClient

SIGNED, BATCH = [], []
class R: code = 200; message = None; tx_hash = ["a", "b"]
class Signer:
    def sign_create_order(self, **kw):
        SIGNED.append(kw); return 14, json.dumps(kw), "h", None
    async def send_tx_batch(self, types, infos):
        BATCH.append((types, infos)); FILLS.clear(); FILLS.update(NEXT); return R()
    async def close(self): pass

def mk(i, sym, px):
    m = lighter_api.Market({"market_id": i, "symbol": sym, "size_decimals": 4, "price_decimals": 1, "min_base_amount": "0.0002", "min_quote_amount": "10", "last_trade_price": str(px)})
    m.max_leverage = 20
    return m
main.api.markets = {1: mk(1, "BTC", 76000), 2: mk(2, "ETH", 2200), 3: mk(3, "SOL", 150)}
main.api.signer = Signer()
main.feed.mark = lambda mid: {1: 76000.0, 2: 2200.0, 3: 150.0}[mid]
main.feed.stats = {1: {"mark": 76000.0, "bid": 75990.0, "ask": 76010.0}, 2: {"mark": 2200.0, "bid": 2199.0, "ask": 2201.0}, 3: {"mark": 150.0, "bid": 149.9, "ask": 150.1}}
main.feed.updated_at = time.time()
main.risk.quote = lambda mid, side: main.feed.stats[mid]["ask" if side > 0 else "bid"]
main.engine.account = {"index": 1, "total_value": 10000, "available": 10000, "positions": [], "settings": {}}
async def noreview(acc, mid, side, size, ref, *a, **k):
    if size * ref < 10: raise main.Blocked("below the minimum")
main.risk.review = noreview
async def nonce(path, params=None, headers=None):
    assert path == "/api/v1/nextNonce", path
    return {"nonce": 500}
main.api._get = nonce
main.BASKET_CHECKS = 2
real_sleep = asyncio.sleep
async def quick(t): await real_sleep(0)
main.asyncio.sleep = quick
FILLS, NEXT = {}, {}
async def account():
    return {"index": 1, "total_value": 10000, "available": 9000, "settings": {}, "positions": [{"market_id": k, "size": v} for k, v in FILLS.items()]}
main.api.account = account
c = TestClient(main.app)
ok = []
def check(name, cond, extra=""):
    ok.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
def send(legs, **b):
    SIGNED.clear(); BATCH.clear()
    return c.post("/api/basket", json={"legs": legs, **b})
A = {"market_id": 1, "side": "buy", "size_usd": 1000}
B = {"market_id": 2, "side": "sell", "size_usd": 500}

import lighter
S = lighter.SignerClient
NEXT.update({1: round(1000 / 76010, 4), 2: -round(500 / 2199, 4)})
r = send([A, B], slippage_bps=50); j = r.json()
check("sent in ONE batch", r.status_code == 200 and len(BATCH) == 1 and len(BATCH[0][0]) == 2, r.text)
check("consecutive nonces", [s["nonce"] for s in SIGNED] == [500, 501], SIGNED)
check("different client order indexes", SIGNED[0]["client_order_index"] != SIGNED[1]["client_order_index"], SIGNED)
check("market IOC, right sides", all(s["order_type"] == S.ORDER_TYPE_MARKET and s["time_in_force"] == S.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL for s in SIGNED) and not SIGNED[0]["is_ask"] and SIGNED[1]["is_ask"], SIGNED)
check("each carries its worst price", SIGNED[0]["price"] == round(76010 * 1.005 * 10) and SIGNED[1]["price"] == round(2199 * 0.995 * 10), (SIGNED[0]["price"], SIGNED[1]["price"]))
check("reports the fills", all(x["filled"] == x["size"] for x in j.get("legs", [])), j)
FILLS.clear(); NEXT.clear(); NEXT.update({1: round(1000 / 76010, 4)})
j = send([A, B]).json()
check("partial: says which one didn't", j["legs"][0]["filled"] == j["legs"][0]["size"] and j["legs"][1]["filled"] == 0, j)
FILLS.clear(); FILLS.update({1: 0.5}); NEXT.clear(); NEXT.update({1: 0.5 + round(1000 / 76010, 4), 2: -round(500 / 2199, 4)})
j = send([A, B]).json(); check("an existing position isn't counted as filled", j["legs"][0]["filled"] == j["legs"][0]["size"], j)
r = send([A]); check("one market refused", r.status_code == 400 and not BATCH, r.text)
r = send([A, dict(A)]); check("same market twice refused", r.status_code == 400 and not BATCH, r.text)
r = send([{"market_id": i % 3 + 1, "side": "buy", "size_usd": 100} for i in range(11)]); check("eleven refused", r.status_code == 400 and not BATCH, r.text)
r = send([A, {"market_id": 99, "side": "buy", "size_usd": 100}]); check("unknown market refused, nothing sent", r.status_code == 400 and not BATCH, r.text)
r = send([A, {"market_id": 2, "side": "buy", "size_usd": 1}]); check("under the minimum refused, naming the market, nothing sent", r.status_code == 400 and not BATCH and "ETH" in r.text, r.text)
main.engine.account["available"] = 40
r = send([A, B]); check("not enough margin for the whole basket", r.status_code == 400 and not BATCH and "basket" in r.text.lower(), r.text)
main.engine.account["available"] = 10000
class Bad(R): code = 400; message = "nope"
class BadSigner(Signer):
    async def send_tx_batch(self, t, i): return Bad()
main.api.signer = BadSigner()
r = send([A, B]); check("Lighter refusing the batch is an error", r.status_code == 400 and "nope" in r.text, r.text)
print("ALL PASS" if all(ok) else f"{ok.count(False)} FAILED")
