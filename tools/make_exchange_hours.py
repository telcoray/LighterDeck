"""Exchange sessions for the market-hours panel: open, close and lunch break of every trading day,
holidays and half-days included, for the next year. Writes frontend/exchange_hours.json.

Each weekday the exchange is shut gets its holiday's name, from exchange_calendars or, for the ones it
lists without a name (lunar holidays, substitute days), from the holidays library.

Uses the exchange_calendars (Apache-2.0) and holidays (MIT) libraries offline, so the server doesn't need them:
  python -m venv venv && venv/Scripts/pip install exchange_calendars holidays
  venv/Scripts/python tools/make_exchange_hours.py
Run it again before each release; the panel falls back to plain weekday hours past the last date.
"""
import json
import re
from datetime import date, timedelta
from pathlib import Path

import exchange_calendars as xc
import holidays as hol
import pandas as pd

CODES = ["XNYS", "XLON", "XETR", "XTKS", "XSHG", "XHKG", "XKRX", "XASX"]  # NYSE, LSE, Xetra, Tokyo, Shanghai, HKEX, Korea Exchange, ASX (Calendar page only)
# the holidays library's country (and region) for each exchange
COUNTRY = {"XNYS": ("US", None), "XLON": ("GB", "ENG"), "XETR": ("DE", None), "XTKS": ("JP", None), "XSHG": ("CN", None),
           "XHKG": ("HK", None), "XKRX": ("KR", None), "XASX": ("AU", "NSW")}
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
    # the weekdays it is shut, by name
    names = {}
    regular = cal.regular_holidays.holidays(pd.Timestamp(start), cal.last_session, return_name=True) if cal.regular_holidays is not None else {}
    regular = {d.date(): n for d, n in dict(regular).items()}
    country, subdiv = COUNTRY[code]
    lib = hol.country_holidays(country, subdiv=subdiv, years=range(start.year, cal.last_session.year + 1), language="en_US")
    open_days = {d.date() for d in cal.sessions}
    d = start
    while d <= cal.last_session.date():
        if d.weekday() < 5 and d not in open_days:
            n = regular.get(d) or lib.get(d) or ""
            # short and plain: no "(2022 onwards)", "(+1 day)" or "(New Year's Day by the lunar)"; a weekend
            # holiday moved to Monday keeps its own name
            n = re.sub(r"\s*\([^)]*\)", "", n.split(";")[0]).replace("Kings's", "King's")
            n = re.sub(r"^Weekend ", "", n).strip()
            names[d.isoformat()] = n
        d += timedelta(days=1)
    out["exchanges"][code] = {"until": sessions[-1][1], "sessions": sessions, "holidays": names}
    print(code, len(sessions), "sessions until", cal.last_session.date())

out_file.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print("wrote", out_file, out_file.stat().st_size, "bytes")
