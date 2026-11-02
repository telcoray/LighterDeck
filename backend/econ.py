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

- Earnings: Nasdaq's public earnings calendar, one request per weekday, kept for the stocks
  listed on Lighter and for US companies worth $300B or more (they move the indices). Nasdaq
  only says "before the open" or "after the close", so those times are approximate.

- Crypto: Deribit's monthly and quarterly BTC/ETH option expiries (last Friday, 08:00 UTC).
  Token unlocks and network upgrades have no free, reliable feed: those go in as the user's own
  events (data/custom_events.json), which can name any market.

Events that move one kind of asset rather than a currency carry `assets` (e.g. ["oil"],
["stock:NVDA", "index"]) and, when the impact differs per asset, `impact_by`; the UI matches
them to markets (WTI, BRENTOIL -> oil, NATGAS -> natgas, a stock -> its own earnings,
ETF/index markets -> the largest companies' earnings).

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
NASDAQ_EARNINGS = "https://api.nasdaq.com/api/calendar/earnings?date={}"
EARNINGS_AHEAD_DAYS = 45
INDEX_MOVER_CAP = 300e9   # market cap from which a company's earnings matter for the indices
INDEX_HIGH_CAP = 1e12
# Nasdaq gives only the session; these are the usual release times, marked as approximate
EARNINGS_TIMES = {"time-pre-market": ((8, 0), "before the open"), "time-after-hours": ((16, 5), "after the close")}
CACHE = config.DATA_DIR / "calendar.json"
CUSTOM_FILE = config.DATA_DIR / "custom_events.json"
IMPACTS = ("High", "Medium", "Low")
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


def _money(text):
    try:
        return float(re.sub(r"[^\d.]", "", text or "") or 0)
    except ValueError:
        return 0.0


def parse_earnings(day, data, stocks):
    """Earnings rows of one day: the stocks on Lighter, plus the largest companies for the indices."""
    out = []
    for r in ((data or {}).get("data") or {}).get("rows") or []:
        sym, cap = r.get("symbol", ""), _money(r.get("marketCap"))
        if sym not in stocks and cap < INDEX_MOVER_CAP:
            continue
        hm, when = EARNINGS_TIMES.get(r.get("time"), ((12, 0), "time not given"))
        e = _make(f"{sym} earnings", "USD", _at(day, hm), "Low", "Nasdaq",
                  r.get("epsForecast", ""), r.get("lastYearEPS", ""))
        e["assets"], e["impact_by"] = [], {}
        if sym in stocks:
            e["assets"].append(f"stock:{sym}")
            e["impact_by"][f"stock:{sym}"] = "High"
        if cap >= INDEX_MOVER_CAP:
            e["assets"].append("index")
            e["impact_by"]["index"] = "High" if cap >= INDEX_HIGH_CAP else "Medium"
        e["when"], e["name"], e["approx"] = when, r.get("name", ""), True
        out.append(e)
    return out


def option_expiries(start, end):
    """Deribit BTC/ETH options: monthly on the last Friday at 08:00 UTC, quarterly in Mar/Jun/Sep/Dec."""
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        last = datetime(y + (m == 12), m % 12 + 1, 1).date() - timedelta(days=1)
        fri = last - timedelta(days=(last.weekday() - 4) % 7)
        if start <= fri <= end:
            quarterly = m in (3, 6, 9, 12)
            ts = datetime(fri.year, fri.month, fri.day, 8, 0, tzinfo=timezone.utc).timestamp()
            e = _make(f"Deribit BTC & ETH options expiry ({'quarterly' if quarterly else 'monthly'})", "", ts,
                      "Low", "Deribit")
            e["assets"] = ["sym:BTC", "sym:ETH"]
            e["impact_by"] = {a: "High" if quarterly else "Medium" for a in e["assets"]}
            out.append(e)
        y, m = y + (m == 12), m % 12 + 1
    return out


# Which events move a market: the same rules as marketFocus / eventFor / impactFor in frontend/app.js
CURRENCIES = ("USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "KRW")
MARKET_ASSETS = {"WTI": ["oil"], "BRENTOIL": ["oil"], "NATGAS": ["natgas"]}
IMPACT_RANK = {"Low": 0, "Medium": 1, "High": 2}


def market_focus(symbol, categories):
    fx = len(symbol) == 6 and symbol[:3] in CURRENCIES and symbol[3:] in CURRENCIES
    assets = [f"sym:{symbol}", *MARKET_ASSETS.get(symbol, []),
              *([f"stock:{symbol}"] if "STOCK" in categories else []), *(["index"] if "ETF" in categories else [])]
    return assets, ([symbol[:3], symbol[3:]] if fx else ["USD"])


def impact_for(e, assets, ccy):
    """The event's impact on a market, or None when it doesn't move it."""
    if e.get("assets"):
        mine = [a for a in e["assets"] if a in assets]
        return max(((e.get("impact_by") or {}).get(a, "High") for a in mine), key=IMPACT_RANK.get, default=None)
    return e["impact"] if e["country"] in ccy else None


class Calendar:
    def __init__(self):
        self.events = {}  # id -> event
        self._official_at = 0
        self.stock_symbols = lambda: set()  # set by main once the markets are loaded
        self.custom = {}  # the user's own events, kept apart from the feeds and never pruned
        if CACHE.exists():
            try:
                self.events = {e["id"]: e for e in json.loads(CACHE.read_text())}
            except Exception:
                log.warning("calendar cache unreadable, starting empty")
        if CUSTOM_FILE.exists() and not config.PUBLIC_MODE:  # the public site keeps visitors' events in their browser
            try:
                self.custom = {e["id"]: e for e in json.loads(CUSTOM_FILE.read_text())}
            except Exception:
                log.warning("custom events unreadable, starting empty")

    def get(self, event_id):
        return self.events.get(event_id) or self.custom.get(event_id)

    def add_custom(self, title, ts, markets, impact):
        """An event of the user's own: a token unlock, an upgrade, anything no feed covers."""
        title = (title or "").strip()
        if not 1 <= len(title) <= 80:
            raise ValueError("title")
        if impact not in IMPACTS:
            raise ValueError("impact")
        markets = sorted({m.strip().upper() for m in markets if m.strip()})
        e = _make(title, "", ts, impact, "custom")
        e["assets"] = [f"sym:{m}" for m in markets]
        e["impact_by"] = {a: impact for a in e["assets"]}
        e["markets"] = markets
        self.custom[e["id"]] = e
        CUSTOM_FILE.write_text(json.dumps(list(self.custom.values()), indent=1))
        return e

    def delete_custom(self, event_id):
        if self.custom.pop(event_id, None) is None:
            raise KeyError(event_id)
        CUSTOM_FILE.write_text(json.dumps(list(self.custom.values()), indent=1))

    def listing(self, days_back=1):
        now = time.time()
        rows = [e for e in [*self.events.values(), *self.custom.values()] if e["ts"] >= now - days_back * 86400]
        # an official release already listed by the weekly feed (same minute) is a duplicate
        ff = [e for e in rows if e.get("source", "ff") == "ff" and e["country"] == "USD"]
        weekly, weekly_titles = {e["ts"] // 60 for e in ff}, {(e["ts"] // 60, e["title"]) for e in ff}

        def duplicate(e):
            if _assets(e["title"]) and e.get("source") != "ff":  # an energy report: the same one in the weekly feed
                return (e["ts"] // 60, e["title"]) in weekly_titles
            return e.get("source") in ("BEA", "Fed") and e["ts"] // 60 in weekly  # official US releases
        rows = [e for e in rows if not duplicate(e)]
        for e in rows:  # also tags events cached before tags existed
            if _assets(e["title"]):
                e["assets"] = _assets(e["title"])
        return sorted(rows, key=lambda e: e["ts"])

    def next_for(self, symbol, categories, now=None):
        """The next event for a market: its own (an oil report, its earnings…) within 30 days first,
        then the next high-impact release, then a medium one in the coming week."""
        now = now or time.time()
        assets, ccy = market_focus(symbol, categories)
        upcoming = [(e, impact_for(e, assets, ccy)) for e in self.listing(days_back=0) if e["ts"] > now]
        own = [e for e, imp in upcoming if imp == "High" and e.get("assets") and e["ts"] < now + 30 * 86400]
        high = [e for e, imp in upcoming if imp == "High"]
        medium = [e for e, imp in upcoming if imp == "Medium" and e["ts"] < now + 7 * 86400]
        return (own or high or medium or [None])[0]

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
                found += option_expiries(today - timedelta(days=35), today + timedelta(days=OFFICIAL_HORIZON_DAYS))
                stocks = self.stock_symbols()
                if stocks:
                    for n in range(-35, EARNINGS_AHEAD_DAYS + 1):
                        day = today + timedelta(days=n)
                        if day.weekday() < 5:
                            found += parse_earnings(day, await self._fetch(s, NASDAQ_EARNINGS.format(day), as_json=True), stocks)
                            await asyncio.sleep(0.3)  # one gentle request at a time
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
