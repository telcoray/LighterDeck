"""The site's link preview card (frontend/og.png, 1200x630) with real BTC 4h candles from Lighter.

Drawn by backend/og.py, the same code and Ambra colours as each market's card:
  python tools/make_og.py
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import og  # noqa: E402

now = int(time.time())
url = (f"https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=1&resolution=4h"
       f"&start_timestamp={now - 4 * 3600 * 70}&end_timestamp={now}&count_back=70")
rows = json.load(urllib.request.urlopen(url, timeout=20))["c"][-56:]
bars = [{"open": float(c["o"]), "high": float(c["h"]), "low": float(c["l"]), "close": float(c["c"])} for c in rows]
out = ROOT / "frontend" / "og.png"
out.write_bytes(og.site_card(bars, f"{bars[-1]['close']:,.0f}"))
print("ok", len(bars), "bars, last", bars[-1]["close"], "->", out)
