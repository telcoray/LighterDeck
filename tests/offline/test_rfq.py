"""RFQ on the server with a fake Lighter: nothing leaves this process."""
import asyncio, os, sys, tempfile, time
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api, main
from fastapi.testclient import TestClient

CALLS = []
ANSWER = {}
class Resp:
    def __init__(self, status, body): self.status, self.body = status, body
    async def json(self, content_type=None): return self.body
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
entry = lambda **k: {"code": 200, "id": 7, "market_index": 1, "direction": 1, "status": "opened", "responses": [], "created_at": 1, **k}
class Http:
    def post(self, path, data=None, headers=None):
        CALLS.append(("POST", path, data, headers))
        return Resp(*ANSWER.get(path, (200, entry(status=(data or {}).get("status", "opened")))))
    def get(self, path, params=None, headers=None):
        CALLS.append(("GET", path, params, headers))
        return Resp(*ANSWER.get(path, (200, entry(responses=[{"account_index": 9, "status": "liquidity_provided", "responded_at": 1, "updated_at": 1}]))))
    async def close(self): pass

m = lighter_api.Market({"market_id": 1, "symbol": "BTC", "size_decimals": 5, "price_decimals": 1, "min_base_amount": "0.0002", "min_quote_amount": "10", "last_trade_price": "76000"})
m.max_leverage = 50
main.api.markets = {1: m}
main.api.http = Http()
class Signer:
    def create_auth_token_with_expiry(self, api_key_index=None): return "tok", None
    async def close(self): pass
main.api.signer = Signer()
main.feed.mark = lambda mid: 76000.0
main.feed.stats = {1: {"mark": 76000.0, "bid": 75990.0, "ask": 76010.0}}
main.feed.updated_at = time.time()
main.risk.quote = lambda mid, side: 76010.0 if side > 0 else 75990.0
main.engine.account = {"index": 1, "total_value": 10000, "available": 10000, "positions": [], "settings": {}}
async def noreview(*a, **k): return None
main.risk.review = noreview
c = TestClient(main.app)
ok = []
def check(name, cond, extra=""):
    ok.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)

r = c.post("/api/rfq", json={"market_id": 1, "side": "buy", "size": 760.1, "unit": "usd"}); j = r.json(); x = CALLS[-1]
check("create: buy, size in the market's integer", r.status_code == 200 and x[1] == "/api/v1/rfq/create" and x[2] == {"market_index": 1, "direction": 1, "base_amount": "1000"}, (r.text, x))
check("create: signed with the auth header", x[3] == {"authorization": "tok"}, x)
check("create: answers id, size and side", j["id"] == 7 and j["size"] == 0.01 and j["side"] == "buy", j)
r = c.post("/api/rfq", json={"market_id": 1, "side": "sell", "size": 0.01, "unit": "base"}); x = CALLS[-1]
check("create: sell is direction 0", x[2]["direction"] == 0 and x[2]["base_amount"] == "1000", x)
n = len(CALLS)
r = c.post("/api/rfq", json={"market_id": 99, "side": "buy", "size": 100}); check("unknown market refused, nothing sent", r.status_code == 400 and len(CALLS) == n, r.text)
r = c.get("/api/rfq/7"); j = r.json(); x = CALLS[-1]
check("get: responses, auth header", j["responses"] == [{"status": "liquidity_provided"}] and x[2] == {"rfq_id": 7} and x[3] == {"authorization": "tok"}, (j, x))
r = c.post("/api/rfq/7/status?status=closed"); x = CALLS[-1]
check("update: closed", r.json()["status"] == "closed" and x[2] == {"rfq_id": 7, "status": "closed"}, r.text)
n = len(CALLS)
r = c.post("/api/rfq/7/status?status=whatever"); check("update: bad status refused, nothing sent", r.status_code == 400 and len(CALLS) == n, r.text)
ANSWER["/api/v1/rfq/create"] = (400, {"code": 64013, "message": "too many"})
r = c.post("/api/rfq", json={"market_id": 1, "side": "buy", "size": 100}); check("three already open: says so plainly", r.status_code == 400 and "3 RFQ" in r.text, r.text)
ANSWER["/api/v1/rfq/create"] = (400, {"code": 64004, "message": "no collateral"})
r = c.post("/api/rfq", json={"market_id": 1, "side": "buy", "size": 100}); check("Lighter's own error passed on", r.status_code == 400 and "no collateral" in r.text, r.text)
ANSWER["/api/v1/rfq/create"] = (200, {"code": 20013, "message": "bad auth"})
r = c.post("/api/rfq", json={"market_id": 1, "side": "buy", "size": 100}); check("an error inside a 200 is still an error", r.status_code == 400 and "bad auth" in r.text, r.text)
main.api.signer = None
r = c.get("/api/rfq/7"); check("no key: refused", r.status_code == 400, r.text)
print("ALL PASS" if all(ok) else f"{ok.count(False)} FAILED")
