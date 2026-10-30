"""Candle timeframes.

Lighter serves 1m, 5m, 15m, 30m, 1h, 4h, 12h and 1d (max 500 candles per request).
Other timeframes are built by merging those, the same way Lighter's own site does:
3m = 3 x 1m, 2h = 2 x 1h, 8h = 2 x 4h, 3d = 3 x 1d, 1w = Monday-start weeks of 1d,
1M = calendar months of 1d. All buckets are UTC.
"""
from datetime import datetime, timezone

NATIVE = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400}
DERIVED = {  # timeframe -> (source, bucket)
    "3m": ("1m", 180), "2h": ("1h", 7200), "8h": ("4h", 28800), "3d": ("1d", 259200),
    "1w": ("1d", "week"), "1M": ("1d", "month"),
}
APPROX_SECS = {**NATIVE, "3m": 180, "2h": 7200, "8h": 28800, "3d": 259200, "1w": 604800, "1M": 2592000}
TIMEFRAMES = list(APPROX_SECS)
PAGE = 500


def bucket_start(ts, bucket):
    """Start (unix seconds, UTC) of the bucket containing ts."""
    if bucket == "week":  # 1970-01-01 was a Thursday; weeks start on Monday
        day = ts // 86400
        return (day - (day + 3) % 7) * 86400
    if bucket == "month":
        d = datetime.fromtimestamp(ts, timezone.utc)
        return int(datetime(d.year, d.month, 1, tzinfo=timezone.utc).timestamp())
    return ts // bucket * bucket


def merge(candles, bucket):
    out = []
    for c in candles:
        t = bucket_start(c["time"], bucket)
        if out and out[-1]["time"] == t:
            b = out[-1]
            b["high"] = max(b["high"], c["high"])
            b["low"] = min(b["low"], c["low"])
            b["close"] = c["close"]
            b["volume"] += c["volume"]
        else:
            out.append({**c, "time": t})
    return out


def source_needed(resolution, count):
    """(source timeframe, how many source candles cover `count` bars)."""
    if resolution in NATIVE:
        return resolution, count
    src, bucket = DERIVED[resolution]
    span = APPROX_SECS[resolution] + (86400 * 3 if bucket == "month" else 0)
    return src, count * span // NATIVE[src]
