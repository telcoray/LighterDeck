"""A funding payment as the Funding history tab shows it. Made-up rows, nothing leaves this process."""
import os, sys, tempfile
from pathlib import Path
os.environ.update(DATA_DIR=tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import lighter_api

class M:
    symbol = "BTC"

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)

# Lighter's testnet, 2026-11-09: rate 3e-06 on a payment worth 0.0003% of the position
row = lighter_api.funding_row({"timestamp": 1794250800, "market_id": 1, "change": "-0.056", "rate": "0.000003", "position_size": "0.25", "position_side": "long"}, M())
check("the rate is a % per hour", abs(row["rate"] - 0.0003) < 1e-12, row)
check("a long that paid: positive rate, negative money", row["rate"] > 0 and row["change"] < 0 and row["side"] == "long", row)
check("milliseconds, symbol, size", row["ts"] == 1794250800000 and row["symbol"] == "BTC" and row["size"] == 0.25, row)
row = lighter_api.funding_row({"timestamp": 1, "market_id": 1, "change": "0.02", "rate": "0.000003", "position_size": "0.25", "position_side": "long"}, M())
check("a long that received: negative rate", row["rate"] < 0 and row["change"] > 0, row)
row = lighter_api.funding_row({"timestamp": 1, "market_id": 9, "change": "0.02", "rate": "-0.000003", "position_size": "-2", "position_side": "short"}, None)
check("a short that received: positive rate, whatever sign Lighter sends; unknown market by its id", row["rate"] > 0 and row["size"] == 2 and row["symbol"] == "9", row)
