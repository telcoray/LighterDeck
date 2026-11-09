"""Advanced orders on the server with a fake signer: nothing leaves this process."""
import base64, os, sys, tempfile, time
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api, main
from fastapi.testclient import TestClient

SENT = []
class Signer:
    async def create_order(self, **kw):
        SENT.append(kw); return None, "ok", None
    async def close(self): pass

m = lighter_api.Market({"market_id": 1, "symbol": "BTC", "size_decimals": 5, "price_decimals": 1, "min_base_amount": "0.0002", "min_quote_amount": "10", "last_trade_price": "76000"})
m.max_leverage = 50
main.api.markets = {1: m}
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
def order(**b):
    SENT.clear()
    return c.post("/api/order", json={"market_id": 1, "side": "buy", "size": 1000, "unit": "usd", **b})

import lighter
S = lighter.SignerClient
r = order(kind="conditional", trigger_price=78000, cond_exec="market", slippage_bps=50)
x = SENT[0] if SENT else {}
check("buy above the mark = stop market", r.status_code == 200 and x.get("order_type") == S.ORDER_TYPE_STOP_LOSS and x["trigger_price"] == 780000 and x["time_in_force"] == S.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL and x["price"] == 783900 and not x.get("reduce_only") and x["base_amount"] == round(1000 / 78000 * 1e5), (r.text, x))
r = order(kind="conditional", trigger_price=74000, cond_exec="limit", price=74100)
x = SENT[0] if SENT else {}
check("buy below the mark = take-profit limit", r.status_code == 200 and x.get("order_type") == S.ORDER_TYPE_TAKE_PROFIT_LIMIT and x["price"] == 741000 and x["trigger_price"] == 740000 and x["time_in_force"] == S.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME, (r.text, x))
r = order(side="sell", kind="conditional", trigger_price=74000, cond_exec="market", reduce_only=True)
x = SENT[0] if SENT else {}
check("sell below the mark = stop, reduce-only", r.status_code == 200 and x.get("order_type") == S.ORDER_TYPE_STOP_LOSS and x["is_ask"] and x["reduce_only"], (r.text, x))
r = order(kind="conditional"); check("no trigger refused", r.status_code == 400 and not SENT, r.text)
r = order(kind="conditional", trigger_price=78000, sl_price=70000); check("SL on an advanced order refused", r.status_code == 400, r.text)

t0 = time.time() * 1000
r = order(kind="twap", twap_minutes=60)
x = SENT[0] if SENT else {}
check("TWAP: type, GTT, expiry in 1h, bound 3%", r.status_code == 200 and x.get("order_type") == S.ORDER_TYPE_TWAP and x["time_in_force"] == S.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME and abs(x["order_expiry"] - t0 - 3600000) < 5000 and x["price"] == round(76010 * 1.03 * 10) and not x.get("trigger_price"), (r.text, x))
r = order(kind="twap", twap_minutes=30, price=77000); x = SENT[0] if SENT else {}
check("TWAP with its own limit", r.status_code == 200 and x["price"] == 770000, (r.text, x))
r = order(kind="twap", twap_minutes=2); check("TWAP under 5 minutes refused", r.status_code == 400 and not SENT, r.text)
r = order(kind="twap", twap_minutes=1441); check("TWAP over 24 hours refused", r.status_code == 400 and not SENT, r.text)

r = order(kind="scale", scale_from=70000, scale_to=74000, scale_count=5, scale_dist="even")
prices = [s["price"] for s in SENT]; sizes = [s["base_amount"] for s in SENT]
check("scale: 5 limits at even steps", r.status_code == 200 and prices == [700000, 710000, 720000, 730000, 740000] and all(s["order_type"] == S.ORDER_TYPE_LIMIT for s in SENT), (r.text, prices))
usd = sum(s["base_amount"] / 1e5 * s["price"] / 10 for s in SENT)
check("scale: the whole order adds up to the size", abs(usd - 1000) < 1, usd)
r = order(kind="scale", scale_from=70000, scale_to=74000, scale_count=4, scale_dist="low"); sizes = [s["base_amount"] for s in SENT]
check("scale: more at the lower prices", sizes == sorted(sizes, reverse=True) and sizes[0] > sizes[-1], sizes)
r = order(kind="scale", scale_from=70000, scale_to=80000, scale_count=3); check("scale crossing the market refused", r.status_code == 400 and not SENT and "80000" in r.text, r.text)
r = order(size=30, kind="scale", scale_from=70000, scale_to=74000, scale_count=5); check("scale under the minimum refused", r.status_code == 400 and not SENT, r.text)
r = order(kind="scale", scale_from=70000, scale_to=74000, scale_count=25); check("scale over 20 orders refused", r.status_code == 400, r.text)
# a failure half way says how far it got
class Fail(Signer):
    n = 0
    async def create_order(self, **kw):
        Fail.n += 1
        if Fail.n == 3: return None, None, "boom"
        return None, "ok", None
