"""Economic calendar.

Sources, merged:
- Forex Factory weekly JSON: this week's releases for every country, with impact,
  forecast and previous (no "actual" value).
- Official US schedules (BEA release calendar, Fed FOMC calendar): verified dates
  months ahead, so event rules can be planned beyond the current week.
  BLS (CPI, jobs) blocks automated requests, so those come from the weekly feed only.
- Energy: EIA crude inventories (Wednesday 10:30 New York) and gas storage (Thursday 10:30),
  with the holiday exceptions from EIA's own schedule pages; the API bulletin the evening
  before the EIA crude report; the Baker Hughes rig count (Friday 13:00).

Events that move one kind of asset rather than a currency carry `assets` (e.g. ["oil"]);
the UI matches them to markets (WTI, BRENTOIL -> oil, NATGAS -> natgas).

Rules react to the event *time* and to price action around it, not to the released number.
"""
import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
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
EIA_WPSR_SCHEDULE = "https://www.eia.gov/petroleum/supply/weekly/schedule.php"
EIA_NGS_SCHEDULE = "https://ir.eia.gov/ngs/schedule.html"
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


# events that move a kind of asset, by title (the weekly feed lists them as low-impact USD)
ASSET_TITLES = [
    (("crude oil inventories", "api weekly statistical bulletin", "rig count", "opec"), "oil"),
    (("natural gas storage",), "natgas"),
]


def _assets(title):
    t = title.lower()
    return [asset for words, asset in ASSET_TITLES if any(w in t for w in words)]


def _event_id(e):
    return hashlib.sha1(f"{e['country']}|{e['title']}|{e['date']}".encode()).hexdigest()[:12]


def _make(title, country, ts, impact, source, forecast="", previous=""):
    e = {"title": title, "country": country, "date": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
         "ts": int(ts), "impact": impact, "forecast": forecast, "previous": previous, "source": source}
    assets = _assets(title)
    if assets:
        e["assets"] = assets
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


def _schedule_rows(html):
    """Table cells of an EIA schedule page, row by row, as plain text."""
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        if cells:
            rows.append(cells)
    return rows


def _day(text):
    m = re.search(r"([A-Z][a-z]+) (\d{1,2}), (\d{4})", text)
    return datetime(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2))).date() if m and m.group(1) in MONTHS else None


def _clock(text):
    m = re.search(r"(\d{1,2}):(\d{2}) ?([ap])\.?m", text, re.I)
    if not m:
        return None
    h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "p" else 0)
    return h, int(m.group(2))


def _at(day, hm):
    return datetime(day.year, day.month, day.day, hm[0], hm[1], tzinfo=EASTERN).timestamp()


def _weekdays(start, end, weekday):
    """Dates between start and end (dates) that fall on `weekday` (Monday = 0)."""
    d = start + timedelta(days=(weekday - start.weekday()) % 7)
    while d <= end:
        yield d
        d += timedelta(days=7)


def _easter(year):
    """Gregorian Easter Sunday (anonymous algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = divmod(b, 4)
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return datetime(year, month, day + 1).date()


def energy_events(start, end, wpsr_html=None, ngs_html=None):
    """EIA crude (Wednesday 10:30) and gas storage (Thursday 10:30) with EIA's holiday exceptions,
    the API bulletin at 16:30 the day before the EIA crude report, Baker Hughes on Friday 13:00."""
    out = []
    # crude: exceptions keyed by the standard Wednesday (data week ending Friday + 5 days)
    crude_moves = {}
    for cells in _schedule_rows(wpsr_html or ""):
        if len(cells) >= 4 and _day(cells[0]) and _day(cells[1]) and _clock(cells[3]):
            crude_moves[_day(cells[0]) + timedelta(days=5)] = (_day(cells[1]), _clock(cells[3]))
    for wed in _weekdays(start, end, 2):
        day, hm = crude_moves.get(wed, (wed, (10, 30)))
        out.append(_make("Crude Oil Inventories", "USD", _at(day, hm), "Low", "EIA"))
        out.append(_make("API Weekly Statistical Bulletin", "USD", _at(day - timedelta(days=1), (16, 30)), "Low", "API"))
    # gas: an alternate date replaces the standard Thursday of its own week (the earlier of two
    # alternates in the same week, e.g. after Christmas and before New Year, takes the week before)
    gas_moves = {}
    for cells in _schedule_rows(ngs_html or ""):
        if len(cells) >= 3 and _day(cells[0]) and _clock(cells[-2] if len(cells) > 3 else cells[2]):
            alt = _day(cells[0])
            thu = alt + timedelta(days=3 - alt.weekday())
            if thu in gas_moves:
                gas_moves[thu - timedelta(days=7)] = gas_moves[thu]
            gas_moves[thu] = (alt, _clock(cells[-2] if len(cells) > 3 else cells[2]))
    for thu in _weekdays(start, end, 3):
        day, hm = gas_moves.get(thu, (thu, (10, 30)))
        out.append(_make("Natural Gas Storage", "USD", _at(day, hm), "Low", "EIA"))
    # rig count: Friday 13:00, a day earlier when Friday is a market holiday, Wednesday in Thanksgiving week
    for fri in _weekdays(start, end, 4):
        day = fri
        thanksgiving = datetime(fri.year, 11, 22).date()
        thanksgiving += timedelta(days=(3 - thanksgiving.weekday()) % 7)
        if fri == thanksgiving + timedelta(days=1):
            day = fri - timedelta(days=2)
        elif (fri.month, fri.day) in ((12, 25), (1, 1), (7, 4)) or fri == _easter(fri.year) - timedelta(days=2):
            day = fri - timedelta(days=1)
        out.append(_make("Baker Hughes Rig Count", "USD", _at(day, (13, 0)), "Low", "Baker Hughes"))
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
        for e in rows:  # also tags events cached before tags existed
            if _assets(e["title"]):
                e["assets"] = _assets(e["title"])
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
                today = datetime.now(EASTERN).date()
                found += energy_events(today - timedelta(days=35), today + timedelta(days=OFFICIAL_HORIZON_DAYS),
                                       await self._fetch(s, EIA_WPSR_SCHEDULE), await self._fetch(s, EIA_NGS_SCHEDULE))
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
