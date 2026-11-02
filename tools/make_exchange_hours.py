"""Exchange sessions for the market-hours panel: open, close and lunch break of every trading day,
holidays and half-days included, for the next year. Writes frontend/exchange_hours.json.

Uses the exchange_calendars library (Apache-2.0) offline, so the server doesn't need it:
  python -m venv venv && venv/Scripts/pip install exchange_calendars
  venv/Scripts/python tools/make_exchange_hours.py
Run it again before each release; the panel falls back to plain weekday hours past the last date.
"""
import json
from datetime import date, timedelta
from pathlib import Path

import exchange_calendars as xc

CODES = ["XNYS", "XLON", "XETR", "XTKS", "XSHG", "XHKG", "XASX"]  # NYSE, LSE, Xetra, Tokyo, Shanghai, HKEX, ASX
out_file = Path(__file__).resolve().parent.parent / "frontend" / "exchange_hours.json"

start = date.today() - timedelta(days=3)
out = {"generated": date.today().isoformat(), "exchanges": {}}
for code in CODES:
    cal = xc.get_calendar(code, start=start.isoformat())
    sessions = []
    for _, row in cal.schedule.iterrows():
        s = [int(row["open"].timestamp()), int(row["close"].timestamp())]
        if row["break_start"] == row["break_start"]:  # not NaT
            s += [int(row["break_start"].timestamp()), int(row["break_end"].timestamp())]
        sessions.append(s)
    out["exchanges"][code] = {"until": sessions[-1][1], "sessions": sessions}
    print(code, len(sessions), "sessions until", cal.last_session.date())

out_file.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print("wrote", out_file, out_file.stat().st_size, "bytes")
