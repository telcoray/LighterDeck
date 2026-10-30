"""Economic calendar.

Two sources, merged:
- Forex Factory weekly JSON: this week's releases for every country, with impact,
  forecast and previous (no "actual" value).
- Official US schedules (BEA release calendar, Fed FOMC calendar): verified dates
  months ahead, so event rules can be planned beyond the current week.
  BLS (CPI, jobs) blocks automated requests, so those come from the weekly feed only.

Rules react to the event *time* and to price action around it, not to the released number.
"""
import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import aiohttp

import config

log = logging.getLogger("econ")

FF_FEEDS = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
]
BEA_ICS = "https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics"
FOMC_PAGE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
CACHE = config.DATA_DIR / "calendar.json"
REFRESH_SECONDS = 30 * 60          # the weekly feed asks for gentle polling
OFFICIAL_REFRESH_SECONDS = 12 * 3600
OFFICIAL_HORIZON_DAYS = 120
EASTERN = ZoneInfo("America/New_York")

# BEA releases worth trading around: (prefix of the ICS summary, our title, impact)
BEA_RELEASES = [
    ("Gross Domestic Product", "GDP", "High"),
    ("Personal Income and Outlays", "PCE · income & spending", "High"),
    ("U.S. International Trade in Goods and Services", "Trade balance", "Medium"),
]
MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August",
     "September", "October", "November", "December"], 1)}


def _event_id(e):
    return hashlib.sha1(f"{e['country']}|{e['title']}|{e['date']}".encode()).hexdigest()[:12]


def _make(title, country, ts, impact, source, forecast="", previous=""):
    e = {"title": title, "country": country, "date": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
         "ts": int(ts), "impact": impact, "forecast": forecast, "previous": previous, "source": source}
    e["id"] = _event_id(e)
    return e


def parse_bea(ics):
    """Major BEA releases from the ICS subscription (folded lines unfolded first)."""
    text = re.sub(r"\r?\n[ \t]", "", ics)
    out = []
    for block in text.split("BEGIN:VEVENT")[1:]:
        summary = re.search(r"^SUMMARY:(.*)$", block, re.M)
        start = re.search(r"^DTSTART[^:]*:(\d{8}T\d{6})(Z?)$", block, re.M)
        if not summary or not start:
            continue
        name = summary.group(1).replace("\\,", ",").strip()
        for prefix, title, impact in BEA_RELEASES:
            if name.startswith(prefix):
                dt = datetime.strptime(start.group(1), "%Y%m%dT%H%M%S")
                dt = dt.replace(tzinfo=timezone.utc if start.group(2) else EASTERN)
                detail = name[len(prefix):].strip(" ,")
                full = f"{title} ({detail})" if detail and title == "GDP" else title
                out.append(_make(full, "USD", dt.timestamp(), impact, "BEA"))
                break
    return out


def parse_fomc(html):
    """FOMC rate decisions: 14:00 New York on the last day of each scheduled meeting."""
    out = []
    for section in re.split(r"<h4><a id=\"\d+\">", html)[1:]:
        year = re.match(r"(\d{4}) FOMC Meetings", section)
        if not year:
            continue
        year = int(year.group(1))
        rows = re.findall(
            r"fomc-meeting__month[^>]*><strong>([A-Za-z/]+)</strong></div>\s*"
            r"<div class=\"fomc-meeting__date[^>]*>([^<]+)</div>", section)
        for month, days in rows:
            m = re.match(r"\s*(\d+)(?:-(\d+))?(\*)?\s*$", days)
            if not m:  # e.g. "22 (notation vote)", unscheduled meetings
                continue
            last_month = month.split("/")[-1]
            if last_month not in MONTHS:
                continue
            day = int(m.group(2) or m.group(1))
            dt = datetime(year, MONTHS[last_month], day, 14, 0, tzinfo=EASTERN)
            title = "FOMC rate decision" + (" + projections" if m.group(3) else "")
            out.append(_make(title, "USD", dt.timestamp(), "High", "Fed"))
    return out


class Calendar:
    def __init__(self):
        self.events = {}  # id -> event
        self._official_at = 0
        if CACHE.exists():
            try:
                self.events = {e["id"]: e for e in json.loads(CACHE.read_text())}
            except Exception:
                log.warning("calendar cache unreadable, starting empty")

    def get(self, event_id):
        return self.events.get(event_id)

    def listing(self, days_back=1):
        now = time.time()
        rows = [e for e in self.events.values() if e["ts"] >= now - days_back * 86400]
        # an official release already listed by the weekly feed (same minute) is a duplicate
        weekly = {e["ts"] // 60 for e in rows if e.get("source", "ff") == "ff" and e["country"] == "USD"}
        rows = [e for e in rows if e.get("source", "ff") == "ff" or e["ts"] // 60 not in weekly]
        return sorted(rows, key=lambda e: e["ts"])

    async def _fetch(self, s, url, as_json=False):
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status != 200:
                    log.info("calendar %s -> %s", url.rsplit("/", 1)[-1], r.status)
                    return None
                return await r.json(content_type=None) if as_json else await r.text()
        except Exception as e:
            log.warning("calendar fetch %s failed: %s", url, e)
            return None

    async def refresh(self):
        async with aiohttp.ClientSession(headers={"User-Agent": "LighterDeck/1.0 (personal calendar)"}) as s:
            for url in FF_FEEDS:
                for it in await self._fetch(s, url, as_json=True) or []:
                    ts = datetime.fromisoformat(it["date"]).timestamp()
                    e = _make(it["title"], it["country"], ts, it.get("impact", ""), "ff",
                              it.get("forecast", ""), it.get("previous", ""))
                    e["date"] = it["date"]
                    e["id"] = _event_id(e)
                    self.events[e["id"]] = e

            if time.time() - self._official_at > OFFICIAL_REFRESH_SECONDS:
                horizon = time.time() + OFFICIAL_HORIZON_DAYS * 86400
                found = []
                bea = await self._fetch(s, BEA_ICS)
                if bea:
                    found += parse_bea(bea)
                fomc = await self._fetch(s, FOMC_PAGE)
                if fomc:
                    found += parse_fomc(fomc)
                if bea and fomc:
                    self._official_at = time.time()
                for e in found:
                    if time.time() - 35 * 86400 <= e["ts"] <= horizon:
                        self.events[e["id"]] = e
                log.info("official calendar: %d events", len(found))

        cutoff = time.time() - 35 * 86400  # keep ~5 weeks of history
        self.events = {k: v for k, v in self.events.items() if v["ts"] >= cutoff}
        CACHE.write_text(json.dumps(list(self.events.values())))

    async def run(self):
        while True:
            await self.refresh()
            await asyncio.sleep(REFRESH_SECONDS)