main.api.signer = Fail()
r = order(kind="scale", scale_from=70000, scale_to=74000, scale_count=5); check("scale failing half way reports it", r.status_code == 400 and "2" in r.text and "5" in r.text, r.text)
main.api.signer = Signer()
# chase and iceberg: start a rule on the engine, nothing goes out from the request itself
main.engine.armed = False
r = order(kind="chase"); check("chase with Auto off refused", r.status_code == 400 and "Auto" in r.text and not main.engine.rules, r.text)
main.engine.armed = True
r = order(kind="chase", chase_cap=77000, chase_minutes=5, chase_market=True)
x = next((v for v in main.engine.rules.values() if v["type"] == "chase"), {})
check("chase: rule with its fields", r.status_code == 200 and not SENT and x.get("side") == 1 and x.get("cap") == 77000 and x.get("then_market") and x.get("until", 0) > time.time() and abs(x.get("qty", 0) - round(1000 / 75990, 5)) < 1e-9 or abs(x.get("qty", 0) - round(1000 / 76010, 5)) < 1e-9, (r.text, x))
r = order(kind="chase", chase_minutes=2000); check("chase over 24 hours refused", r.status_code == 400, r.text)
r = order(kind="chase", sl_price=70000); check("SL on a chase refused", r.status_code == 400, r.text)
r = order(side="sell", kind="iceberg", price=78000, ice_slice=10, post_only=True)
x = next((v for v in main.engine.rules.values() if v["type"] == "iceberg"), {})
check("iceberg: rule with its fields", r.status_code == 200 and not SENT and x.get("side") == -1 and x.get("price") == 78000 and x.get("slice_pct") == 10 and x.get("post_only"), (r.text, x))
r = order(kind="iceberg", ice_slice=10); check("iceberg without a price refused", r.status_code == 400, r.text)
r = order(kind="iceberg", price=70000, ice_slice=60); check("iceberg slice over 50% refused", r.status_code == 400, r.text)
r = order(size=30, kind="iceberg", price=70000, ice_slice=10); check("iceberg slice under the minimum refused", r.status_code == 400 and "minim" in r.text.lower(), r.text)
main.engine.rules.clear()
# from the browser: the visitor's own engine takes it
async def own_engine(request): return main.engine
main.visitor_engine = own_engine
vis = lambda **b: c.post("/api/u/working", json={"market_id": 1, "side": 1, "qty": 0.01, **b}, headers={"X-Lighter-Auth": "x"})
r = vis(kind="chase", cap=77000, minutes=5, then_market=True); x = next((v for v in main.engine.rules.values() if v["type"] == "chase"), {})
check("browser: chase reaches the engine", r.status_code == 200 and x.get("cap") == 77000 and x.get("then_market"), r.text)
r = vis(kind="iceberg", price=70000, slice_pct=10); check("browser: iceberg reaches the engine", r.status_code == 200 and any(v["type"] == "iceberg" for v in main.engine.rules.values()), r.text)
for bad in (dict(kind="market"), dict(kind="chase", side=2), dict(kind="chase", qty=-1), dict(kind="iceberg", slice_pct=10), dict(kind="iceberg", price=70000, slice_pct=90), dict(kind="chase", minutes=5000)):
    r = vis(**bad); check(f"browser: refused {bad}", r.status_code == 400, r.text)
main.engine.armed = False; r = vis(kind="chase"); check("browser: refused with Auto off", r.status_code == 400 and "Auto" in r.text, r.text)
main.engine.armed = True; main.engine.rules.clear()
# leverage with tenths
LEV = []
async def fake_lev(mid, l, cross=True): LEV.append((mid, l, cross))
real_lev, main.api.set_leverage = main.api.set_leverage, fake_lev
r = c.post("/api/leverage?market_id=1&leverage=12.9&cross=false"); check("leverage takes tenths", r.status_code == 200 and LEV == [(1, 12.9, False)], (r.text, LEV))
r = c.post("/api/leverage?market_id=1&leverage=50.5"); check("over the market's maximum refused", r.status_code == 400 and len(LEV) == 1, r.text)
r = c.post("/api/leverage?market_id=1&leverage=0.5"); check("under 1x refused", r.status_code == 400 and len(LEV) == 1, r.text)
main.api.set_leverage = real_lev
# basic orders untouched
r = order(kind="market", slippage_bps=50); check("market order still works", r.status_code == 200 and SENT[0].get("order_type") == S.ORDER_TYPE_MARKET, (r.text, SENT))
print("ALL PASS" if all(ok) else f"{ok.count(False)} FAILED")
