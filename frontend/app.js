"use strict";

// ================= state =================
const qs = new URLSearchParams(location.search);
if (qs.get("token")) { store("token", qs.get("token")); history.replaceState(null, "", location.pathname); }
const TOKEN = load("token", "");
// every timeframe the backend offers; 3m, 2h, 8h, 3d, 1w and 1M are merged from smaller candles
const ALL_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"];
const TF_LABEL = { "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M" };
const tfLabel = (tf) => TF_LABEL[tf] || tf;
const TF_SECS = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
                  "8h": 28800, "12h": 43200, "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2592000 };
// a phone has room for one row: no 30m there (it stays under More)
const DEFAULT_TFS = matchMedia("(hover: none), (max-width: 768px)").matches
  ? ["1m", "5m", "15m", "1h", "4h", "12h", "1d"]
  : ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"];
let shownTfs = load("tfs", DEFAULT_TFS).filter((t) => ALL_TFS.includes(t));

// The charts' times in the computer's own time zone, like the calendar (the library alone writes UTC).
// Only the labels change: the bars are still Lighter's UTC buckets, so a day's bar starts at midnight UTC.
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d, secs) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}${secs ? ":" + pad2(d.getSeconds()) : ""}`;
function localTick(time, type) {
  if (typeof time !== "number") return null;
  const d = new Date(time * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return d.toLocaleDateString(LOCALE, { month: "short" });
  if (type === 2) return String(d.getDate());
  return hhmm(d, type === 4);
}
function localStamp(time) {
  if (typeof time !== "number") return typeof time === "string" ? time : `${time.year}-${pad2(time.month)}-${pad2(time.day)}`;
  const d = new Date(time * 1000);
  return `${d.getDate()} ${d.toLocaleDateString(LOCALE, { month: "short" })} '${String(d.getFullYear()).slice(2)}  ${hhmm(d)}`;
}
const LOCAL_TIME = { localization: { timeFormatter: localStamp }, timeScale: { tickMarkFormatter: localTick } };

// start (UTC seconds) of the bar containing ts, matching the backend's buckets
function barStart(tf, ts) {
  if (tf === "1w") { const day = Math.floor(ts / 86400); return (day - ((day + 3) % 7)) * 86400; }
  if (tf === "1M") { const d = new Date(ts * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  const secs = TF_SECS[tf];
  return Math.floor(ts / secs) * secs;
}
// up and down: the theme's own green and red (read when used, so a theme change carries over)
const C = { get green() { return cssVar("--green") || "#2bd9a4"; }, get red() { return cssVar("--red") || "#f2546d"; } };

// ---------- themes: colours live in CSS variables (style.css), charts read them from there ----------
const THEMES = [ // Classic first, then alphabetical
  { id: "classic", name: "Classic", note: "i colori di Lighter" },
  { id: "ambra", name: "Ambra", note: "pro terminal look: nero, arancio e bianco" },
  { id: "champagne", name: "Champagne", note: "nero caldo, testo sabbia e oro" },
  { id: "fosforo", name: "Fosforo", note: "sfondo grafite, testo verde da terminale" },
  { id: "ghiaccio", name: "Ghiaccio", note: "blu notte, testo azzurro ghiaccio" },
  { id: "grafite", name: "Grafite", note: "il tema originale, grigi neutri" },
];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function chartTheme() {
  return {
    layout: { textColor: cssVar("--muted") },
    grid: { vertLines: { color: cssVar("--chart-grid") }, horzLines: { color: cssVar("--chart-grid") } },
    rightPriceScale: { borderColor: cssVar("--line") },
    timeScale: { borderColor: cssVar("--line") },
    crosshair: {
      vertLine: { color: cssVar("--line-3"), labelBackgroundColor: cssVar("--line-2") },
      horzLine: { color: cssVar("--line-3"), labelBackgroundColor: cssVar("--line-2") },
    },
  };
}

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  store("theme", theme.id);
  panels.forEach((p) => {
    p.chart.applyOptions(chartTheme());
    p.series.applyOptions({ upColor: C.green, downColor: C.red, wickUpColor: C.green, wickDownColor: C.red });
    p.drawLines();
    p.drawMarkers();
  });
  $("#themeBtn").title = `${t("Cambia tema")} · ${t(theme.name)}`;
  $("#themeSwatch").innerHTML = swatch();
  $("#themeMenu").innerHTML = THEMES.map((th) => `<button data-theme="${th.id}" class="${th.id === theme.id ? "active" : ""}">
      <span class="swatch" data-preview="${th.id}"></span><span>${t(th.name)}<small>${t(th.note)}</small></span><span class="check">✓</span></button>`).join("");
  // each menu swatch shows that theme's own colours
  $$("#themeMenu [data-preview]").forEach((el) => {
    const keep = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = el.dataset.preview;
    el.innerHTML = swatch();
    document.documentElement.dataset.theme = keep;
  });
}

function swatch() {
  return [cssVar("--bg"), cssVar("--text-2"), cssVar("--muted")].map((c) => `<i style="background:${c}"></i>`).join("");
}

let info = {}, markets = [], bySymbol = {}, byId = {};
let prices = {}, account = null, events = [], lastTick = 0;
let panels = [];
// first visit: four charts across crypto, gold and a stock, to show what Lighter lists
let panelCfg = load("panels", [
  { symbol: "BTC", tf: "1h" }, { symbol: "ETH", tf: "1h" }, { symbol: "XAU", tf: "1h" }, { symbol: "HOOD", tf: "1h" },
]);
// a phone shows one chart until it picks another layout; a computer starts with four
let layout = load("layout", matchMedia("(hover: none), (max-width: 768px)").matches ? "1" : "4");
let activeIdx = Math.min(load("active", 0), 3);
let favs = load("favs", ["BTC", "ETH", "LIT", "WTI", "XAU"]); // first visit
let showBook = load("book", false), showTape = load("tape", false);
const ticket = { side: "buy", kind: "market" };

function load(k, d) { try { const v = localStorage.getItem("ld." + k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function store(k, v) { try { localStorage.setItem("ld." + k, JSON.stringify(v)); } catch {} }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  if (Live.on) { // live trading with the key in this browser: signed here, sent to Lighter
    const r = Live.route(path, opts);
    if (r !== undefined) return r;
  }
  if (Paper.on) { // paper trading answers the trading calls in this browser
    const r = Paper.route(path, opts);
    if (r !== undefined) return r;
  }
  // a request the page already started while the scripts loaded (index.html): taken over once, if recent
  const pre = !opts.method && window.ldPre && window.ldPre[path];
  if (pre) {
    delete window.ldPre[path];
    if (Date.now() - pre.at < 20000) {
      try {
        return await new Promise((ok, no) => {
          pre.p.then(ok, no);
          if (opts.signal) opts.signal.addEventListener("abort", () => no(opts.signal.reason));
        });
      } catch {} // failed or too slow: asked again below
    }
  }
  const r = await fetch("/api" + path, { ...opts, headers: { "Content-Type": "application/json", "X-Token": TOKEN, "X-Lang": LANG, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || r.statusText), { status: r.status });
  return body;
}

// A short notice under the top bar. kind: true for an error (red mark, stays longer), "ok" for something the
// exchange or the app has just confirmed (green tick), nothing for plain information. A click sends it away.
const TOAST_ICO = {
  ok: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8.3l2.1 2.1L11 6.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  err: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".95" fill="currentColor"/></svg>',
};
function toast(msg, kind = false) {
  const el = $("#toast"), k = kind === true ? "err" : kind === "ok" ? "ok" : "";
  el.innerHTML = `${k ? `<i class="toast-ico">${TOAST_ICO[k]}</i>` : ""}<span></span>`;
  el.lastChild.textContent = msg;
  el.className = "toast" + (k ? " " + k : "");
  // a computer: at the right, centred on the favourites strip. A phone: just under the top bar,
  // at the top of the screen once the page has scrolled past it
  const strip = $(".ticker"), bar = $(".topbar");
  if (innerWidth > 860 && strip) {
    const r = strip.getBoundingClientRect();
    el.style.top = `${Math.max(6, Math.round(r.top + r.height / 2 - el.offsetHeight / 2))}px`;
  } else {
    const under = bar ? bar.getBoundingClientRect().bottom : 0;
    el.style.top = `${Math.max(10, Math.round(under) + 8)}px`;
  }
  void el.offsetWidth; // so the entrance plays again when one notice follows another
  el.classList.add("show");
  clearTimeout(toast.t);
  const leave = () => { el.classList.remove("show"); toast.t = setTimeout(() => el.classList.add("hidden"), 220); };
  toast.t = setTimeout(leave, k === "err" ? 6000 : 3500);
  el.onclick = () => { clearTimeout(toast.t); leave(); };
}

// ---------- formatting ----------
const decimals = (m) => (m ? Math.min(m.price_decimals, 6) : 2);
function fp(p, m) {
  if (p === null || p === undefined || p === 0 || isNaN(p)) return "—";
  const d = decimals(m);
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fusd(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fcompact(v) {
  if (!v) return "—";
  const a = Math.abs(v);
  return "$" + (a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
}
const fpct = (v, d = 2) => (v >= 0 ? "+" : "") + v.toFixed(d) + "%";
const cls = (v) => (v >= 0 ? "up" : "down");
// market logo (cached by the backend) with the initial underneath as fallback; one that fails to load goes
// (a listener, not an onerror attribute: the page's CSP runs no inline handlers)
document.addEventListener("error", (e) => { if (e.target.matches && e.target.matches("img[data-logo]")) e.target.remove(); }, true);
function ico(sym, size = "") {
  const m = bySymbol[sym];
  const img = m && m.has_logo ? `<img src="/logo/${encodeURIComponent(sym)}" alt="" loading="lazy" data-logo>` : "";
  return `<i class="mk-ico${size ? " " + size : ""}">${esc(sym[0])}${img}</i>`;
}
const fsize = (v, m) => Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: m ? m.size_decimals : 4 });

// "ETH/BTC": a spread chart, one market's price over another's; "ETH-BTC" in the address
const pairOf = (sym) => {
  if (!sym || !sym.includes("/")) return null;
  const [a, b] = sym.split("/");
  return bySymbol[a] && bySymbol[b] && a !== b ? [bySymbol[a], bySymbol[b]] : null;
};
const ratioDecimals = (r) => Math.min(6, Math.max(2, Math.ceil(4 - Math.log10(r))));
const Z_LEN = 50; // z-score: mean and standard deviation of the last 50 closes
function zStats(closes) {
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const sd = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / closes.length);
  return { mean, sd };
}

// ================= charts =================
// empty bars between the last candle and the price scale, so the live candle reads as the last one:
// fewer on a phone, where every bar of width counts
const rightGap = () => (innerWidth < 768 ? 1 : 4);

class Panel {
  constructor(idx) {
    this.idx = idx;
    this.el = document.createElement("div");
    this.el.className = "panel";
    this.el.innerHTML = `<div class="chart"></div>
      <div class="legend"><span class="ttl"></span><i class="dot"></i><span class="ohlc"></span></div>
      <div class="ctx-badges chart-ctx"></div>
      <div class="ev-tip hidden"></div>
      <div class="drag-ok hidden"></div>
      <div class="chart-menu hidden"></div>`;
    this.el.addEventListener("mousedown", () => setActive(this.idx));
    $(".ttl", this.el).addEventListener("click", (e) => { e.stopPropagation(); setActive(this.idx); openPalette(); });
    this.chart = LightweightCharts.createChart($(".chart", this.el), {
      autoSize: true,
      layout: { background: { color: "transparent" }, fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: rightGap(), barSpacing: 8 },
      crosshair: { mode: 0, vertLine: { style: 2 }, horzLine: { style: 2 } },
    });
    this.chart.applyOptions(chartTheme());
    this.chart.applyOptions(LOCAL_TIME);
    this.series = this.chart.addCandlestickSeries({
      upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: C.green, wickDownColor: C.red,
      priceLineStyle: 2, priceLineWidth: 1, // last-price line and label take the candle colour
    });
    this.vol = this.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    this.lines = [];
    this.dragOrders = [];  // open orders on this chart that can be dragged: { line, price, label, order }
    this.dragPreview = []; // ticket preview lines that can be dragged: { line, price, label, kind, preview }
    // the price scale follows the candles only: a line (an order, the ticket's SL or TP, the managed stop) shows when
    // it falls inside, and a farther one is reached with a larger timeframe or by zooming out, not by the chart
    // stretching and snapping back under it
    this.series.applyOptions({ autoscaleInfoProvider: (original) => {
      const r = original();
      if (!r || !r.priceRange) return r;
      let lo = r.priceRange.minValue, hi = r.priceRange.maxValue;
      // the mouse wheel over the price scale stretches or squeezes the prices around the middle
      if (this.yZoom !== 1) { const mid = (lo + hi) / 2, half = (hi - lo) / 2 * this.yZoom; lo = mid - half; hi = mid + half; }
      // no room added for the marks (fills, event dots): showing or hiding them doesn't resize the candles;
      // they sit in the scale's own top and bottom margins
      return { priceRange: { minValue: lo, maxValue: hi } };
    } });
    this.yZoom = 1;
    this.wireDrag();
    this.wirePriceZoom();
    this.wireOrderMenu();
    this.data = new Map();
    this.eventBars = new Map();
    this.fills = [];          // this market's latest fills, grouped by order
    this.fillBars = new Map(); // bar time -> the fill groups drawn on it
    this.chart.subscribeCrosshairMove((p) => {
      const at = p && p.point ? this.series.coordinateToPrice(p.point.y) : null;
      this.pointerPrice = at > 0 ? at : null;
      if (this.pointerPrice) hoverPanel = this;
      else if (hoverPanel === this) hoverPanel = null;
      const bar = p && p.time ? this.data.get(p.time) : null;
      this.hover = bar || null;
      this.renderLegend();
      this.renderEventTip(p, bar);
    });
    // a finger has no hover: a tap shows the events or fills of the nearest dot or arrow
    this.chart.subscribeClick((p) => {
      if (!touchUI() || !p || !p.point) return;
      const ts = this.chart.timeScale();
      let best = null, gap = 18;
      for (const t of new Set([...this.eventBars.keys(), ...this.fillBars.keys()])) {
        const x = ts.timeToCoordinate(t);
        if (x !== null && Math.abs(x - p.point.x) < gap) { best = t; gap = Math.abs(x - p.point.x); }
      }
      this.renderEventTip(p, best !== null ? this.data.get(best) : null, 18);
    });
  }

  get cfg() { return panelCfg[this.idx]; }
  get market() { return bySymbol[this.cfg.symbol]; }
  get pair() { return pairOf(this.cfg.symbol); }

  async load() {
    if (this.pair) return this.loadPair();
    this.clearZ();
    const m = this.market;
    if (!m) return;
    const d = decimals(m);
    this.series.applyOptions({ priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
    const token = (this.loadToken = Symbol());
    // until the new candles arrive, live prices must not land on the old ones (another market's
    // candles with this market's price made one giant bar); a new market starts from an empty chart
    this.last = null;
    if (this.loadedSym !== m.symbol) {
      this.loadedSym = m.symbol;
      this.data = new Map();
      this.series.setData([]);
      this.vol.setData([]);
    }
    this.loadingAt = Date.now();
    const candles = await this.fetchCandles(m);
    if (token !== this.loadToken) return;
    this.loadingAt = 0;
    if (!candles) { this.retryLoad(token); return; }
    this.data = new Map(candles.map((c) => [c.time, c]));
    this.series.setData(candles);
    this.vol.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(43,217,164,.28)" : "rgba(242,84,109,.28)" })));
    this.last = candles[candles.length - 1] || null;
    this.keepGap();
    this.loadFills(true);
    this.drawMarkers();
    this.drawLines();
    this.renderLegend();
  }

  // the last 600 candles, or null when the request failed or timed out (it is tried again)
  fetchCandles(m) {
    return api(`/candles?market_id=${m.id}&resolution=${this.cfg.tf}&count=600`, { signal: AbortSignal.timeout(20000) })
      .then((c) => { this.failShown = false; return c; })
      .catch((e) => { // said once, not at every retry
        if (e.name !== "TimeoutError" && e.name !== "AbortError" && !this.failShown) { this.failShown = true; toast(e.message, true); }
        return null;
      });
  }
  retryLoad(token) {
    setTimeout(() => { if (token === this.loadToken) this.load(); }, 5000);
  }

  renderLegend() {
    const pair = this.pair;
    const m = this.market || (pair && { price_decimals: this.pairDec || 6 });
    if (this.ttlFor !== this.cfg.symbol + this.cfg.tf) { // avoid reloading the logo on every tick
      this.ttlFor = this.cfg.symbol + this.cfg.tf;
      $(".ttl", this.el).innerHTML = pair
        ? `<span class="pair-ico">${ico(pair[0].symbol, "sm")}${ico(pair[1].symbol, "sm")}</span><b>${esc(this.cfg.symbol)}</b> · ${tfLabel(this.cfg.tf)} · Spread`
        : `${ico(this.cfg.symbol, "sm")}<b>${esc(this.cfg.symbol)}</b> · ${tfLabel(this.cfg.tf)} · Lighter`;
    }
    const b = this.hover || this.last;
    if (!b) { $(".ohlc", this.el).textContent = ""; return; }
    const ch = b.close - b.open, pct = b.open ? (ch / b.open) * 100 : 0;
    const c = cls(ch);
    $(".ohlc", this.el).innerHTML =
      `<span>O<em class="${c}">${fp(b.open, m)}</em></span><span>H<em class="${c}">${fp(b.high, m)}</em></span>` +
      `<span>L<em class="${c}">${fp(b.low, m)}</em></span><span>C<em class="${c}">${fp(b.close, m)}</em></span>` +
      `<em class="${c}">${ch >= 0 ? "+" : ""}${fp(ch, m).replace("—", "0")} (${fpct(pct)})</em>` +
      (pair && this.z !== undefined && this.z !== null ? `<span class="zval" title="${t("Distanza dalla media delle ultime {n} candele, in deviazioni standard", { n: Z_LEN })}">z <b class="${Math.abs(this.z) >= 2 ? "hot" : ""}">${this.z >= 0 ? "+" : "−"}${Math.abs(this.z).toFixed(2)}</b></span>` : "");
  }

  // ---------- spread chart: candles of A / B, z-score bands ----------
  async loadPair() {
    const [a, b] = this.pair;
    const token = (this.loadToken = Symbol());
    this.last = null;
    if (this.loadedSym !== this.cfg.symbol) {
      this.loadedSym = this.cfg.symbol;
      this.data = new Map();
      this.series.setData([]);
      this.vol.setData([]);
      this.fills = [];
      this.fillBars = new Map();
      this.eventBars = new Map();
      this.series.setMarkers([]);
      $(".chart-ctx", this.el).innerHTML = "";
      $(".chart-ctx", this.el).dataset.html = "";
    }
    this.loadingAt = Date.now();
    const [ca, cb] = await Promise.all([this.fetchCandles(a), this.fetchCandles(b)]);
    if (token !== this.loadToken) return;
    this.loadingAt = 0;
    if (!ca || !cb) { this.retryLoad(token); return; }
    const candles = ratioCandles(ca, cb);
    const d = (this.pairDec = candles.length ? ratioDecimals(candles[candles.length - 1].close) : 6);
    this.series.applyOptions({ priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
    this.data = new Map(candles.map((c) => [c.time, c]));
    this.series.setData(candles);
    this.vol.setData([]);
    this.last = candles[candles.length - 1] || null;
    this.keepGap();
    this.drawZ();
    this.drawLines();
    this.renderLegend();
  }

  // the pairs on this spread: their entry ratio and their SL/TP, which can be dragged
  pairsHere() {
    const [a, b] = this.pair;
    return pairs.map((x) => (x.long_id === a.id && x.short_id === b.id ? { x, inv: false } : x.long_id === b.id && x.short_id === a.id ? { x, inv: true } : null)).filter(Boolean);
  }

  drawPairLines() {
    if (!chartEls.position && !chartEls.orders) return;
    const add = (o) => { const l = this.series.createPriceLine({ lineWidth: 1, lineStyle: 0, ...o, title: lineTitle(o.title) }); this.lines.push(l); return l; };
    const conv = (v, inv) => (inv ? 1 / v : v);
    for (const { x, inv } of this.pairsHere()) {
      const side = inv ? "SHORT" : "LONG"; // long the pair = long this spread, unless the spread is the other way round
      if (chartEls.position) add({ price: conv(x.long_entry / x.short_entry, inv), color: cssVar("--blue"), lineStyle: 2, title: `${side} ${t("coppia")}` });
      if (!chartEls.orders) continue;
      for (const k of ["sl", "tp"]) {
        if (!x[k]) continue;
        const price = conv(x[k], inv);
        const line = add({ price, color: k === "sl" ? C.red : C.green, lineStyle: 2, title: k.toUpperCase() });
        this.dragOrders.push({ line, price, label: k.toUpperCase(), pairStop: { id: x.id, k, inv } });
      }
    }
  }

  // right-click on a spread chart: the pair's SL or TP at that ratio, or removing the one under the pointer
  pairMenuItems(price, y) {
    const items = [], fmtR = (v) => fp(v, { price_decimals: this.pairDec || 6 });
    for (const d of this.dragOrders.filter((z) => z.pairStop)) {
      const ly = this.series.priceToCoordinate(d.price);
      if (ly !== null && Math.abs(ly - y) <= 6) items.push({ line: true, cls: "danger", label: t("Togli il {kind} della coppia", { kind: d.label }), run: () => setPairStop(d.pairStop.id, d.pairStop.k, null) });
    }
    const last = this.last && this.last.close;
    if (!info.trading || !last) return items;
    for (const { x, inv } of this.pairsHere()) {
      // the stored ratio is long over short; on an inverted chart, up here is down there
      const up = (price > last) !== inv, k = up ? "tp" : "sl";
      items.push({ label: t(k === "tp" ? "TP della coppia a {price}" : "SL della coppia a {price}", { price: fmtR(price) }), cls: "pos " + k, note: t("subito"),
        run: () => setPairStop(x.id, k, inv ? 1 / price : price) });
    }
    return items;
  }

  // a new market or timeframe opens on the latest candle with the gap on its right; the periodic
  // reload of the same chart keeps wherever it was scrolled
  keepGap() {
    if (!this.last || !this.el.clientWidth) return; // a hidden chart gets it once shown
    const chart = this.cfg.symbol + this.cfg.tf + ":";
    const gap = Math.max(rightGap(), this.labelGap()), view = chart + gap; // a phone turned wide gets the wider gap
    if (this.viewFor === view) return;
    const ts = this.chart.timeScale();
    // a new market or timeframe starts at the live edge; a gap that grows or shrinks moves the view only
    // when it is there, not while you look back in time
    const atEdge = !(this.viewFor || "").startsWith(chart) || Math.abs(ts.scrollPosition() - ts.options().rightOffset) < 2;
    this.viewFor = view;
    ts.applyOptions({ rightOffset: gap });
    if (atEdge) ts.scrollToPosition(gap, false);
  }

  // A line's label (LONG 0.5, SL, TP, LIMIT…) is drawn at the right edge, over the latest candles. When one
  // sits within their range, the empty space on the right grows to fit it: bars it needs, or 0.
  // The gap only grows while the chart stays the same: on a short timeframe a line drifts in and out of the
  // latest candles' range every few bars, and a gap that came and went made the whole chart jump sideways.
  // It starts again from nothing with another market or timeframe, or once no line carries a label.
  labelGap() {
    const spacing = this.chart.timeScale().options().barSpacing || 8;
    const ctx = (Panel.measure ||= document.createElement("canvas").getContext("2d"));
    ctx.font = "11px 'JetBrains Mono', monospace"; // the chart's own label font
    let need = 0, labels = 0;
    for (const l of [...(this.lines || []), ...(this.previewLines || [])]) {
      const o = l.options();
      if (!o.title) continue;
      labels++;
      const n = Math.ceil((ctx.measureText(o.title).width + 16) / spacing) + 1;
      if (n <= need) continue;
      const bars = [...this.data.values()].slice(-(n + 10));
      if (bars.length && o.price >= Math.min(...bars.map((b) => b.low)) && o.price <= Math.max(...bars.map((b) => b.high))) need = n;
    }
    const key = `${this.cfg.symbol}:${this.cfg.tf}:${spacing}`;
    if (this.gapKey !== key || !labels) { this.gapKey = key; this.gapHeld = 0; }
    this.gapHeld = Math.max(this.gapHeld, need);
    return this.gapHeld;
  }

  clearZ() {
    for (const s of this.zSeries || []) this.chart.removeSeries(s);
    this.zSeries = null;
    this.z = null;
  }

  // mean and ±2 standard deviations of the last Z_LEN closes, at every bar
  drawZ() {
    this.clearZ();
    if (!this.pair || !chartEls.zscore) return;
    const d = this.pairDec || 6, muted = cssVar("--muted");
    const line = (style, title) => this.chart.addLineSeries({ color: muted, lineWidth: 1, lineStyle: style, title, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
    this.zSeries = [line(2, ""), line(1, "+2σ"), line(1, "−2σ")];
    const bars = [...this.data.values()], rows = [[], [], []];
    for (let i = Z_LEN - 1; i < bars.length; i++) {
      const { mean, sd } = zStats(bars.slice(i - Z_LEN + 1, i + 1).map((x) => x.close));
      rows[0].push({ time: bars[i].time, value: mean });
      rows[1].push({ time: bars[i].time, value: mean + 2 * sd });
      rows[2].push({ time: bars[i].time, value: mean - 2 * sd });
    }
    this.zSeries.forEach((s, k) => s.setData(rows[k]));
    this.updateZ();
  }

  // the live bar moves the last point of the bands and the z value in the legend
  updateZ() {
    if (!this.zSeries || !this.last) { this.z = null; return; }
    const closes = [...this.data.values()].slice(-Z_LEN).map((x) => x.close);
    if (closes.length < Z_LEN) { this.z = null; return; }
    const { mean, sd } = zStats(closes), time = this.last.time;
    this.zSeries[0].update({ time, value: mean });
    this.zSeries[1].update({ time, value: mean + 2 * sd });
    this.zSeries[2].update({ time, value: mean - 2 * sd });
    this.z = sd ? (this.last.close - mean) / sd : 0;
  }

  tickPair() {
    const [a, b] = this.pair;
    const pa = prices[a.id], pb = prices[b.id];
    const xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark);
    if (!xa || !xb || !this.last) return;
    const price = xa / xb;
    const barTime = barStart(this.cfg.tf, Math.floor(Date.now() / 1000));
    if (barTime > this.last.time) {
      const prev = this.last.close; // a new bar opens where the last one closed, as Lighter's candles do
      this.last = { time: barTime, open: prev, high: Math.max(prev, price), low: Math.min(prev, price), close: price };
    } else this.last = { ...this.last, close: price, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price) };
    this.data.set(this.last.time, this.last);
    this.series.update(this.last);
    this.updateZ();
    if (!this.hover) this.renderLegend();
  }

  tick() {
    this.keepGap();
    if (!this.last && this.loadingAt && Date.now() - this.loadingAt > 30000) { this.load(); return; }
    if (this.pair) return this.tickPair();
    const m = this.market;
    const p = m && prices[m.id];
    if (!p || !this.last) return;
    const price = p.mark || p.last; // the mark moves between trades, as on Lighter's chart (history merges it too)
    if (!price) return;
    const barTime = barStart(this.cfg.tf, Math.floor(Date.now() / 1000));
    if (barTime > this.last.time) {
      // a new bar opens where the last one closed, as Lighter's candles do (no step between them), and the bar
      // just closed is read again from Lighter in a moment: built here from the prices that came in, it can lack
      // a wick or two, and it should look the same as after a reload
      const prev = this.last.close;
      this.last = { time: barTime, open: prev, high: Math.max(prev, price), low: Math.min(prev, price), close: price, volume: 0 };
      this.syncClosed();
    } else this.last = { ...this.last, close: price, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price) };
    this.data.set(this.last.time, this.last);
    this.series.update(this.last);
    if (!this.hover) this.renderLegend();
    setBadges($(".chart-ctx", this.el), m, 3);
    const s = stops[m.id];
    if (this.stopLine && s && s.stop) this.stopLine.applyOptions({ title: lineTitle(this.stopTitle(s)) });
    if (this.markLine && p.mark) this.markLine.applyOptions({ price: p.mark });
  }

  // the last closed bars as Lighter has them, a few seconds after a new bar starts
  syncClosed() {
    const m = this.market, tf = this.cfg.tf, token = this.loadToken;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      const rows = await api(`/candles?market_id=${m.id}&resolution=${tf}&count=4`).catch(() => null);
      if (!rows || token !== this.loadToken || this.market !== m || this.cfg.tf !== tf || !this.last) return;
      let changed = false;
      for (const c of rows) {
        if (c.time >= this.last.time || !this.data.has(c.time)) continue; // the live bar stays the page's own
        const old = this.data.get(c.time);
        if (old.open === c.open && old.high === c.high && old.low === c.low && old.close === c.close && old.volume === c.volume) continue;
        this.data.set(c.time, c);
        changed = true;
      }
      if (!changed) return;
      const prev = [...this.data.values()].filter((b) => b.time < this.last.time).pop();
      if (prev && prev.close !== this.last.open) { // the live bar opens where the corrected one closed
        this.last = { ...this.last, open: prev.close, high: Math.max(this.last.high, prev.close), low: Math.min(this.last.low, prev.close) };
        this.data.set(this.last.time, this.last);
      }
      const bars = [...this.data.values()];
      this.series.setData(bars);
      this.vol.setData(bars.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(43,217,164,.28)" : "rgba(242,84,109,.28)" })));
    }, 4000);
  }

  drawMarkers() {
    const now = Date.now() / 1000;
    // events and fills older than the first candle would all pile up on it: only the loaded bars get marks
    const first = this.data.size ? this.data.keys().next().value : Infinity;
    // one discreet dot per bar that had high-impact news for this market
    const bars = new Map();
    const sym = this.market && this.market.symbol;
    for (const e of events) {
      if (!sym || !eventFor(e, sym) || impactFor(e, sym) !== "High" || e.ts > now) continue;
      const t = barStart(this.cfg.tf, e.ts);
      if (t < first) continue;
      bars.set(t, (bars.get(t) || []).concat(e));
    }
    if (!chartEls.events) bars.clear();
    this.eventBars = bars;
    const markers = [...bars.entries()].map(([time]) => ({
      time, position: "belowBar", shape: "circle", size: 0.4, color: "rgba(232,177,74,.8)",
      text: "",
    }));
    // your fills: an arrow under the bar for buys, over it for sells, one per side and bar
    this.fillBars = new Map();
    if (chartEls.fills && info.trading) {
      for (const f of this.fills) {
        const time = barStart(this.cfg.tf, Math.floor(f.ts / 1000));
        if (time < first) continue;
        this.fillBars.set(time, (this.fillBars.get(time) || []).concat(f));
      }
      for (const [time, fs] of this.fillBars) {
        for (const side of ["buy", "sell"]) {
          const n = fs.filter((f) => f.side === side).length;
          if (!n) continue;
          markers.push({ time, position: side === "buy" ? "belowBar" : "aboveBar", shape: side === "buy" ? "arrowUp" : "arrowDown",
            color: side === "buy" ? C.green : C.red, size: 0.8, text: n > 1 ? `${side === "buy" ? "B" : "S"}×${n}` : side === "buy" ? "B" : "S" });
        }
      }
    }
    this.series.setMarkers(markers.sort((a, b) => a.time - b.time));
  }

  // this market's latest fills (100), merged per order; at most every 20 s unless something just happened
  async loadFills(fresh = false) {
    const m = this.market;
    if (!m || !info.trading || !chartEls.fills) { if (this.fills.length) { this.fills = []; this.drawMarkers(); } return; }
    if (!fresh && this.fillsFor === m.id && Date.now() - (this.fillsAt || 0) < 20000) return;
    this.fillsAt = Date.now();
    this.fillsFor = m.id;
    const list = await api(`/trades?market_id=${m.id}`).catch(() => null);
    if (!list || this.market !== m) return;
    const fills = aggregateTrades(list.filter((f) => f.market_id === m.id));
    if (JSON.stringify(fills) === JSON.stringify(this.fills)) return;
    this.fills = fills;
    this.drawMarkers();
  }

  // box with the events behind a dot, shown while the pointer is on or near it
  // reach: extra room around the mark for a finger
  renderEventTip(p, bar, reach = 0) {
    const tip = $(".ev-tip", this.el);
    const evs = bar && this.eventBars.get(bar.time);
    const fs = bar && this.fillBars.get(bar.time);
    const lowY = bar && this.series.priceToCoordinate(bar.low), highY = bar && this.series.priceToCoordinate(bar.high);
    const nearLow = lowY !== null && p.point && p.point.y >= lowY - 6 - reach && p.point.y <= lowY + 34 + reach;
    const nearHigh = highY !== null && p.point && p.point.y <= highY + 6 + reach && p.point.y >= highY - 34 - reach;
    const showFills = fs && ((nearLow && fs.some((f) => f.side === "buy")) || (nearHigh && fs.some((f) => f.side === "sell")));
    if (!showFills && (!evs || !nearLow)) {
      tip.classList.add("hidden");
      return;
    }
    // the arrows under the bar are its buys, the ones over it its sells
    if (showFills) return this.placeTip(tip, p, this.fillTip(fs.filter((f) => (f.side === "buy" ? nearLow : nearHigh))));
    const m = this.market;
    let prev = null; // previous bar (bars are not all the same length on 1W / 1M)
    for (const [t, c] of this.data) { if (t >= bar.time) break; prev = c; }
    const before = prev ? prev.close : null, after = bar.close;
    const move = before ? ((after - before) / before) * 100 : null;
    tip.innerHTML = evs.sort((a, b) => a.ts - b.ts).map((e) => `
        <div class="ev">
          <div class="ev-t"><span class="imp ${impactFor(e, m.symbol)}"></span>${evLabel(e)}</div>
          <div class="ev-s">${new Date(e.ts * 1000).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", ...(e.approx ? {} : { hour: "2-digit", minute: "2-digit" }) })}${e.forecast || e.previous || e.when ? " · " + eventDetail(e) : ""}</div>
        </div>`).join("") +
      (move !== null ? `<div class="ev-move">${t("Candela {tf}: {move} · chiusura {close}", { tf: tfLabel(this.cfg.tf), move: `<b class="${cls(move)}">${fpct(move)}</b>`, close: fp(after, m) })}</div>` : "");
    this.placeTip(tip, p);
  }

  // the fills on a bar: side, size, average price, maker/taker, time and the PnL they realized
  fillTip(fs) {
    const m = this.market;
    return fs.sort((a, b) => a.ts - b.ts).map((f) => `
        <div class="ev fill">
          <div class="ev-t"><b class="${f.side === "buy" ? "up" : "down"}">${f.side === "buy" ? "Buy" : "Sell"}</b> ${fsize(f.size, m)} ${esc(m.symbol)} @ ${fp(f.price, m)}</div>
          <div class="ev-s">${new Date(f.ts).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${esc(f.role)}${f.fills > 1 ? ` · ${t("{n} fill", { n: f.fills })}` : ""}${f.pnl ? ` · PnL <b class="${cls(f.pnl)}">${fusd(f.pnl)}</b>` : ""}</div>
        </div>`).join("");
  }

  placeTip(tip, p, html) {
    if (html !== undefined) tip.innerHTML = html;
    tip.classList.remove("hidden");
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = p.point.x + 14, y = p.point.y + 14;
    if (x + tw > w - 70) x = p.point.x - tw - 14;
    if (y + th > h - 30) y = p.point.y - th - 14;
    tip.style.left = Math.max(6, x) + "px";
    tip.style.top = Math.max(6, y) + "px";
  }

  // price lines picked in the Chart elements menu: position, liquidation, open orders, managed stop, mark
  drawLines() {
    if (this.drag || this.hold) return; // don't pull a line from under the pointer; redrawn when the drag ends
    for (const l of this.lines) this.series.removePriceLine(l);
    this.lines = [];
    this.dragOrders = [];
    this.stopLine = this.markLine = null;
    this.trailPrices = []; // the managed stop's own lines (stop, "trailing from here", BE), for the right-click menu
    const m = this.market;
    if (this.pair) return this.drawPairLines();
    if (!m) return;
    const add = (o) => { const l = this.series.createPriceLine({ lineWidth: 1, lineStyle: 0, ...o, title: lineTitle(o.title) }); this.lines.push(l); return l; };
    const pos = account && account.positions.find((p) => p.market_id === m.id);
    const s = pos && stops[m.id];
    this.posPrice = pos && chartEls.position ? pos.entry : null;
    if (pos && chartEls.position) add({ price: pos.entry, color: cssVar("--blue"), lineStyle: 2, title: `${pos.size > 0 ? "LONG" : "SHORT"} ${fsize(pos.size, m)}` });
    if (pos && pos.liq && chartEls.liq) add({ price: pos.liq, color: C.red, lineStyle: 1, title: "LIQ" });
    if (chartEls.orders) {
      const tick = 10 ** -decimals(m);
      for (const o of openOrders[m.id] || []) {
        const kind = orderKind(o);
        if (kind === "TWAP") continue; // it has no level on the chart: it fills over time, in the orders table
        // the managed stop's own order is drawn by the stop line below
        if (chartEls.stop && s && s.stop && kind === "SL" && Math.abs(o.trigger_price - s.stop) < tick * 1.5) continue;
        const price = o.trigger_price || o.price;
        const line = add({ price, color: kind === "SL" ? C.red : kind === "TP" ? C.green : cssVar("--text-2"),
          lineStyle: kind === "LIMIT" ? 0 : 2, title: `${kind} ${fsize(o.remaining, m)}` });
        if (!workingOf(o)) this.dragOrders.push({ line, price, label: kind, order: o }); // those move by themselves
      }
    }
    if (pos && s && chartEls.stop) {
      const dir = Math.sign(pos.size), amber = cssVar("--amber"), lev = pos.leverage || 1;
      // activation and breakeven are PnL % on margin: the price moves that much divided by the leverage
      const at = (pct) => pos.entry * (1 + dir * pct / 100 / lev);
      if (s.stop) this.stopLine = add({ price: s.stop, color: amber, lineWidth: 2, title: this.stopTitle(s) });
      else if (s.trail_activate_pct) add({ price: at(s.trail_activate_pct), color: amber, lineStyle: 2, title: t("trailing da qui") });
      if (s.breakeven_at_pct && (!s.stop || (s.stop - pos.entry) * dir < 0)) add({ price: at(s.breakeven_at_pct), color: amber, lineStyle: 3, title: "BE" });
      this.trailPrices = [s.stop || (s.trail_activate_pct ? at(s.trail_activate_pct) : null), s.breakeven_at_pct ? at(s.breakeven_at_pct) : null].filter(Boolean);
    }
    if (chartEls.alerts) {
      for (const a of alerts.filter((x) => x.market_id === m.id)) {
        const line = add({ price: a.price, color: cssVar("--blue"), lineStyle: 1, title: `ALERT ${a.dir > 0 ? "≥" : "≤"}` });
        this.dragOrders.push({ line, price: a.price, label: "ALERT", alert: a });
      }
    }
    const q = prices[m.id];
    if (chartEls.mark && q && q.mark) this.markLine = add({ price: q.mark, color: cssVar("--muted"), lineStyle: 3, title: "MARK" });
  }

  // provisional lines from the order ticket, on the selected chart only; faded and dotted to tell them from real orders
  drawPreview() {
    if (this.drag) return;
    for (const l of this.previewLines || []) this.series.removePriceLine(l);
    this.previewLines = [];
    this.dragPreview = [];
    this.previewTrail = [];
    const d = ticketDraft, m = this.market;
    if (!d || !m || d.market !== m.id || this.idx !== activeIdx) return;
    const colour = { limit: cssVar("--text-2"), sl: C.red, tp: C.green, trail: cssVar("--amber") };
    const add = (price, color, title, style = 1) => {
      if (!(price > 0)) return null;
      const line = this.series.createPriceLine({ price, color: fade(color), lineWidth: 1, lineStyle: style, title: lineTitle(title) });
      this.previewLines.push(line);
      return line;
    };
    for (const l of d.lines) {
      const line = add(l.price, colour[l.kind], l.title, l.dashed ? 3 : 1);
      if (line && l.kind !== "trail" && !l.fixed) this.dragPreview.push({ line, price: l.price, label: l.label || l.kind.toUpperCase(), kind: l.kind, input: l.input, preview: true });
      if (line && l.kind === "trail") this.previewTrail.push(l.price);
    }
    if (d.liq) add(d.liq, C.red, t("LIQ stimata"), 3);
  }

  // Drag SL/TP/limit lines with the mouse. Ticket preview lines fill the ticket fields; real orders show a
  // small "Move / Cancel" box by the line and only change on Lighter after Move. The trailing stop isn't draggable.
  wireDrag() {
    const box = $(".chart", this.el);
    const yOf = (e) => e.clientY - box.getBoundingClientRect().top;
    const near = (y, reach = 6) => { // closest draggable line within reach of the pointer (wider for a finger)
      let best = null, gap = reach;
      for (const d of [...this.dragOrders, ...this.dragPreview]) {
        const ly = this.series.priceToCoordinate(d.price);
        if (ly !== null && Math.abs(ly - y) < gap) { best = d; gap = Math.abs(ly - y); }
      }
      return best;
    };
    const start = (d) => {
      this.drag = { ...d, from: d.price, to: d.price };
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      document.body.classList.add("dragging-line");
    };
    const move = (y) => {
      const p = this.series.coordinateToPrice(y);
      if (p === null || p <= 0) return;
      const fm = this.market || { price_decimals: this.pairDec || 6 }; // a spread's ratio has its own decimals
      const price = +p.toFixed(decimals(fm));
      this.drag.to = price;
      this.drag.line.applyOptions({ price, title: lineTitle(`${this.drag.label} → ${fp(price, fm)}`) }); // the axis shows the price anyway
    };
    // capture phase: the chart never sees a press that grabs a line, so it doesn't pan at the same time
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || this.hold) return;
      const d = near(yOf(e));
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      start(d);
    }, true);
    box.addEventListener("mousemove", (e) => {
      if (!this.drag) box.style.cursor = !this.hold && near(yOf(e)) ? "ns-resize" : "";
    });
    document.addEventListener("mousemove", (e) => { if (this.drag && !this.touchDrag) move(yOf(e)); });
    document.addEventListener("mouseup", (e) => { if (!this.touchDrag) this.endDrag(yOf(e)); });
    // a finger: a touch on a line drags it; a press held still elsewhere opens the chart's menu
    const finger = (e) => e.touches[0] || e.changedTouches[0];
    box.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || this.hold) return;
      const tch = finger(e), y = tch.clientY - box.getBoundingClientRect().top;
      const d = near(y, 16);
      if (d) {
        e.preventDefault();
        e.stopPropagation();
        this.touchDrag = true;
        start(d);
        return;
      }
      clearTimeout(this.pressTimer);
      this.press = { x: tch.clientX, y: tch.clientY };
      this.pressTimer = setTimeout(() => {
        this.press = null;
        box.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: tch.clientX, clientY: tch.clientY }));
      }, 550);
    }, { capture: true, passive: false });
    document.addEventListener("touchmove", (e) => {
      const tch = finger(e);
      if (this.press && Math.hypot(tch.clientX - this.press.x, tch.clientY - this.press.y) > 10) { clearTimeout(this.pressTimer); this.press = null; }
      if (!this.drag || !this.touchDrag) return;
      e.preventDefault();
      move(tch.clientY - box.getBoundingClientRect().top);
    }, { passive: false });
    document.addEventListener("touchend", (e) => {
      clearTimeout(this.pressTimer);
      this.press = null;
      if (!this.touchDrag) return;
      this.touchDrag = false;
      this.endDrag(finger(e).clientY - box.getBoundingClientRect().top);
    });
    $(".drag-ok", this.el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-mv]");
      if (b) this.endMove(b.dataset.mv === "ok");
    });
  }

  // a line let go: a ticket line fills its field, an alert or pair stop moves at once, an order asks first
  endDrag(y) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      document.body.classList.remove("dragging-line");
      if (d.to === d.from) { this.drawLines(); this.drawPreview(); return; }
      if (d.alert) { moveAlert(d.alert.id, d.to); return; }
      if (d.pairStop) { setPairStop(d.pairStop.id, d.pairStop.k, d.pairStop.inv ? 1 / d.to : d.to); return; }
      if (d.preview) {
        (d.input || $({ sl: "#tkSl", tp: "#tkTp", limit: "#tkPrice" }[d.kind])).value = d.to;
        this.drawLines();
        updateTicketSummary();
        return;
      }
      this.askMove(d, y);
  }

  askMove(d, y) {
    const m = this.market;
    this.hold = d;
    const chip = $(".drag-ok", this.el);
    chip.innerHTML = `<span>${esc(d.label)} ${fp(d.from, m)} → <b>${fp(d.to, m)}</b></span>
      <button data-mv="ok">${t("Sposta")}</button><button data-mv="no">${t("Annulla")}</button>`;
    chip.style.top = Math.max(4, Math.min(this.el.clientHeight - 40, y - 15)) + "px";
    chip.classList.remove("hidden");
  }

  async endMove(ok) {
    const d = this.hold;
    if (!d) return;
    const chip = $(".drag-ok", this.el);
    if (ok) {
      chip.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api("/move_order", { method: "POST", body: JSON.stringify({ market_id: d.order.market_id, order_index: d.order.order_index, price: d.to }) });
        toast(t("{kind} spostato a {price}", { kind: d.label, price: fp(d.to, this.market) }));
      } catch (err) { toast(err.message, true); }
    }
    this.hold = null;
    chip.classList.add("hidden");
    this.drawLines(); // back to where the order really is until the refresh below shows the new level
    if (ok) loadOrders(true);
  }

  // Right-click on the chart: what can go at that price. A limit entry and the ticket's SL/TP fill the
  // ticket (sent from there, with its confirm); the open position's SL/TP is set or moved at once.
  wireOrderMenu() {
    const box = $(".chart", this.el), menu = $(".chart-menu", this.el);
    box.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.hold || this.drag) return;
      if (Date.now() - (this.menuAt || 0) < 800) return; // a long press can fire it twice
      this.menuAt = Date.now();
      const y = e.clientY - box.getBoundingClientRect().top;
      const raw = this.series.coordinateToPrice(y);
      const m = this.market;
      if (raw !== null && raw > 0 && this.pair) return this.openPairMenu(e, raw, y);
      if (raw === null || raw <= 0 || !m) return;
      setActive(this.idx);
      this.menuPrice = +raw.toFixed(decimals(m));
      const items = [...this.lineMenuItems(m, y), ...this.orderMenuItems(m, this.menuPrice)];
      if (!items.length) return;
      menu.innerHTML = `<div class="cm-price">${fp(this.menuPrice, m)}</div>` + items.map((it, i) =>
        `<button data-cm="${i}" class="${it.cls || ""}${it.line && !(items[i + 1] || {}).line ? " line-last" : ""}">${esc(it.label)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</button>`).join("");
      this.menuItems = confirmOnTouch(items);
      menu.classList.remove("hidden");
      const r = this.el.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(4, Math.min(r.width - w - 4, e.clientX - r.left + 2)) + "px";
      menu.style.top = Math.max(4, Math.min(r.height - h - 4, e.clientY - r.top + 2)) + "px";
    });
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cm]");
      if (!b) return;
      const it = this.menuItems[+b.dataset.cm];
      if (it.confirm && !b.classList.contains("armed")) { // a second click on the same item does it
        b.classList.add("armed");
        b.innerHTML = `${esc(it.confirm)}<small>${t("clicca di nuovo")}</small>`;
        return;
      }
      this.closeOrderMenu();
      it.run();
    });
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    // any press outside it closes it, a finger too: on a chart the touch never becomes a mousedown
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".chart-menu")) this.closeOrderMenu(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.closeOrderMenu(); });
    box.addEventListener("wheel", () => this.closeOrderMenu(), { passive: true });
  }

  closeOrderMenu() { $(".chart-menu", this.el).classList.add("hidden"); }

  // Mouse wheel over the price scale: up stretches the prices (taller candles), down squeezes them; the
  // chart keeps fitting the price as it moves. A double click on the scale goes back to the normal fit.
  wirePriceZoom() {
    const box = $(".chart", this.el);
    // the scale refits only when its options change: switch the autoscale off and on again
    const refit = () => { const ps = this.chart.priceScale("right"); ps.applyOptions({ autoScale: false }); ps.applyOptions({ autoScale: true }); };
    const onScale = (e) => e.clientX - box.getBoundingClientRect().left > box.clientWidth - this.chart.priceScale("right").width();
    box.addEventListener("wheel", (e) => {
      if (!onScale(e)) return;
      e.preventDefault();
      e.stopPropagation(); // the chart itself would zoom time
      this.yZoom = Math.min(20, Math.max(0.05, this.yZoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      refit();
    }, { capture: true, passive: false });
    box.addEventListener("dblclick", (e) => { if (onScale(e)) { this.yZoom = 1; refit(); } }, true);
  }

  openPairMenu(e, raw, y) {
    setActive(this.idx);
    const d = this.pairDec || 6, price = +raw.toFixed(d);
    const items = this.pairMenuItems(price, y);
    if (!items.length) return;
    const menu = $(".chart-menu", this.el);
    menu.innerHTML = `<div class="cm-price">${fp(price, { price_decimals: d })}</div>` + items.map((it, i) =>
      `<button data-cm="${i}" class="${it.cls || ""}${it.line && !(items[i + 1] || {}).line ? " line-last" : ""}">${esc(it.label)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</button>`).join("");
    this.menuItems = confirmOnTouch(items);
    menu.classList.remove("hidden");
    const r = this.el.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(r.width - menu.offsetWidth - 4, e.clientX - r.left + 2)) + "px";
    menu.style.top = Math.max(4, Math.min(r.height - menu.offsetHeight - 4, e.clientY - r.top + 2)) + "px";
  }

  // the line under the pointer (within 6 px), if any: what can be done to it comes first in the menu
  lineMenuItems(m, y) {
    const near = (price) => { const ly = price > 0 ? this.series.priceToCoordinate(price) : null; return ly !== null && Math.abs(ly - y) <= 6; };
    const items = [];
    for (const d of this.dragOrders.filter((x) => near(x.price))) {
      if (d.alert) {
        items.push({ line: true, cls: "alert", label: t("Togli l'alert a {price}", { price: fp(d.alert.price, m) }), run: () => removeAlert(d.alert.id) });
        continue;
      }
      const o = d.order, kind = orderKind(o);
      const label = kind === "LIMIT" ? t("Annulla il limit {side} {size} a {price}", { side: o.is_ask ? "Sell" : "Buy", size: fsize(o.remaining, m), price: fp(o.price, m) })
        : t("Annulla il {kind} a {price}", { kind, price: fp(o.trigger_price, m) });
      items.push({ line: true, cls: "danger", label, run: () => chartCancelOrder(o) });
    }
    for (const d of this.dragPreview.filter((x) => near(x.price))) {
      items.push({ line: true, label: t("Togli {what} dal ticket", { what: d.label }), run: () => chartClearTicket(d) });
    }
    const s = stops[m.id];
    if (s && (this.trailPrices || []).some(near)) {
      items.push({ line: true, label: s.stop ? t("Ferma il trailing (lo stop resta a {price})", { price: fp(s.stop, m) }) : t("Togli il trailing"), run: () => chartStopTrail(m) });
    }
    if ((this.previewTrail || []).some(near)) {
      items.push({ line: true, label: t("Togli il trailing dal ticket"), run: () => { $("#tkTrail").checked = false; renderTicketTrail(); } });
    }
    const pos = account && account.positions.find((p) => p.market_id === m.id);
    if (pos && info.trading && near(this.posPrice)) {
      const what = `${pos.size > 0 ? "Long" : "Short"} ${fsize(pos.size, m)} ${m.symbol}`;
      items.push({ line: true, cls: "danger", label: t("Chiudi la posizione ({what})", { what }), confirm: t("Conferma: chiudi {what} a mercato", { what }),
        run: () => chartClosePosition(pos) });
    }
    return items;
  }

  orderMenuItems(m, price) {
    const q = prices[m.id], last = (q && (q.last || q.mark)) || (this.last && this.last.close);
    if (!last) return [];
    const above = price > last, at = fp(price, m), items = [];
    if (info.trading) {
      // a limit buys below the price and sells above it (the other way it would fill at once)
      items.push({ label: t(above ? "Sell limit a {price}" : "Buy limit a {price}", { price: at }), cls: above ? "down" : "up", note: t("nel ticket"),
        run: () => chartLimit(above ? "sell" : "buy", price) });
      // the ticket's protection on its own side of the entry
      const ref = ticket.kind === "limit" && +$("#tkPrice").value ? +$("#tkPrice").value : last;
      const side = ticket.side === "buy" ? 1 : -1;
      const isTp = (price - ref) * side > 0;
      const levels = readTpLevels();
      if (isTp && levels) {
        const n = levels.findIndex((l) => !l.price);
        if (n >= 0) items.push({ label: t("TP{n} del ticket a {price}", { n: n + 1, price: at }), note: `${ticket.side === "buy" ? "Long" : "Short"}`, run: () => chartTicketStop("tp", price, n) });
      } else items.push({ label: t(isTp ? "TP del ticket a {price}" : "SL del ticket a {price}", { price: at }), note: `${ticket.side === "buy" ? "Long" : "Short"}`, run: () => chartTicketStop(isTp ? "tp" : "sl", price) });
      // the open position's SL/TP: set now, or moved if it has one
      const pos = account && account.positions.find((p) => p.market_id === m.id);
      if (pos) {
        const k = (price - last) * Math.sign(pos.size) > 0 ? "tp" : "sl";
        const cur = positionStops(pos)[k];
        const label = cur ? t(k === "tp" ? "Sposta il TP della posizione a {price}" : "Sposta lo SL della posizione a {price}", { price: at })
          : t(k === "tp" ? "TP della posizione a {price}" : "SL della posizione a {price}", { price: at });
        items.push({ label, cls: "pos " + k, note: t("subito"), run: () => chartPositionStop(pos, k, price, cur) });
      }
    }
    // a price alert, with or without trading
    items.push({ label: t("Alert a {price}", { price: at }), cls: "alert", note: matchMedia("(hover: none)").matches ? "" : "A", run: () => addAlert(m, price) });
    return items;
  }

  // "TRAIL 1% · 0.84%": distance and current gap between the price and the managed stop
  stopTitle(s) {
    const q = prices[this.market.id], px = q && (q.last || q.mark);
    const gap = px ? ` · ${(Math.abs(px - s.stop) / px * 100).toFixed(2)}%` : "";
    return `${!autoOn() || !s.enabled ? "OFF " : ""}TRAIL ${trailLabel(s, this.market)}${gap}`;
  }

  destroy() { this.chart.remove(); this.el.remove(); }
}

function savePanels() { store("panels", panelCfg); }

// ---------- Chart elements menu: which lines and marks every chart draws ----------
// A line's text (SL PnL −$24, LONG 0.5, LIMIT…) is drawn at the chart's right edge, over the latest candles, and
// the chart makes room for it there. Off by default: the line and its price on the price axis are enough, and the
// chart doesn't move. "Text on graph lines" in Elements brings it back.
const lineTitle = (title) => (chartEls.labels ? title || "" : "");
const CHART_ELEMENTS = [
  ["labels", "Testo sulle linee del grafico"], ["orders", "Linee ordini"], ["stop", "Stop gestito"], ["position", "Linea posizione"],
  ["liq", "Prezzo di liquidazione"], ["mark", "Linea prezzo mark"], ["events", "Eventi macro"], ["fills", "I tuoi fill"], ["alerts", "Alert di prezzo"], ["zscore", "Z-score degli spread"], ["preview", "Anteprima ticket"],
];
let chartEls = { labels: false, orders: false, stop: false, position: false, liq: true, mark: false, events: true, fills: true, alerts: true, zscore: true, preview: false, ...load("chartEls", {}) };
let openOrders = {}; // market id -> open orders on Lighter, shared by the chart lines and the Orders tab
const fade = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c + "b0" : c); // hex colour at ~70% for provisional lines
// a trigger order that isn't reduce-only opens a position: it is no SL or TP
// orders worked by the engine (chase, iceberg): by client order index; in paper the order says so itself
let working = {};
const workingOf = (o) => o.working || working[o.client_order_index] || null;
const orderKind = (o) => (workingOf(o) ? workingOf(o).kind.toUpperCase() : /twap/i.test(o.type) ? "TWAP" : !/stop|take/i.test(o.type) ? "LIMIT" : !o.reduce_only ? "COND" : /stop/i.test(o.type) ? "SL" : "TP");

function renderChartEls() {
  $("#elMenu").innerHTML = `<div class="caps muted">${t("Elementi del grafico")}</div>` +
    CHART_ELEMENTS.map(([k, name]) => `<button data-el="${k}" class="${chartEls[k] ? "on" : ""}"><span>${t(name)}</span><i>✓</i></button>`).join("") +
    (info.trading ? "" : `<p class="hint">${t("Ordini e stop gestito compaiono con un'API key collegata.")}</p>`);
}

function toggleChartEl(k) {
  chartEls[k] = !chartEls[k];
  store("chartEls", chartEls);
  renderChartEls();
  panels.forEach((p) => { p.drawLines(); p.drawMarkers(); });
  if (k === "zscore") panels.forEach((p) => { p.drawZ(); p.renderLegend(); });
  if (k === "preview" || k === "labels") updateTicketSummary(); // the ticket's lines are drawn from there
  if (k === "orders" && chartEls.orders) fetchOpenOrders().catch(() => {});
  if (k === "fills") panels.forEach((p) => p.loadFills(true));
}

// ---------- timeframe toolbar + "More" menu ----------
function setTf(tf) {
  panelCfg[activeIdx].tf = tf;
  savePanels();
  activePanel().load();
  setActive(activeIdx);
}

function renderTfs() {
  const cur = panelCfg[activeIdx].tf;
  $("#tfs").innerHTML = shownTfs.map((t) => `<button data-tf="${t}" class="${t === cur ? "active" : ""}">${tfLabel(t)}</button>`).join("");
  const hidden = ALL_TFS.filter((t) => !shownTfs.includes(t));
  // a selected timeframe that is not in the toolbar shows on the More button
  const more = $("#tfMoreBtn");
  more.classList.toggle("active", !shownTfs.includes(cur));
  $("span", more).textContent = shownTfs.includes(cur) ? t("Altri") : tfLabel(cur);
  $("#tfHidden").innerHTML = hidden.length
    ? hidden.map((t) => `<button data-pick="${t}" class="${t === cur ? "active" : ""}">${tfLabel(t)}</button>`).join("")
    : `<span class="muted">${t("Tutti i timeframe sono nella barra.")}</span>`;
  $("#tfShown").innerHTML = ALL_TFS.map((t) => `<button data-show="${t}" class="${shownTfs.includes(t) ? "on" : ""}">${tfLabel(t)}<i>✓</i></button>`).join("");
}

function toggleTfMenu(open) {
  const menu = $("#tfMenu");
  const show = open === undefined ? menu.classList.contains("hidden") : open;
  menu.classList.toggle("hidden", !show);
  if (show) { renderTfs(); fitInView(menu); }
}

// ---------- drop-down lists in the theme's colours ----------
// A <select>'s own list is drawn by the operating system and ignores the theme. With a mouse, a click on any
// select opens this menu instead; picking sets the select and fires its change, so the code that reads it is the
// same. Phones keep the system's picker, which suits a thumb. The select itself still works from the keyboard.
const selMenu = { el: null, select: null, items: [], at: -1 };
function openSelMenu(select) {
  closeSelMenu();
  const opts = [...select.options];
  if (!opts.length) return;
  const el = (selMenu.el ||= Object.assign(document.createElement("div"), { className: "sel-menu hidden" }));
  if (!el.isConnected) document.body.appendChild(el);
  el.innerHTML = opts.map((o, i) => `<button type="button" data-i="${i}" class="${o.selected ? "active" : ""}"${o.disabled ? " disabled" : ""}>${esc(o.textContent)}</button>`).join("");
  selMenu.select = select;
  selMenu.items = [...el.children];
  selMenu.at = select.selectedIndex;
  el.classList.remove("hidden");
  const r = select.getBoundingClientRect();
  el.style.minWidth = Math.round(r.width) + "px";
  const h = el.offsetHeight, w = el.offsetWidth;
  const below = innerHeight - r.bottom - 8, above = r.top - 8;
  el.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
  el.style.top = (h <= below || below >= above ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(h, above))) + "px";
  el.style.maxHeight = Math.max(160, Math.min(360, h <= below || below >= above ? below : above)) + "px";
  const cur = selMenu.items[selMenu.at];
  if (cur) cur.scrollIntoView({ block: "nearest" });
  select.classList.add("sel-open");
}
function closeSelMenu() {
  if (!selMenu.select) return;
  selMenu.select.classList.remove("sel-open");
  selMenu.el.classList.add("hidden");
  selMenu.select = null;
}
function pickSelMenu(i) {
  const select = selMenu.select;
  closeSelMenu();
  if (!select || i < 0 || select.options[i].disabled) return;
  select.focus();
  if (select.selectedIndex === i) return;
  select.selectedIndex = i;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function moveSelMenu(dir) {
  const n = selMenu.items.length;
  let i = selMenu.at;
  for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (!selMenu.items[i].disabled) break; }
  selMenu.items.forEach((b, k) => b.classList.toggle("focus", k === i));
  selMenu.at = i;
  selMenu.items[i].scrollIntoView({ block: "nearest" });
}
function wireSelMenus() {
  const mouse = matchMedia("(hover: hover) and (pointer: fine)");
  document.addEventListener("mousedown", (e) => {
    const sel = e.target.closest && e.target.closest("select");
    if (sel && mouse.matches && !sel.multiple && !sel.disabled && e.button === 0) {
      e.preventDefault(); // no system list
      if (selMenu.select === sel) return closeSelMenu();
      sel.focus();
      return openSelMenu(sel);
    }
    if (selMenu.select && !(e.target.closest && e.target.closest(".sel-menu"))) closeSelMenu();
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".sel-menu [data-i]");
    if (b) pickSelMenu(+b.dataset.i);
  });
  document.addEventListener("keydown", (e) => {
    if (!selMenu.select) return;
    const k = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (k) { e.preventDefault(); e.stopPropagation(); return moveSelMenu(k); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); return pickSelMenu(selMenu.at); }
    if (e.key === "Escape" || e.key === "Tab") { e.stopPropagation(); closeSelMenu(); }
  }, true);
  for (const ev of ["resize", "blur"]) addEventListener(ev, closeSelMenu);
  document.addEventListener("scroll", (e) => { if (selMenu.select && !(e.target.closest && e.target.closest(".sel-menu"))) closeSelMenu(); }, true);
}

// a menu opened next to its button is moved sideways to stay inside the screen (on a phone the button
// can sit anywhere along a wrapped toolbar)
function fitInView(el) {
  el.style.transform = "";
  const r = el.getBoundingClientRect(), pad = 8;
  const dx = r.left < pad ? pad - r.left : r.right > innerWidth - pad ? innerWidth - pad - r.right : 0;
  if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
}

function buildCharts() {
  panels.forEach((p) => p.destroy());
  panels = [];
  const n = { "1": 1, "2v": 2, "2h": 2, "4": 4 }[layout];
  if (activeIdx >= n) activeIdx = 0;
  const box = $("#charts");
  box.className = "charts l" + layout;
  for (const i of [...Array(n).keys()]) {
    const p = new Panel(i);
    box.appendChild(p.el);
    panels.push(p);
    p.load();
  }
  $$("#layouts button").forEach((b) => b.classList.toggle("active", b.dataset.layout === layout));
  applyKeyHints();
  setActive(activeIdx);
}

const activePanel = () => panels.find((p) => p.idx === activeIdx);

function setActive(i) {
  activeIdx = i;
  store("active", i);
  panels.forEach((p) => p.el.classList.toggle("active", p.idx === i));
  const cfg = panelCfg[i];
  renderTfs();
  renderMarketBar();
  renderTicket();
  renderTicker();
  renderTitle();
  if (curView === "trade" && activeMarket()) syncUrl(false); // /trade/<market> follows the selected chart
  loadBook();
  renderEcon(); // the calendar follows the selected market
}

// browser tab: last price of the selected chart, like Lighter's own tab
function renderTitle() {
  const pr = activePair();
  if (pr) {
    const pa = prices[pr[0].id], pb = prices[pr[1].id], xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark);
    document.title = xa && xb ? `${fp(xa / xb, { price_decimals: ratioDecimals(xa / xb) })} • ${pr[0].symbol}/${pr[1].symbol} • LighterDeck` : "LighterDeck";
    return;
  }
  const m = activeMarket(), q = m && prices[m.id];
  const px = q && (q.last || q.mark);
  document.title = px ? `${fp(px, m)} • ${m.symbol} • LighterDeck` : "LighterDeck";
}

// a spread chart's ticket, order book and calendar follow its first market
const activeMarket = () => { const s = panelCfg[activeIdx].symbol; return bySymbol[s] || (pairOf(s) || [])[0]; };
const activePair = () => pairOf(panelCfg[activeIdx].symbol);

function setSymbol(sym) {
  if (!bySymbol[sym] && !pairOf(sym)) return;
  panelCfg[activeIdx].symbol = sym;
  savePanels();
  activePanel() && activePanel().load();
  setActive(activeIdx);
  if (chartEls.orders && info.trading) fetchOpenOrders().catch(() => {});
}

// ================= market bar / ticker =================
// the star in the market button: this market or spread in the favourites, or out of them
function renderMkStar(sym) {
  const star = $("#mkStar"), on = favs.includes(sym);
  star.classList.toggle("on", on);
  star.title = t(on ? "Togli dai preferiti" : "Aggiungi ai preferiti");
}
function renderMarketBar() {
  const pr = activePair();
  if (pr) return renderPairBar(pr);
  const m = activeMarket();
  if (!m) return;
  renderMkStar(m.symbol);
  $("#mkSym").textContent = m.symbol;
  if ($("#mkIco").dataset.sym !== m.symbol) {
    $("#mkIco").outerHTML = ico(m.symbol).replace('<i class="mk-ico"', `<i class="mk-ico" id="mkIco" data-sym="${m.symbol}"`);
  }
  const p = prices[m.id];
  if (!p) return;
  $("#stMark").textContent = fp(p.mark, m);
  const ch = $("#stChg");
  ch.textContent = fpct(p.change);
  ch.className = cls(p.change);
  $("#stVol").textContent = fcompact(p.volume);
  $("#stIdx").textContent = fp(p.index, m);
  const f = $("#stFund");
  f.textContent = p.funding.toFixed(4) + "%";
  // plain while normal; once high (as its badge): red if your position pays it, green if it receives it, amber otherwise
  const fpos = Math.abs(p.funding) >= BADGE_FUNDING && account && account.positions.find((x) => x.market_id === m.id);
  f.className = Math.abs(p.funding) < BADGE_FUNDING ? "" : fpos ? (Math.sign(fpos.size) === Math.sign(p.funding) ? "down" : "up") : "warn";
  if (fundView.open && $("#fundPop").dataset.mid !== String(m.id)) { $("#fundPop").dataset.mid = m.id; loadFundingHistory(); }
  $("#stOi").textContent = fcompact(p.oi);
}

// a spread in the market bar: the ratio and its 24h change; the rest belongs to each market
function renderPairBar([a, b]) {
  const sym = `${a.symbol}/${b.symbol}`;
  renderMkStar(sym);
  $("#mkSym").textContent = sym;
  if ($("#mkIco").dataset.sym !== sym) {
    $("#mkIco").outerHTML = `<span class="pair-ico" id="mkIco" data-sym="${esc(sym)}">${ico(a.symbol)}${ico(b.symbol)}</span>`;
  }
  const pa = prices[a.id], pb = prices[b.id];
  const xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark);
  const r = xa && xb ? xa / xb : null;
  $("#stMark").textContent = r ? fp(r, { price_decimals: ratioDecimals(r) }) : "—";
  const chg = pa && pb ? ((1 + pa.change / 100) / (1 + pb.change / 100) - 1) * 100 : null;
  const ch = $("#stChg");
  ch.textContent = chg !== null ? fpct(chg) : "—";
  ch.className = chg !== null ? cls(chg) : "";
  for (const id of ["#stVol", "#stIdx", "#stFund", "#stOi"]) { $(id).textContent = "—"; $(id).className = ""; }
}

// ---------- context badges: what matters about a market right now ----------
// Each badge has a stable key (event:<id>, funding, session, liq), so it can later drive an alert too.
const BADGE_EVENT_BEFORE = 3600, BADGE_EVENT_AFTER = 900; // high-impact event: from 1 h before to 15 min after
const BADGE_FUNDING = 0.01;                               // % per hour (about 88% a year)
const BADGE_LIQ = 10;                                     // liquidation within 10% of the mark
// where a stock or ETF trades; anything not listed here or in US_EXTRA has no session badge
const MARKET_EXCHANGE = { XIAOMI: "XHKG", TENCENT: "XHKG", POPMART: "XHKG", BYD: "XHKG", SMIC: "XHKG", KIOXIA: "XTKS" };
const US_EXTRA = ["AVGO", "ARM", "QCOM", "NOK", "AAOI"];
const NO_SESSION = ["SHEIN", "UNITREE", "CXMT", "ZHIPU", "MINIMAX", "STABLECOINX", "WEN", "SPCX", "BOT", "STONK", "TUR30"];

function marketSession(m) {
  const cats = m.categories || [];
  if (NO_SESSION.includes(m.symbol) || cats.some((c) => ["PRE_IPO", "PRE_LAUNCH", "KRW"].includes(c))) return null;
  const code = MARKET_EXCHANGE[m.symbol] || ((cats.includes("STOCK") || cats.includes("ETF") || US_EXTRA.includes(m.symbol)) ? "XNYS" : null);
  if (code) return SESSIONS.find((s) => s.code === code);
  // FX and the CME futures behind metals, energy and bonds: Sunday evening to Friday 17:00 New York
  if ((cats.includes("FX") || cats.includes("COMMODITIES") || cats.includes("BONDS")) && m.symbol !== "PAXG") return { weekly: cats.includes("FX") ? 17 : 18 };
  return null;
}

// FX / CME: closed from Friday 17:00 to Sunday 17:00 (FX) or 18:00 (CME) New York time
function weeklyStatus(openHour, now) {
  const z = zoned(now, "America/New_York");
  const closed = z.wd === "Sat" || (z.wd === "Fri" && z.h >= 17) || (z.wd === "Sun" && z.h < openHour);
  if (!closed) return null;
  const add = { Fri: 2, Sat: 1, Sun: 0 }[z.wd];
  const d = new Date(Date.UTC(z.y, z.mo - 1, z.d + add));
  return wallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), openHour, 0, "America/New_York");
}

function contextBadges(m) {
  const out = [], now = Date.now(), p = prices[m.id];
  // the next high-impact event for this market, or one just out
  const ev = events.filter((e) => eventFor(e, m.symbol) && impactFor(e, m.symbol) === "High" && e.when !== "time not given"
    && e.ts > now / 1000 - BADGE_EVENT_AFTER && e.ts < now / 1000 + BADGE_EVENT_BEFORE).sort((a, b) => a.ts - b.ts)[0];
  if (ev) {
    const left = ev.ts * 1000 - now, name = `${ev.country && ev.source !== "Nasdaq" ? ev.country + " " : ""}${ev.title}`;
    // earnings come with the session only, so no countdown to a made-up minute
    const text = ev.approx && WHEN[ev.when] ? `${name} · ${t(WHEN[ev.when])}` : left > 0 ? t("{ev} tra {d}", { ev: name, d: dur(left) }) : t("{ev} {d} fa", { ev: name, d: dur(-left) });
    out.push({ key: `event:${ev.id || ev.ts}`, cls: left > 0 && left < 900000 && !ev.approx ? "warn hot" : "warn", text,
      title: t("Evento ad alto impatto per {sym}", { sym: m.symbol }), go: "calendar" });
  }
  // funding far from the usual
  if (p && Math.abs(p.funding) >= BADGE_FUNDING) {
    const pos = account && account.positions.find((x) => x.market_id === m.id);
    const pays = pos && Math.sign(pos.size) === Math.sign(p.funding);
    out.push({ key: "funding", cls: pays ? "bad" : "warn", text: t("Funding {r}/h", { r: fpctf(p.funding) }) + (pays ? " · " + t("lo paghi") : ""),
      title: p.funding > 0 ? t("Funding alto: i long pagano gli short ogni ora") : t("Funding alto: gli short pagano i long ogni ora"), go: "funding" });
  }
  // the underlying market: closed, at lunch, or about to close
  const s = marketSession(m);
  if (s && s.weekly) {
    const opens = weeklyStatus(s.weekly, now);
    if (opens) out.push({ key: "session", cls: "info", text: t("Chiuso · apre tra {d}", { d: dur(opens - now) }), title: t("Il mercato sottostante è chiuso nel weekend: il prezzo può muoversi poco o saltare alla riapertura") });
  } else if (s) {
    const st = sessionStatus(s, now);
    if (st.state === "closed") out.push({ key: "session", cls: "info", text: t("{ex} chiusa · apre tra {d}", { ex: s.ex, d: st.at ? dur(st.at - now) : "—" }),
      title: t("La borsa del sottostante è chiusa: il prezzo può muoversi poco o saltare alla riapertura") });
    else if (st.state === "lunch") out.push({ key: "session", cls: "info", text: t("{ex} in pausa · riprende tra {d}", { ex: s.ex, d: dur(st.at - now) }), title: t("Pausa pranzo della borsa del sottostante") });
    else if (!st.lunchNext && st.at - now < 1800000) out.push({ key: "session", cls: "warn", text: t("{ex} chiude tra {d}", { ex: s.ex, d: dur(st.at - now) }), title: t("La borsa del sottostante sta per chiudere") });
  }
  // your position close to liquidation
  const pos = account && account.positions.find((x) => x.market_id === m.id);
  const mark = p && p.mark;
  if (pos && pos.liq && mark) {
    const gap = Math.abs(mark - pos.liq) / mark * 100;
    if (gap < BADGE_LIQ) out.push({ key: "liq", cls: "bad", text: t("Liquidazione a {g}%", { g: gap.toFixed(1) }), title: t("Il prezzo di liquidazione della tua posizione è a {price}", { price: fp(pos.liq, m) }) });
  }
  return out;
}

function setBadges(box, m, max = 6) {
  if (!box || !m) return;
  const list = contextBadges(m).slice(0, max);
  const html = list.map((b) => `<button class="ctx ${b.cls}" data-go="${b.go || ""}" title="${esc(b.title || "")}">${esc(b.text)}</button>`).join("");
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function wirePairGroup() {
  const pop = $("#pairGroupPop");
  pop.addEventListener("click", async (e) => {
    const sp = e.target.closest("[data-spreadfrom]");
    if (sp) { pop.classList.add("hidden"); return openSpreadPicker(sp.dataset.spreadfrom); }
    const b = e.target.closest("[data-group]");
    if (!b) return;
    const [l, s] = b.dataset.group.split(":").map(Number);
    pop.classList.add("hidden");
    try { pairs = await api("/pairs", { method: "POST", body: JSON.stringify({ long_id: l, short_id: s }) }); renderPositions(); }
    catch (err) { toast(err.message, true); }
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#pairGroupPop, [data-pairfrom]")) pop.classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.classList.add("hidden"); });
}

// On a phone the bottom tables turn into cards (CSS); each cell needs its column's name to show beside the value.
// Every table put into a bottom tab gets them from its header, whatever renders it.
function labelTable(table) {
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  for (const tr of table.querySelectorAll("tbody tr")) {
    let col = 0;
    for (const td of tr.children) {
      td.dataset.label = td.colSpan > 1 ? "" : heads[col] || ""; // a cell over several columns is text of its own
      col += td.colSpan || 1;
    }
  }
}

function wireCardTables() {
  for (const box of $$(".btab")) {
    new MutationObserver(() => box.querySelectorAll("table.table").forEach(labelTable)).observe(box, { childList: true, subtree: true });
  }
}

function wireBadges() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".ctx[data-go]");
    if (!b || !b.dataset.go) return;
    const panel = b.closest(".panel");
    if (panel) { const p = panels.find((x) => x.el === panel); if (p) setActive(p.idx); }
    if (b.dataset.go === "funding") toggleFunding(true);
    else if (b.dataset.go === "calendar") switchView("cal");
  });
}

// ---------- funding details ----------
// Lighter pays funding every hour; the estimate in the market bar is the % per hour, positive when longs pay
const fundView = { open: false, days: 7, chart: null, rate: null, cum: null, timer: null };
const fpctf = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}%`;

function toggleFunding(open = !fundView.open) {
  fundView.open = open;
  $("#fundPop").classList.toggle("hidden", !open);
  if (open) fitInView($("#fundPop"));
  $("#stFundBtn").classList.toggle("open", open);
  clearInterval(fundView.timer);
  if (!open) return;
  fundView.timer = setInterval(renderFundingStats, 1000); // countdown
  renderFundingStats();
  $("#fundPop").dataset.mid = activeMarket() ? activeMarket().id : "";
  loadFundingHistory();
}

function renderFundingStats() {
  const m = activeMarket(), p = m && prices[m.id];
  if (!fundView.open || !m) return;
  $("#fundTitle").textContent = t("Funding {sym}", { sym: m.symbol });
  const left = 3600 - Math.floor(Date.now() / 1000) % 3600;
  $("#fdNext").textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  const r = p ? p.funding : null;
  const show = (id, v) => { const el = $(id); el.textContent = r === null ? "—" : fpctf(v); el.className = r === null ? "" : v >= 0 ? "up" : "down"; };
  show("#fdNow", r); show("#fdWeek", r * 24 * 7); show("#fdMonth", r * 24 * 30); show("#fdYear", r * 24 * 365);
  // the legend reads the sign the rate has now
  $("#fundSign").textContent = r < 0 ? t("Negativo: gli short pagano i long") : t("Positivo: i long pagano gli short");
  // what the open position pays (−) or receives (+) at the next funding, at the current estimate
  const pos = account && account.positions.find((x) => x.market_id === m.id);
  $("#fdPosRow").classList.toggle("hidden", !pos || r === null);
  if (pos && r !== null) {
    const usd = -Math.sign(pos.size) * Math.abs(pos.size) * (p.mark || pos.entry) * r / 100;
    const el = $("#fdPos");
    el.textContent = `${usd >= 0 ? t("ricevi") : t("paghi")} ${fusd(Math.abs(usd))}/h`;
    el.className = usd >= 0 ? "up" : "down";
  }
}

// the hour under the pointer: its rate and the running total, and who paid whom
function fundTip(p) {
  const tip = $("#fundTip"), box = $("#fundChart");
  const rate = p.point && p.time ? p.seriesData.get(fundView.rate) : null, cum = rate ? p.seriesData.get(fundView.cum) : null;
  if (!rate) { tip.classList.add("hidden"); return; }
  const who = (v) => (v > 0 ? t("i long pagano gli short") : v < 0 ? t("gli short pagano i long") : "");
  const line = (label, v) => `<div class="ft-row"><span>${label}</span><b class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${fpctf(v, 4)}</b></div>${v ? `<div class="ft-who">${who(v)}</div>` : ""}`;
  // in local time, like the chart's time axis
  tip.innerHTML = `<div class="ft-time">${new Date(p.time * 1000).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>`
    + line(t("Funding dell'ora"), rate.value) + (cum ? line(t("Cumulato"), cum.value) : "");
  tip.classList.remove("hidden");
  // at the top, on the half away from the pointer: never over the hour being read
  const plot = fundView.chart.timeScale().width(), left = box.clientWidth - plot - fundView.chart.priceScale("right").width();
  const x = p.point.x > plot / 2 ? left + 8 : left + plot - tip.offsetWidth - 8;
  tip.style.left = Math.max(4, x) + "px";
  tip.style.top = "6px";
}

async function loadFundingHistory() {
  const m = activeMarket();
  if (!m) return;
  const days = fundView.days;
  $$("#fundRange button").forEach((b) => b.classList.toggle("active", +b.dataset.d === days));
  if (!fundView.chart) {
    const pct = { type: "custom", minMove: 0.0001, formatter: (v) => v.toFixed(4) + "%" };
    fundView.chart = LightweightCharts.createChart($("#fundChart"), {
      autoSize: true,
      layout: { background: { color: "transparent" }, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" },
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } },
      leftPriceScale: { visible: true, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { timeVisible: true, secondsVisible: false },
      // no line following the pointer up and down: the dots sit on both curves and the box reads them out
      crosshair: { mode: 0, vertLine: { style: 2 }, horzLine: { visible: false, labelVisible: false } },
      handleScroll: false, handleScale: false,
    });
    fundView.cum = fundView.chart.addLineSeries({ priceScaleId: "left", lineWidth: 1.5, priceFormat: pct, lastValueVisible: false, priceLineVisible: false });
    fundView.chart.applyOptions(LOCAL_TIME);
    fundView.rate = fundView.chart.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 1.5, priceFormat: pct, priceLineVisible: false });
    fundView.chart.subscribeCrosshairMove(fundTip);
  }
  fundView.chart.applyOptions({ ...chartTheme(), leftPriceScale: { visible: innerWidth > 640 } }); // phones: room for the chart, cumulative still drawn
  fundView.cum.applyOptions({ color: cssVar("--muted") });
  fundView.rate.applyOptions({ topLineColor: C.green, bottomLineColor: C.red, topFillColor1: "transparent", topFillColor2: "transparent",
    bottomFillColor1: "transparent", bottomFillColor2: C.red + "22" });
  const rows = await api(`/funding?market_id=${m.id}&days=${days}`).catch(() => null);
  if (!rows || activeMarket() !== m || fundView.days !== days) return;
  let sum = 0;
  fundView.rate.setData(rows.map((r) => ({ time: r.t, value: r.rate })));
  fundView.cum.setData(rows.map((r) => ({ time: r.t, value: (sum += r.rate) })));
  fundView.chart.timeScale().fitContent();
}

// the favourites as the bar shows them: the number keys follow this order (1 is the first, 0 the tenth)
const shownFavs = () => favs.filter((s) => bySymbol[s] || pairOf(s));

function renderTicker() {
  if (tickerDrag) return; // don't rebuild the row under the pointer
  const box = $("#ticker");
  const active = panelCfg[activeIdx].symbol;
  box.innerHTML = shownFavs().map((s, i) => {
    const pr = pairOf(s);
    const key = i < 10 ? ` title="${t("Tasto {n}: nel grafico selezionato", { n: (i + 1) % 10 })}"` : ""; // the number key that loads it
    if (pr) { // a spread: its ratio and the ratio's 24h change, as in the market bar
      const [pa, pb] = [prices[pr[0].id], prices[pr[1].id]];
      const xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark), r = xa && xb ? xa / xb : null;
      const chg = pa && pb ? ((1 + pa.change / 100) / (1 + pb.change / 100) - 1) * 100 : null;
      return `<button class="tk${active === s ? " active" : ""}" data-sym="${esc(s)}"${key}>
        <span class="pair-ico">${ico(pr[0].symbol, "xs")}${ico(pr[1].symbol, "xs")}</span><b>${esc(s)}</b><span class="num">${r ? fp(r, { price_decimals: ratioDecimals(r) }) : "—"}</span>
        <span class="chg ${chg !== null ? cls(chg) : ""}">${chg !== null ? fpct(chg) : ""}</span></button>`;
    }
    const m = bySymbol[s];
    const p = prices[m.id];
    return `<button class="tk${active === s ? " active" : ""}" data-sym="${s}"${key}>
      ${ico(s, "xs")}<b>${s}</b><span class="num">${p ? fp(p.last || p.mark, m) : "—"}</span>
      <span class="chg ${p ? cls(p.change) : ""}">${p ? fpct(p.change) : ""}</span></button>`;
  }).join("");
  updateTickerArrows();
}

// favourites row wider than the screen: the mouse wheel scrolls it sideways, and an arrow shows on each side
// that has favourites out of view (a click moves it by most of its width)
function updateTickerArrows() {
  updateTickerFold();
  const box = $("#ticker"), end = box.scrollWidth - box.clientWidth;
  $("#tickerLeft").classList.toggle("hidden", box.scrollLeft <= 2);
  $("#tickerRight").classList.toggle("hidden", end <= 2 || box.scrollLeft >= end - 2);
}

// on a computer the favourites wrap onto as many rows as they need; the arrow at the end folds them to one
// scrolling row (remembered) and back. A tablet has the arrow too but starts on one row, to keep the screen for
// the chart; a phone only scrolls the row with the finger. The arrow shows only when there is more than one row's worth.
const tickerMouse = matchMedia("(hover: hover) and (pointer: fine)");
// a touch screen whose short side is at least 600px is a tablet (phones stay under it, also turned sideways)
const tickerTablet = () => !tickerMouse.matches && Math.min(screen.width, screen.height) >= 600;
let tickerOneRow = load("tickerOneRow", null);
function updateTickerFold() {
  const bar = $(".ticker"), box = $("#ticker"), fold = $("#tickerFold");
  const folds = tickerMouse.matches || tickerTablet();
  const wrap = folds && !(tickerOneRow ?? !tickerMouse.matches);
  bar.classList.toggle("wrap", wrap);
  const items = box.children, last = items[items.length - 1];
  const more = folds && !!last && (wrap ? last.offsetTop > items[0].offsetTop : box.scrollWidth > box.clientWidth + 2);
  fold.classList.toggle("hidden", !more);
  bar.classList.toggle("has-fold", more);
  const label = t(wrap ? "Riduci a una riga" : "Mostra tutti i preferiti");
  fold.title = label;
  fold.setAttribute("aria-label", label);
}

function wireTickerScroll() {
  const box = $("#ticker");
  $("#tickerFold").onclick = () => {
    tickerOneRow = $(".ticker").classList.contains("wrap");
    store("tickerOneRow", tickerOneRow);
    box.scrollLeft = 0;
    updateTickerArrows();
  };
  tickerMouse.addEventListener("change", updateTickerArrows);
  box.addEventListener("wheel", (e) => {
    if (box.scrollWidth <= box.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a sideways swipe scrolls by itself
    e.preventDefault();
    box.scrollLeft += e.deltaY;
  }, { passive: false });
  box.addEventListener("scroll", updateTickerArrows, { passive: true });
  const step = (dir) => box.scrollBy({ left: dir * box.clientWidth * 0.7, behavior: "smooth" });
  $("#tickerLeft").onclick = () => step(-1);
  $("#tickerRight").onclick = () => step(1);
  addEventListener("resize", updateTickerArrows);
}

// the chart toolbar on a narrow column: icons only when it doesn't fit, a second line when even that doesn't
function fitToolbar() {
  const tb = document.querySelector(".toolbar");
  if (!tb || !tb.offsetWidth) return;
  tb.classList.remove("tb-icons", "tb-wrap");
  const over = () => tb.scrollWidth > tb.clientWidth + 1;
  if (over()) tb.classList.add("tb-icons");
  if (over()) tb.classList.add("tb-wrap");
}
function wireToolbarFit() {
  const tb = document.querySelector(".toolbar");
  if (!tb) return;
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitToolbar); }).observe(tb.parentElement);
  new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitToolbar); }).observe($("#tfs"), { childList: true });
}

// a spread's candles: the bars both markets have. A ratio's true high and low aren't known, so they come from
// the bar's open, close and the two highs and lows over each other (one market's high over the other's low
// would draw wicks far past anything the ratio reached)
function ratioCandles(ca, cb) {
  const byTime = new Map(cb.map((c) => [c.time, c]));
  const candles = [];
  for (const x of ca) {
    const y = byTime.get(x.time);
    if (!y || !y.open || !y.close || !y.high || !y.low) continue;
    const o = x.open / y.open, c = x.close / y.close, h = x.high / y.high, l = x.low / y.low;
    candles.push({ time: x.time, open: o, close: c, high: Math.max(o, c, h, l), low: Math.min(o, c, h, l) });
  }
  return candles;
}

// ---------- a favourite's chart on hover ----------
// Resting the pointer on a favourite for a moment shows its last 24 hours in 15-minute candles, under it; a spread
// shows its ratio. Candles are kept a minute per market, so moving along the bar doesn't ask Lighter again.
const PEEK_TF = "15m", PEEK_BARS = 96, PEEK_TTL = 60000, PEEK_DELAY = 280;
const peek = { chart: null, series: null, sym: null, timer: 0, cache: new Map() };
const peekMouse = matchMedia("(hover: hover) and (pointer: fine)");
async function peekBars(sym) {
  const hit = peek.cache.get(sym);
  if (hit && Date.now() - hit.at < PEEK_TTL) return hit.bars;
  const get = (m) => api(`/candles?market_id=${m.id}&resolution=${PEEK_TF}&count=${PEEK_BARS}`);
  const pr = pairOf(sym);
  let bars;
  if (pr) { // the ratio of the two markets' candles, as on the main chart
    const [a, b] = await Promise.all([get(pr[0]), get(pr[1])]);
    bars = ratioCandles(a, b);
  } else {
    bars = await get(bySymbol[sym]);
  }
  peek.cache.set(sym, { at: Date.now(), bars });
  return bars;
}
function peekHead(sym) {
  const pr = pairOf(sym), m = bySymbol[sym];
  let price = null, chg = null, dec = m;
  if (pr) {
    const [pa, pb] = [prices[pr[0].id], prices[pr[1].id]];
    const xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark);
    price = xa && xb ? xa / xb : null;
    chg = pa && pb ? ((1 + pa.change / 100) / (1 + pb.change / 100) - 1) * 100 : null;
    dec = price ? { price_decimals: ratioDecimals(price) } : null;
  } else if (m && prices[m.id]) {
    price = prices[m.id].last || prices[m.id].mark;
    chg = prices[m.id].change;
  }
  const icon = pr ? `<span class="pair-ico">${ico(pr[0].symbol, "xs")}${ico(pr[1].symbol, "xs")}</span>` : ico(sym, "xs");
  return `${icon}<b>${esc(sym)}</b><span class="num">${price ? fp(price, dec) : "—"}</span>`
    + `<span class="chg ${chg !== null ? cls(chg) : ""}">${chg !== null ? fpct(chg) : ""}</span><span class="tf">24h · ${PEEK_TF}</span>`;
}
async function showPeek(el) {
  const sym = el.dataset.sym, box = $("#tkPeek");
  peek.sym = sym;
  if (!peek.chart) {
    peek.chart = LightweightCharts.createChart($(".tkp-chart", box), {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { color: "transparent" }, fontSize: 10, fontFamily: "JetBrains Mono, monospace" },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0, vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
    });
    peek.chart.applyOptions(LOCAL_TIME);
    peek.series = peek.chart.addCandlestickSeries({ borderVisible: false, priceLineStyle: 2, priceLineWidth: 1 });
  }
  peek.chart.applyOptions(chartTheme());
  peek.series.applyOptions({ upColor: C.green, downColor: C.red, wickUpColor: C.green, wickDownColor: C.red });
  $(".tkp-head", box).innerHTML = peekHead(sym);
  const r = el.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - 328)) + "px";
  box.style.top = r.bottom + 6 + "px";
  box.classList.add("loading");
  box.classList.remove("hidden");
  const bars = await peekBars(sym).catch(() => null);
  if (peek.sym !== sym) return; // the pointer moved on meanwhile
  if (!bars || !bars.length) { hidePeek(); return; }
  const pr = pairOf(sym), m = bySymbol[sym], d = pr ? ratioDecimals(bars[bars.length - 1].close) : decimals(m);
  peek.series.applyOptions({ priceFormat: { type: "price", precision: d, minMove: 1 / 10 ** d } });
  peek.series.setData(bars);
  peek.chart.timeScale().fitContent();
  box.classList.remove("loading");
}
function hidePeek() {
  clearTimeout(peek.timer);
  peek.sym = null;
  $("#tkPeek").classList.add("hidden");
}
function wireTickerPeek() {
  const box = $("#ticker");
  box.addEventListener("pointermove", (e) => {
    if (!peekMouse.matches || e.pointerType !== "mouse" || tickerDrag) return;
    const el = e.target.closest(".tk");
    const sym = el && el.dataset.sym;
    if (sym === (peek.sym || peek.pending)) return;
    clearTimeout(peek.timer);
    peek.pending = sym;
    if (!sym) { hidePeek(); return; }
    if (peek.sym) { showPeek(el); return; } // already open: it follows the pointer along the bar at once
    // the bar is redrawn every second with the prices: the favourite is found again by its name
    peek.timer = setTimeout(() => {
      const now = box.querySelector(`.tk[data-sym="${CSS.escape(sym)}"]`);
      if (peek.pending === sym && now) showPeek(now);
    }, PEEK_DELAY);
  });
  box.addEventListener("pointerleave", () => { peek.pending = null; hidePeek(); });
  box.addEventListener("pointerdown", () => { peek.pending = null; hidePeek(); }); // a click or a drag
  box.addEventListener("scroll", hidePeek, { passive: true });
}

// favourites row: drag an item sideways to reorder (a plain click still selects the market). On a touch screen
// a tap opens the market and a swipe scrolls the row; holding a favourite for a moment picks it up to move.
let tickerDrag = null, tickerDragEnd = 0;
const TICKER_HOLD = 350; // ms
function wireTickerDrag() {
  const box = $("#ticker");
  const lift = (d) => {
    d.lifted = true;
    d.el.classList.add("dragging");
    document.body.classList.add("reordering");
  };
  box.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tk");
    if (!el || e.button !== 0) return;
    const d = tickerDrag = { el, x0: e.clientX, y0: e.clientY, left0: el.offsetLeft, top0: el.offsetTop, moved: false, id: e.pointerId,
      touch: e.pointerType !== "mouse", lifted: false };
    if (d.touch) d.timer = setTimeout(() => {
      if (tickerDrag !== d) return;
      lift(d);
      if (navigator.vibrate) navigator.vibrate(10);
    }, TICKER_HOLD);
  });
  // once a favourite is picked up the finger moves it, not the row
  box.addEventListener("touchmove", (e) => { if (tickerDrag && tickerDrag.lifted) e.preventDefault(); }, { passive: false });
  box.addEventListener("contextmenu", (e) => { if (tickerDrag && tickerDrag.touch) e.preventDefault(); });
  box.addEventListener("pointermove", (e) => {
    const d = tickerDrag;
    if (!d || e.pointerId !== d.id) return;
    if (d.touch && !d.lifted) { // moving before the hold: a swipe, the row scrolls
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) { clearTimeout(d.timer); tickerDrag = null; }
      return;
    }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.moved = true;
      lift(d);
      try { box.setPointerCapture(e.pointerId); } catch {}
    }
    if ($(".ticker").classList.contains("wrap")) { // rows: move it before or after the favourite under the pointer
      const over = [...box.children].find((b) => {
        if (b === d.el) return false;
        const r = b.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (over) {
        const kids = [...box.children];
        box.insertBefore(d.el, kids.indexOf(over) < kids.indexOf(d.el) ? over : over.nextSibling);
      }
      d.el.style.transform = `translate(${d.left0 + e.clientX - d.x0 - d.el.offsetLeft}px, ${d.top0 + e.clientY - d.y0 - d.el.offsetTop}px)`;
      return;
    }
    // where the item's left edge would be, then swap with a neighbour once we pass its middle
    const left = d.left0 + e.clientX - d.x0;
    const mid = left + d.el.offsetWidth / 2;
    const prev = d.el.previousElementSibling, next = d.el.nextElementSibling;
    if (prev && mid < prev.offsetLeft + prev.offsetWidth / 2) box.insertBefore(d.el, prev);
    else if (next && mid > next.offsetLeft + next.offsetWidth / 2) box.insertBefore(next, d.el);
    d.el.style.transform = `translateX(${left - d.el.offsetLeft}px)`;
  });
  const finish = (e) => {
    const d = tickerDrag;
    if (!d || e.pointerId !== d.id) return;
    tickerDrag = null;
    clearTimeout(d.timer);
    if (d.lifted && !d.moved) { // held and let go in place: nothing moved, and no tap either
      d.el.classList.remove("dragging");
      document.body.classList.remove("reordering");
      tickerDragEnd = Date.now();
      return;
    }
    if (!d.moved) return;
    d.el.classList.remove("dragging");
    d.el.style.transform = "";
    document.body.classList.remove("reordering");
    const order = [...box.querySelectorAll(".tk")].map((b) => b.dataset.sym);
    favs = [...order, ...favs.filter((s) => !order.includes(s))];
    store("favs", favs);
    tickerDragEnd = Date.now(); // the click that follows a drag doesn't select the market
    renderTicker();
    if (!$("#picker").classList.contains("hidden")) renderPicker();
  };
  box.addEventListener("pointerup", finish);
  box.addEventListener("pointercancel", finish);
}

// ================= order book =================
// ---------- order book: live stream straight from Lighter's websocket ----------
// Snapshot on subscribe, then deltas (size 0 removes a level). Each update's begin_nonce
// must match the previous nonce; on a gap we resubscribe for a fresh snapshot.
const book = { ws: null, market: null, asks: new Map(), bids: new Map(), nonce: null, dirty: false, live: false, trades: [], liqs: [] };

function bookConnect() {
  if (book.ws || !info.ws_url) return;
  const ws = new WebSocket(info.ws_url);
  book.ws = ws;
  ws.onopen = () => bookSubscribe(activeMarket());
  book.lastMsg = Date.now();
  ws.onmessage = (ev) => {
    book.lastMsg = Date.now();
    const msg = JSON.parse(ev.data);
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type && msg.type.endsWith("/trade")) return bookTrades(msg);
    if (!msg.type || !msg.type.endsWith("order_book") || !book.market) return;
    if (msg.channel && msg.channel !== `order_book:${book.market.id}`) return;
    const ob = msg.order_book;
    if (msg.type === "subscribed/order_book") { book.asks.clear(); book.bids.clear(); }
    else if (book.nonce !== null && ob.begin_nonce !== book.nonce) { bookSubscribe(book.market, true); return; }
    const m = book.market;
    for (const [side, map] of [["asks", book.asks], ["bids", book.bids]]) {
      for (const lvl of ob[side] || []) {
        const price = +lvl.price / (m.multiplier || 1), size = +lvl.size * (m.multiplier || 1);
        if (size > 0) map.set(price, size); else map.delete(price);
      }
    }
    book.nonce = ob.nonce;
    book.live = true;
    book.dirty = true;
  };
  ws.onclose = () => {
    book.ws = null;
    book.live = false;
    if (showBook || showTape) setTimeout(bookConnect, 2000);
  };
}

// A stream can go quiet without closing (a tablet or phone whose network naps, a tab left in the background):
// the book and the trades would stay frozen at the last update. Nothing heard for a while, or the tab coming
// back into view after one: the stream is dropped and opened again, with a fresh snapshot.
const BOOK_QUIET = 30000;
function bookWatch() {
  const ws = book.ws;
  if (!ws || !(showBook || showTape) || ws.readyState !== 1 || Date.now() - book.lastMsg < BOOK_QUIET) return;
  ws.onclose = ws.onmessage = null;
  try { ws.close(); } catch {}
  book.ws = null;
  book.live = false;
  book.market = null;
  bookConnect();
}
setInterval(bookWatch, 5000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") bookWatch(); });

function bookSubscribe(m, resync = false) {
  if (!book.ws || book.ws.readyState !== 1 || !m) return;
  if (book.market && (book.market.id !== m.id || resync)) {
    book.ws.send(JSON.stringify({ type: "unsubscribe", channel: `order_book/${book.market.id}` }));
    book.ws.send(JSON.stringify({ type: "unsubscribe", channel: `trade/${book.market.id}` }));
  }
  book.market = m;
  book.nonce = null;
  book.asks.clear();
  book.bids.clear();
  book.trades = [];
  book.liqs = [];
  book.ws.send(JSON.stringify({ type: "subscribe", channel: `order_book/${m.id}` }));
  book.ws.send(JSON.stringify({ type: "subscribe", channel: `trade/${m.id}` }));
}

// the stream is open while the book or the trades show
function loadBook() {
  if (!showBook && !showTape) return;
  if (!book.ws) bookConnect();
  else if (!book.market || book.market !== activeMarket()) bookSubscribe(activeMarket());
}

// the book's view (both sides, bids only, asks only), its size unit (the market's coin or dollars) and the price
// grouping (the tick times 1, 10, 100…, kept per market), like Lighter's own book
let bookView = load("bookView", "both"), bookUnit = load("bookUnit", "base"), bookGroups = load("bookGroup", {});
const BOOK_ROW = 20; // a level's height in px (16 line + 4 padding): as many as fit are shown
const bookGroupK = (m) => Math.min(4, Math.max(0, bookGroups[m.symbol] || 0));

// the best n levels of one side, grouped into buckets of g: asks round up, bids down, so a bucket never shows
// a better price than the levels inside it. Each is [price, size, dollars].
function bookLevels(map, asks, g, n) {
  const sorted = [...map].sort((x, y) => (asks ? x[0] - y[0] : y[0] - x[0]));
  const out = [];
  for (const [p, sz] of sorted) {
    const q = g ? (asks ? Math.ceil(p / g - 1e-9) : Math.floor(p / g + 1e-9)) * g : p;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - q) < (g || 0) / 2) { last[1] += sz; last[2] += sz * p; continue; }
    if (out.length === n) break;
    out.push([q, sz, sz * p]);
  }
  return out;
}

function renderBook() {
  if (!book.dirty || !book.market) return;
  book.dirty = false;
  if (showTape) renderTape();
  if (showBook) drawBook();
}

function drawBook() {
  const m = book.market, k = bookGroupK(m), d = Math.max(0, decimals(m) - k);
  const g = k ? 10 ** -decimals(m) * 10 ** k : 0;
  const fit = (el) => Math.max(1, Math.floor(el.clientHeight / BOOK_ROW) || 14);
  const asks = bookLevels(book.asks, true, g, fit($("#bookAsks")));
  const bids = bookLevels(book.bids, false, g, fit($("#bookBids")));
  const usd = bookUnit === "usd";
  // short numbers, so the size and total columns never run into each other in the narrow column: dollars
  // 840, 12.5K, 2.35M; a size keeps fewer decimals the bigger it is (1.38K, 299.2, 26.01, 0.0123)
  const sd = m.size_decimals ?? 4;
  const fq = (v) => {
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(1) + "K";
    if (usd) return v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 });
    if (v >= 1000) return (v / 1e3).toFixed(2) + "K";
    const dd = Math.min(sd, v >= 100 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : 4);
    return v.toFixed(dd);
  };
  const rows = (lvls, rev) => {
    let tot = 0;
    const withTot = lvls.map(([p, sz, dol]) => { const v = usd ? dol : sz; tot += v; return [p, v, tot]; });
    const max = tot || 1;
    const html = withTot.map(([p, v, t]) => `<div class="lvl"><i style="width:${(t / max) * 100}%"></i><span>${p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}</span><span>${fq(v)}</span><span>${fq(t)}</span></div>`);
    return (rev ? html.reverse() : html).join("");
  };
  $("#bookAsks").innerHTML = rows(asks, true);
  $("#bookBids").innerHTML = rows(bids, false);
  $("#bookUnit span").textContent = usd ? "USD" : m.symbol;
  $("#bookGroup span").textContent = (10 ** -decimals(m) * 10 ** k).toFixed(d);
  const a = asks[0] && asks[0][0], b = bids[0] && bids[0][0];
  const ra = [...book.asks.keys()].reduce((x, y) => Math.min(x, y), Infinity), rb = [...book.bids.keys()].reduce((x, y) => Math.max(x, y), -Infinity);
  if (a && b && isFinite(ra) && isFinite(rb)) {
    const spread = ((ra - rb) / ((ra + rb) / 2)) * 10000;
    $("#bookMid").innerHTML = `<span>${fp((ra + rb) / 2, m)}</span><small>spread ${spread.toFixed(1)} bps</small>`;
  }
}

// ---------- the latest trades, from the same stream: the snapshot brings the last 50 and the recent
// liquidations, updates bring the new ones. A buy is a taker buying (the maker was the ask).
let tradeView = load("tradeView", "both"), tradeUnit = load("tradeUnit", "base"), tradeMin = load("tradeMin", 0), tradeKind = load("tradeKind", "all");
const TRADE_KEEP = 200;
function bookTrades(msg) {
  const m = book.market;
  if (!m || (msg.channel && msg.channel !== `trade:${m.id}`)) return;
  const conv = (x) => ({ id: x.trade_id, price: +x.price / (m.multiplier || 1), size: +x.size * (m.multiplier || 1),
    usd: +x.usd_amount, buy: !!x.is_maker_ask, liq: x.type === "liquidation" || x.type === "deleverage", at: x.timestamp });
  const add = (list, xs) => {
    const seen = new Set(list.map((x) => x.id));
    const fresh = (xs || []).map(conv).filter((x) => !seen.has(x.id));
    return [...fresh, ...list].sort((x, y) => y.at - x.at || y.id - x.id).slice(0, TRADE_KEEP);
  };
  if (msg.type === "subscribed/trade") { book.trades = []; book.liqs = []; }
  book.trades = add(book.trades, msg.trades);
  book.liqs = add(book.liqs, [...(msg.liquidation_trades || []), ...(msg.trades || []).filter((x) => x.type === "liquidation" || x.type === "deleverage")]);
  book.dirty = true;
}

// the size filter, in the unit the trades show: the market's coin or dollars
const tradeMins = () => (tradeUnit === "usd" ? [0, 100, 1000, 10000, 100000, 1000000] : [0, 0.01, 0.02, 0.05, 0.1, 1, 10, 100]);
const fminLabel = (v) => (!v ? t("Tutti") : "> " + (tradeUnit === "usd" ? "$" + (v >= 1e6 ? v / 1e6 + "M" : v >= 1e3 ? v / 1e3 + "K" : v) : v));

function renderTape() {
  const m = book.market, el = $("#tradeList");
  const usd = tradeUnit === "usd";
  const min = tradeMins().includes(tradeMin) ? tradeMin : 0;
  $("#tradeUnit span").textContent = usd ? "USD" : m.symbol;
  $("#tradeMin span").textContent = fminLabel(min);
  $("#tradeKind span").textContent = tradeKind === "liq" ? t("Liquidazioni") : t("Tutti");
  const n = Math.max(1, Math.floor(el.clientHeight / BOOK_ROW) || 20);
  const today = new Date().toDateString();
  const when = (ms) => {
    const d = new Date(ms), p2 = (v) => String(v).padStart(2, "0");
    return d.toDateString() === today ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
      : `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const list = (tradeKind === "liq" ? book.liqs : book.trades)
    .filter((x) => (tradeView === "both" || (tradeView === "bids") === x.buy) && (usd ? x.usd : x.size) > min).slice(0, n);
  el.innerHTML = list.length ? list.map((x) => `<div class="lvl tr ${x.buy ? "buy" : "sell"}${x.liq ? " liq" : ""}"><span>${fp(x.price, m)}</span>`
    + `<span>${usd ? x.usd.toLocaleString("en-US", { maximumFractionDigits: x.usd >= 100 ? 0 : 2 }) : fsize(x.size, m)}</span><span>${when(x.at)}</span></div>`).join("")
    : `<div class="trade-none">${book.live ? t("Nessun trade") : "—"}</div>`;
}

// both sides or one, for the book (bids / asks) and for the trades (buys / sells), each remembered
function setBookView(v) {
  bookView = v;
  store("bookView", v);
  markViews("#book", v);
}
function setTapeView(v) {
  tradeView = v;
  store("tradeView", v);
  markViews("#tape", v);
}
function markViews(panel, v) {
  $(panel).dataset.view = v;
  $$(panel + " .book-views button").forEach((b) => { b.classList.toggle("active", b.dataset.view === v); b.setAttribute("aria-checked", String(b.dataset.view === v)); });
  book.dirty = true;
  renderBook();
}

// the small menus under the panels' unit, grouping and filters (each panel has its own)
function openBookMenu(btn, items) {
  const menu = btn.parentElement.querySelector(".book-menu");
  if (!menu.classList.contains("hidden") && menu.dataset.for === btn.id) return closeBookMenu();
  closeBookMenu();
  if (!menu.classList.contains("hidden") && menu.dataset.for === btn.id) return closeBookMenu();
  menu.dataset.for = btn.id;
  menu.innerHTML = items.map(([label, on], i) => `<button type="button" role="menuitemradio" aria-checked="${on}" data-i="${i}"${on ? ' class="on"' : ""}><span>${esc(label)}</span>${on ? "<b>✓</b>" : ""}</button>`).join("");
  menu.style.left = "";
  menu.style.right = `${btn.parentElement.offsetWidth - btn.offsetLeft - btn.offsetWidth}px`;
  menu.classList.remove("hidden");
  menu.onclick = (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    items[+b.dataset.i][2]();
    closeBookMenu();
    book.dirty = true;
    renderBook();
  };
}
function closeBookMenu() { $$(".book-menu").forEach((x) => x.classList.add("hidden")); }

function wireBook() {
  if (!["both", "bids", "asks"].includes(bookView)) bookView = "both";
  if (!["both", "bids", "asks"].includes(tradeView)) tradeView = "both";
  setBookView(bookView);
  setTapeView(tradeView);
  $("#tapeViews").onclick = (e) => { const b = e.target.closest("[data-view]"); if (b) setTapeView(b.dataset.view); };
  $("#tradeUnit").onclick = (e) => {
    e.stopPropagation();
    const m = book.market || activeMarket();
    const pick = (u) => () => { if (u !== tradeUnit) { tradeUnit = u; tradeMin = 0; store("tradeUnit", u); store("tradeMin", 0); } };
    openBookMenu($("#tradeUnit"), [[m ? m.symbol : "Coin", tradeUnit !== "usd", pick("base")], ["USD", tradeUnit === "usd", pick("usd")]]);
  };
  $("#tradeMin").onclick = (e) => {
    e.stopPropagation();
    openBookMenu($("#tradeMin"), tradeMins().map((v) => [fminLabel(v), v === tradeMin || (!v && !tradeMins().includes(tradeMin)), () => { tradeMin = v; store("tradeMin", v); }]));
  };
  $("#tradeKind").onclick = (e) => {
    e.stopPropagation();
    const pick = (k) => () => { tradeKind = k; store("tradeKind", k); };
    openBookMenu($("#tradeKind"), [[t("Tutti"), tradeKind !== "liq", pick("all")], [t("Liquidazioni"), tradeKind === "liq", pick("liq")]]);
  };
  $("#bookViews").onclick = (e) => { const b = e.target.closest("[data-view]"); if (b) setBookView(b.dataset.view); };
  $("#bookUnit").onclick = (e) => {
    e.stopPropagation();
    const m = book.market || activeMarket();
    const pick = (u) => () => { bookUnit = u; store("bookUnit", u); };
    openBookMenu($("#bookUnit"), [[m ? m.symbol : "Coin", bookUnit !== "usd", pick("base")], ["USD", bookUnit === "usd", pick("usd")]]);
  };
  $("#bookGroup").onclick = (e) => {
    e.stopPropagation();
    const m = book.market || activeMarket();
    if (!m) return;
    const tick = 10 ** -decimals(m), cur = bookGroupK(m);
    openBookMenu($("#bookGroup"), [0, 1, 2, 3, 4].map((k) => [(tick * 10 ** k).toFixed(Math.max(0, decimals(m) - k)), k === cur, () => { bookGroups[m.symbol] = k; store("bookGroup", bookGroups); }]));
  };
  document.addEventListener("click", (e) => { if (!e.target.closest(".book-menu")) closeBookMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBookMenu(); });
  // a taller or shorter column shows more or fewer levels
  const ro = new ResizeObserver(() => { book.dirty = true; renderBook(); });
  ro.observe($("#book"));
  ro.observe($("#tape"));
}

function toggleBook(v) {
  showBook = v;
  store("book", v);
  $("#book").classList.toggle("hidden", !v);
  $("#obToggle").classList.toggle("active", v);
  bookStream();
}
function toggleTape(v) {
  showTape = v;
  store("tape", v);
  $("#tape").classList.toggle("hidden", !v);
  $("#tapeToggle").classList.toggle("active", v);
  bookStream();
}
// open the stream while either panel shows, close it when neither does
function bookStream() {
  book.dirty = true;
  if (showBook || showTape) { loadBook(); renderBook(); }
  else if (book.ws) { book.ws.close(); book.market = null; }
}

// ================= confirm with a second click =================
// Instead of the browser's confirm() dialog, a button that needs confirming changes its label on the
// first click (e.g. "Confirm LONG WTI · $10,231") and acts on a second click within 4 seconds.
// Anything else (Esc, a click elsewhere, editing the ticket, the timeout) puts it back.
// Buttons carry data-ck="<key>"; tables that redraw call markConfirm() so the state survives.
let pendingConfirm = null; // { key, text }
const CONFIRM_MS = 4000;

// the chart menu's items that act at once (the position's SL/TP, a pair's SL/TP, cancelling an order or a
// pair stop) ask for a second tap on touch screens; filling the ticket or setting an alert doesn't
function confirmOnTouch(items) {
  if (!touchUI()) return items;
  for (const it of items) if (!it.confirm && (it.note === t("subito") || (it.cls || "").includes("danger"))) it.confirm = `${t("Conferma")}: ${it.label}`;
  return items;
}

// a finger slips more easily than a mouse: on touch screens the actions that trade on one click
// (cancelling an order, the chart menu's "now" items) ask for a second tap too; partial closes ask
// everywhere
const touchUI = () => matchMedia("(hover: none)").matches;

function askConfirm(key, text) {
  if (pendingConfirm && pendingConfirm.key === key) { cancelConfirm(); return true; }
  cancelConfirm();
  pendingConfirm = { key, text };
  markConfirm();
  clearTimeout(askConfirm.timer);
  askConfirm.timer = setTimeout(cancelConfirm, CONFIRM_MS);
  return false;
}

function markConfirm() {
  if (!pendingConfirm) return;
  for (const el of $$(`[data-ck="${pendingConfirm.key}"]`)) {
    if (!el.classList.contains("confirming")) {
      el.dataset.ckText = el.textContent;
      el.dataset.ckTitle = el.title;
      // the position's close buttons keep their width, so the row doesn't move: a short "OK?" instead
      if (el.closest(".qbtn")) el.style.width = el.offsetWidth + "px";
    }
    el.classList.add("confirming");
    el.textContent = el.closest(".qbtn") ? "OK?" : pendingConfirm.text;
    el.title = pendingConfirm.text;
  }
}

function cancelConfirm() {
  if (!pendingConfirm) return;
  for (const el of $$(`[data-ck="${pendingConfirm.key}"]`)) {
    el.classList.remove("confirming");
    el.textContent = el.dataset.ckText;
    el.title = el.dataset.ckTitle || "";
    el.style.width = "";
  }
  pendingConfirm = null;
}

// ================= ticket =================
// The quick sizes: a share of the money available, rounded to the coarsest step that still gives four different
// sizes (dollars to the nearest 50 on an ordinary account, a market's quantity to whole units where it can).
const CHIP_SHARES = [1, 2.5, 5, 10];

function chipSteps(unit, m) {
  if (unit !== "base") return [50, 10, 5, 1];
  return Array.from({ length: m.size_decimals + 1 }, (_, i) => +(10 ** -i).toFixed(m.size_decimals));
}

function quickChips(unit, m) {
  if (unit === "equity_pct") return CHIP_SHARES.map((v) => [v, v + "%"]);
  const dollars = unit !== "base";
  const money = account && account.available > 0 ? account.available : 0;
  const p = prices[m.id], price = dollars ? 1 : p ? ticketRef(m, p) : 0;
  const label = (v) => (dollars ? "$" + v : String(v));
  if (money && price) {
    const raw = CHIP_SHARES.map((share) => (money * share) / 100 / price);
    const decimals = dollars ? 0 : m.size_decimals;
    for (const step of chipSteps(unit, m)) {
      const out = raw.map((v) => +(Math.round(v / step) * step).toFixed(decimals));
      if (out[0] > 0 && new Set(out).size === out.length) return out.map((v) => [v, label(v)]);
    }
    // so little that even the finest step can't tell them apart: the smallest four sizes, still on the account's scale
    const fine = chipSteps(unit, m).at(-1);
    let prev = 0;
    return raw.map((v) => {
      prev = +Math.max(Math.round(v / fine) * fine, prev + fine).toFixed(decimals);
      return [prev, label(prev)];
    });
  }
  // no money to take a share of (read only, or all of it in use): sizes that fit any account
  if (dollars) return [25, 50, 100, 250].map((v) => [v, label(v)]);
  return [1, 5, 10, 50].map((x) => +(x * 10 ** -Math.max(0, m.size_decimals - 2)).toFixed(m.size_decimals)).map((v) => [v, label(v)]);
}

// max: a last button for the largest size the money available opens at this leverage
function renderChips(chips, max = false) {
  const box = $("#tkChips");
  const html = chips.map(([v, label]) => `<button data-v="${v}" title="${t("Aggiunge {v} alla size: clicca più volte per sommare", { v: label })}">${label}</button>`).join("")
    + (max ? `<button data-max title="${t("La size più grande che il disponibile apre a questa leva")}">Max</button>` : "");
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; } // not under a click on the way
}

// what's held on the market in the ticket, among the account's figures
function setAccPos(html) {
  for (const id of ["#accPos", "#accPosDt"]) $(id).classList.toggle("hidden", !html);
  $("#accPos").innerHTML = html;
}

function positionLabel(size, m) {
  return size ? `${size > 0 ? "Long" : "Short"} ${fsize(size, m)} ${m.symbol}` : "—";
}

function renderSizeContext(m, pos) {
  $("#tkSizeContext").classList.toggle("hidden", !account || ticket.kind === "basket");
  $("#tkAvailable").textContent = account ? fusd(account.available) : "—";
  const value = $("#tkPosition");
  value.textContent = positionLabel(pos?.size, m);
  value.className = pos ? cls(pos.size) : "";
}

// Cross / Isolated: Lighter changes a market's margin mode only with nothing on it, neither a position nor an
// open order (checked on its testnet), so the other mode is locked until then
function renderTicketMode() {
  const m = activeMarket();
  if (!m || activePair()) return;
  const set = levSet(m), isolated = !!(set && !set.cross);
  const pos = account && account.positions.some((p) => p.market_id === m.id);
  const resting = (openOrders[m.id] || []).length > 0;
  $$("#tkMode [data-cross]").forEach((b) => {
    const on = (b.dataset.cross === "0") === isolated;
    b.classList.toggle("active", on);
    b.disabled = (pos || resting) && !on;
    b.title = b.disabled ? t(pos ? "Chiudi la posizione per passare tra cross e isolated" : "Annulla gli ordini aperti su questo mercato per passare tra cross e isolated")
      : t(b.dataset.cross === "1" ? "Cross: usa tutto il margine dell'account, e la liquidazione guarda tutto l'account" : "Isolated: rischia solo il margine di questa posizione");
  });
}

// Where something runs, marked only when it isn't Lighter itself: an order on Lighter needs nothing else to work,
// so it carries no mark. A cloud is LighterDeck's server (it goes on with the page closed, and stops if the server
// does); a window is this page (it works only while LighterDeck is open: alerts, and everything in paper).
const RUNS_SVG = {
  server: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4.6 12.5a3 3 0 0 1-.5-5.96 4 4 0 0 1 7.8.56 2.75 2.75 0 0 1-.4 5.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  page: '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.3h12" stroke="currentColor" stroke-width="1.4"/></svg>',
};
// what: "auto" (an automation), "trail" (an automation whose stop is an order on Lighter), "alert"
function runsWhere(what) { return what === "alert" || Paper.on ? "page" : "server"; }
function runsTitle(what) {
  if (what === "alert") return t("Gira in questa pagina: avvisa solo mentre LighterDeck è aperto");
  if (Paper.on) return t("Paper: gira in questa pagina, solo mentre LighterDeck è aperto");
  return t("Gira sul server di LighterDeck: continua a pagina chiusa e si ferma se si ferma il server")
    + (what === "trail" ? ". " + t("Lo stop è un ordine su Lighter: resta attivo all'ultimo prezzo anche senza server") : "");
}
const runsIcon = (what) => `<i class="runs runs-${runsWhere(what)}" title="${esc(runsTitle(what))}">${RUNS_SVG[runsWhere(what)]}</i>`;
// the marks written in the page itself (ticket, menus, tabs) follow paper / live and the language
function renderRuns() {
  for (const el of $$("i[data-runs]")) {
    const where = runsWhere(el.dataset.runs), title = runsTitle(el.dataset.runs);
    if (el.dataset.where === where && el.title === title) continue;
    el.className = `runs runs-${where}`;
    el.dataset.where = where;
    el.title = title;
    el.innerHTML = RUNS_SVG[where];
  }
}

function renderTicket() {
  renderRuns();
  const pr = activePair();
  $(".ticket").classList.toggle("pair", !!pr);
  if (pr) return renderPairTicket(pr);
  $('#sideSel [data-side="buy"]').textContent = "Buy / Long";
  $('#sideSel [data-side="sell"]').textContent = "Sell / Short";
  $('#sideSel [data-side="buy"]').title = t("Buy / Long · B"); // a pair set its legs here
  $('#sideSel [data-side="sell"]').title = t("Sell / Short · S");
  const m = activeMarket();
  if (!m) return;
  $("#tkSym").textContent = m.symbol;
  const pos = account && account.positions.find((p) => p.market_id === m.id);
  renderSizeContext(m, pos);
  const set = levSet(m);
  const levNow = set ? set.leverage : m.default_leverage;
  $("#tkLev").textContent = levNow ? `${levNow}x` : "—";
  renderTicketMode();
  setAccPos(pos ? `<span class="${pos.size > 0 ? "up" : "down"}">${pos.size > 0 ? "Long" : "Short"} ${fsize(pos.size, m)} ${esc(m.symbol)}</span>` : "");
  const unit = $("#tkUnit").value;
  $('#tkUnit option[value="base"]').textContent = m.symbol; // the menu is the size's unit
  $("#tkSizeUnit").textContent = { usd: "USD", base: m.symbol, equity_pct: "%", risk_usd: "USD" }[unit];
  syncSizeSlider(m, +$("#tkSize").value ? null : 0, null);
  const showsLimit = hasLimitField(), showsMarket = ticket.kind === "market" || ticket.kind === "rfq" || (ticket.kind === "conditional" && ticketAdv.exec === "market");
  $$(".limit-only").forEach((e) => e.classList.toggle("hidden", !showsLimit));
  $$(".market-only").forEach((e) => e.classList.toggle("hidden", !showsMarket));
  $("#tkPost").closest("label").classList.toggle("hidden", !["limit", "scale", "iceberg"].includes(ticket.kind));
  $(".ticket").dataset.kind = ticket.kind;
  $$("#sideSel [data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === ticket.side));
  $$("#kindSel [data-kind]").forEach((b) => b.classList.toggle("active", b.dataset.kind === ticket.kind));
  $("#advBtn").classList.toggle("active", !isBasicKind());
  $("#advName").textContent = { conditional: t("Condizionale"), twap: "TWAP", scale: "Scale", chase: "Chase Limit", iceberg: "Iceberg", basket: "Basket", rfq: "RFQ" }[ticket.kind] || t("Avanzati");
  $$("#tkCondExec [data-exec]").forEach((b) => b.classList.toggle("active", b.dataset.exec === ticketAdv.exec));
  $$("#tkScaleDist [data-dist]").forEach((b) => b.classList.toggle("active", b.dataset.dist === ticketAdv.dist));
  const ex = $("#tkExec");
  ex.className = "execute" + (!info.trading ? " connect" : ticket.side === "sell" ? " sell" : "");
  ex.textContent = info.trading ? `${ticket.side === "buy" ? "Buy / Long" : "Sell / Short"} ${m.symbol}${Paper.on ? " · Paper" : ""}`
    : (liveFirst() ? t("Collega Lighter per fare trading") : t("Sola lettura · collega un'API key"));
  renderTicketSwitch();
  if (ticket.kind === "basket") {
    $("#tkSym").textContent = "Basket";
    if (info.trading) ex.textContent = `Basket · ${t("{n} mercati", { n: ticketAdv.legs.length })}${Paper.on ? " · Paper" : ""}`;
    ex.className = "execute" + (!info.trading ? " connect" : "");
  }
  ex.disabled = false;
  renderRfq(m, ex);
  ex.dataset.ckText = ex.textContent;
  markConfirm();
  updateTicketSummary();
}

function ticketBody() {
  const m = activeMarket();
  const body = {
    market_id: m.id, side: ticket.side, kind: ticket.kind, size: +$("#tkSize").value, unit: $("#tkUnit").value,
    reduce_only: $("#tkReduce").checked,
  };
  // the advanced kinds carry their own fields; SL, TP and trailing go on the position afterwards
  if (ticket.kind === "rfq") return { ...body, kind: "market", slippage_bps: +$("#tkSlip").value || 50 };
  if (ticket.kind === "conditional") {
    body.trigger_price = +$("#tkTrig").value;
    body.cond_exec = ticketAdv.exec;
    if (ticketAdv.exec === "limit") body.price = +$("#tkPrice").value;
    else body.slippage_bps = +$("#tkSlip").value || 50;
    return body;
  }
  if (ticket.kind === "twap") {
    body.twap_minutes = Math.round(+$("#tkTwapMin").value);
    if (+$("#tkTwapPx").value) body.price = +$("#tkTwapPx").value;
    return body;
  }
  if (ticket.kind === "chase") {
    if (+$("#tkChaseCap").value) body.chase_cap = +$("#tkChaseCap").value;
    if (+$("#tkChaseMin").value) { body.chase_minutes = +$("#tkChaseMin").value; body.chase_market = $("#tkChaseEnd").checked; }
    return body;
  }
  if (ticket.kind === "iceberg") {
    Object.assign(body, { price: +$("#tkPrice").value, ice_slice: +$("#tkIceSlice").value, post_only: $("#tkPost").checked });
    return body;
  }
  if (ticket.kind === "scale") {
    Object.assign(body, { scale_from: +$("#tkScaleFrom").value, scale_to: +$("#tkScaleTo").value, scale_count: Math.round(+$("#tkScaleN").value), scale_dist: ticketAdv.dist, post_only: $("#tkPost").checked });
    return body;
  }
  if (+$("#tkSl").value) body.sl_price = +$("#tkSl").value;
  const levels = readTpLevels();
  if (levels) {
    body.tp_levels = levels;
    body.be_after_tp1 = $("#tkTpBe").checked;
  } else if (+$("#tkTp").value) body.tp_price = +$("#tkTp").value;
  for (const [id, key] of [["Sl", "sl"], ["Tp", "tp"]]) {
    if ((id !== "Tp" || !levels) && $(`#tk${id}Exec`).value === "limit") {
      body[`${key}_limit_price`] = +$(`#tk${id}Limit`).value;
    }
  }
  if ($("#tkTrail").checked && !body.reduce_only) body.trail = readTrail($("#tkTrailBox"));
  if (ticket.kind === "limit") {
    body.price = +$("#tkPrice").value;
    body.post_only = $("#tkPost").checked;
  } else {
    body.slippage_bps = +$("#tkSlip").value || 50;
  }
  return body;
}

// ---------- pair ticket: on a spread chart, long one market and short the other, same dollar value ----------
// Buy side = long the spread (long the first market, short the second); sell side the other way round.
const pairLegs = () => { const [a, b] = activePair(); return ticket.side === "buy" ? [a, b] : [b, a]; }; // [long, short]

function renderPairTicket([a, b]) {
  $("#tkSym").textContent = `${a.symbol}/${b.symbol}`;
  const held = (m) => { const p = account && account.positions.find((x) => x.market_id === m.id); return p ? `<span class="${p.size > 0 ? "up" : "down"}">${m.symbol} ${p.size > 0 ? "Long" : "Short"} ${fsize(p.size, m)}</span>` : ""; };
  setAccPos([held(a), held(b)].filter(Boolean).join(" · "));
  // two lines, one per leg, so long names fit the button (each line ends in … if it still doesn't)
  const legs = (x, y) => `<span>${x} ${esc(a.symbol)}</span><span>${y} ${esc(b.symbol)}</span>`;
  $('#sideSel [data-side="buy"]').innerHTML = legs("Long", "Short");
  $('#sideSel [data-side="sell"]').innerHTML = legs("Short", "Long");
  $('#sideSel [data-side="buy"]').title = `Long ${a.symbol} / Short ${b.symbol}`;
  $('#sideSel [data-side="sell"]').title = `Short ${a.symbol} / Long ${b.symbol}`;
  $$("#sideSel [data-side]").forEach((x) => x.classList.toggle("active", x.dataset.side === ticket.side));
  $("#tkSizeUnit").textContent = "USD";
  renderChips(quickChips("usd", a));
  $$(".market-only").forEach((e) => e.classList.remove("hidden"));
  const ex = $("#tkExec");
  const [l, s] = pairLegs();
  ex.className = "execute" + (!info.trading ? " connect" : ticket.side === "sell" ? " sell" : "");
  ex.textContent = info.trading ? `Long ${l.symbol} / Short ${s.symbol}${Paper.on ? " · Paper" : ""}` : (liveFirst() ? t("Collega Lighter per fare trading") : t("Sola lettura · collega un'API key"));
  renderTicketSwitch();
  ex.disabled = false;
  ex.dataset.ckText = ex.textContent;
  markConfirm();
  updateTicketSummary();
}

function pairBody() {
  const [l, s] = pairLegs();
  return { long_id: l.id, short_id: s.id, size_usd: +$("#tkSize").value, slippage_bps: +$("#tkSlip").value || 50 };
}

// each leg's size, value, margin and fees from the book; the server preview checks both legs
function updatePairSummary() {
  const size = +$("#tkSize").value;
  const legs = pairLegs().map((m, i) => {
    const p = prices[m.id] || {}, ref = (i === 0 ? p.ask : p.bid) || p.mark;
    const set = account && account.settings && account.settings[m.id];
    const lev = (set && set.leverage) || m.default_leverage || 1;
    const usd = size > 0 ? size / 2 : 0, qty = ref && usd ? usd / ref : 0;
    return { m, ref, lev, usd, qty, fee: usd * feeRates(m).taker, margin: usd / lev };
  });
  const row = (x, i) => `<dt><span class="${i === 0 ? "up" : "down"}">${i === 0 ? "Long" : "Short"}</span> ${esc(x.m.symbol)}</dt><dd>${x.qty ? `${x.qty.toFixed(x.m.size_decimals)} · ${fusd(x.usd)}` : "—"}</dd>`;
  const tot = (k) => legs.reduce((s, x) => s + x[k], 0);
  $("#tkPairSum").innerHTML = legs.map(row).join("") +
    `<dt>${t("Margine richiesto")}</dt><dd>${size > 0 ? fusd(tot("margin")) : "—"}</dd>
     <dt>${t("Commissioni stimate")}</dt><dd>${size > 0 ? fusd(tot("fee")) : "—"}</dd>
     <dt>${t("Slippage")}</dt><dd>${slipButton()}</dd>`;
  setTicketDraft({ market: null, lines: [] });
  clearTimeout(updateTicketSummary.t);
  updateTicketSummary.t = setTimeout(previewPair, 350);
}

async function previewPair() {
  const note = $("#tkRisk"), b = pairBody();
  if (!info.trading || !(b.size_usd > 0)) { note.classList.add("hidden"); return; }
  const key = JSON.stringify(b);
  if (key === previewPair.key && Date.now() - previewPair.at < 5000) return;
  previewPair.key = key;
  previewPair.at = Date.now();
  const leg = (id, side) => api("/preview?live=true", { method: "POST", body: JSON.stringify({ market_id: id, side, kind: "market", size: b.size_usd / 2, unit: "usd", slippage_bps: b.slippage_bps }) })
    .catch((e) => ({ ok: false, error: e.message }));
  const rs = await Promise.all([leg(b.long_id, "buy"), leg(b.short_id, "sell")]);
  if (key !== previewPair.key) return;
  const bad = rs.map((r, i) => (r.ok ? null : `${byId[i ? b.short_id : b.long_id].symbol}: ${r.error}`)).filter(Boolean);
  note.classList.toggle("hidden", !bad.length);
  note.textContent = bad.join(" · ");
}

async function executePair(byMouse) {
  const b = pairBody();
  if (!(b.size_usd > 0)) return ticketMsg(t("Inserisci una size valida."), "err");
  const [l, s] = pairLegs();
  if (!(pendingConfirm && pendingConfirm.key === "order")) {
    previewPair.key = null;
    await previewPair();
    if (!$("#tkRisk").classList.contains("hidden")) return ticketMsg($("#tkRisk").textContent, "err");
    $("#tkMsg").className = "ticket-msg hidden";
  }
  if (!askConfirm("order", `${t("Conferma")} Long ${l.symbol} / Short ${s.symbol} · ${fusd(b.size_usd)}`)) return;
  const btn = $("#tkExec");
  btn.disabled = true;
  try {
    const r = await api("/pair_order", { method: "POST", body: JSON.stringify(b) });
    if (r.ok) {
      ticketMsg(t("Eseguito: long {a} {qa} / short {b} {qb}.", { a: r.legs[0].symbol, qa: r.legs[0].size, b: r.legs[1].symbol, qb: r.legs[1].size }), "ok");
      switchBottom("positions");
      if (byMouse) keyboardTip();
    } else pairLegFailed(r);
    loadOrders(true);
  } catch (e) {
    ticketMsg(e.message, "err");
  } finally {
    btn.disabled = !info.trading;
  }
}

// the second leg failed: the first is open on its own, so offer to close exactly what it bought or sold
function pairLegFailed(r) {
  const f = r.filled[0];
  ticketMsg(t("{b} non eseguito ({err}). {a} è aperto da solo: la coppia non è coperta.", { b: r.failed.symbol, err: r.error, a: f.symbol }), "err");
  const fix = document.createElement("button");
  fix.className = "pair-fix";
  fix.textContent = t("Chiudi {size} {sym} a mercato", { size: f.size, sym: f.symbol });
  fix.onclick = async () => {
    fix.disabled = true;
    try {
      await api("/order", { method: "POST", body: JSON.stringify({ market_id: f.market_id, side: f.side === "buy" ? "sell" : "buy", kind: "market", size: f.size, unit: "base", reduce_only: true }) });
      ticketMsg(t("{sym} chiuso.", { sym: f.symbol }), "ok");
      loadOrders(true);
    } catch (e) { fix.disabled = false; toast(e.message, true); }
  };
  $("#tkMsg").appendChild(fix);
}

// ---------- RFQ: asks the market makers for liquidity. No price is locked: what it gives is a better book,
// so the ticket shows whether the book really got better since asking, and the trade stays a market order ----------
function renderRfq(m, ex) {
  const q = ticketAdv.rfq, on = ticket.kind === "rfq";
  if (q && !on) closeRfq(); // left the RFQ for another kind of order
  const live = q && on;
  $(".ticket").classList.toggle("rfq-on", !!live);
  $("#tkRfqIdle").classList.toggle("hidden", !!live);
  $("#tkRfqLive").classList.toggle("hidden", !live);
  if (!on || !info.trading) return;
  if (!live) { ex.textContent = `${t("Chiedi liquidità")} · ${ticket.side === "buy" ? "Buy" : "Sell"} ${m.symbol}${Paper.on ? " · Paper" : ""}`; return; }
  ticket.side = q.side;
  if (m.id !== q.market_id) { ex.textContent = t("Torna su {sym} per eseguire", { sym: byId[q.market_id].symbol }); ex.disabled = true; return; }
  ex.textContent = `${q.side === "buy" ? "Buy" : "Sell"} ${m.symbol} · Market${Paper.on ? " · Paper" : ""}`;
  ex.className = "execute" + (q.side === "sell" ? " sell" : "");
}

function renderRfqLive() {
  const q = ticketAdv.rfq;
  if (!q || ticket.kind !== "rfq") return;
  const secs = Math.floor((Date.now() - q.at) / 1000);
  $("#tkRfqState").textContent = t("In attesa da {t}", { t: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` });
  const answered = q.responses.filter((x) => x.status !== "not_interested").length, gave = q.responses.filter((x) => x.status === "liquidity_provided").length;
  $("#tkRfqAnswers").textContent = !q.responses.length ? t("Nessuna risposta per ora. Di solito arrivano in pochi secondi; si chiude da sola in 1 o 2 minuti.")
    : t("Market maker al lavoro: {a}. Con liquidità aggiunta: {g}.", { a: answered, g: gave });
  const now = estBook.last, pct = (x) => (x.deep ? "> " : "") + `${x.est.toFixed(2)}%`;
  $("#tkRfqBetter").textContent = now && q.base && pct(now) !== pct(q.base) ? t("Slippage stimato: {x}", { x: fromTo(q.base, now, pct) }) : ""; // the row below has it when nothing changed
}

async function startRfq() {
  const m = activeMarket(), body = ticketBody();
  if (!m || !(body.size > 0)) return ticketMsg(t("Inserisci una size valida."), "err");
  const btn = $("#tkExec");
  btn.disabled = true;
  try {
    const r = await api("/rfq", { method: "POST", body: JSON.stringify({ market_id: m.id, side: ticket.side, size: body.size, unit: body.unit, reduce_only: body.reduce_only }) });
    // the request is for this quantity: it stays fixed until it's traded or closed
    $("#tkUnit").value = "base";
    $("#tkSize").value = r.size;
    $("#tkUnit").disabled = $("#tkSize").disabled = true;
    ticketAdv.rfq = { id: r.id, market_id: m.id, side: ticket.side, size: r.size, reduce: !!body.reduce_only, responses: r.responses || [], at: Date.now(), base: estBook.last };
    $("#tkMsg").className = "ticket-msg hidden";
    clearInterval(ticketAdv.rfqTimer);
    ticketAdv.rfqTimer = setInterval(pollRfq, 2000);
    renderTicket();
  } catch (e) {
    ticketMsg(e.message, "err");
  } finally {
    btn.disabled = !info.trading;
  }
}

async function pollRfq() {
  const q = ticketAdv.rfq;
  if (!q) return;
  try {
    const r = await api(`/rfq/${q.id}`);
    if (ticketAdv.rfq !== q) return;
    q.responses = r.responses || [];
    if (r.status === "closed") { endRfq(); return ticketMsg(t("La RFQ si è chiusa. Puoi eseguire a market o chiederne un'altra."), "err"); }
  } catch (e) { console.warn("rfq", e.message); }
  updateTicketSummary();
}

function endRfq() {
  clearInterval(ticketAdv.rfqTimer);
  ticketAdv.rfq = null;
  $("#tkUnit").disabled = $("#tkSize").disabled = false;
  renderTicket();
}

function closeRfq() {
  const q = ticketAdv.rfq;
  if (!q) return;
  api(`/rfq/${q.id}/status?status=closed`, { method: "POST" }).catch(() => {});
  endRfq();
}

async function executeRfq(byMouse) {
  const q = ticketAdv.rfq;
  if (!q) return startRfq();
  const m = byId[q.market_id];
  if (!askConfirm("order", `${t("Conferma")} ${q.side === "buy" ? "LONG" : "SHORT"} ${m.symbol} · ${q.size} · market`)) return;
  const btn = $("#tkExec");
  btn.disabled = true;
  try {
    const r = await api("/order", { method: "POST", body: JSON.stringify({ market_id: q.market_id, side: q.side, kind: "market", size: q.size, unit: "base", reduce_only: q.reduce, slippage_bps: +$("#tkSlip").value || 50 }) });
    // these two only tell Lighter how it went: the trade above is what counts, so their failure changes nothing
    api(`/rfq/${q.id}/status?status=order_created`, { method: "POST" }).catch(() => {}).finally(() => api(`/rfq/${q.id}/status?status=closed`, { method: "POST" }).catch(() => {}));
    endRfq();
    $("#tkSize").value = "";
    updateTicketSummary();
    ticketMsg(t("Eseguito: {side} {size} {sym}. Controlla posizioni e ordini per i fill.", { side: q.side, size: r.size, sym: m.symbol }), "ok");
    loadOrders(true);
    if (byMouse) keyboardTip();
  } catch (e) {
    ticketMsg(e.message, "err"); // the RFQ stays open: it can be tried again
  } finally {
    btn.disabled = !info.trading;
  }
}

// a market order the book can't take well: the ticket says so, where the choice is made
function renderRfqNudge(notional) {
  const b = $("#tkRfqNudge"), x = estBook.last;
  const thin = x && ((x.est > 0.1 && notional >= 10000) || x.deep), big = notional >= 500000;
  const show = ticket.kind === "market" && info.trading && (thin || big);
  b.classList.toggle("hidden", !show);
  if (show) b.textContent = t(thin ? "Book sottile per questa size: chiedi liquidità con RFQ →" : "Ordine grande: chiedi liquidità con RFQ →");
}

// ---------- basket: market orders on several markets, one send ----------
const BASKET_MAX = 10;
function renderBasketLegs() {
  const markets = Object.values(byId).sort((a, b) => a.symbol.localeCompare(b.symbol));
  $("#tkBasketLegs").innerHTML = ticketAdv.legs.map((x, i) => `<div class="bk-leg" data-i="${i}">
    <select data-leg="market" autocomplete="off"><option value="">${t("Mercato")}</option>${markets.map((m) => `<option value="${m.id}"${m.id === x.market_id ? " selected" : ""}>${esc(m.symbol)}</option>`).join("")}</select>
    <button type="button" class="bk-side ${x.side === "buy" ? "long" : "short"}" data-leg="side">${x.side === "buy" ? "Long" : "Short"}</button>
    <input data-leg="usd" type="number" min="0" step="any" autocomplete="off" placeholder="USD" value="${x.usd || ""}">
    <button type="button" class="bk-del" data-leg="del" title="${t("Togli")}"${ticketAdv.legs.length <= 2 ? " disabled" : ""}>×</button></div>`).join("");
  $("#tkBasketAdd").classList.toggle("hidden", ticketAdv.legs.length >= BASKET_MAX);
}

function startBasket() {
  if (ticketAdv.legs.length) return renderBasketLegs();
  const m = activeMarket();
  ticketAdv.legs = [{ market_id: m ? m.id : null, side: "buy", usd: 0 }, { market_id: null, side: "sell", usd: 0 }];
  renderBasketLegs();
}

const basketReady = () => ticketAdv.legs.filter((x) => x.market_id != null && x.usd > 0); // market ids start at 0

function basketLegRows() {
  return basketReady().map((x) => {
    const m = byId[x.market_id], p = prices[m.id] || {}, ref = (x.side === "buy" ? p.ask : p.bid) || p.mark;
    const set = levSet(m), lev = (set && set.leverage) || m.default_leverage || 1;
    return { ...x, m, ref, lev, cross: !set || set.cross !== false, qty: ref ? x.usd / ref : 0 };
  });
}

function updateBasketSummary() {
  const rows = basketLegRows();
  const money = (k) => rows.reduce((s, x) => s + k(x), 0);
  const fees = money((x) => x.usd * feeRates(x.m).taker);
  $("#tkBasketSum").innerHTML = rows.map((x) => `<dt><span class="${x.side === "buy" ? "up" : "down"}">${x.side === "buy" ? "Long" : "Short"}</span> ${esc(x.m.symbol)}</dt><dd>${fsize(x.qty, x.m)}</dd>`).join("") +
    (rows.length ? `<dt>${t("Valore ordine")}</dt><dd>${fusd(money((x) => x.usd))}</dd><dt>${t("Margine")}</dt><dd>${fusd(money((x) => x.usd / x.lev))}</dd>${fees ? `<dt>${t("Commissioni stimate")}</dt><dd>${fusd(fees)}</dd>` : ""}<dt>${t("Slippage")}</dt><dd>${slipButton()}</dd>` : "");
  setTicketMargin(rows.length && account ? rows.map((x) => ({ market_id: x.m.id, delta: (x.side === "buy" ? 1 : -1) * x.qty, price: x.ref, leverage: x.lev, cross: x.cross })) : null);
  setTicketDraft({ market: null, lines: [] });
  clearTimeout(updateTicketSummary.t);
  updateTicketSummary.t = setTimeout(previewBasket, 350);
}

// each market's own checks, while it's being filled in
async function previewBasket() {
  const note = $("#tkRisk"), rows = basketReady();
  if (!info.trading || !rows.length) { note.classList.add("hidden"); return; }
  const slip = +$("#tkSlip").value || 50, key = JSON.stringify([rows, slip]);
  previewBasket.key = key;
  const rs = await Promise.all(rows.map((x) => api("/preview?live=true", { method: "POST", body: JSON.stringify({ market_id: x.market_id, side: x.side, kind: "market", size: x.usd, unit: "usd", slippage_bps: slip }) }).catch((e) => ({ ok: false, error: e.message }))));
  if (key !== previewBasket.key) return;
  const bad = rs.map((r, i) => (r.ok ? null : `${byId[rows[i].market_id].symbol}: ${r.error}`)).filter(Boolean);
  note.classList.toggle("hidden", !bad.length);
  note.textContent = bad.join(" · ");
}

async function executeBasket(byMouse) {
  const legs = ticketAdv.legs;
  if (legs.length < 2 || legs.some((x) => x.market_id == null || !(x.usd > 0))) return ticketMsg(t("Ogni riga del basket vuole un mercato e un valore."), "err");
  if (new Set(legs.map((x) => x.market_id)).size !== legs.length) return ticketMsg(t("Il basket vuole da 2 a {n} mercati diversi", { n: BASKET_MAX }), "err");
  const total = legs.reduce((s, x) => s + x.usd, 0);
  if (!askConfirm("order", `${t("Conferma")} ${t("{n} mercati", { n: legs.length })} · ${fusd(total)}`)) return;
  const btn = $("#tkExec");
  btn.disabled = true;
  try {
    const r = await api("/basket", { method: "POST", body: JSON.stringify({ legs: legs.map((x) => ({ market_id: x.market_id, side: x.side, size_usd: x.usd })), slippage_bps: +$("#tkSlip").value || 50 }) });
    basketResult(r);
    switchBottom("positions");
    if (byMouse) keyboardTip();
    loadOrders(true);
  } catch (e) {
    ticketMsg(e.message, "err");
  } finally {
    btn.disabled = !info.trading;
  }
}

// what each market really did; a basket that only partly went through offers to undo what did
function basketResult(r) {
  const short = r.legs.filter((x) => x.filled !== null && x.filled < x.size * 0.99);
  if (r.legs.some((x) => x.filled === null)) return ticketMsg(t("Basket inviato: controlla le posizioni, non sono riuscito a leggerle."), "err");
  if (!short.length) {
    ticketAdv.legs.forEach((x) => { x.usd = 0; });
    renderBasketLegs();
    updateTicketSummary();
    return ticketMsg(t("Eseguito: {list}.", { list: r.legs.map((x) => `${x.side} ${x.filled} ${x.symbol}`).join(", ") }), "ok");
  }
  ticketMsg(t("Basket eseguito solo in parte. Non completi: {list}.", { list: short.map((x) => `${x.symbol} ${x.filled}/${x.size}`).join(", ") }), "err");
  const done = r.legs.filter((x) => x.filled > 0);
  if (!done.length) return;
  const fix = document.createElement("button");
  fix.className = "pair-fix";
  fix.textContent = t("Chiudi quanto eseguito a mercato");
  fix.onclick = async () => {
    fix.disabled = true;
    try {
      for (const x of done) await api("/order", { method: "POST", body: JSON.stringify({ market_id: x.market_id, side: x.side === "buy" ? "sell" : "buy", kind: "market", size: x.filled, unit: "base", reduce_only: true }) });
      ticketMsg(t("Chiuso quanto eseguito."), "ok");
      loadOrders(true);
    } catch (e) { fix.disabled = false; toast(e.message, true); }
  };
  $("#tkMsg").appendChild(fix);
}

// local estimate, refined by the server preview (which also runs every risk check)
// ---------- advanced orders: conditional, TWAP, scale ----------
const ticketAdv = { exec: "market", dist: "even", twapFees: null, legs: [], rfq: null, rfqTimer: null };
const isBasicKind = () => ticket.kind === "market" || ticket.kind === "limit";
const hasLimitField = () => ticket.kind === "limit" || ticket.kind === "iceberg" || (ticket.kind === "conditional" && ticketAdv.exec === "limit");

// a scale order's prices and sizes, as the order will have them (paper.js / main.py scale_prices)
function scalePreview(m) {
  const a = +$("#tkScaleFrom").value, b = +$("#tkScaleTo").value, n = Math.round(+$("#tkScaleN").value);
  if (!(a > 0 && b > 0) || a === b || !(n >= 2 && n <= 20)) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const prices = Array.from({ length: n }, (_, i) => +(lo + (hi - lo) * i / (n - 1)).toFixed(decimals(m)));
  const weights = prices.map((_, i) => (ticketAdv.dist === "low" ? n - i : ticketAdv.dist === "high" ? i + 1 : 1));
  const total = weights.reduce((s, w) => s + w, 0), shares = weights.map((w) => w / total);
  return { prices, shares, avg: prices.reduce((s, x, i) => s + x * shares[i], 0) };
}

// the price the ticket's numbers are worked out at
function ticketRef(m, p) {
  const quote = p ? (ticket.side === "buy" ? p.ask : p.bid) || p.mark : 0;
  if (ticket.kind === "limit" || ticket.kind === "iceberg") return +$("#tkPrice").value || quote;
  if (ticket.kind === "chase") { // it rests at the best price on its own side, up to the cap
    const best = p ? (ticket.side === "buy" ? p.bid : p.ask) || p.mark : 0, cap = +$("#tkChaseCap").value;
    return cap ? (ticket.side === "buy" ? Math.min(best, cap) : Math.max(best, cap)) : best;
  }
  if (ticket.kind === "conditional") return (ticketAdv.exec === "limit" && +$("#tkPrice").value) || +$("#tkTrig").value || quote;
  if (ticket.kind === "scale") { const s = scalePreview(m); return s ? s.avg : quote; }
  return quote;
}

function renderAdvHints(m, p, qty) {
  const mark = p && p.mark, buy = ticket.side === "buy";
  const trig = +$("#tkTrig").value;
  $("#tkCondHint").textContent = ticket.kind === "conditional" && trig > 0 && mark
    ? t(trig > mark ? "Si attiva quando il mark sale a {p}." : "Si attiva quando il mark scende a {p}.", { p: fp(trig, m) }) : "";
  const mins = +$("#tkTwapMin").value;
  if (ticket.kind === "twap") {
    const end = mins >= 5 ? new Date(Date.now() + mins * 60000).toLocaleString(LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—";
    const px = +$("#tkTwapPx").value;
    $("#tkTwapHint").textContent = t("Finisce {end}.", { end }) + " " + (px ? t(buy ? "Non compra sopra {p}." : "Non vende sotto {p}.", { p: fp(px, m) }) : t("Senza limite, si ferma al 3% dal prezzo attuale."));
  }
  if (ticket.kind === "chase") {
    const cap = +$("#tkChaseCap").value, chaseMin = +$("#tkChaseMin").value;
    $("#tkChaseCapLabel").textContent = buy ? "Max" : "Min"; // short beside its twin field; the full name on hover
    $("#tkChaseCapField").title = t(buy ? "Prezzo massimo" : "Prezzo minimo");
    $("#tkChaseEndRow").classList.toggle("hidden", !chaseMin);
    $("#tkChaseHint").textContent = [t(buy ? "Sta sempre sul miglior bid, senza mai pagare da taker." : "Sta sempre sul miglior ask, senza mai pagare da taker."),
      cap ? t(buy ? "Non compra sopra {p}." : "Non vende sotto {p}.", { p: fp(cap, m) }) : "",
      chaseMin ? t($("#tkChaseEnd").checked ? "Dopo {n} minuti il resto va a market." : "Dopo {n} minuti si annulla.", { n: chaseMin }) : "",
      workedHint()].filter(Boolean).join(" ");
  }
  if (ticket.kind === "iceberg") {
    const pct = +$("#tkIceSlice").value;
    $("#tkIceHint").textContent = qty && pct > 0 ? [t("Circa {n} fette da {q}, una alla volta, ognuna un po' diversa.", { n: Math.ceil(100 / pct), q: fsize(qty * pct / 100, m) }), workedHint()].filter(Boolean).join(" ") : "";
  }
  if (ticket.kind === "scale") {
    const s = scalePreview(m);
    $("#tkScaleHint").textContent = s && qty ? t("{n} ordini da {a} a {b}, media {avg}.", { n: s.prices.length, a: fp(s.prices[0], m), b: fp(s.prices[s.prices.length - 1], m), avg: fp(s.avg, m) }) : "";
  }
}

// paper runs in the page; the real ones on the engine, so a closed page doesn't stop them
const workedHint = () => (Paper.on ? "" : t("Continua anche a pagina chiusa."));

async function loadTwapFees() {
  if (ticketAdv.twapFees) return;
  ticketAdv.twapFees = await api("/twap_fees").catch(() => null);
  updateTicketSummary();
}

// what a TWAP costs on this account's plan; it has its own fee, even where the rest is free
const twapRate = () => {
  const fees = ticketAdv.twapFees || {}, tier = (account && account.fees && account.fees.tier) || "standard";
  return fees[tier] ?? fees.standard ?? 0;
};

function wireAdvOrders() {
  const menu = $("#advMenu");
  $("#advBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); fitInView(menu); };
  menu.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-adv]");
    if (!b) return;
    ticket.kind = b.dataset.adv;
    menu.classList.add("hidden");
    if (ticket.kind === "twap") loadTwapFees();
    if (ticket.kind === "iceberg" && !$("#tkPrice").value) fillMid();
    if (ticket.kind === "basket") startBasket();
    renderTicket();
  };
  document.addEventListener("click", () => menu.classList.add("hidden"));
  $("#tkCondExec").onclick = (e) => {
    const b = e.target.closest("[data-exec]");
    if (!b) return;
    ticketAdv.exec = b.dataset.exec;
    if (ticketAdv.exec === "limit" && !$("#tkPrice").value) fillMid();
    renderTicket();
  };
  $("#tkScaleDist").onclick = (e) => { const b = e.target.closest("[data-dist]"); if (b) { ticketAdv.dist = b.dataset.dist; renderTicket(); } };
  const legBox = $("#tkBasketLegs");
  legBox.onclick = (e) => {
    const b = e.target.closest('button[data-leg]'), row = e.target.closest(".bk-leg");
    if (!b || !row) return;
    const i = +row.dataset.i, x = ticketAdv.legs[i];
    if (b.dataset.leg === "side") x.side = x.side === "buy" ? "sell" : "buy";
    else if (ticketAdv.legs.length > 2) ticketAdv.legs.splice(i, 1);
    renderBasketLegs();
    renderTicket();
  };
  legBox.onchange = (e) => {
    const row = e.target.closest(".bk-leg");
    if (row && e.target.dataset.leg === "market") { ticketAdv.legs[+row.dataset.i].market_id = e.target.value === "" ? null : +e.target.value; updateTicketSummary(); }
  };
  legBox.oninput = (e) => {
    const row = e.target.closest(".bk-leg");
    if (row && e.target.dataset.leg === "usd") { ticketAdv.legs[+row.dataset.i].usd = +e.target.value || 0; updateTicketSummary(); }
  };
  $("#tkBasketAdd").onclick = () => {
    ticketAdv.legs.push({ market_id: null, side: "buy", usd: 0 });
    renderBasketLegs();
    renderTicket();
  };
  $("#tkRfqCancel").onclick = closeRfq;
  $("#tkRfqNudge").onclick = () => { ticket.kind = "rfq"; $("#tkRfqNudge").classList.add("hidden"); renderTicket(); };
  $("#tkIceChips").onclick = (e) => { const b = e.target.closest("[data-pct]"); if (b) { $("#tkIceSlice").value = b.dataset.pct; updateTicketSummary(); } };
  $("#tkChaseEnd").onchange = updateTicketSummary;
  $("#tkTwapChips").onclick = (e) => { const b = e.target.closest("[data-min]"); if (b) { $("#tkTwapMin").value = b.dataset.min; updateTicketSummary(); } };
  $$(".adv-box input").forEach((el) => {
    el.oninput = updateTicketSummary;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tkExec").click(); } });
  });
}

function renderProtectionSummary(m) {
  const levels = readTpLevels();
  const sl = +$("#tkSl").value, tp = +$("#tkTp").value;
  const parts = [];
  if (sl > 0) parts.push(`SL ${fp(sl, m)}${$("#tkSlExec").value === "limit" ? " · Limit" : ""}`);
  if (levels) {
    const set = levels.filter((level) => level.price > 0).length;
    parts.push(`TP ${set}/${levels.length}`);
  } else if (tp > 0) {
    parts.push(`TP ${fp(tp, m)}${$("#tkTpExec").value === "limit" ? " · Limit" : ""}`);
  }
  if ($("#tkTrail").checked && !$("#tkReduce").checked) parts.push(t("Trailing stop"));
  const summary = $("#tkProtectionSummary");
  summary.textContent = parts.join(" · ");
  summary.classList.toggle("hidden", !parts.length || !$("#tkProtection").classList.contains("hidden"));
}

function toggleTicketProtection() {
  const open = !$("#tkProtection").classList.toggle("hidden");
  $("#tkProtectionToggle").setAttribute("aria-expanded", String(open));
  renderProtectionSummary(activeMarket());
}

function syncExitEditor(id, m, ref, qty, write = false) {
  const el = (suffix) => $(`#tk${id}${suffix}`);
  const trigger = el(""), move = el("Move"), usd = el("Unit").value === "usd";
  const direction = (ticket.side === "buy" ? 1 : -1) * (id === "Tp" ? 1 : -1);
  // % is of the margin, so the leverage counts: a 1% move at 10x is 10%
  const set = levSet(m), leverage = (set && set.leverage) || m.default_leverage;
  const factor = usd ? qty : 100 * leverage / ref;
  const ready = ref > 0 && Number.isFinite(factor) && factor > 0 && !(usd && $("#tkUnit").value === "risk_usd");
  el("Options").classList.toggle("hidden", trigger.disabled);
  el("Limit").classList.toggle("hidden", el("Exec").value !== "limit"); // the limit price sits in the execution row, before its menu
  move.disabled = !ready;
  move.title = usd && !ready ? t("Per usare USD, imposta la size in USD, quantità o % capitale")
    : usd ? t("Stima lorda sulla quantità dell’ordine al prezzo di trigger") : t("Perdita o guadagno in % del margine, con la leva ({lev}x)", { lev: +(+leverage).toFixed(1) });
  // the distance is shown signed (− a loss, + a gain); typed, its sign is ignored: an SL's distance goes the losing way, a TP's the winning way
  const typed = +move.value.replace(/[+−-]/g, "").replace(",", ".").trim();
  const show = (value, gain) => { // value: the distance's size; red or green, also while it is being typed
    if (value !== undefined) move.value = value ? `${gain ? "+" : "−"}${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2, useGrouping: false })}` : "";
    move.classList.toggle("up", gain);
    move.classList.toggle("down", !gain);
  };
  // a typed distance holds while the entry moves (the price follows it); a typed or dragged price holds the other way.
  // The price we wrote is remembered: if it is no longer in the field, the price was changed by hand
  const anchor = exitAnchor[id];
  if (anchor.on === "move" && !write && trigger.value !== anchor.price) anchor.on = "price";
  if ((write || anchor.on === "move") && ready) {
    if (write) anchor.on = "move";
    show(undefined, id === "Tp");
    if (!move.value.trim()) { trigger.value = ""; anchor.price = ""; }
    else {
      const price = +(ref + direction * typed / factor).toFixed(decimals(m));
      if (!(typed > 0 && price > 0 && (price - ref) * direction > 0)) {
        move.setCustomValidity(t("Scegli una distanza che produca un prezzo valido"));
        return;
      }
      trigger.value = price;
      anchor.price = trigger.value;
      if (!write && document.activeElement !== move) show(typed, id === "Tp");
    }
    move.setCustomValidity("");
  } else if (document.activeElement !== move) {
    if (ready && !move.validity.valid) return;
    move.setCustomValidity("");
    const value = (+trigger.value - ref) * direction * factor; // > 0: the exit's own way (a loss for the SL)
    const gain = +trigger.value > 0 && value ? (id === "Tp" ? value > 0 : value < 0) : id === "Tp"; // empty: the exit's own colour
    show(ready && +trigger.value > 0 ? value : 0, gain);
  }
}

// which of an exit's two numbers the trader set: "move" (the distance) or "price"
const exitAnchor = { Sl: { on: "price", price: "" }, Tp: { on: "price", price: "" } };

function ticketQuantity(ref) {
  const size = +$("#tkSize").value, unit = $("#tkUnit").value, sl = +$("#tkSl").value;
  if (!(ref > 0 && size > 0)) return null;
  if (unit === "usd") return size / ref;
  if (unit === "base") return size;
  if (unit === "equity_pct" && account) return account.total_value * size / 100 / ref;
  if (unit === "risk_usd" && sl && sl !== ref) return size / Math.abs(ref - sl);
  return null;
}

function updateTicketSummary() {
  if (activePair()) return updatePairSummary();
  if (ticket.kind === "basket") return updateBasketSummary();
  const m = activeMarket();
  if (m && isBasicKind()) renderProtectionSummary(m);
  const p = m && prices[m.id];
  const unit = $("#tkUnit").value;
  const ref = m ? ticketRef(m, p) : 0;
  const qty = ticketQuantity(ref);
  tpHint();
  $("#tkNotional").textContent = qty ? fusd(qty * ref) : "—";
  $("#tkQty").textContent = qty ? `${qty.toFixed(m.size_decimals)} ${m.symbol}` : "—";
  // the size is already in one of them: no need to repeat it
  $("#tkNotional").classList.toggle("hidden", unit === "usd");
  $("#tkQty").classList.toggle("hidden", unit === "base");
  syncSizeSlider(m, qty, ref);
  if (m && isBasicKind()) {
    for (const id of ["Sl", "Tp"]) syncExitEditor(id, m, ref, qty && +qty.toFixed(m.size_decimals));
  }
  renderTicketEstimates(m, p, qty, ref);
  clearTimeout(updateTicketSummary.t);
  updateTicketSummary.t = setTimeout(previewTicket, 350);
}

// ---------- size slider: a share of what the margin can open at this leverage ----------
// An order against the position first closes it, which frees its margin; reduce-only goes up to the position.
function sizeMax(m, ref) {
  if (!account || !m || !ref) return null;
  const set = levSet(m), lev = (set && set.leverage) || m.default_leverage || 1;
  const side = ticket.side === "buy" ? 1 : -1;
  const pos = account.positions.find((x) => x.market_id === m.id);
  const against = pos && Math.sign(pos.size) !== side;
  if ($("#tkReduce").checked) return against ? Math.abs(pos.size) : 0;
  const fee = feeRates(m)[ticket.kind === "limit" && $("#tkPost").checked ? "maker" : "taker"];
  const posValue = against ? Math.abs(pos.size) * ref : 0, freed = against ? posValue / lev : 0;
  return (posValue + (account.available + freed) / (1 / lev + (fee || 0))) / ref; // in the market's own unit
}

// what this account pays: its plan when known (paper has none), otherwise the market's listing
const feeRates = (m) => (account && account.fees ? account.fees : { taker: m.taker_fee || 0, maker: m.maker_fee || 0 });

const floorTo = (v, d) => Math.floor(v * 10 ** d + 1e-9) / 10 ** d;

// the slider's 100%: what the margin can open; a % of equity also stops at 100% of it, where the field does
function sliderMax(m, ref) {
  const max = sizeMax(m, ref);
  return max && $("#tkUnit").value === "equity_pct" ? Math.min(max, account.total_value / ref) : max;
}

// $ risk needs the stop to be worked out
const riskNeedsStop = (ref) => $("#tkUnit").value === "risk_usd" && !(+$("#tkSl").value > 0 && +$("#tkSl").value !== ref);

// The wheel on a focused stop-loss or take-profit moves it by 0.1% of the order's entry (1% with Shift) and keeps it
// on its own side: below the entry for a long's stop and a short's take-profit, above it for the other two, never
// at or through it and never below zero. An empty field starts one step from the entry.
function wheelStop(e) {
  const input = e.currentTarget, m = activeMarket();
  if (document.activeElement !== input || !m || input.disabled) return;
  const entry = ticketRef(m, prices[m.id]);
  if (!(entry > 0)) return;
  e.preventDefault();
  const dec = m.price_decimals, tick = 10 ** -dec;
  const step = Math.max(tick, +(entry * (e.shiftKey ? 0.01 : 0.001)).toFixed(dec));
  const below = (input.id === "tkSl") === (ticket.side === "buy");
  const delta = e.deltaY || e.deltaX; // Shift turns some wheels sideways
  let v = +input.value;
  if (!(v > 0)) v = below ? entry - step : entry + step;
  else v += delta < 0 ? step : -step;
  v = below ? Math.min(v, entry - tick) : Math.max(v, entry + tick);
  input.value = +Math.max(tick, v).toFixed(dec);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// the wheel on a focused SL/TP distance: up widens it, down narrows it, never to zero; 1 a notch (% of margin or $),
// 5 with Shift. The price follows, as when the distance is typed
function wheelMove(e) {
  const input = e.currentTarget;
  if (document.activeElement !== input || input.disabled) return;
  e.preventDefault();
  const step = e.shiftKey ? 5 : 1, delta = e.deltaY || e.deltaX; // Shift turns some wheels sideways
  const now = +input.value.replace(/[+−-]/g, "").replace(",", ".").trim() || 0;
  const v = delta < 0 ? now + step : Math.max(step, now - step);
  const sign = input.id === "tkTpMove" ? "+" : "−";
  input.value = sign + (+v.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2, useGrouping: false });
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// the slider follows the size typed (as a share of the largest size the money available opens at this leverage)
function syncSizeSlider(m, qty, ref) {
  const row = $("#tkPctRow");
  if (!m || !row) return;
  ref = ref || ticketRef(m, prices[m.id]);
  const max = ref ? sliderMax(m, ref) : 0;
  const needsStop = ref && riskNeedsStop(ref);
  const off = !(max > 0) || needsStop;
  row.classList.toggle("hidden", !account);
  row.classList.toggle("sell", ticket.side === "sell");
  row.classList.toggle("off", off);
  const reduce = $("#tkReduce").checked;
  const label = t(reduce ? "Percentuale della posizione riducibile" : "Percentuale della size massima");
  row.title = needsStop ? t("Imposta lo stop-loss: il rischio si calcola da lì")
    : off && reduce ? t("Nessuna posizione da ridurre su {sym}", { sym: m.symbol }) : label;
  const range = $("#tkPct"), box = $("#tkPctIn");
  range.title = row.title;
  for (const input of [range, box]) input.setAttribute("aria-label", label);
  range.disabled = box.disabled = off;
  if (qty === null) return; // the summary sets it once the quantity is known
  const pct = !off && qty ? Math.min(100, (qty / max) * 100) : 0;
  if (document.activeElement !== range || !range.matches(":active")) range.value = Math.round(pct);
  range.style.setProperty("--p", range.value + "%");
  if (document.activeElement !== box) box.value = qty && !off ? +(pct.toFixed(1)) : "";
}

function sizeFromPct(pct) {
  const m = activeMarket(), p = m && prices[m.id], unit = $("#tkUnit").value;
  const ref = ticketRef(m, p);
  const max = sliderMax(m, ref);
  if (!(max > 0) || riskNeedsStop(ref)) return;
  const qty = max * Math.max(0, Math.min(100, pct)) / 100;
  const v = unit === "base" ? floorTo(qty, m.size_decimals)
    : unit === "equity_pct" ? floorTo(qty * ref / account.total_value * 100, 2)
    : unit === "risk_usd" ? floorTo(qty * Math.abs(ref - +$("#tkSl").value), 2)
    : floorTo(qty * ref, 2);
  $("#tkSize").value = v > 0 ? v : "";
  updateTicketSummary();
}

// ---------- estimated price: the order walked through the book ----------
const estBook = { market: null, at: 0, asks: [], bids: [], busy: false };

function renderEstFill(m, qty, entry) {
  const buy = ticket.side === "buy", maxSlip = (+$("#tkSlip").value || 50) / 100;
  const slip = $("#tkEstSlip");
  const levels = estBook.market === m.id ? (buy ? estBook.asks : estBook.bids) : [];
  renderSlipButtons();
  estBook.last = null;
  if (!qty || !levels.length) {
    slip.textContent = "";
    slip.parentElement.classList.remove("down");
    return entry;
  }
  let left = qty, cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(left, size);
    cost += take * price;
    left -= take;
    if (left <= 1e-12) break;
  }
  const filled = qty - Math.max(0, left), avg = cost / (filled || 1);
  const best = levels[0][0], other = (buy ? estBook.bids : estBook.asks)[0];
  const mid = other ? (best + other[0]) / 2 : best;
  const est = Math.abs(avg - mid) / mid * 100, deep = left > 1e-12; // past the levels we can see
  estBook.last = { est, deep };
  slip.textContent = `${t("stimato {e}%", { e: (deep ? "> " : "") + est.toFixed(2) })} · `;
  slip.parentElement.classList.toggle("down", est >= maxSlip || deep);
  return avg;
}

// ---------- max slippage: shown as "max 0.5%" in the summaries, a click turns it into a field ----------
const slipBps = () => +$("#tkSlip").value || 50;
const slipButton = () => `<button type="button" class="slip-max" data-slip title="${t("Slippage massimo: clicca per cambiarlo")}">${t("max {m}%", { m: +(slipBps() / 100).toFixed(2) })}</button>`;

function renderSlipButtons() {
  for (const b of $$(".ticket .slip-max")) b.textContent = t("max {m}%", { m: +(slipBps() / 100).toFixed(2) });
}

function editSlip(btn) {
  const input = document.createElement("input");
  Object.assign(input, { type: "number", min: "0.01", max: "10", step: "0.05", className: "slip-in", value: +(slipBps() / 100).toFixed(2) });
  input.setAttribute("aria-label", t("Slippage massimo: clicca per cambiarlo"));
  const wrap = document.createElement("span");
  wrap.className = "slip-edit";
  wrap.append(input, "%");
  btn.replaceWith(wrap);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const pct = +input.value;
    if (save && pct > 0) {
      const bps = Math.min(1000, Math.max(1, Math.round(pct * 100)));
      $("#tkSlip").value = bps;
      store("slipBps", bps);
    }
    btn.textContent = t("max {m}%", { m: +(slipBps() / 100).toFixed(2) });
    wrap.replaceWith(btn);
    updateTicketSummary();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}

function refreshEstBook(m, qty, entry) {
  if (!qty || !["market", "rfq"].includes(ticket.kind) || estBook.busy) return;
  if (estBook.market === m.id && Date.now() - estBook.at < 3000) return;
  estBook.busy = true;
  api(`/orderbook?market_id=${m.id}`).then((b) => {
    Object.assign(estBook, { market: m.id, at: Date.now(), asks: b.asks || [], bids: b.bids || [] });
    if (activeMarket() === m) renderTicket(); // not this request's qty: the ticket may have changed while it was out
  }).catch(() => {}).finally(() => { estBook.busy = false; });
}

// margin, fees, liquidation and SL/TP outcome (formulas.js, ported from lighter-ts)
function renderTicketEstimates(m, p, qty, entry) {
  const side = ticket.side === "buy" ? 1 : -1;
  const set = levSet(m);
  const leverage = (set && set.leverage) || m.default_leverage;
  const notional = qty ? qty * entry : 0;
  const isMaker = ticket.kind === "chase" || ((ticket.kind === "limit" || ticket.kind === "iceberg") && $("#tkPost").checked);
  const rates = feeRates(m), feeRate = isMaker ? rates.maker : rates.taker;
  const feeUsd = Formulas.fee(notional, feeRate);
  const reduce = $("#tkReduce").checked;
  $("#tkMargin").textContent = qty && !reduce ? `${fusd(Formulas.orderMargin(notional, leverage))} · ${leverage}x` : "—";
  const feePct = (r) => +((r || 0) * 100).toFixed(3);
  $("#tkFee").textContent = `${qty ? fusd(feeUsd) + " · " : ""}T ${feePct(rates.taker)}% · M ${feePct(rates.maker)}%`;
  $("#tkFee").classList.toggle("hidden", !rates.taker && !rates.maker); // no fees, no row
  if (ticket.kind === "twap") { // its own fee, shown even on a plan with no others
    const rate = twapRate();
    $("#tkFee").textContent = `${qty ? fusd(notional * rate) + " · " : ""}TWAP ${feePct(rate)}%`;
    $("#tkFee").classList.toggle("hidden", !rate);
  }
  renderAdvHints(m, p, qty);
  const fillPx = ticket.kind === "market" || ticket.kind === "rfq" ? renderEstFill(m, qty, entry) || entry : (renderEstFill(m, null, entry), entry);
  renderRfqNudge(notional);
  renderRfqLive();
  refreshEstBook(m, qty, entry);
  // SL/TP fill within the same slippage as the order
  const hasStops = isBasicKind() && !reduce && (
    (+$("#tkSl").value > 0 && $("#tkSlExec").value === "market") ||
    (+$("#tkTp").value > 0 && $("#tkTpExec").value === "market") || !!readTpLevels()
  );
  for (const id of ["#tkTpslSlipDt", "#tkTpslSlip"]) $(id).classList.toggle("hidden", !hasStops);
  $("#tkTpslSlip").textContent = t("max {m}%", { m: +(slipBps() / 100).toFixed(2) });
  const mark = p && p.mark;
  const curPos = account && account.positions.find((x) => x.market_id === m.id);
  const after = $("#tkPositionAfter");
  const current = curPos?.size || 0;
  const orderQty = qty ? +qty.toFixed(m.size_decimals) : 0;
  const impactQty = !reduce ? orderQty : Math.sign(current) === -side ? Math.min(orderQty, Math.abs(current)) : 0;
  const nextSize = +(current + side * impactQty).toFixed(m.size_decimals);
  after.textContent = nextSize ? positionLabel(nextSize, m) : t("Nessuna posizione aperta.");
  after.className = impactQty && account ? (nextSize ? cls(nextSize) : "") : "hidden";
  const liq = set && set.cross === false
    ? (() => { // isolated: the position after the order stands on its own margin
        const size = (curPos ? curPos.size : 0) + side * qty;
        if (!qty || Math.abs(size) < 1e-12) return null;
        const avg = curPos && Math.sign(curPos.size) === side ? (curPos.entry * Math.abs(curPos.size) + entry * qty) / Math.abs(size) : entry;
        return Formulas.isolatedLiquidation(size, avg, Math.abs(size) * avg / leverage, m.mmf);
      })()
    : Formulas.liquidationAfterOrder({
      account, market: m, side, qty, entry, mark, feeUsd,
      markOf: (id) => prices[id] && prices[id].mark, mmfOf: (id) => (byId[id] ? byId[id].mmf : m.mmf),
    });
  const liqEl = $("#tkLiq");
  // with a position: what it is now, and what this order makes of it
  const closes = curPos && qty && Math.abs(curPos.size + side * qty) < 10 ** -m.size_decimals;
  liqEl.textContent = curPos && curPos.liq
    ? (qty ? `${fp(curPos.liq, m)} → ${liq && !closes ? fp(liq, m) : "—"}` : fp(curPos.liq, m))
    : liq ? fp(liq, m) : account ? "—" : t("serve l'account");
  liqEl.className = liq && mark && Math.abs(liq - mark) / mark < 0.05 ? "down" : "";
  const marginOf = (size, price) => Math.abs(size) * price / leverage;
  for (const id of ["#tkPosMarginDt", "#tkPosMargin", "#tkEntryDt", "#tkEntry"]) $(id).classList.toggle("hidden", !curPos);
  if (curPos) {
    // adding moves the average entry; reducing leaves it; going past zero opens at the order's price
    const next = curPos.size + side * (qty || 0), adds = Math.sign(curPos.size) === side;
    const nextEntry = adds ? (Math.abs(curPos.size) * curPos.entry + (qty || 0) * fillPx) / Math.abs(next || 1)
      : Math.sign(next) === Math.sign(curPos.size) ? curPos.entry : fillPx;
    $("#tkPosMargin").textContent = qty ? `${fusd(marginOf(curPos.size, curPos.entry))} → ${closes ? "—" : fusd(marginOf(next, nextEntry))}` : fusd(marginOf(curPos.size, curPos.entry));
    const changes = qty && (closes || fp(nextEntry, m) !== fp(curPos.entry, m));
    $("#tkEntry").textContent = changes ? `${fp(curPos.entry, m)} → ${closes ? "—" : fp(nextEntry, m)}` : fp(curPos.entry, m);
  }
  setTicketMargin(qty && account ? { market_id: m.id, delta: side * qty, price: entry, leverage, cross: !set || set.cross !== false, reduce } : null);
  const draft = { market: m.id, side, entry, liq: qty && !reduce ? liq : null, lines: [] };
  const sideWord = side > 0 ? "BUY" : "SELL", sizeWord = qty ? " " + fsize(qty, m) : "";
  if (hasLimitField() && +$("#tkPrice").value) draft.lines.push({ kind: "limit", price: +$("#tkPrice").value, title: `LIMIT ${sideWord}${ticket.kind === "limit" ? sizeWord : ""}` });
  if (ticket.kind === "chase" && +$("#tkChaseCap").value > 0) draft.lines.push({ kind: "limit", label: "MAX", input: $("#tkChaseCap"), price: +$("#tkChaseCap").value, title: `CHASE ${sideWord} MAX` });
  if (ticket.kind === "conditional" && +$("#tkTrig").value > 0) draft.lines.push({ kind: "limit", label: "COND", input: $("#tkTrig"), price: +$("#tkTrig").value, title: `COND ${sideWord}${sizeWord}` });
  if (ticket.kind === "scale") { // one line per order; they move with the two prices in the ticket
    const s = scalePreview(m);
    if (s) s.prices.forEach((price, i) => draft.lines.push({ kind: "limit", fixed: true, price, title: `${i + 1}/${s.prices.length} ${sideWord}${qty ? " " + fsize(qty * s.shares[i], m) : ""}` }));
  }
  // The ticket's SL/TP are position-tied on Lighter (size 0): when they fire they close the whole position.
  // So with a position already open on this side, the outcome is for the position plus this order,
  // at their average entry; the side check still uses this order's price.
  const pos = account && account.positions.find((x) => x.market_id === m.id);
  const held = pos && !reduce && Math.sign(pos.size) === side ? Math.abs(pos.size) : 0;
  const totQty = (qty || 0) + held;
  const avgEntry = totQty ? ((qty || 0) * entry + (held ? held * pos.entry : 0)) / totQty : entry;
  const levels = isBasicKind() ? readTpLevels() : null;
  for (const id of ["Sl", "Tp"]) for (const x of [`#tk${id}PnlDt`, `#tk${id}Pnl`]) $(x).classList.add("hidden"); // shown again below when set
  for (const [id, isSL] of !isBasicKind() ? [] : levels ? [["Sl", true]] : [["Sl", true], ["Tp", false]]) {
    const trigger = +$("#tk" + id).value;
    const out = $(`#tk${id}Out`);
    const pnlRow = (text, c) => { // the summary's "At take-profit" / "At stop-loss": the result in dollars
      for (const x of [`#tk${id}PnlDt`, `#tk${id}Pnl`]) $(x).classList.toggle("hidden", !text);
      $(`#tk${id}Pnl`).textContent = text || "—";
      $(`#tk${id}Pnl`).className = text ? c : "hidden";
    };
    pnlRow("");
    const check = Formulas.sltpOutcome({ isSL, side, entry, trigger, qty: qty || 1, leverage });
    const res = Formulas.sltpOutcome({ isSL, side, entry: avgEntry, trigger, qty: totQty || null, leverage });
    if (trigger > 0) draft.lines.push({ kind: isSL ? "sl" : "tp", price: trigger, title: isSL ? "SL" : "TP" });
    if (!res || !check) { out.textContent = ""; out.className = "sltp-out"; continue; }
    // a level on the wrong side shows nothing here: the check comes when the trade button is pressed
    if (check.usd < 0) { out.textContent = ""; out.className = "sltp-out"; continue; }
    const beyondLiq = isSL && Formulas.slBeyondLiquidation(side, trigger, liq);
    const pnl = isSL ? -res.usd : res.usd, roe = isSL ? -res.pct : res.pct; // signed result when it fires
    const sign = (v) => (v >= 0 ? "+" : "−");
    // the estimated result goes on the chart line only; the field keeps just the liquidation warning
    out.textContent = beyondLiq ? t("oltre la liquidazione") : "";
    out.className = "sltp-out" + (beyondLiq ? " warn" : "");
    draft.lines[draft.lines.length - 1].title += " " + (beyondLiq ? out.textContent
      : `PnL ${sign(pnl)}${fusd(Math.abs(pnl))} (${sign(roe)}${Math.abs(roe).toFixed(1)}%)`);
    if (totQty && Number.isFinite(pnl)) pnlRow(beyondLiq ? t("oltre la liquidazione") : `${sign(pnl)}${fusd(Math.abs(pnl))}`, beyondLiq ? "warn" : pnl >= 0 ? "up" : "down");
  }
  if (levels) {
    const inputs = $$("#tkTpBox [data-tp-price]");
    levels.forEach((l, i) => {
      if (!(l.price > 0)) return;
      const res = qty && Formulas.sltpOutcome({ isSL: false, side, entry, trigger: l.price, qty: qty * l.pct / 100, leverage });
      const sign = (v) => (v >= 0 ? "+" : "−");
      const outcome = res && res.usd >= 0 ? ` · PnL ${sign(res.usd)}${fusd(Math.abs(res.usd))} (${sign(res.pct)}${Math.abs(res.pct).toFixed(1)}%)` : "";
      draft.lines.push({ kind: "tp", price: l.price, label: `TP${i + 1}`, input: inputs[i], title: `TP${i + 1} ${+l.pct.toFixed(1)}%${outcome}` });
    });
  }
  if (isBasicKind()) draft.lines.push(...trailDraft(m, side, entry, leverage));
  setTicketDraft(draft);
}

// where the ticket's trailing stop would sit right after the fill (ATR needs candles: start and breakeven only)
function trailDraft(m, side, entry, leverage = 1) {
  const tr = $("#tkTrail").checked && !$("#tkReduce").checked && readTrail($("#tkTrailBox"));
  if (!tr || !entry) return [];
  const out = [];
  const dist = tr.mode === "pnl" ? entry * tr.value / 100 / leverage : tr.mode === "pct" ? entry * tr.value / 100 : tr.mode === "price" ? tr.value : null;
  const label = `TRAIL ${trailLabel(trailToStop(tr), m)}`;
  if (tr.activate_pct) out.push({ kind: "trail", dashed: true, price: entry * (1 + side * tr.activate_pct / 100 / leverage), title: `${label} · ${t("trailing da qui")}` });
  else if (dist) out.push({ kind: "trail", price: entry - side * dist, title: label });
  if (tr.breakeven_at_pct) out.push({ kind: "trail", dashed: true, price: entry * (1 + side * tr.breakeven_at_pct / 100 / leverage), title: "BE" });
  return out;
}

// ticket preview on the chart: provisional lines while the order is being filled in, gone once it is sent
let ticketDraft = null;
function setTicketDraft(d) {
  const sent = previewTicket.sentKey && previewTicket.sentKey === JSON.stringify(ticketBody());
  // size alone draws nothing: the estimated liquidation comes with a price typed in the ticket
  ticketDraft = chartEls.preview && !sent && d.lines.length ? d : null;
  panels.forEach((p) => p.drawPreview());
}

async function previewTicket() {
  const note = $("#tkRisk");
  const m = activeMarket();
  if (!info.trading || !m || !(+$("#tkSize").value > 0)) { note.classList.add("hidden"); return; }
  const key = JSON.stringify(ticketBody());
  if (key === previewTicket.key && Date.now() - previewTicket.at < 5000) return;
  previewTicket.key = key;
  previewTicket.at = Date.now();
  const r = await api("/preview?live=true", { method: "POST", body: key }).catch((e) => ({ ok: false, error: e.message }));
  if (key !== previewTicket.key) return;
  note.classList.toggle("hidden", r.ok);
  if (!r.ok) note.textContent = r.error;
  else {
    $("#tkNotional").textContent = fusd(r.notional);
    $("#tkQty").textContent = `${r.size} ${m.symbol}`;
  }
}

// the ticket's answer under the button: an error stays until the ticket is changed, a success fades by itself
let ticketMsgTimer = 0;
function ticketMsg(text, kind) {
  const el = $("#tkMsg");
  clearTimeout(ticketMsgTimer);
  el.textContent = text;
  el.className = "ticket-msg " + kind;
  if (kind === "ok") ticketMsgTimer = setTimeout(hideTicketMsg, 6000);
}
function hideTicketMsg() {
  clearTimeout(ticketMsgTimer);
  $("#tkMsg").className = "ticket-msg hidden";
}

async function executeTicket(byMouse = false) {
  if (activePair()) return executePair(byMouse);
  if (ticket.kind === "basket") return executeBasket(byMouse);
  if (ticket.kind === "rfq") return executeRfq(byMouse);
  if (isBasicKind() && ["Sl", "Tp"].some((id) => {
    const input = $(`#tk${id}Move`);
    return !input.disabled && !$(`#tk${id}`).disabled && !input.validity.valid;
  })) return ticketMsg(t("Scegli una distanza che produca un prezzo valido"), "err");
  if (!(await levFlush())) return; // the leverage on screen didn't go through: no order on the wrong one
  const m = activeMarket();
  const size = +$("#tkSize").value;
  if (!m || !(size > 0)) return ticketMsg(t("Inserisci una size valida."), "err");
  const body = ticketBody();
  if (ticket.kind === "limit" && !body.price) return ticketMsg(t("Inserisci il prezzo limite."), "err");
  if (body.trail === null) return ticketMsg(t("Inserisci la distanza del trailing."), "err");
  const label = `${ticket.side === "buy" ? "LONG" : "SHORT"} ${m.symbol} · ${$("#tkNotional").textContent} · ${ticket.kind}`
    + (body.tp_levels ? ` · ${body.tp_levels.length} TP` : "") + (body.trail ? ` · trailing ${trailLabel(trailToStop(body.trail), m)}` : "");
  const bodyKey = JSON.stringify(body);
  if (pendingConfirm?.key === "order" && pendingConfirm.body !== bodyKey) cancelConfirm();
  if (!(pendingConfirm && pendingConfirm.key === "order")) { // first click: full check, SL/TP sides included
    const r = await api("/preview", { method: "POST", body: bodyKey }).catch((e) => ({ ok: false, error: e.message }));
    if (!activeMarket() || activePair() || JSON.stringify(ticketBody()) !== bodyKey) return;
    if (!r.ok) return ticketMsg(r.error, "err");
    $("#tkMsg").className = "ticket-msg hidden";
  }
  if (!askConfirm("order", `${t("Conferma")} ${label}`)) {
    pendingConfirm.body = bodyKey;
    return;
  }
  const btn = $("#tkExec");
  btn.disabled = true;
  try {
    const r = await api("/order", { method: "POST", body: JSON.stringify(body) });
    ticketMsg(t("Eseguito: {side} {size} {sym}. Controlla posizioni e ordini per i fill.", { side: ticket.side, size: r.size, sym: m.symbol })
      + (body.trail && !r.armed ? " " + t("Trailing impostato: parte quando attivi Auto.") : "")
      + (body.tp_levels && !r.armed && (body.be_after_tp1 || ticket.kind === "limit") ? " " + t("Uscite scalari: il breakeven dopo TP1 (e i TP di un limit) parte quando attivi Auto.") : ""), "ok");
    previewTicket.sentKey = JSON.stringify(body);
    updateTicketSummary();
    loadOrders(true);
    if (byMouse) keyboardTip();
  } catch (e) {
    ticketMsg(e.message, "err");
  } finally {
    btn.disabled = !info.trading;
  }
}

// ---------- orders from the chart's right-click menu ----------
function chartLimit(side, price) {
  ticket.side = side;
  ticket.kind = "limit";
  $("#tkPrice").value = price;
  renderTicket();
  updateTicketSummary();
  const size = $("#tkSize");
  if (!(+size.value > 0)) { size.focus(); size.select(); }
}

function chartTicketStop(k, price, level = null) {
  if (level !== null) $$("#tkTpBox [data-tp-price]")[level].value = price;
  else $(k === "tp" ? "#tkTp" : "#tkSl").value = price;
  updateTicketSummary();
}

async function chartCancelOrder(o) {
  try {
    await api(`/cancel_order?market_id=${o.market_id}&order_index=${o.order_index}`, { method: "POST" });
    toast(t("Ordine annullato"));
    loadOrders(true);
  } catch (err) { toast(err.message, true); }
}

function chartClearTicket(d) {
  if (d.input) d.input.value = "";
  else $({ sl: "#tkSl", tp: "#tkTp", limit: "#tkPrice" }[d.kind]).value = "";
  if (d.kind === "limit") { ticket.kind = "market"; renderTicket(); }
  updateTicketSummary();
}

async function chartStopTrail(m) {
  try {
    const res = await api(`/trail/${m.id}`, { method: "DELETE" });
    stops = res.stops;
    renderPositions();
    panels.forEach((p) => p.drawLines());
    toast(t("Trailing fermato su {sym}", { sym: m.symbol }));
  } catch (err) { toast(err.message, true); }
}

async function chartClosePosition(pos) {
  try {
    await api(`/close?market_id=${pos.market_id}&fraction=1`, { method: "POST" });
    toast(t("Chiusura {f}%: ordine accettato", { f: 100 }), "ok");
  } catch (err) { toast(err.message, true); }
}

async function chartPositionStop(pos, k, price, cur) {
  try {
    await api("/position_sltp", { method: "POST", body: JSON.stringify({ market_id: pos.market_id, kind: k, price, order_index: cur ? cur.order_index : null }) });
    toast(t("{kind} a {price}", { kind: k.toUpperCase(), price: fp(price, byId[pos.market_id]) }));
    await fetchOpenOrders(true).catch(() => {});
  } catch (err) { toast(err.message, true); }
}

// ================= price alerts =================
// Kept in this browser and checked on every price tick while LighterDeck is open: an alert fires when the
// last price reaches its level from the side it was on when set. One-shot; the last 20 stay listed.
let alerts = load("alerts", []);
let alertsFired = load("alertsFired", []);
let hoverPanel = null; // the chart under the pointer, for the A key

function saveAlerts() {
  store("alerts", alerts);
  store("alertsFired", alertsFired);
  $("#alertCount").textContent = alerts.length;
  panels.forEach((p) => p.drawLines());
  if (!$("#btab-alerts").classList.contains("hidden")) renderAlerts();
}

const lastPrice = (id) => { const q = prices[id]; return q ? q.last || q.mark : null; };

function addAlert(m, price) {
  const px = lastPrice(m.id);
  if (!m || !px) return toast(t("Nessun prezzo per questo mercato in questo momento"), true);
  price = +(+price).toFixed(decimals(m));
  alerts.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), market_id: m.id, symbol: m.symbol,
    price, dir: price >= px ? 1 : -1, created: Date.now() });
  saveAlerts();
  toast(t("Alert su {sym} a {price}", { sym: m.symbol, price: fp(price, m) }));
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

function moveAlert(id, price) {
  const a = alerts.find((x) => x.id === id), px = a && lastPrice(a.market_id);
  if (!a) return;
  a.price = price;
  if (px) a.dir = price >= px ? 1 : -1;
  saveAlerts();
  toast(t("Alert su {sym} spostato a {price}", { sym: a.symbol, price: fp(price, byId[a.market_id]) }));
}

function removeAlert(id) {
  alerts = alerts.filter((x) => x.id !== id);
  saveAlerts();
}

function checkAlerts() {
  const hit = alerts.filter((a) => { const px = lastPrice(a.market_id); return px && (a.dir > 0 ? px >= a.price : px <= a.price); });
  if (!hit.length) return;
  alerts = alerts.filter((a) => !hit.includes(a));
  for (const a of hit) {
    const m = byId[a.market_id], px = lastPrice(a.market_id);
    alertsFired.unshift({ ...a, at: Date.now(), px });
    notify(t("Alert {sym}: {price} raggiunto (ora {px})", { sym: a.symbol, price: m ? fp(a.price, m) : a.price, px: m ? fp(px, m) : px }), a.id);
  }
  alertsFired.length = Math.min(alertsFired.length, 20);
  alertSound();
  saveAlerts();
}

// toast in the page and a system notification (when allowed); the sound is played once by the caller
function notify(msg, tag) {
  toast(msg);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const direct = () => { try { new Notification("LighterDeck", { body: msg, tag }); } catch {} };
  if (swReg) swReg.showNotification("LighterDeck", { body: msg, tag, icon: "/favicon.svg" }).catch(direct);
  else direct();
}

// the service worker that shows notifications on phones (frontend/sw.js); without it, the page shows them
let swReg = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then((r) => (swReg = r)).catch(() => {});

// phones keep sound off until the page is touched: the first touch or click unlocks it for the alerts
document.addEventListener("pointerdown", () => {
  try {
    const ctx = alertSound.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch {}
}, { once: true });

// ---------- automatic alerts, from the same facts as the context badges ----------
// Each kind is switched on in the Alert tab. A condition fires once, and again only after it has cleared
// (with a margin, so a value hovering on the line doesn't repeat it).
const AUTO_KINDS = [
  ["liq", "Liquidazione vicina", "La tua posizione arriva al 10% e poi al 5% dal prezzo di liquidazione"],
  ["event", "Evento in arrivo", "15 minuti prima di un evento ad alto impatto sui mercati delle tue posizioni e dei tuoi grafici"],
  ["funding", "Funding che paghi", "Il funding supera lo 0,01% all'ora dal lato della tua posizione"],
];
let autoAlertsOn = { liq: true, event: true, funding: false, ...load("autoAlerts", {}) };
const autoActive = new Set(); // conditions true right now, so they fire once
let autoSeen = load("autoSeen", {}); // event alerts already sent (survive a reload), key -> time

function autoFire(key, sym, text) {
  if (autoActive.has(key)) return false;
  autoActive.add(key);
  alertsFired.unshift({ auto: true, id: key, symbol: sym, text, at: Date.now() });
  notify(text, key);
  return true;
}

function checkAutoAlerts() {
  if (!account) return;
  const now = Date.now();
  let fired = false;
  const clear = (key) => autoActive.delete(key);
  for (const p of account.positions) {
    const m = byId[p.market_id], q = prices[p.market_id];
    if (!m || !q) continue;
    // liquidation: at 10% and again at 5%; each clears once the gap is back above 12% / 6%
    if (autoAlertsOn.liq && p.liq && q.mark) {
      const gap = Math.abs(q.mark - p.liq) / q.mark * 100;
      for (const [lvl, back] of [[10, 12], [5, 6]]) {
        const key = `liq:${p.market_id}:${lvl}`;
        if (gap < lvl) fired = autoFire(key, m.symbol, t("{sym}: liquidazione al {g}% (a {price})", { sym: m.symbol, g: gap.toFixed(1), price: fp(p.liq, m) })) || fired;
        else if (gap > back) clear(key);
      }
    }
    // funding the position pays: a long pays a positive rate, a short a negative one
    if (autoAlertsOn.funding) {
      const key = `funding:${p.market_id}`, pays = Math.sign(p.size) === Math.sign(q.funding);
      if (pays && Math.abs(q.funding) >= BADGE_FUNDING)
        fired = autoFire(key, m.symbol, t("{sym}: funding {r}/h, lo paga la tua posizione", { sym: m.symbol, r: fpctf(q.funding) })) || fired;
      else if (!pays || Math.abs(q.funding) < BADGE_FUNDING * 0.8) clear(key);
    }
  }
  // a high-impact event 15 minutes ahead, for the markets of the positions and the charts
  if (autoAlertsOn.event) {
    const syms = new Set([...account.positions.map((p) => p.symbol),
      ...panelCfg.flatMap((c) => (pairOf(c.symbol) ? pairOf(c.symbol).map((m) => m.symbol) : [c.symbol]))].filter((s) => bySymbol[s]));
    for (const e of events) {
      const left = e.ts * 1000 - now;
      if (left <= 0 || left > 15 * 60000 || e.approx || e.when === "time not given") continue;
      const key = `event:${e.id || e.ts + e.title}`;
      if (autoSeen[key]) continue;
      const mine = [...syms].filter((s) => eventFor(e, s) && impactFor(e, s) === "High");
      if (!mine.length) continue;
      autoSeen[key] = now;
      autoActive.delete(key);
      const name = `${e.country && e.source !== "Nasdaq" ? e.country + " " : ""}${e.title}`;
      fired = autoFire(key, mine.join(", "), t("{ev} tra {d} · {syms}", { ev: name, d: dur(left), syms: mine.join(", ") })) || fired;
    }
    for (const [k, at] of Object.entries(autoSeen)) if (now - at > 86400000) delete autoSeen[k];
    store("autoSeen", autoSeen);
  }
  if (!fired) return;
  alertsFired.length = Math.min(alertsFired.length, 20);
  alertSound();
  saveAlerts();
}

// two short tones
function alertSound() {
  try {
    const ctx = alertSound.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + i * 0.18;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.17);
    });
  } catch {}
}

function renderAlerts() {
  const box = $("#btab-alerts");
  const autos = `<div class="auto-alerts"><span class="caps muted">${t("Avvisi automatici")}</span>${AUTO_KINDS.map(([k, name, hint]) =>
    `<label title="${t(hint)}"><input type="checkbox" data-auto="${k}" ${autoAlertsOn[k] ? "checked" : ""}> ${t(name)}</label>`).join("")}
    <span class="muted auto-note">${t("Arrivano con LighterDeck aperto, anche in una tab in secondo piano.")}</span></div>`;
  // when: the day and time, and how long ago for the fired ones ("12:26 · 5m ago")
  const when = (ts) => new Date(ts).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fired = (a) => `<span class="al-fired">${t("Scattato {t}", { t: when(a.at) })}<small>${t("{d} fa", { d: dur(Date.now() - a.at) })}</small></span>`;
  const row = (a, done) => {
    if (a.auto) return `<tr class="auto done"><td class="mk">${a.symbol && bySymbol[a.symbol] ? gotoBtn(a.symbol) : esc(a.symbol || "")}</td><td colspan="4">${esc(a.text)}</td>
      <td class="r muted">—</td><td class="r">${fired(a)}</td></tr>`;
    const m = byId[a.market_id], px = lastPrice(a.market_id);
    const dist = !done && px ? ((a.price - px) / px) * 100 : null;
    return `<tr class="${done ? "done" : ""}"><td class="mk">${gotoBtn(a.symbol)}</td><td>${a.dir > 0 ? t("sale a") : t("scende a")}</td><td class="r main">${m ? fp(a.price, m) : a.price}</td>
      <td class="r">${done ? (m ? fp(a.px, m) : a.px) : px && m ? fp(px, m) : "—"}</td><td class="r ${dist !== null ? cls(dist) : ""}">${dist !== null ? fpct(dist) : "—"}</td>
      <td class="r muted">${a.created ? when(a.created) : "—"}</td>
      <td class="r">${done ? fired(a) : `<span class="al-live">${t("attivo")}</span><button class="xbtn" data-alert-del="${a.id}">${t("Togli")}</button>`}</td></tr>`;
  };
  const head = `<thead><tr><th>${t("Mercato")}</th><th>${t("Quando il prezzo")}</th><th class="r">${t("Livello")}</th><th class="r" title="${t("Il prezzo ora, o quando l'alert è scattato")}">${t("Prezzo")}</th><th class="r">${t("Distanza")}</th><th class="r">${t("Creato")}</th><th class="r">${t("Stato")}</th></tr></thead>`;
  if (!alerts.length && !alertsFired.length) {
    box.innerHTML = autos + `<div class="empty">${t("Nessun alert. Click destro sul grafico → Alert, oppure punta il mouse a un prezzo e premi A.")}</div>`;
    return;
  }
  box.innerHTML = autos + `<table class="table">${head}<tbody>${alerts.map((a) => row(a, false)).join("")}${alertsFired.map((a) => row(a, true)).join("")}</tbody></table>`
    + (alertsFired.length ? `<div class="alerts-foot"><button class="link" data-alert-clear>${t("Svuota gli alert scattati")}</button></div>` : "");
}

// ================= the account's margin: now, and after what you're about to do =================
// One place for these figures, used by the account card, the ticket and the close buttons. `change` is a position
// moving: { market_id, delta (signed size), price, leverage, cross, reduce }. A resting order counts as if it filled.
function marginState(a, change) {
  const levOf = (p) => p.leverage || (byId[p.market_id] && byId[p.market_id].default_leverage) || 1;
  const marginOf = (p) => (p.cross === false ? p.margin : Math.abs(p.value) / levOf(p));
  const mmfOf = (id) => (byId[id] && byId[id].mmf) || 0;
  const iso = a.positions.filter((p) => p.cross === false), cross = a.positions.filter((p) => p.cross !== false);
  const isoMargin = iso.reduce((s, p) => s + p.margin, 0), isoEquity = iso.reduce((s, p) => s + p.margin + p.upnl, 0);
  const eq = a.total_value, parts = a.positions.map((p) => ({ market_id: p.market_id, symbol: p.symbol, long: p.size > 0, margin: marginOf(p) }));
  const known = parts.reduce((s, p) => s + p.margin, 0);
  // what's taken also covers resting orders, which only show in the available balance
  let used = Math.max(a.initial != null ? a.initial + isoMargin : known, eq - a.available, known);
  const orders = Math.max(0, used - known);
  const crossValue = a.cross_value != null ? a.cross_value : eq - isoEquity;
  let maintenance = a.maintenance != null ? a.maintenance : cross.reduce((s, p) => s + Math.abs(p.value) * mmfOf(p.market_id), 0);
  let notional = a.positions.reduce((s, p) => s + Math.abs(p.value), 0);
  let crossNotional = cross.reduce((s, p) => s + Math.abs(p.value), 0);
  let free = a.available, delta = 0;
  for (const c of change ? [].concat(change) : []) { // a basket is several at once
    const pos = a.positions.find((p) => p.market_id === c.market_id);
    const was = pos ? pos.size : 0;
    let move = c.delta;
    // a reduce-only order can only shrink what's there
    if (c.reduce) move = !was || Math.sign(move) === Math.sign(was) ? 0 : Math.sign(move) * Math.min(Math.abs(move), Math.abs(was));
    const next = was + move, wasValue = pos ? Math.abs(pos.value) : 0, wasMargin = pos ? marginOf(pos) : 0;
    const adds = !was || Math.sign(move) === Math.sign(was), shrinks = !adds && Math.sign(next) === Math.sign(was);
    // what's held stays at its value; only the part this order adds, or a flip's new side, is at the order's price
    const nextValue = adds ? wasValue + Math.abs(move) * c.price : shrinks ? wasValue * Math.abs(next) / Math.abs(was) : Math.abs(next) * c.price;
    const nextMargin = shrinks ? wasMargin * Math.abs(next) / Math.abs(was) : nextValue / (c.leverage || 1);
    delta += nextMargin - wasMargin;
    used += nextMargin - wasMargin;
    notional += nextValue - wasValue;
    if (c.cross !== false) {
      maintenance += (nextValue - wasValue) * mmfOf(c.market_id);
      crossNotional += nextValue - wasValue;
    }
    free = eq - used;
  }
  const ratio = crossValue > 0 ? maintenance / crossValue : maintenance > 0 ? 1 : 0;
  return {
    eq, used, usedPct: eq > 0 ? (used / eq) * 100 : 0, free, parts, orders, delta, ratio,
    lev: eq > 0 ? notional / eq : 0,
    // how far every cross position together can go against you before the equity meets the maintenance requirement
    room: crossNotional > 1e-9 ? Math.max(0, crossValue - maintenance) / crossNotional : null,
    level: ratio >= 0.8 ? "danger" : ratio >= 0.5 ? "warn" : "",
  };
}

const marginView = { ticket: null, hover: null, hoverEl: null };
const fromTo = (a, b, f) => (f(a) === f(b) ? f(a) : `${f(a)} → ${f(b)}`);
const fpctUsed = (v) => `${v.toFixed(v > 0 && v < 10 ? 1 : 0)}%`;
const froom = (v) => (v == null ? "—" : v >= 1 ? "> 100%" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`); // past 100% nothing more to say

function renderMargin() {
  const gauge = $("#accGauge"), pill = $("#accountPill");
  const show = (id, on) => { $(id).classList.toggle("hidden", !on); $(id + "Dt").classList.toggle("hidden", !on); };
  gauge.classList.toggle("hidden", !account);
  $("#accFunds").classList.toggle("hidden", !account || Paper.on);
  if (!account) {
    $("#accMgLegend").innerHTML = "";
    $("#accMgLegend").dataset.html = "";
    $("#accAvail").textContent = "—";
    for (const id of ["#accUsed", "#accLev", "#accRoom", "#accUpnl"]) show(id, false);
    delete pill.dataset.margin;
    return;
  }
  // a button that was redrawn under the mouse never says the mouse left
  if (marginView.hoverEl && !marginView.hoverEl.isConnected) marginView.hover = marginView.hoverEl = null;
  const change = marginView.hover || marginView.ticket;
  const now = marginState(account), next = change ? marginState(account, change) : now;
  const moved = change && Math.abs(next.delta) > 1e-9;
  const active = account.positions.length > 0 || now.used > 1e-9;
  // the bar: one piece per market, then the orders, then what the change adds or frees
  const scale = Math.max(now.eq, now.used, next.used, 1e-9);
  const width = (v) => `${(Math.max(0, v) / scale) * 100}%`;
  const pieces = [...now.parts].sort((x, y) => (change && x.market_id === change.market_id ? 1 : 0) - (change && y.market_id === change.market_id ? 1 : 0)).map((p) => {
    const shrink = moved && next.delta < 0 && p.market_id === change.market_id ? -next.delta : 0;
    return `<i class="mg-seg ${p.long ? "long" : "short"}" style="width:${width(p.margin - shrink)}"></i>${shrink ? `<i class="mg-seg freed" style="width:${width(shrink)}"></i>` : ""}`;
  });
  if (now.orders > 1e-9) pieces.push(`<i class="mg-seg orders" style="width:${width(now.orders)}"></i>`);
  if (moved && next.delta > 0) pieces.push(`<i class="mg-seg adds${next.used > next.eq ? " over" : ""}" style="width:${width(next.delta)}"></i>`);
  const html = pieces.join("");
  const bar = $("#accMgBar");
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  const tick = $("#accMgTick");
  tick.style.left = `${Math.min(100, next.ratio * 100)}%`;
  tick.className = `mg-tick ${next.level}${next.ratio > 0 ? "" : " hidden"}`;
  tick.title = t("Margine di mantenimento: quando questa linea arriva in fondo, scatta la liquidazione");
  // the legend says which market holds what, and takes you there
  const legend = now.parts.slice().sort((x, y) => y.margin - x.margin).map((p) => `<button class="mg-key ${p.long ? "long" : "short"}" data-sym="${esc(p.symbol)}">${esc(p.symbol)} <b>${fpctUsed(now.eq > 0 ? (p.margin / now.eq) * 100 : 0)}</b></button>`);
  if (now.orders > 1e-9) legend.push(`<span class="mg-key orders">${t("Ordini")} <b>${fpctUsed(now.eq > 0 ? (now.orders / now.eq) * 100 : 0)}</b></span>`);
  const legendHtml = legend.join("");
  const legendEl = $("#accMgLegend");
  if (legendEl.dataset.html !== legendHtml) { legendEl.innerHTML = legendHtml; legendEl.dataset.html = legendHtml; }
  // the rows, before -> after only when something is about to change
  const short = moved && next.free < 0 && next.delta > 0;
  $("#accAvail").textContent = short ? t("Mancano {x}", { x: fusd(-next.free) }) : moved ? fromTo(account.available, Math.max(0, next.free), fusd) : fusd(account.available);
  $("#accAvail").className = short ? "down" : "";
  show("#accUsed", active || moved);
  $("#accUsed").textContent = moved ? fromTo(now.usedPct, next.usedPct, fpctUsed) : fpctUsed(now.usedPct);
  $("#accUsed").classList.toggle("down", (moved ? next : now).usedPct > 100);
  show("#accLev", active || moved);
  $("#accLev").textContent = moved ? fromTo(now.lev, next.lev, (v) => `${v.toFixed(1)}x`) : `${now.lev.toFixed(1)}x`;
  show("#accRoom", now.room != null || (moved && next.room != null));
  $("#accRoom").textContent = moved ? fromTo(now.room, next.room, froom) : froom(now.room);
  const level = (moved ? next : now).level;
  $("#accRoom").classList.toggle("down", level === "danger");
  $("#accRoom").classList.toggle("warn", level === "warn");
  $("#accRoomDt").title = t("Quanto possono muoversi tutte le posizioni cross contro di te prima della liquidazione");
  $("#accLevDt").title = t("Valore delle posizioni diviso il capitale");
  show("#accUpnl", account.positions.length > 0);
  if (now.level) pill.dataset.margin = now.level; else delete pill.dataset.margin;
  renderTicketMargin(now, marginView.ticket ? marginState(account, marginView.ticket) : now);
}

// the same answer inside the ticket, which is where the decision is taken (and on a phone the card is far below)
function renderTicketMargin(now, next) {
  const row = $("#tkAcct"), room = $("#tkRoom");
  const moved = marginView.ticket && Math.abs(next.delta) > 1e-9;
  row.classList.toggle("hidden", !moved);
  room.classList.add("hidden");
  if (!moved) return;
  const short = next.free < 0 && next.delta > 0;
  row.textContent = short ? t("Mancano {x}", { x: fusd(-next.free) }) : fromTo(now.usedPct, next.usedPct, fpctUsed);
  row.className = short || next.usedPct > 100 ? "down" : "";
  // only when it's worth a thought
  if (next.room == null || (next.delta > 0 && !next.level && next.room >= 0.1) || (next.delta <= 0 && !now.level)) return;
  room.classList.remove("hidden");
  room.textContent = fromTo(now.room, next.room, froom);
  room.className = next.level === "danger" ? "down" : next.level === "warn" ? "warn" : "";
}

function setTicketMargin(change) {
  marginView.ticket = change;
  renderMargin();
}

// ================= account / bottom tables =================
function renderAccount() {
  renderNetBadge();
  renderAccountHead();
  const has = !!account;
  const liveInfo = Live.on && Live.info();
  $("#accEq").textContent = has ? account.total_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const upnl = has ? account.positions.reduce((s, p) => s + p.upnl, 0) : null;
  const u = $("#accUpnl");
  u.textContent = has ? fusd(upnl) : "—";
  u.className = has ? cls(upnl) : "";
  const perOrder = info.limits && info.limits.on && info.limits.on.per_order_pct && info.limits.per_order_pct;
  $("#accLimit").classList.toggle("hidden", !perOrder);
  $("#accLimitDt").classList.toggle("hidden", !perOrder);
  $("#accLimit").textContent = perOrder ? `${perOrder}%${has ? " · " + fusd((account.total_value * perOrder) / 100, 0) : ""}` : "—";
  // Paper / Live, in the top bar and, in paper only, on the account card: the whole pill amber in paper and green
  // in live, the dot on the side in use; the two buttons stay, so the mouse never loses them
  const liveAcct = liveInfo ? liveInfo.account_index : info.trading && !Paper.on ? info.account_index : null;
  $("#accSwitch").classList.toggle("hidden", !Paper.on);
  for (const el of $$(".acct-split")) {
    const pb = el.querySelector('[data-acct="paper"]'), lb = el.querySelector('[data-acct="live"]');
    el.classList.toggle("is-paper", Paper.on);
    el.classList.toggle("is-live", !Paper.on && liveAcct != null);
    pb.classList.toggle("active", Paper.on);
    lb.classList.toggle("active", !Paper.on);
    lb.querySelector(".dot").classList.toggle("off", Paper.on || liveAcct == null);
    lb.disabled = paperOnly();
    pb.title = Paper.on ? t("Paper trading: ricomincia o passa al live") : t("Passa al paper trading");
    lb.title = paperOnly() ? t("Il trading reale arriva presto") : liveAcct != null
      ? t("Account #{n}", { n: liveAcct }) + (has ? " · " + fusd(account.total_value, 0) : "") : Paper.on ? t("Passa al live") : t("Collega un'API key");
  }
  const pill = $("#accountPill");
  pill.classList.toggle("muted", !info.trading);
  if (info.trading && !$("#keyModal").classList.contains("hidden")) renderKeyEquity();
  if (Paper.on && !$("#paperModal").classList.contains("hidden")) renderPaperModal();
  renderPositions();
  renderTicket();
  renderMargin();
  panels.forEach((p) => p.drawLines());
}

// the position's own TP and SL: reduce-only trigger orders that close it, nearest to the price if there
// are several (the managed trailing stop has its own column)
function positionStops(p) {
  const m = byId[p.market_id], s = stops[p.market_id], tick = 10 ** -decimals(m);
  const mark = prices[p.market_id] ? prices[p.market_id].mark : p.entry;
  const out = {};
  for (const o of openOrders[p.market_id] || []) {
    const kind = orderKind(o);
    if ((kind !== "SL" && kind !== "TP") || o.is_ask !== p.size > 0) continue;
    if (kind === "SL" && s && s.stop && Math.abs(o.trigger_price - s.stop) < tick * 1.5) continue;
    const k = kind.toLowerCase(), cur = out[k];
    if (!cur || Math.abs(o.trigger_price - mark) < Math.abs(cur.trigger_price - mark)) out[k] = o;
  }
  return out;
}

function sltpCell(p, m) {
  const st = positionStops(p);
  const one = (k) => `<button class="sltp-v ${k}${st[k] ? "" : " none"}" data-psl="${p.market_id}:${k}">${st[k] ? fp(st[k].trigger_price, m) : "—"}</button>`;
  const x = exits[p.market_id];
  const steps = x ? `<small class="tp-step" title="${t("Uscite scalari: livelli eseguiti")}">TP ${x.levels.filter((l) => l.done).length}/${x.levels.length}</small>${runsIcon("auto")}` : "";
  return `${steps}${one("tp")}<span class="sltp-sep">/</span>${one("sl")}`;
}

// TP / SL from the positions table: a small window over the cell with 25 / 50 / 75 / 100% of the initial margin
// (leverage included, as the PnL column counts it), a slider and the price itself; Enter saves, Esc closes,
// Remove (or an empty price) takes the order away
let posEdit = null; // a pair's stop being typed in its row
const sltpPop = { mid: null, k: null, exec: "market", limitTyped: false };
// Market or Limit, remembered for TP and SL apart
let sltpExecPref = load("sltpExec", { tp: "market", sl: "market" });
function sltpPos() { return account && sltpPop.mid != null && account.positions.find((x) => x.market_id === sltpPop.mid); }
// what a % of the initial margin means for this position: the price that gives it, and back
function sltpMath(p) {
  const m = byId[p.market_id], lev = p.leverage || (m && m.default_leverage) || 1;
  const dir = (p.size > 0 ? 1 : -1) * (sltpPop.k === "tp" ? 1 : -1);
  return {
    m,
    price: (pct) => +(p.entry * (1 + (dir * pct) / 100 / lev)).toFixed(decimals(m)),
    pct: (price) => ((price / p.entry - 1) * lev * 100) / dir,
  };
}
function openSltpPop(btn) {
  const [mid, k] = btn.dataset.psl.split(":");
  sltpPop.mid = +mid; sltpPop.k = k;
  const p = sltpPos();
  if (!p) return;
  const cur = positionStops(p)[k], m = byId[p.market_id];
  const pop = $("#sltpPop");
  pop.classList.toggle("sl", k === "sl");
  $("#sltpPopTitle").textContent = `${k === "tp" ? "Take profit" : "Stop loss"} · ${m.symbol}`;
  $("#sltpChips").innerHTML = [25, 50, 75, 100].map((x) => `<button type="button" data-sltppct="${x}">${k === "tp" ? "+" : "−"}${x}%</button>`).join("");
  $("#sltpPrice").value = cur ? cur.trigger_price : "";
  // an existing order keeps its own execution, its limit price too
  sltpPop.exec = cur ? (/limit/i.test(cur.type) ? "limit" : "market") : sltpExecPref[k] || "market";
  sltpPop.limitTyped = !!(cur && sltpPop.exec === "limit" && cur.price && cur.price !== cur.trigger_price);
  $("#sltpLimit").value = cur && sltpPop.exec === "limit" ? cur.price || cur.trigger_price : "";
  sltpExecShow();
  $("#sltpPopRemove").classList.toggle("hidden", !cur);
  $("#sltpPopError").classList.add("hidden");
  sltpFromPrice();
  pop.classList.remove("hidden");
  // above the cell, kept inside the window
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12)) + "px";
  pop.style.top = Math.max(12, Math.min(r.top - h - 8 < 12 ? r.bottom + 8 : r.top - h - 8, innerHeight - h - 12)) + "px";
}
function closeSltpPop() { $("#sltpPop").classList.add("hidden"); sltpPop.mid = null; }
function sltpExecShow() {
  const lim = sltpPop.exec === "limit";
  $$("#sltpExec button").forEach((b) => b.classList.toggle("active", b.dataset.exec === sltpPop.exec));
  $("#sltpLimitRow").classList.toggle("hidden", !lim);
  $("#sltpPriceLabel").textContent = lim ? "Trigger" : t("Prezzo");
}
// until a limit is typed, it follows the trigger
function sltpLimitFollow() {
  if (sltpPop.exec === "limit" && !sltpPop.limitTyped) $("#sltpLimit").value = $("#sltpPrice").value;
}
// a % chosen (chip, slider or box): the price from it
function sltpSetPct(pct, fromBox) {
  const p = sltpPos();
  if (!p) return;
  if (!fromBox) $("#sltpPctIn").value = pct ? +pct.toFixed(1) : "";
  $("#sltpPrice").value = pct > 0 ? sltpMath(p).price(pct) : "";
  sltpLimitFollow();
  sltpShow(pct);
}
// a price typed: the % from it
function sltpFromPrice() {
  const p = sltpPos(), price = +$("#sltpPrice").value;
  const pct = p && price > 0 ? sltpMath(p).pct(price) : 0;
  $("#sltpPctIn").value = price > 0 ? +pct.toFixed(1) : "";
  sltpLimitFollow();
  sltpShow(pct);
}
function sltpShow(pct) {
  const p = sltpPos();
  if (!p) return;
  const m = byId[p.market_id], k = sltpPop.k, price = +$("#sltpPrice").value;
  const sl = $("#sltpPct");
  sl.value = Math.max(0, Math.min(100, pct || 0));
  sl.style.setProperty("--p", sl.value + "%");
  $$("#sltpChips button").forEach((b) => b.classList.toggle("on", price > 0 && Math.abs(+b.dataset.sltppct - pct) < 0.05));
  const mark = prices[p.market_id] ? prices[p.market_id].mark : p.entry, long = p.size > 0;
  // a TP on the wrong side of the price, or a SL the price has already passed, would trigger at once
  const now = price > 0 && (k === "tp" ? (long ? price <= mark : price >= mark) : (long ? price >= mark : price <= mark));
  const pastLiq = k === "sl" && price > 0 && p.liq && (long ? price <= p.liq : price >= p.liq);
  const limit = sltpPop.exec === "limit" ? +$("#sltpLimit").value : 0;
  const usd = price > 0 ? ((limit > 0 ? limit : price) - p.entry) * p.size : 0;
  const out = $("#sltpUsd");
  out.textContent = price > 0 ? `${usd >= 0 ? "+" : "−"}${fusd(Math.abs(usd))}` : fusd(0); // no price yet: $0.00, muted
  out.className = "sltp-usd " + (!(price > 0) ? "zero" : usd >= 0 ? "up" : "down");
  $("#sltpInfo").innerHTML = !(price > 0) ? ""
    : (now ? `<div class="warn">${t("Si attiverebbe subito: il prezzo è già oltre.")}</div>` : "")
      + (pastLiq ? `<div class="warn">${t("Oltre la liquidazione ({price}): la posizione verrebbe liquidata prima.", { price: fp(p.liq, m) })}</div>` : "");
  // the result line and its warnings make it taller: still inside the window
  const pop = $("#sltpPop"), over = pop.getBoundingClientRect().bottom - (innerHeight - 12);
  if (over > 0 && !pop.classList.contains("hidden")) pop.style.top = Math.max(12, parseFloat(pop.style.top) - over) + "px";
}
async function saveSltp(remove) {
  const p = sltpPos();
  if (!p) return closeSltpPop();
  const k = sltpPop.k, cur = positionStops(p)[k], price = remove ? 0 : +$("#sltpPrice").value;
  const lim = sltpPop.exec === "limit", limit = lim ? +$("#sltpLimit").value || price : null;
  const curLim = cur && /limit/i.test(cur.type);
  if (!price && !cur) return closeSltpPop();
  if (cur && price && price === cur.trigger_price && lim === curLim && (!lim || limit === cur.price)) return closeSltpPop(); // nothing changed
  const mid = p.market_id;
  $("#sltpPopSave").disabled = true;
  try {
    // a limit one, or a change between market and limit, replaces the order; a market one just moves
    await api("/position_sltp", { method: "POST", body: JSON.stringify({ market_id: mid, kind: k, price: price || null, order_index: cur ? cur.order_index : null,
      limit_price: price && lim ? limit : null, replace: !!(cur && price && (lim || curLim)) }) });
    if (price) { sltpExecPref[k] = sltpPop.exec; store("sltpExec", sltpExecPref); }
    toast(price ? t("{kind} a {price}", { kind: k.toUpperCase(), price: fp(price, byId[mid]) }) : t("{kind} rimosso", { kind: k.toUpperCase() }));
    closeSltpPop();
    await fetchOpenOrders(true).catch(() => {});
    renderPositions();
  } catch (err) { $("#sltpPopError").textContent = err.message; $("#sltpPopError").classList.remove("hidden"); }
  $("#sltpPopSave").disabled = false;
}
function wireSltpPop() {
  $("#sltpChips").onclick = (e) => { const b = e.target.closest("[data-sltppct]"); if (b) sltpSetPct(+b.dataset.sltppct); };
  $("#sltpPct").oninput = (e) => sltpSetPct(+e.target.value);
  $("#sltpPctIn").oninput = (e) => sltpSetPct(+e.target.value, true);
  $("#sltpPrice").oninput = sltpFromPrice;
  $("#sltpExec").onclick = (e) => {
    const b = e.target.closest("[data-exec]");
    if (!b) return;
    sltpPop.exec = b.dataset.exec;
    sltpPop.limitTyped = false;
    sltpLimitFollow();
    sltpExecShow();
    sltpFromPrice();
  };
  $("#sltpLimit").oninput = () => { sltpPop.limitTyped = $("#sltpLimit").value !== ""; sltpFromPrice(); };
  $("#sltpPopClose").onclick = closeSltpPop;
  $("#sltpPopSave").onclick = () => saveSltp(false);
  $("#sltpPopRemove").onclick = () => saveSltp(true);
  $("#sltpPop").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveSltp(false); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSltpPop(); });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#sltpPop, [data-psl]")) closeSltpPop(); });
}

// a button pressed in the positions table: the prices redraw the table several times a second, and a button
// swapped between press and release loses its click (a close that asks OK? twice); the redraw waits for it
let posPress = null; // { pending }
function wirePosPress() {
  $("#btab-positions").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) posPress = { pending: false }; });
  const release = () => {
    const p = posPress;
    if (!p) return;
    setTimeout(() => { // after the click that follows the release
      if (posPress !== p) return;
      posPress = null;
      if (p.pending) renderPositions();
    }, 0);
  };
  addEventListener("pointerup", release, true);
  addEventListener("pointercancel", release, true);
}
function renderPositions() {
  if (posEdit) return; // don't rebuild the row under a TP/SL being typed
  if (posPress) { posPress.pending = true; return; }
  const box = $("#btab-positions");
  const list = account ? account.positions : [];
  $("#posCount").textContent = list.length; // 0 too: the tabs after it never move
  if (!list.length) {
    box.innerHTML = `<div class="empty">${info.trading ? t("Nessuna posizione aperta.") : t("Sola lettura: collega un'API key per vedere posizioni e ordini.")}</div>`;
    return;
  }
  const sizeOf = (id) => { const p = list.find((x) => x.market_id === id); return p ? p.size : 0; };
  const live = pairs.filter((x) => sizeOf(x.long_id) > 0 && sizeOf(x.short_id) < 0);
  // how much of each market's position belongs to pairs, shown under its size
  const paired = {};
  for (const x of live) { paired[x.long_id] = (paired[x.long_id] || 0) + x.long_qty; paired[x.short_id] = (paired[x.short_id] || 0) + x.short_qty; }
  // a position wholly inside pairs is shown by them; one partly in pairs stays, with how much is paired
  const whole = (p) => paired[p.market_id] && paired[p.market_id] >= Math.abs(p.size) - 10 ** -(byId[p.market_id] ? byId[p.market_id].size_decimals : 8);
  const rows = [...live.map((x) => pairRow(x)), ...list.filter((p) => !whole(p))];
  box.innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th class="r">Size</th><th class="r">${t("Valore")}</th><th class="r" title="${t("Il tuo capitale impegnato: valore all'entrata diviso la leva.")}">${t("Margine")}</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">${t("Liquidazione")}</th><th class="r" title="${t("PnL non realizzato")} · ${t("La percentuale è calcolata sul margine iniziale.")}">PnL</th><th class="r">TP / SL</th><th>${t("Trailing")}</th><th>${t("Chiudi a mercato")}</th><th>${t("Coppia")}</th></tr></thead><tbody>${
    rows.map((p) => {
      if (typeof p === "string") return p; // a pair's own row
      const m = byId[p.market_id];
      const mark = prices[p.market_id] ? prices[p.market_id].mark : 0;
      // PnL % on the initial margin (entry value / leverage), as Lighter and the ticket show it
      const margin = p.leverage ? (Math.abs(p.size) * p.entry) / p.leverage : 0;
      const pct = margin ? (p.upnl / margin) * 100 : 0;
      return `<tr><td class="mk">${gotoBtn(p.symbol)}${p.leverage ? `<span class="mk-lev">${p.leverage}x</span>` : ""}<small class="${p.size > 0 ? "up" : "down"}">${p.size > 0 ? "Long" : "Short"}${marginTag(p)}</small></td>
        <td class="r ${p.size > 0 ? "up" : "down"}">${fsize(p.size, m)}${paired[p.market_id] ? `<small class="pos-lev">${t("di cui {q} in coppia", { q: fsize(paired[p.market_id], m) })}</small>` : ""}</td><td class="r main">${fusd(p.value)}</td>
        <td class="r">${margin ? fusd(margin) : "—"}</td><td class="r">${fp(p.entry, m)}</td><td class="r main">${fp(mark, m)}</td>
        <td class="r liq" title="${p.cross === false ? t("Isolated: si liquida quando la perdita si mangia il margine di questa posizione.") : t("Cross: si liquida solo quando la perdita si mangia il collaterale di tutto l'account, non solo il margine di questa posizione. Per questo può essere molto lontana.")}">${fp(p.liq, m)}</td><td class="r pnl ${cls(p.upnl)}">${fusd(p.upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
        <td class="r sltp">${sltpCell(p, m)}</td>
        <td>${trailButton(p.market_id, m)}</td>
        <td><span class="qbtn">${[25, 50, 75, 100].map((f) => `<button data-close="${p.market_id}" data-f="${f}"${f === 100 ? ` class="all" data-ck="close:${p.market_id}" data-key="F" title="${t("Chiudi tutto · F")}"` : ` data-ck="close:${p.market_id}:${f}"${f === 50 ? ` title="${t("Chiudi metà · H")}"` : ""}`}>${f}%</button>`).join("")}<button class="rev" data-reverse="${p.market_id}" data-ck="reverse:${p.market_id}" data-key="R" title="${t("Reverse: chiude e apre il lato opposto, stessa size · R")}">⇄ Rev<span class="wide-only">erse</span></button></span></td>
        <td class="pair-cell"><button class="pair-add" data-pairfrom="${p.market_id}" title="${t("Fai una coppia con una posizione dal lato opposto")}">+ ${t("Coppia")}</button></td></tr>`;
    }).join("")}</tbody></table>`;
  evenCols(box);
  markConfirm();
}

// A full table spreads the width it doesn't need in proportion to each column's content, and on the side
// its text isn't aligned to, so a wide column (the close buttons) got a far bigger gap than a narrow one.
// Here the spare width goes evenly between the columns, as space after each one: the gaps stay equal and
// still grow and shrink with the window.
// A table that fits except for the few pixels the horizontal bar takes (its last row's bottom padding)
// would get a vertical bar too: those pixels are hidden instead. Checked whenever a tab is redrawn or resized.
// an empty tab (no positions, no orders…) shrinks the panel to its tabs and that one line, and the charts get the
// rest; it goes back to its own height as soon as the tab has something to show
// the arrow at the end of the bottom tabs folds the panel down to its tab row, so the charts get the room;
// the arrow again, or any tab, opens it
function setBottomFold(on) {
  $("#bottom").classList.toggle("folded", on);
  $("#bottomSplit").classList.toggle("folded", on);
  $("#bottomFold").title = t(on ? "Mostra il pannello" : "Nascondi il pannello");
  store("bottomFold", on);
}
function fitBottomEmpty() {
  const b = $$(".btab").find((x) => !x.classList.contains("hidden"));
  const empty = !!b && b.children.length === 1 && b.firstElementChild.classList.contains("empty");
  $("#bottom").classList.toggle("is-empty", empty);
  $("#bottomSplit").classList.toggle("is-empty", empty);
}
function fitBtabY(b) {
  const over = b.scrollHeight - b.clientHeight;
  b.classList.toggle("fit-y", over > 0 && over <= 10);
}
function wireBtabY() {
  $$(".btab").forEach((b) => {
    new ResizeObserver(() => fitBtabY(b)).observe(b);
    new MutationObserver(() => { fitBtabY(b); fitBottomEmpty(); }).observe(b, { childList: true });
    // a table wider than the panel scrolls sideways with the mouse wheel, unless it has rows to scroll down to
    b.addEventListener("wheel", (e) => {
      if (e.shiftKey || b.scrollWidth <= b.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a sideways swipe scrolls by itself
      if (!b.classList.contains("fit-y") && b.scrollHeight > b.clientHeight) return;
      e.preventDefault();
      b.scrollLeft += e.deltaY;
    }, { passive: false });
  });
}

let evenColsRO = null;
const evenColsMax = {};
const WIDE_SPARE = 12; // the roomier positions layout once every gap still gets this much more
function evenCols(box) {
  if (!evenColsRO) { evenColsRO = new ResizeObserver(() => evenCols(box)); evenColsRO.observe(box); }
  const tb = box.querySelector("table");
  if (!tb || !tb.tHead) return;
  const ths = [...tb.tHead.rows[0].cells];
  tb.classList.remove("even", "wide");
  ths.forEach((th) => (th.style.width = ""));
  if (getComputedStyle(tb.tHead).display === "none") return; // the phone's cards have no columns
  // each column's own width, the table as wide as its content
  const measure = () => {
    tb.style.width = "max-content";
    const w = ths.map((th) => th.getBoundingClientRect().width);
    tb.style.width = "";
    return w;
  };
  const room = (w) => box.clientWidth - w.reduce((a, b) => a + b, 0) - 1;
  // with room to spare, the roomier layout: side and margin on the market's line, PnL $ and % on one line,
  // Reverse in full and the shortcut keys on their buttons
  // a column keeps the widest it has been (in each layout), so opening or closing a position, or a price
  // with one more digit, doesn't nudge the titles after it; unless that would no longer fit
  const keep = (w, mode) => {
    const k = (evenColsMax[mode] ||= []);
    if (k.length !== w.length) k.length = 0;
    const kept = w.map((x, i) => Math.max(x, k[i] || 0));
    if (room(kept) < 0) { w.forEach((x, i) => (k[i] = x)); return w; }
    kept.forEach((x, i) => (k[i] = x));
    return kept;
  };
  tb.classList.add("wide");
  let nat = measure();
  if (room(nat) < WIDE_SPARE * (ths.length - 1)) { tb.classList.remove("wide"); nat = keep(measure(), "compact"); }
  else nat = keep(nat, "wide");
  const extra = room(nat);
  if (extra <= 0 || ths.length < 2) return;
  ths.forEach((th, i) => {
    const cs = getComputedStyle(th);
    th.style.width = `${nat[i] - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
  });
  tb.style.setProperty("--even", `${extra / (ths.length - 1)}px`);
  tb.classList.add("even");
}

// Cross or isolated next to the side: with cross, all the account's collateral backs the position, so
// its liquidation price can be far away; easy to misread as an isolated trade
function marginTag(p) {
  if (p.cross === undefined || p.cross === null) return "";
  return p.cross === false
    ? `<span class="mode-tag iso" title="${t("Isolated: si liquida quando la perdita si mangia il margine di questa posizione.")}">${t("Isolated")}</span>`
    : `<span class="mode-tag" title="${t("Cross: si liquida solo quando la perdita si mangia il collaterale di tutto l'account, non solo il margine di questa posizione. Per questo può essere molto lontana.")}">${t("Cross")}</span>`;
}

// ---------- pairs: a long and a short position that go together ----------
let pairs = [];
const pairPrice = (m) => { const q = prices[m.id]; return q ? q.mark || q.last : null; };

// The pair's own row and its two legs: each leg is the pair's quantity at the pair's entry price (the
// market's whole position can be bigger), so PnL, value and margin are the pair's alone. Funding per hour
// for the two together: the long pays a positive rate, the short receives it.
function pairRow(x) {
  const ml = byId[x.long_id], ms = byId[x.short_id];
  if (!ml || !ms) return "";
  const lev = (m) => { const s = account && account.settings && account.settings[m.id]; return (s && s.leverage) || m.default_leverage || 1; };
  const pl = pairPrice(ml), ps = pairPrice(ms);
  const legs = [[ml, x.long_qty, x.long_entry, pl, 1], [ms, x.short_qty, x.short_entry, ps, -1]].map(([m, qty, entry, mark, side]) =>
    ({ m, qty, entry, mark, side, value: qty * (mark || entry), margin: qty * entry / lev(m), upnl: mark ? (mark - entry) * qty * side : 0 }));
  const sum = (k) => legs[0][k] + legs[1][k];
  const margin = sum("margin"), upnl = sum("upnl"), pct = margin ? (upnl / margin) * 100 : 0;
  const entry = x.long_entry / x.short_entry, now = pl && ps ? pl / ps : null;
  const fmt = (r) => (r ? fp(r, { price_decimals: ratioDecimals(r) }) : "—");
  const fl = prices[ml.id] ? prices[ml.id].funding : 0, fs = prices[ms.id] ? prices[ms.id].funding : 0;
  const fundH = (-legs[0].value * fl + legs[1].value * fs) / 100;
  const sym = `${ml.symbol}/${ms.symbol}`;
  // a pair has no liquidation price of its own: each leg's position has one; the row shows the nearer
  const liqOf = (m) => { const p = account && account.positions.find((x) => x.market_id === m.id); return p && p.liq ? p.liq : null; };
  const gap = (g) => { const l = liqOf(g.m); return l && g.mark ? { m: g.m, pct: Math.abs(g.mark - l) / g.mark * 100 } : null; };
  const near = legs.map(gap).filter(Boolean).sort((a, b) => a.pct - b.pct)[0];
  const legRow = (g) => `<tr class="leg"><td class="mk">${esc(g.m.symbol)}<small class="${g.side > 0 ? "up" : "down"}">${g.side > 0 ? "Long" : "Short"}</small></td>
    <td class="r ${g.side > 0 ? "up" : "down"}">${fsize(g.qty, g.m)}</td><td class="r">${fusd(g.value)}</td><td class="r">${fusd(g.margin)}</td>
    <td class="r">${fp(g.entry, g.m)}</td><td class="r">${fp(g.mark, g.m)}</td><td class="r liq">${fp(liqOf(g.m), g.m)}</td><td class="r pnl ${cls(g.upnl)}">${fusd(g.upnl)}</td><td></td><td></td><td></td><td></td></tr>`;
  const stop = (k) => `<button class="sltp-v ${k}${x[k] ? "" : " none"}" data-pstop="${x.id}:${k}" title="${t(k === "tp" ? "Take-profit della coppia sul rapporto" : "Stop-loss della coppia sul rapporto")}">${x[k] ? fmt(x[k]) : "—"}</button>`;
  return `<tr class="pair-row"><td class="mk">${gotoBtn(sym)}<small class="up">${t("Coppia")}</small></td>
    <td class="r"><span class="up">L ${esc(ml.symbol)}</span> / <span class="down">S ${esc(ms.symbol)}</span></td>
    <td class="r main">${fusd(sum("value"))}<small class="pos-lev" title="${t("Funding all'ora delle due gambe insieme")}">funding ${fsmall(fundH)}/h</small></td>
    <td class="r">${margin ? fusd(margin) : "—"}</td><td class="r" title="${t("Rapporto all'entrata")}">${fmt(entry)}</td><td class="r main" title="${t("Rapporto attuale")}">${fmt(now)}</td>
    <td class="r liq" title="${t("La liquidazione più vicina fra le due gambe")}">${near ? `<span class="${near.pct < BADGE_LIQ ? "down" : ""}">${near.pct > 100 ? "> 100%" : near.pct.toFixed(1) + "%"}</span><small class="pos-lev">${esc(near.m.symbol)}</small>` : "—"}</td>
    <td class="r pnl ${cls(upnl)}">${fusd(upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
    <td class="r sltp">${stop("tp")}<span class="sltp-sep">/</span>${stop("sl")}</td><td></td>
    <td><span class="qbtn">${[50, 100].map((f) => `<button data-pclose="${x.id}" data-f="${f}" class="${f === 100 ? "all" : ""}" data-ck="pclose:${x.id}${f === 100 ? "" : ":" + f}">${f}%</button>`).join("")}<button class="unpair" data-unpair="${x.id}" title="${t("Separa: le due posizioni restano aperte, non più come coppia")}">${t("Separa")}</button></span></td><td></td></tr>`
    + legs.map(legRow).join("");
}

// "+ Pair" on a position: the positions on the other side it can pair with (a pair is one long and one
// short), each with what it still has outside other pairs; or, with none, a spread to open from its chart
function openPairGroup(anchor, mid) {
  const list = account ? account.positions : [], me = list.find((p) => p.market_id === mid);
  if (!me) return;
  const taken = {};
  for (const x of pairs) { taken[x.long_id] = (taken[x.long_id] || 0) + x.long_qty; taken[x.short_id] = (taken[x.short_id] || 0) + x.short_qty; }
  const free = (p) => Math.abs(p.size) - (taken[p.market_id] || 0) > 10 ** -((byId[p.market_id] || {}).size_decimals || 8);
  const others = free(me) ? list.filter((p) => Math.sign(p.size) === -Math.sign(me.size) && free(p)) : [];
  const pop = $("#pairGroupPop"), long = me.size > 0;
  const label = (o) => (long ? [me, o] : [o, me]);
  pop.innerHTML = `<div class="caps muted">${t("Coppia con {sym} {side}", { sym: esc(me.symbol), side: long ? "Long" : "Short" })}</div>` + (others.length
    ? others.map((o) => { const [l, s] = label(o); return `<button data-group="${l.market_id}:${s.market_id}"><span class="up">Long ${esc(l.symbol)}</span> / <span class="down">Short ${esc(s.symbol)}</span></button>`; }).join("")
    : `<p class="hint">${free(me) ? t("Una coppia è un long e uno short: non hai posizioni {side} da abbinare.", { side: long ? "short" : "long" }) : t("{sym} è già tutta in coppia.", { sym: esc(me.symbol) })}</p>`)
    + `<button class="pair-spread" data-spreadfrom="${esc(me.symbol)}">÷ ${t("Apri uno spread {sym}/…", { sym: esc(me.symbol) })}</button>`;
  pop.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 12) + "px";
  pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + "px";
}

// money too small for cents: "<$0.01" with its sign instead of "$0.00"
const fsmall = (v) => (!v ? "$0" : Math.abs(v) < 0.01 ? `${v < 0 ? "−" : "+"}<$0.01` : fsigned(v));

// SL/TP of a pair on its ratio: typed in the row, dragged on the spread chart or set from its right-click menu
async function setPairStop(id, k, value) {
  const x = pairs.find((p) => p.id === id);
  if (!x) return;
  const body = { sl: x.sl || null, tp: x.tp || null, [k]: value || null };
  try {
    const res = await api(`/pairs/${encodeURIComponent(id)}/stops`, { method: "PUT", body: JSON.stringify(body) });
    pairs = res.pairs;
    toast(value ? t("{kind} della coppia a {r}", { kind: k.toUpperCase(), r: +(+value).toPrecision(6) }) + (res.armed ? "" : " · " + t("parte quando attivi Auto"))
      : t("{kind} della coppia rimosso", { kind: k.toUpperCase() }));
  } catch (err) { toast(err.message, true); }
  renderPositions();
  panels.forEach((p) => p.drawLines());
}

function editPairStop(btn) {
  const [id, k] = btn.dataset.pstop.split(":");
  const x = pairs.find((p) => p.id === id);
  if (!x) return;
  posEdit = { pair: id, k };
  const input = document.createElement("input");
  input.className = "sltp-in " + k;
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.placeholder = k.toUpperCase();
  input.value = x[k] || "";
  btn.replaceWith(input);
  input.focus();
  input.select();
  const end = () => { posEdit = null; renderPositions(); };
  input.onkeydown = async (e) => {
    if (e.key === "Escape") return end();
    if (e.key !== "Enter") return;
    const v = +input.value.trim();
    input.onblur = null;
    posEdit = null;
    if ((!v && !x[k]) || v === x[k]) return end();
    await setPairStop(id, k, v || null);
  };
  input.onblur = end;
}

async function loadPairs() {
  if (!info.trading) { pairs = []; return; }
  const list = await api("/pairs").catch(() => null);
  if (list && JSON.stringify(list) !== JSON.stringify(pairs)) { pairs = list; renderPositions(); }
}

async function closePair(id, f) {
  try {
    await api(`/pairs/${encodeURIComponent(id)}/close?fraction=${f / 100}`, { method: "POST" });
    toast(t("Chiusura {f}% della coppia: ordini accettati", { f }), "ok");
  } catch (err) { toast(err.message, true); }
  loadOrders(true);
}

// open orders on the markets in use (positions + charts); fresh skips the server's few-second cache
async function fetchOpenOrders(fresh = false) {
  if (!info.trading) { openOrders = {}; panels.forEach((p) => p.drawLines()); return []; }
  const ids = new Set([...(account ? account.positions.map((p) => p.market_id) : []), ...panelCfg.map((c) => bySymbol[c.symbol] && bySymbol[c.symbol].id)].filter((x) => x !== undefined));
  const list = await api(`/open_orders?market_ids=${[...ids].join(",")}${fresh ? "&fresh=1" : ""}`);
  openOrders = {};
  for (const o of list) (openOrders[o.market_id] ||= []).push(o);
  renderTicketMode();
  panels.forEach((p) => { p.drawLines(); p.loadFills(fresh); });
  await loadPairs();
  panels.forEach((p) => p.pair && p.drawLines());
  renderPositions();
  return list;
}

async function loadOrders(fresh = false) {
  const box = $("#btab-orders");
  if (!info.trading) { box.innerHTML = `<div class="empty">${t("Sola lettura.")}</div>`; fetchOpenOrders(); return; }
  const orders = await fetchOpenOrders(fresh).catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; });
  if (!orders) return;
  if (!orders.length) { box.innerHTML = `<div class="empty">${t("Nessun ordine aperto sui mercati in uso.")}</div>`; return; }
  box.innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th>${t("Tipo")}</th><th>${t("Lato")}</th><th class="r">${t("Prezzo")}</th><th class="r">Trigger</th><th class="r">${t("Size residua")}</th><th>Reduce only</th><th></th></tr></thead><tbody>${
    orders.map((o) => {
      const m = byId[o.market_id];
      return `<tr><td class="mk">${gotoBtn(o.symbol)}</td><td>${workingOf(o) ? `${orderKind(o)} · ${+workingOf(o).filled}/${+workingOf(o).qty}${runsIcon("auto")}` : esc(o.type)}</td><td class="${o.is_ask ? "down" : "up"}">${o.is_ask ? "Sell" : "Buy"}</td>
        <td class="r">${fp(o.price, m)}</td><td class="r">${o.trigger_price ? fp(o.trigger_price, m) : "—"}</td><td class="r">${fsize(o.remaining, m)}</td>
        <td>${o.reduce_only ? t("sì") : "—"}</td><td class="r"><button class="xbtn" data-cancel="${o.market_id}:${o.order_index}" data-ck="cancel:${o.market_id}:${o.order_index}">${t("Annulla")}</button></td></tr>`;
    }).join("")}</tbody></table>`;
}

async function loadTrades() {
  const box = $("#btab-trades");
  if (!info.trading) { box.innerHTML = `<div class="empty">${t("Sola lettura.")}</div>`; return; }
  const trades = await api("/trades").catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; });
  if (!trades) return;
  if (!trades.length) { box.innerHTML = `<div class="empty">${t("Nessun trade recente.")}</div>`; return; }
  loadTrades.last = trades;
  renderTrades();
}

// what the positions paid (−) or received (+) at each hourly funding: a total per market on top, then the payments
async function loadFundingPaid() {
  const box = $("#btab-funding");
  if (!info.trading) { box.innerHTML = `<div class="empty">${t("Sola lettura.")}</div>`; return; }
  const rows = await api("/funding_history").catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; });
  if (!rows) return;
  if (!rows.length) { box.innerHTML = `<div class="empty">${t("Nessun pagamento di funding: arriva ogni ora sulle posizioni aperte.")}</div>`; return; }
  const time = (ts) => new Date(ts).toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const per = {};
  for (const r of rows) per[r.symbol] = (per[r.symbol] || 0) + r.change;
  const total = rows.reduce((s, r) => s + r.change, 0);
  const since = time(rows[rows.length - 1].ts);
  box.innerHTML = `<div class="btab-bar"><span class="muted">${rows.length === 1 ? t("1 pagamento dal {t}", { t: since }) : t("{n} pagamenti dal {t}", { n: rows.length, t: since })} · ${t("totale")} <b class="${cls(total)}">${fsigned(total)}</b></span>
    <span class="fund-per">${Object.entries(per).sort((a, b) => a[1] - b[1]).map(([sym, v]) => `<span>${esc(sym)} <b class="${cls(v)}">${fsigned(v)}</b></span>`).join("")}</span></div>
    <table class="table"><thead><tr><th>${t("Ora")}</th><th>${t("Mercato")}</th><th>${t("Lato")}</th><th class="r">Size</th><th class="r" title="${t("Tasso dell'ora: positivo quando i long pagano gli short")}">${t("Tasso")}</th><th class="r">${t("Pagato / ricevuto")}</th></tr></thead><tbody>${
    rows.map((r) => {
      const m = byId[r.market_id];
      return `<tr><td>${time(r.ts)}${r.hours > 1 ? ` <span class="fills">× ${r.hours}h</span>` : ""}</td><td class="mk">${gotoBtn(r.symbol)}</td>
        <td class="${r.side === "long" ? "up" : "down"}">${r.side === "long" ? "Long" : "Short"}</td><td class="r">${m ? fsize(r.size, m) : r.size}</td>
        <td class="r">${fpctf(r.rate)}</td><td class="r main ${cls(r.change)}">${fsigned(r.change)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

// a market's name in the bottom tables: a click brings up its chart, the one already showing it if any
const gotoBtn = (sym) => `<button class="goto" data-goto="${esc(sym)}" title="${t("Apri il grafico di {sym}", { sym: esc(sym) })}">${esc(sym)}</button>`;

function goToMarket(sym) {
  if (!bySymbol[sym] && !pairOf(sym)) return;
  const shown = panels.find((p) => panelCfg[p.idx].symbol === sym);
  if (shown) setActive(shown.idx);
  else setSymbol(sym);
}

// fills of the same order merged into one row: total size, average price, summed value and PnL
function aggregateTrades(fills) {
  const byOrder = new Map();
  for (const f of fills) {
    const key = `${f.market_id}:${f.side}:${f.order_id ?? f.ts}`;
    const g = byOrder.get(key);
    if (!g) { byOrder.set(key, { ...f, fills: 1, first: f.ts, roles: new Set([f.role]) }); continue; }
    g.fills += 1;
    g.size += f.size;
    g.usd += f.usd;
    g.pnl += f.pnl;
    g.ts = Math.max(g.ts, f.ts);
    g.first = Math.min(g.first, f.ts);
    g.roles.add(f.role);
  }
  return [...byOrder.values()].map((g) => ({ ...g, price: g.size ? g.usd / g.size : g.price, role: g.roles.size > 1 ? "maker + taker" : g.role }));
}

function renderTrades() {
  const box = $("#btab-trades"), fills = loadTrades.last;
  if (!fills) return;
  const split = load("tradesSplit", false);
  const rows = split ? fills : aggregateTrades(fills);
  const time = (ts) => new Date(ts).toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  box.innerHTML = `<div class="btab-bar"><span class="muted">${split ? t("{n} fill", { n: fills.length }) : t("{n} ordini da {f} fill", { n: rows.length, f: fills.length })}</span>
    <div class="seg" id="tradesMode"><button data-split="0" class="${split ? "" : "active"}">${t("Aggregati")}</button><button data-split="1" class="${split ? "active" : ""}">${t("Fill singoli")}</button></div></div>
    <table class="table"><thead><tr><th>${t("Ora")}</th><th>${t("Mercato")}</th><th>${t("Lato")}</th><th class="r">Size</th><th class="r">${split ? t("Prezzo") : t("Prezzo medio")}</th><th class="r">${t("Valore")}</th><th>${t("Ruolo")}</th><th class="r" title="${t("Calcolato da LighterDeck dal prezzo medio di entrata: commissioni e funding esclusi. — per i fill che aprono o aumentano la posizione.")}">${t("PnL realizzato")}</th></tr></thead><tbody>${
    rows.map((r) => {
      const m = byId[r.market_id];
      const count = !split && r.fills > 1 ? `<span class="fills" title="${t("Primo fill: {t}", { t: time(r.first) })}">${t("{n} fill", { n: r.fills })}</span>` : "";
      return `<tr><td>${time(r.ts)}</td>
        <td class="mk">${gotoBtn(r.symbol)}${count}</td><td class="${r.side === "buy" ? "up" : "down"}">${r.side === "buy" ? "Buy" : "Sell"}</td>
        <td class="r main">${fsize(r.size, m)}</td><td class="r">${fp(r.price, m)}</td><td class="r main">${fusd(r.usd)}</td><td>${r.role}</td>
        <td class="r ${r.pnl ? cls(r.pnl) : ""}">${r.pnl ? fusd(r.pnl) : "—"}</td></tr>`;
    }).join("")}</tbody></table>`;
  $("#tradesMode").onclick = (e) => {
    const b = e.target.closest("[data-split]");
    if (b) { store("tradesSplit", b.dataset.split === "1"); renderTrades(); }
  };
}

// ================= calendar =================
// Which events move a market: its own kind of asset (oil reports for WTI) and the currencies it is
// priced in (EUR and USD for EURUSD, USD for everything quoted in dollars).
const MARKET_ASSETS = { WTI: ["oil"], BRENTOIL: ["oil"], NATGAS: ["natgas"],
  // China's data (NBS): its companies and copper (keep in step with MARKET_ASSETS in backend/econ.py)
  ...Object.fromEntries(["BABA", "TENCENT", "XIAOMI", "BYD", "SMIC", "ZHIPU", "MINIMAX", "UNITREE", "CXMT", "POPMART", "XCU"].map((s) => [s, ["china"]])),
  // South Korea's data: its stocks, the EWY ETF and the won
  ...Object.fromEntries(["SAMSUNGUSD", "SKHYNIXUSD", "HYUNDAIUSD", "SKHY", "EWY", "USDKRW"].map((s) => [s, ["korea"]])) };
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "KRW"];
// stocks: their own earnings; ETF and index markets: the earnings of the largest US companies
function marketFocus(sym) {
  const fx = sym.length === 6 && CURRENCIES.includes(sym.slice(0, 3)) && CURRENCIES.includes(sym.slice(3));
  const cats = (bySymbol[sym] && bySymbol[sym].categories) || [];
  const assets = [`sym:${sym}`, ...(MARKET_ASSETS[sym] || []), ...(cats.includes("STOCK") ? [`stock:${sym}`] : []), ...(cats.includes("ETF") ? ["index"] : [])];
  return { assets, ccy: fx ? [sym.slice(0, 3), sym.slice(3)] : ["USD"] };
}
const eventFor = (e, sym) => {
  const f = marketFocus(sym);
  return e.assets && e.assets.length ? e.assets.some((a) => f.assets.includes(a)) : f.ccy.includes(e.country);
};
// a weekly oil report is "Low" for the dollar but high-impact for the oil markets it is about;
// earnings are high for the stock itself, high or medium for the indices depending on the company's size
const IMPACT_RANK = { Low: 0, Medium: 1, High: 2 };
function impactFor(e, sym) {
  const mine = e.assets && sym ? e.assets.filter((a) => marketFocus(sym).assets.includes(a)) : [];
  // a small economy's top release: high for its own currency pairs, medium elsewhere (backend/econ.py rate())
  if (!mine.length) return (e.impact_ccy && sym && marketFocus(sym).ccy.includes(e.country)) ? e.impact_ccy : e.impact;
  return mine.map((a) => (e.impact_by && e.impact_by[a]) || "High").sort((a, b) => IMPACT_RANK[b] - IMPACT_RANK[a])[0];
}
// earnings come with the session only ("before the open"): the time shown is the usual one
const WHEN = { "before the open": "prima dell'apertura", "after the close": "dopo la chiusura", "time not given": "orario non comunicato" };
// "USD · CPI m/m" for a country's release, the title alone for crypto and your own events
const evLabel = (e) => `${e.country ? esc(e.country) + " · " : ""}${esc(e.title)}${e.source && e.source !== "ff" ? `<span class="src">${esc(SOURCES[e.source] ? t(SOURCES[e.source]) : e.source)}</span>` : ""}`;
const SOURCES = { custom: "tuo" };
const eventTime = (e, d) => (e.when === "time not given" ? "—" : (e.approx ? "≈ " : "") + d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }));
const eventDetail = (e) => (e.source === "custom" ? esc((e.markets || []).join(", "))
  : e.source === "Deribit" ? t("scadenza opzioni BTC ed ETH")
  : e.source === "Nasdaq"
  ? `${t(WHEN[e.when] || e.when)} · ${t("stima EPS {f} · anno scorso {p}", { f: esc(e.forecast || "—"), p: esc(e.previous || "—") })}`
  : e.forecast || e.previous ? t("prev. {f} · prec. {p}", { f: esc(e.forecast || "—"), p: esc(e.previous || "—") }) : "");

// Real sessions come from exchange_hours.json (holidays, half-days, lunch breaks; made by
// tools/make_exchange_hours.py); past its last date the plain weekday hours below are used.
const SESSIONS = [
  { name: "Stati Uniti", ex: "NYSE", code: "XNYS", ccy: "USD", tz: "America/New_York", open: [9, 30], close: [16, 0] },
  { name: "Regno Unito", ex: "LSE", code: "XLON", ccy: "GBP", tz: "Europe/London", open: [8, 0], close: [16, 30] },
  { name: "Germania", ex: "Xetra", code: "XETR", ccy: "EUR", tz: "Europe/Berlin", open: [9, 0], close: [17, 30] },
  { name: "Giappone", ex: "TSE", code: "XTKS", ccy: "JPY", tz: "Asia/Tokyo", open: [9, 0], close: [15, 30], lunch: [[11, 30], [12, 30]] },
  { name: "Cina", ex: "SSE Shanghai", code: "XSHG", ccy: "CNY", tz: "Asia/Shanghai", open: [9, 30], close: [15, 0], lunch: [[11, 30], [13, 0]] },
  { name: "Hong Kong", ex: "HKEX", code: "XHKG", ccy: "HKD", tz: "Asia/Hong_Kong", open: [9, 30], close: [16, 0], lunch: [[12, 0], [13, 0]] },
  { name: "Corea del Sud", ex: "KRX", code: "XKRX", ccy: "KRW", tz: "Asia/Seoul", open: [9, 0], close: [15, 30] },
  // the Calendar page only: the trade sidebar keeps the exchanges behind Lighter's markets
  { name: "Australia", ex: "ASX", code: "XASX", ccy: "AUD", tz: "Australia/Sydney", open: [10, 0], close: [16, 0], calOnly: true },
];
let exchangeHours = null;
fetch("exchange_hours.json?v=4").then((r) => r.json()).then((d) => { exchangeHours = d.exchanges; renderSessions(); }).catch(() => {});

function zoned(ts, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
    .formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second, wd: parts.weekday };
}
// UTC ms of a wall-clock time in tz
function wallToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const z = zoned(guess, tz);
    const asUtc = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return guess;
}

// state: "open" (until the lunch break or the close), "lunch" (until trading resumes) or "closed"
// (until the next open; holiday when the exchange is shut on a weekday)
function sessionStatus(s, now) {
  const data = exchangeHours && exchangeHours[s.code];
  let days;
  if (data && now / 1000 < data.until) days = data.sessions.map((x) => x.map((v) => v * 1000));
  else { // plain weekday hours
    days = [];
    for (let dayOff = -1; dayOff < 8; dayOff++) {
      const z = zoned(now + dayOff * 86400000, s.tz);
      if (z.wd === "Sat" || z.wd === "Sun") continue;
      const at = (hm) => wallToUtc(z.y, z.mo, z.d, hm[0], hm[1], s.tz);
      days.push([at(s.open), at(s.close), ...(s.lunch ? [at(s.lunch[0]), at(s.lunch[1])] : [])]);
    }
  }
  for (const [open, close, bs, be] of days) {
    if (now >= close) continue;
    if (now < open) {
      const today = zoned(now, s.tz), next = zoned(open, s.tz);
      const weekday = today.wd !== "Sat" && today.wd !== "Sun";
      const holiday = weekday && (today.y !== next.y || today.mo !== next.mo || today.d !== next.d)
        && !days.some(([o]) => { const z = zoned(o, s.tz); return z.y === today.y && z.mo === today.mo && z.d === today.d; });
      const key = `${today.y}-${pad2(today.mo)}-${pad2(today.d)}`;
      return { state: "closed", at: open, holiday, holidayName: holiday && data && data.holidays ? data.holidays[key] || "" : "" };
    }
    if (bs && now >= bs && now < be) return { state: "lunch", at: be };
    return { state: "open", at: bs && now < bs ? bs : close, lunchNext: !!(bs && now < bs), close };
  }
  return { state: "closed", at: null };
}

// a holiday's name with a small picture when there is a fitting one (first match wins)
const HOLIDAY_EMOJI = [
  [/chinese new year|lunar new year|spring festival|seollal/i, "🐉"], [/^thanksgiving/i, "🦃"], [/chuseok|mid-autumn/i, "🥮"],
  [/halloween/i, "🎃"], [/christmas/i, "🎄"], [/boxing day/i, "🎁"], [/new year's eve|end of year/i, "🥂"], [/new year/i, "🎆"],
  [/good friday|easter/i, "🐣"], [/buddha/i, "🪷"], [/dragon boat/i, "🛶"], [/tomb-sweeping|ching ming|qingming/i, "🌿"],
  [/double ninth|mountain/i, "⛰️"], [/juneteenth|martin luther king/i, "✊"], [/july 4th|^independence day/i, "🎆"],
  [/constitution/i, "📜"], [/memorial day|anzac/i, "🎖️"], [/president/i, "🏛️"], [/labou?r/i, "🛠️"], [/bank holiday/i, "🏦"], [/children/i, "🎏"],
  [/coming of age/i, "👘"], [/emperor|king's birthday/i, "👑"], [/equinox/i, "🍂"], [/marine/i, "🌊"], [/respect for the aged/i, "🍵"],
  [/culture/i, "🎨"], [/sports/i, "🏅"], [/greenery|showa/i, "🌳"], [/australia day/i, "🦘"],
  [/hangul/i, "✍️"], [/national|foundation|liberation|independence|establishment/i, "🎉"],
];
function holidayLabel(name) {
  const hit = HOLIDAY_EMOJI.find(([re]) => re.test(name));
  return (hit ? hit[1] + " " : "") + esc(name);
}

function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}${LANG === "it" ? "g" : "d"} ${h % 24}h`;
}

function renderSessions() {
  const now = Date.now();
  const rank = { open: 0, lunch: 1, closed: 2 };
  const rows = SESSIONS.map((s) => ({ s, st: sessionStatus(s, now) }))
    .sort((a, b) => (rank[a.st.state] - rank[b.st.state]) || (a.st.at - b.st.at));
  const local = (t) => new Date(t).toLocaleString(LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const hm = (t) => new Date(t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  const line = (st) => st.state === "open"
    ? (st.lunchNext ? t("pausa pranzo alle {t} · chiude {c}", { t: hm(st.at), c: hm(st.close) }) : `${t("chiude")} ${local(st.at)}`)
    : st.state === "lunch" ? t("pausa pranzo · riprende {t}", { t: hm(st.at) })
    : `${st.holiday ? (st.holidayName ? holidayLabel(st.holidayName) : t("festività")) + " · " : ""}${t("apre")} ${st.at ? local(st.at) : ""}`;
  // a country's row filters the Calendar page to its releases (Germany: the euro area's)
  const row = ({ s, st }) => `<div class="cal-row${cp.country === s.ccy ? " on" : ""}" data-cc="${s.ccy}" role="button" tabindex="0" title="${t("Solo gli eventi di {c}", { c: t(s.name) })}">
      <div><div class="t">${t(s.name)}</div><div class="s">${s.ex} · ${line(st)}</div></div>
      <div class="w ${st.state === "open" ? "open" : st.state === "lunch" || st.at - now < 3600000 ? "soon" : ""}">${
        st.state === "open" ? t("aperto · {d}", { d: dur(st.at - now) }) : st.state === "lunch" ? t("pausa · {d}", { d: dur(st.at - now) }) : t("tra {d}", { d: dur(st.at - now) })}</div>
    </div>`;
  $("#ctab-sessions").innerHTML = rows.filter((r) => !r.s.calOnly).map(row).join("");
  $("#cpSessions").innerHTML = rows.map(row).join("");
}

// Trade sidebar: the next events that move the selected market; the Calendar page has everything
function renderEcon() {
  const m = activeMarket(), sym = m ? m.symbol : null;
  $("#econMkt").textContent = sym ? t("Prossimi eventi per {sym}", { sym }) : "";
  const now = Date.now() / 1000;
  const keep = (e) => sym && eventFor(e, sym) && ["High", "Medium"].includes(impactFor(e, sym));
  const list = events.filter((e) => e.ts > now - 3 * 3600 && keep(e)).slice(0, 12);
  renderCalPage();
  let lastDay = "";
  $("#econList").innerHTML = list.map((e) => {
    const d = new Date(e.ts * 1000);
    const day = d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "short" });
    const head = day !== lastDay ? `<div class="group">${day}</div>` : "";
    lastDay = day;
    const left = e.ts - now;
    return `${head}<div class="cal-row${left < 0 ? " past" : ""}">
      <div style="min-width:0"><div class="t"><span class="imp ${impactFor(e, sym)}"></span>${evLabel(e)}</div>
      <div class="s">${eventDetail(e)}</div>${evTradeTags(e)}</div>
      <div class="w ${left > 0 && left < 3600 ? "soon" : ""}">${eventTime(e, d)}<div class="s">${left > 0 ? t("tra {d}", { d: dur(left * 1000) }) : ""}${evTradeBtn(e)}${e.source === "custom" ? ` <button class="ev-del" data-delev="${e.id}" data-ck="delev:${e.id}" title="${t("Elimina")}">✕</button>` : ""}</div></div>
    </div>`;
  }).join("") || `<div class="empty">${t("Nessun evento.")}</div>`;
  markConfirm();
}

// ---------- Account page ----------
// equity and margin from the live account; curve, stats, calendar and per-market figures from
// /api/account_stats (Lighter's daily PnL series, which keeps deposits and withdrawals apart)
const acc = { days: load("acc.days", 30), mode: load("acc.mode", "pnl"), month: null, day: null, data: null, mkt: null, chart: null, line: null, cache: {}, mcache: {} };
const fk = (v) => { // +$1.85K
  const a = Math.abs(v), s = v >= 0 ? "+" : "−";
  return a >= 1000 ? `${s}$${(a / 1000).toFixed(a >= 100000 ? 0 : 2)}K` : `${s}$${a.toFixed(a >= 100 ? 0 : 2)}`;
};
const fkShort = (v) => { const a = Math.abs(v), s = v >= 0 ? "+" : "−"; return a >= 1000 ? `${s}${(a / 1000).toFixed(1)}K` : `${s}${Math.round(a)}`; }; // phone cells
const fsigned = (v) => `${v >= 0 ? "+" : "−"}${fusd(Math.abs(v))}`;
const utcDay = (d) => d.toISOString().slice(0, 10);
const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

// stats come first (fast); per-market figures follow; answers are kept per period, so switching
// period shows what is known at once and refreshes behind it, and the other periods are preloaded
async function fetchAccount(days, kind) {
  const path = kind === "stats" ? `/account_stats?days=${days}` : `/account_markets?days=${days}`;
  const box = kind === "stats" ? acc.cache : acc.mcache;
  const d = await api(path);
  box[days] = { at: Date.now(), d };
  return d;
}

// the deck's own key (on the server): equity curve, PnL calendar, per-market stats. Paper or a key in the browser:
// the account's figures, and the latest fills per market
// paper and a key in the browser answer the same calls in the page (paper.js, live.js), so the page is the same
const accLite = () => !(info.trading && !Paper.on) && !!account;
async function loadAccountPage() {
  const deck = !!info.trading && !Paper.on, lite = accLite();
  $("#acEmpty").classList.toggle("hidden", deck || lite);
  $("#acBody").classList.toggle("hidden", !(deck || lite));
  $("#acLite").classList.toggle("hidden", !lite);
  $("#acLighter").classList.toggle("hidden", Paper.on);
  if (lite) renderAccountMode();
  if (!deck && !lite) return;
  $$("#acDays button").forEach((b) => b.classList.toggle("active", +b.dataset.days === acc.days));
  $$("#acMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === acc.mode));
  renderAccountHead();
  const days = acc.days, fresh = (x) => x && Date.now() - x.at < 60000;
  const known = acc.cache[days], knownM = acc.mcache[days];
  if (known) showAccountStats(known.d);
  acc.mkt = knownM ? knownM.d : null;
  renderAccountMarkets();
  if (!fresh(known)) {
    $("#acState").textContent = t("Aggiorno…");
    const d = await fetchAccount(days, "stats").catch((e) => { toast(e.message, true); return null; });
    $("#acState").textContent = "";
    if (d && days === acc.days) showAccountStats(d);
  }
  if (!fresh(knownM)) {
    const m = await fetchAccount(days, "markets").catch(() => null);
    if (m && days === acc.days) { acc.mkt = m; renderAccountMarkets(); renderAccountStats(); }
  }
  preloadAccount();
}

// the Account page open while the account arrives or changes (paper, live, another key), and its fills now and then
function accountPageFollow() {
  const key = Paper.on ? "paper" : account ? "live:" + account.index : "none";
  if (key !== acc.pageKey) { // another account: what was read for the last one goes
    acc.pageKey = key;
    acc.cache = {}; acc.mcache = {}; acc.data = null; acc.mkt = null;
    if (curView === "account") loadAccountPage();
    return;
  }
  if (curView === "account" && accLite() && Date.now() - (acc.liteAt || 0) > 60000) { acc.liteAt = Date.now(); loadAccountPage(); }
}

function renderAccountMode() {
  const paper = Paper.on;
  $("#acLiteTitle").textContent = paper ? t("Paper trading") : t("Chiave nel browser");
  $("#acLiteNote").textContent = paper ? t("Soldi simulati sui prezzi veri di Lighter, salvati in questo browser.")
    : t("Conto Lighter #{n}: gli ordini sono firmati in questo browser e vanno direttamente a Lighter.", { n: account.index });
  $("#acReset").classList.toggle("hidden", !paper);
  $("#acLive").classList.toggle("hidden", !paper || (!!info.public && !info.browser_trading));
  $("#acKey").classList.toggle("hidden", paper);
}

function showAccountStats(d) {
  acc.data = d;
  acc.month = acc.month || utcDay(new Date()).slice(0, 7);
  renderAccountHead();
  renderAccountChart();
  renderAccountStats();
  renderPnlCalendar();
}

async function preloadAccount() {
  if (preloadAccount.busy) return;
  preloadAccount.busy = true;
  try {
    for (const kind of ["stats", "markets"]) {
      for (const days of [7, 30, 90, 365]) {
        const box = kind === "stats" ? acc.cache : acc.mcache;
        if (!box[days] || Date.now() - box[days].at > 60000) await fetchAccount(days, kind).catch(() => {});
      }
    }
  } finally { preloadAccount.busy = false; }
}

function renderAccountHead() {
  if (!account || $("#view-account").classList.contains("hidden")) return;
  const eq = account.total_value, avail = account.available;
  const upnl = account.positions.reduce((s, p) => s + p.upnl, 0);
  const notional = account.positions.reduce((s, p) => s + Math.abs(p.value), 0);
  const used = marginState(account).usedPct;
  $("#acIdx").textContent = account.paper ? t("Paper trading") : "#" + account.index;
  $("#acEq").textContent = fusd(eq);
  const today = acc.data && acc.data.days.find((x) => x.day === utcDay(new Date()));
  const td = $("#acToday");
  td.textContent = today ? fsigned(today.pnl) : "—";
  td.className = today ? cls(today.pnl) : "";
  $("#acUpnl").textContent = fsigned(upnl);
  $("#acUpnl").className = cls(upnl);
  $("#acAvail").textContent = fusd(avail);
  $("#acLev").textContent = eq > 0 ? `${(notional / eq).toFixed(1)}x` : "—";
  $("#acUsed").textContent = `${used.toFixed(1)}%`;
  const bar = $("#acUsedBar");
  bar.style.width = Math.min(100, used) + "%";
  bar.className = used >= 85 ? "danger" : used >= 65 ? "warn" : "";
}

function renderAccountChart() {
  const d = acc.data;
  if (!d) return;
  $$("#acMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === acc.mode));
  if (acc.chart) { acc.chart.remove(); acc.chart = null; }
  const money = { type: "custom", minMove: 0.01, formatter: (v) => fusd(v, 0) };
  acc.chart = LightweightCharts.createChart($("#acChart"), {
    autoSize: true,
    layout: { background: { color: "transparent" }, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" },
    rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.1 } },
    timeScale: { timeVisible: acc.days <= 7, secondsVisible: false },
    crosshair: { mode: 0, vertLine: { style: 2 }, horzLine: { style: 2 } },
    handleScroll: false, handleScale: false,
  });
  acc.chart.applyOptions(chartTheme());
  if (acc.days <= 7) acc.chart.applyOptions(LOCAL_TIME); // hours in local time; longer ranges are UTC days, as on Lighter
  const pnl = acc.mode === "pnl";
  // PnL: green above zero, red below; equity: one line
  acc.line = pnl
    ? acc.chart.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2, priceFormat: money, priceLineVisible: false,
        topLineColor: C.green, topFillColor1: C.green + "33", topFillColor2: C.green + "05",
        bottomLineColor: C.red, bottomFillColor1: C.red + "05", bottomFillColor2: C.red + "33" })
    : acc.chart.addAreaSeries({ lineWidth: 2, priceFormat: money, priceLineVisible: false,
        lineColor: C.green, topColor: C.green + "33", bottomColor: C.green + "03" });
  acc.line.setData(d.series.map((s) => ({ time: s.t, value: pnl ? s.pnl : s.equity })));
  // deposits: blue arrow below the line; withdrawals: amber arrow above; the amount shows on hover
  const flowAt = new Map(d.flows.map((f) => [f.t, f]));
  acc.line.setMarkers(d.flows.map((f) => ({ time: f.t, position: f.usd > 0 ? "belowBar" : "aboveBar",
    shape: f.usd > 0 ? "arrowUp" : "arrowDown", color: f.usd > 0 ? cssVar("--blue") : cssVar("--amber"), size: 0.8 })));
  const tip = $("#acTip");
  acc.chart.subscribeCrosshairMove((p) => {
    const f = p.time !== undefined && flowAt.get(p.time);
    if (!f || !p.point) { tip.classList.add("hidden"); return; }
    tip.className = "ac-tip " + (f.usd > 0 ? "dep" : "wd");
    tip.innerHTML = `<b>${f.usd > 0 ? t("Deposito") : t("Prelievo")} ${fsigned(f.usd)}</b><span>${new Date((acc.days <= 7 ? f.t : f.at) * 1000).toLocaleString(LOCALE, { day: "numeric", month: "short", ...(acc.days <= 7 ? { hour: "2-digit", minute: "2-digit" } : { timeZone: "UTC" }) })}</span>`;
    const w = $("#acChart").clientWidth;
    tip.style.left = Math.min(Math.max(p.point.x - 70, 4), w - 150) + "px";
    tip.style.top = Math.max(p.point.y - 52, 4) + "px";
  });
  acc.chart.timeScale().fitContent();
  const legend = d.flows.length ? `<span class="dep">▲ ${t("depositi")}</span> <span class="wd">▼ ${t("prelievi")}</span> · ${t("passa sopra per l'importo")}` : "";
  $("#acChartHint").innerHTML = (pnl ? t("Solo trading: depositi e prelievi non spostano la curva.") + (legend ? " " : "") : "") + legend;
}

function renderAccountStats() {
  const s = acc.data && acc.data.stats;
  if (!s) { $("#acStats").innerHTML = ""; return; }
  $("#acPeriod").textContent = { 7: t("ultimi 7 giorni"), 30: t("ultimi 30 giorni"), 90: t("ultimi 90 giorni"), 365: t("ultimo anno") }[acc.days];
  const day = (x) => x ? `${fsigned(x.pnl)}<small>${new Date(x.day + "T00:00:00Z").toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</small>` : "—";
  const row = (k, v, c = "") => `<dt>${k}</dt><dd class="${c}">${v}</dd>`;
  $("#acStats").innerHTML =
    row(t("PnL"), fsigned(s.pnl), cls(s.pnl)) +
    row(`<span title="${t("PnL diviso per il capitale medio nell'account durante il periodo")}">${t("Rendimento")}</span>`, s.return_pct === null ? "—" : fpct(s.return_pct), cls(s.return_pct || 0)) +
    row(t("Massimo drawdown"), s.max_drawdown ? "−" + fusd(s.max_drawdown) : "—", s.max_drawdown ? "down" : "") +
    row(t("Giorno migliore"), day(s.best_day), s.best_day && s.best_day.pnl > 0 ? "up" : "") +
    row(t("Giorno peggiore"), day(s.worst_day), s.worst_day && s.worst_day.pnl < 0 ? "down" : "") +
    row(t("Giorni verdi / rossi"), `${s.green_days} / ${s.red_days}`) +
    row(t("Volume"), acc.mkt ? fusd(acc.mkt.volume, 0) : "…") +
    row(t("Depositi − prelievi"), Math.abs(s.net_flows) < 1 ? "—" : fsigned(s.net_flows));
}

function renderPnlCalendar() {
  const d = acc.data;
  if (!d || !acc.month) return;
  const byDay = Object.fromEntries(d.days.map((x) => [x.day, x.pnl]));
  const [y, m] = acc.month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  $("#acMonth").textContent = first.toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const dows = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(LOCALE, { weekday: "short", timeZone: "UTC" }));
  let html = dows.map((w) => `<div class="dow">${w}</div>`).join("") + '<div class="pad"></div>'.repeat(lead);
  let green = 0, red = 0, net = 0;
  for (let n = 1; n <= days; n++) {
    const key = `${acc.month}-${String(n).padStart(2, "0")}`, v = byDay[key];
    if (v !== undefined) { net += v; if (v > 0.005) green++; else if (v < -0.005) red++; }
    const c = v === undefined ? "" : v > 0.005 ? "up" : v < -0.005 ? "down" : "";
    html += `<button data-day="${key}" class="${c}${acc.day === key ? " sel" : ""}"${v === undefined ? " disabled" : ""}><span class="n">${n}</span><span class="v">${v === undefined ? "" : `<span class="vl">${fk(v)}</span><span class="vs">${fkShort(v)}</span>`}</span></button>`;
  }
  $("#acCal").innerHTML = html;
  $("#acMonthSum").innerHTML = `<span>${t("Netto")} <b class="${cls(net)}">${fsigned(net)}</b></span><span>${t("{g} giorni verdi · {r} rossi", { g: green, r: red })}</span><span class="muted">${t("Giorni UTC, come su Lighter")}</span>`;
  const now = utcDay(new Date()).slice(0, 7), oldest = d.days.length ? d.days[0].day.slice(0, 7) : now;
  $("#acPrev").disabled = acc.month <= oldest;
  $("#acNext").disabled = acc.month >= now;
  if (!acc.day) $("#acDayFills").innerHTML = "";
}

async function showDayFills(day) {
  acc.day = day;
  renderPnlCalendar();
  const start = Date.parse(day + "T00:00:00Z") / 1000;
  const box = $("#acDayFills");
  box.innerHTML = `<div class="t">${t("Carico i trade…")}</div>`;
  const rows = await api(`/fills?start=${start}&end=${start + 86400}`).catch(() => null);
  if (acc.day !== day) return;
  const title = new Date(day + "T00:00:00Z").toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  if (!rows || !rows.length) { box.innerHTML = `<div class="t">${title}</div><div class="muted">${t("Nessun trade quel giorno: il PnL viene dalle posizioni aperte e dal funding.")}</div>`; return; }
  const groups = aggregateTrades(rows);
  const time = (ts) => new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div class="t">${title} · ${t("{n} ordini", { n: groups.length })}</div><table class="table"><thead><tr><th>${t("Ora")}</th><th>${t("Mercato")}</th><th>${t("Lato")}</th><th class="r">Size</th><th class="r">${t("Prezzo medio")}</th><th class="r">${t("PnL realizzato")}</th></tr></thead><tbody>${
    groups.map((r) => `<tr><td>${time(r.ts)}</td><td class="mk">${esc(r.symbol)}</td><td class="${r.side === "buy" ? "up" : "down"}">${r.side === "buy" ? "Buy" : "Sell"}</td>
      <td class="r">${fsize(r.size, byId[r.market_id])}</td><td class="r">${fp(r.price, byId[r.market_id])}</td><td class="r ${r.pnl ? cls(r.pnl) : ""}">${r.pnl ? fsigned(r.pnl) : "—"}</td></tr>`).join("")}</tbody></table>`;
}

function renderAccountMarkets() {
  const d = acc.mkt;
  if (!d) { $("#acMktNote").textContent = ""; $("#acMarkets").innerHTML = `<div class="empty">${t("Carico trade e funding…")}</div>`; return; }
  $("#acMktNote").textContent = d.funding_complete ? "" : t("funding parziale");
  if (!d.markets.length) { $("#acMarkets").innerHTML = `<div class="empty">${t("Nessun trade nel periodo.")}</div>`; return; }
  $("#acMarkets").innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th class="r" title="${t("Dai fill del periodo, al netto del prezzo medio di entrata")}">${t("Realizzato")}</th><th class="r">Funding</th><th class="r">${t("Totale")}</th><th class="r">Fill</th><th class="r">${t("Volume")}</th></tr></thead><tbody>${
    d.markets.map((r) => { const tot = r.realized + r.funding; return `<tr><td class="mk">${esc(r.symbol)}</td>
      <td class="r ${cls(r.realized)}">${r.realized ? fsigned(r.realized) : "—"}</td><td class="r ${cls(r.funding)}">${r.funding ? fsigned(r.funding) : "—"}</td>
      <td class="r main ${cls(tot)}">${fsigned(tot)}</td><td class="r">${r.fills}</td><td class="r">${fcompact(r.volume)}</td></tr>`; }).join("")}</tbody></table>
    <p class="hint">${t("Il PnL di un trade si conta quando chiudi: le posizioni ancora aperte sono nel PnL non realizzato in alto.")}</p>`;
}

// ---------- Calendar page ----------
// what kind of event it is, for the filters
const evType = (e) => (e.source === "custom" ? "mine" : e.source === "Deribit" ? "crypto" : e.source === "Nasdaq" ? "earnings"
  : e.assets && e.assets.some((a) => a === "oil" || a === "natgas") ? "energy" : "macro");
const TYPE_LABEL = { macro: "Macro", energy: "Energia", earnings: "Trimestrali", crypto: "Crypto", mine: "Tuoi" };
// impact anywhere: the highest it has for any market (an oil report is high for WTI)
function impactAny(e) {
  if (!e.assets || !e.assets.length) return e.impact;
  const levels = e.impact_by ? Object.values(e.impact_by) : ["High"];
  return levels.sort((a, b) => IMPACT_RANK[b] - IMPACT_RANK[a])[0] || e.impact;
}
// the markets an event moves, as chips: its own symbols, or the currency for a country's release
function evMarkets(e) {
  if (!e.assets || !e.assets.length) return e.country ? [e.country] : [];
  const out = [];
  for (const a of e.assets) {
    if (a.startsWith("sym:") || a.startsWith("stock:")) out.push(a.split(":")[1]);
    else if (a === "oil") out.push("WTI", "BRENTOIL");
    else if (a === "natgas") out.push("NATGAS");
    else if (a === "index") out.push(...["US500", "US100", "SPY", "QQQ"].filter((x) => bySymbol[x]));
  }
  return [...new Set(out)];
}
const cp = { scope: "all", types: ["macro", "energy", "earnings", "crypto", "mine"], impacts: ["High", "Medium"], range: "7", ...load("cp", {}) };
function saveCp() { store("cp", { scope: cp.scope, types: cp.types, impacts: cp.impacts, range: cp.range, market: cp.market }); }

// The calendar's market panel: the picker's tabs and categories over the markets' names, A to Z in three
// columns; typing in the box searches all of them
const cpPop = { tab: "all", cat: "", typing: false };
// The Calendar's own favourites: the Trade page's until the first star is changed here, then a list of their own
let calFavs = load("calFavs", null);
const calFavList = () => calFavs || favs;
function toggleCalFav(sym) {
  const cur = calFavList();
  calFavs = cur.includes(sym) ? cur.filter((x) => x !== sym) : [...cur, sym];
  store("calFavs", calFavs);
}
function openCpPop() { if (!$("#cpMkPop").classList.contains("hidden")) return; cpPop.typing = false; $("#cpMkPop").classList.remove("hidden"); renderCpPop(); }
function closeCpPop() { $("#cpMkPop").classList.add("hidden"); }
function renderCpPop() {
  const pop = $("#cpMkPop");
  if (pop.classList.contains("hidden")) return;
  const typed = $("#cpMarket").value.trim().toUpperCase();
  const q = cpPop.typing ? typed : ""; // until something is typed, the chosen market's name lists everything
  const inTab = (m) => (cpPop.tab === "favs" ? calFavList().includes(m.symbol) : cpPop.tab === "all" ? true : m.asset_type === cpPop.tab);
  const scope = markets.filter(inTab);
  const cats = CATEGORIES.filter(([k]) => scope.some((m) => (m.categories || []).includes(k)));
  if (cpPop.cat && !cats.some(([k]) => k === cpPop.cat)) cpPop.cat = "";
  const list = (q ? markets.filter((m) => m.symbol.toUpperCase().includes(q) || (m.name || "").toUpperCase().includes(q))
    : scope.filter((m) => !cpPop.cat || (m.categories || []).includes(cpPop.cat)))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  // a search: names starting with what was typed first, then those containing it, then matches on the full name
  if (q) { const rank = (m) => (m.symbol.startsWith(q) ? 0 : m.symbol.includes(q) ? 1 : 2); list.sort((a, b) => rank(a) - rank(b)); }
  const on = cp.scope === "mkt" ? cp.market : null;
  pop.innerHTML = `<div class="cp-pop-tabs${q ? " off" : ""}">${TABS.filter(([k]) => k !== "spread").map(([k, label]) => `<button type="button" data-cptab="${k}" class="${cpPop.tab === k ? "active" : ""}">${t(label)}</button>`).join("")}</div>`
    + (q ? "" : `<div class="cp-pop-cats"><button type="button" data-cpcat="" class="${cpPop.cat ? "" : "active"}">${t("Tutte")}</button>${cats.map(([k, label]) => `<button type="button" data-cpcat="${k}" class="${cpPop.cat === k ? "active" : ""}">${t(label)}</button>`).join("")}</div>`)
    + `<div class="cp-pop-list">${list.map((m) => `<div class="cp-mk${m.symbol === on ? " on" : ""}"><button type="button" data-cpmk="${m.symbol}">${ico(m.symbol, "xs")}<b>${esc(m.symbol)}</b></button><button type="button" class="star${calFavList().includes(m.symbol) ? " on" : ""}" data-cpstar="${m.symbol}" title="${t("Preferito")}">★</button></div>`).join("")
      || `<div class="empty">${t(cpPop.tab === "favs" && !q ? "Nessun preferito: tocca la stella accanto a un mercato." : "Nessun mercato trovato.")}</div>`}</div>`;
}

function renderCalPage() {
  if ($("#view-cal").classList.contains("hidden")) return;
  const now = Date.now() / 1000, q = $("#cpSearch").value.trim().toLowerCase();
  const sym = cp.scope === "mkt" ? cp.market || (activeMarket() && activeMarket().symbol) : null;
  $$("#cpScope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === cp.scope));
  $$("#cpTypes button").forEach((b) => b.classList.toggle("active", cp.types.includes(b.dataset.type)));
  $$("#cpImpacts button").forEach((b) => b.classList.toggle("active", cp.impacts.includes(b.dataset.imp)));
  $$("#cpRange button").forEach((b) => b.classList.toggle("active", b.dataset.range === cp.range));
  // the market box shows the chosen market, empty for all of them; not rewritten while being typed in
  const box = $("#cpMarket");
  if (document.activeElement !== box) box.value = sym || "";
  const endOfToday = new Date().setHours(24, 0, 0, 0) / 1000;
  const inRange = (e) => cp.range === "past" ? e.ts < now
    : e.ts >= now - 3 * 3600 && (cp.range === "all" || e.ts < (cp.range === "today" ? endOfToday : now + +cp.range * 86400));
  const list = events.filter((e) => {
    if (!inRange(e) || !cp.types.includes(evType(e))) return false;
    if (cp.country && e.country !== cp.country) return false;
    const imp = sym ? impactFor(e, sym) : impactAny(e);
    if (!cp.impacts.includes(imp === "Holiday" ? "Low" : imp)) return false;
    if (sym && !eventFor(e, sym)) return false;
    return !q || `${e.title} ${e.country} ${e.name || ""} ${evMarkets(e).join(" ")}`.toLowerCase().includes(q);
  });
  if (cp.range === "past") list.reverse();
  const country = cp.country && SESSIONS.find((s) => s.ccy === cp.country);
  $("#cpCount").innerHTML = esc(t("{n} eventi", { n: list.length }) + (sym ? " · " + t("che muovono {sym}", { sym }) : ""))
    + (country ? ` · <button class="cp-country" data-cc="${country.ccy}" title="${t("Mostra tutti i paesi")}">${esc(t(country.name))} · ${country.ccy} ✕</button>` : "");
  $$("#cpSessions [data-cc]").forEach((r) => r.classList.toggle("on", r.dataset.cc === cp.country));
  let lastDay = "";
  $("#cpList").innerHTML = list.map((e) => {
    const d = new Date(e.ts * 1000), left = e.ts - now;
    const day = d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
    const head = day !== lastDay ? `<div class="cp-day">${day}</div>` : "";
    lastDay = day;
    const imp = sym ? impactFor(e, sym) : impactAny(e);
    const chips = evMarkets(e).map((s) => (bySymbol[s] ? `<button data-cpsym="${s}">${s}</button>` : `<span class="muted">${esc(s)}</span>`)).join("");
    return `${head}<div class="cp-row${left < 0 ? " past" : ""}">
      <div class="tm${left > 0 && left < 3600 ? " soon" : ""}">${eventTime(e, d)}<small>${left > 0 ? t("tra {d}", { d: dur(left * 1000) }) : ""}</small></div>
      <span class="imp ${imp}"></span>
      <div class="ti"><b>${evLabel(e)}</b><span class="kind">${t(TYPE_LABEL[evType(e)])}</span><div class="s">${eventDetail(e)}</div>${evTradeTags(e)}</div>
      <div class="mk">${chips}${evTradeBtn(e)}${e.source === "custom" ? `<button class="ev-del" data-delev="${e.id}" data-ck="delev:${e.id}" title="${t("Elimina")}">✕</button>` : ""}</div>
    </div>`;
  }).join("") || `<div class="empty">${t("Nessun evento con questi filtri.")}</div>`;
  markConfirm();
}

// ---------- event trades from the calendar ----------
// A ⚡ button on each upcoming event with a real time opens a small form: market, long/short at the release
// or a breakout of the range before it, size, SL/TP. The trade then shows on the event, where it can be
// cancelled. On the deck the server's engine runs it (Auto ON); in paper, this browser.
let eventRules = [];
const EV_STATUS = { waiting: "in attesa", window: "range pronto", done: "eseguito", expired: "scaduto", blocked: "bloccato", skipped: "saltato" };

async function loadEventRules() {
  if (!info.trading) { eventRules = []; return; }
  const list = await api("/rules").catch(() => null);
  if (!list) return;
  const ev = list.filter((r) => r.type === "event_trade");
  if (JSON.stringify(ev) === JSON.stringify(eventRules)) return;
  eventRules = ev;
  renderEcon();
}

const evTradeBtn = (e) => (info.trading && e.ts > Date.now() / 1000 && !e.approx && e.when !== "time not given"
  ? `<button class="ev-trade" data-evtrade="${esc(e.id)}" title="${t("Trade su questo evento")}">⚡</button>` : "");

function evTradeTags(e) {
  const mine = eventRules.filter((r) => r.event_id === e.id);
  return mine.map((r) => {
    const m = byId[r.market_id], mode = { breakout: "Breakout", long: "Long", short: "Short" }[r.mode] || r.mode;
    const live = ["waiting", "window"].includes(r.status);
    return `<div class="ev-rule ${esc(r.status)}">⚡ ${esc(m ? m.symbol : "")} ${mode} ${fusd(r.size_usd, 0)}${r.stop_pct ? ` · SL ${r.stop_pct}%` : ""}${r.tp_pct ? ` · TP ${r.tp_pct}%` : ""} · ${t(EV_STATUS[r.status] || r.status)}${
      live ? `<button data-evrule-del="${r.id}" title="${t("Annulla il trade su evento")}">✕</button>` : ""}</div>`;
  }).join("");
}

function openEventTrade(btn) {
  const e = events.find((x) => x.id === btn.dataset.evtrade);
  if (!e) return;
  const cur = activeMarket(), marketsOf = evMarkets(e).filter((s) => bySymbol[s]);
  const opts = [...new Set([...(cur && eventFor(e, cur.symbol) ? [cur.symbol] : []), ...marketsOf, ...(cur ? [cur.symbol] : [])])];
  const last = load("evTrade", { mode: "breakout", size_usd: 50, stop_pct: 1, tp_pct: "" });
  const pop = $("#evTradePop");
  pop.dataset.ev = e.id;
  pop.innerHTML = `<div class="ev-pop-head"><b>${evLabel(e)}</b><small class="muted">${new Date(e.ts * 1000).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div>
    <div class="field sm"><label>${t("Mercato")}</label><select name="market">${opts.map((s) => `<option value="${s}">${s}</option>`).join("")}</select></div>
    <div class="seg ev-mode">${[["breakout", "Breakout"], ["long", "Long"], ["short", "Short"]].map(([k, l]) => `<button type="button" data-mode="${k}" class="${last.mode === k ? "active" : ""}">${l}</button>`).join("")}</div>
    <p class="hint ev-mode-hint"></p>
    <div class="three"><div class="field sm"><label>Size · USD</label><input name="size_usd" type="number" min="0" step="any" value="${last.size_usd}"></div>
      <div class="field sm"><label>SL %</label><input name="stop_pct" type="number" min="0" step="0.1" value="${last.stop_pct ?? ""}"></div>
      <div class="field sm"><label>TP %</label><input name="tp_pct" type="number" min="0" step="0.1" value="${last.tp_pct ?? ""}" placeholder="—"></div></div>
    <p class="hint warn ev-auto hidden">${t("Auto è OFF: il trade parte solo se Auto è ON all'orario dell'evento.")}</p>
    <div class="ev-pop-actions"><button type="button" class="ghost" data-evpop="cancel">${t("Annulla")}</button><button type="button" class="primary" data-evpop="ok">${t("Imposta trade")}</button></div>
    <p class="hint err ev-err hidden"></p>`;
  const setMode = (k) => {
    pop.dataset.mode = k;
    pop.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === k));
    pop.querySelector(".ev-mode-hint").textContent = k === "breakout"
      ? t("Range dei 15 minuti prima: entra nella direzione in cui il prezzo esce, entro 30 minuti.")
      : t("Entra {side} 5 secondi dopo l'uscita del dato.", { side: k === "long" ? "long" : "short" });
  };
  setMode(last.mode);
  pop.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  pop.querySelector(".ev-auto").classList.toggle("hidden", autoOn());
  pop.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 12)) + "px";
  pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? Math.max(12, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
}

async function submitEventTrade() {
  const pop = $("#evTradePop"), e = events.find((x) => x.id === pop.dataset.ev);
  if (!e) return;
  const val = (n) => pop.querySelector(`[name="${n}"]`).value;
  const body = { type: "event_trade", event_id: e.id, event_ts: e.ts, event_title: `${e.country ? e.country + " " : ""}${e.title}`,
    market_id: bySymbol[val("market")].id, mode: pop.dataset.mode, size_usd: +val("size_usd") };
  if (+val("stop_pct") > 0) body.stop_pct = +val("stop_pct");
  if (+val("tp_pct") > 0) body.tp_pct = +val("tp_pct");
  if (body.mode === "breakout") Object.assign(body, { range_minutes: 15, buffer_pct: 0.05, window_minutes: 30 });
  else body.delay_s = 5;
  const err = pop.querySelector(".ev-err");
  if (!(body.size_usd > 0)) { err.textContent = t("Inserisci una size valida."); err.classList.remove("hidden"); return; }
  try {
    await api("/rules", { method: "POST", body: JSON.stringify(body) });
    store("evTrade", { mode: body.mode, size_usd: body.size_usd, stop_pct: body.stop_pct ?? "", tp_pct: body.tp_pct ?? "" });
    pop.classList.add("hidden");
    toast(t("Trade su evento impostato: {sym} {mode}", { sym: val("market"), mode: body.mode }) + (autoOn() ? "" : " · " + t("parte quando attivi Auto")));
    eventRules = [];
    await loadEventRules();
    renderEcon();
  } catch (x) { err.textContent = x.message; err.classList.remove("hidden"); }
}

function wireEventTrades() {
  const onList = async (e) => {
    const b = e.target.closest("[data-evtrade]");
    if (b) { e.stopPropagation(); return openEventTrade(b); }
    const d = e.target.closest("[data-evrule-del]");
    if (d) {
      e.stopPropagation();
      await api(`/rules/${encodeURIComponent(d.dataset.evruleDel)}`, { method: "DELETE" }).catch((x) => toast(x.message, true));
      eventRules = [];
      await loadEventRules();
      renderEcon();
    }
  };
  for (const id of ["#cpList", "#econList"]) $(id).addEventListener("click", onList, true);
  const pop = $("#evTradePop");
  pop.addEventListener("click", (e) => {
    const a = e.target.closest("[data-evpop]");
    if (a) a.dataset.evpop === "ok" ? submitEventTrade() : pop.classList.add("hidden");
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#evTradePop, [data-evtrade]")) pop.classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.classList.add("hidden"); });
}

// ---------- public site ----------
// lighterdeck.xyz runs read-only: a welcome bar, a residence check, and your own events kept in this browser
function applyPublic() {
  document.body.classList.toggle("public", !!info.public);
  if (!info.public) return;
  // the visitor's country, from Cloudflare (the server's answer is the same for everyone so it can be kept)
  if ((info.blocked_countries || []).length) {
    fetch("/cdn-cgi/trace").then((r) => (r.ok ? r.text() : "")).then((txt) => {
      const loc = (txt.match(/^loc=(\w+)/m) || [])[1];
      if (loc && info.blocked_countries.includes(loc)) $("#geoPage").classList.remove("hidden");
    }).catch(() => {});
  }
  $("#pubGithub").href = info.github_url;
  $("#pubReferral").href = info.referral_url;
  $("#pubBar").classList.toggle("hidden", !!load("pubbarClosed", false));
  $("#pubClose").onclick = () => { store("pubbarClosed", true); $("#pubBar").classList.add("hidden"); };
  if (!load("residence", false)) { $("#resVeil").classList.remove("hidden"); $("#resModal").classList.remove("hidden"); }
  $("#resYes").onclick = () => { store("residence", true); $("#resVeil").classList.add("hidden"); $("#resModal").classList.add("hidden"); liveIntro(); };
  if (info.browser_trading) {
    $("#pubLong").textContent = t("Terminale per i perpetual di Lighter: gli ordini si firmano in questo browser e vanno dritti a Lighter. Per provare senza rischi c'è il paper trading.");
    $("#pubShort").textContent = t("Trading su Lighter · chiave nel tuo browser");
  }
  $("#resNo").onclick = () => { $("#resVeil").classList.add("hidden"); $("#resModal").classList.add("hidden"); $("#geoPage").classList.remove("hidden"); };
}
const myEvents = () => (info && info.public ? load("myEvents", []) : []);

async function loadCalendar() {
  events = await api("/calendar").catch(() => events);
  events = [...events.filter((e) => !String(e.id).startsWith("my")), ...myEvents()].sort((a, b) => a.ts - b.ts);
  renderEcon();
  renderEventSelect();
  renderCalPage(); // the Calendar page opened before the events arrived
  panels.forEach((p) => p.drawMarkers());
}

// ================= markets page =================
let mktSort = { key: "volume", dir: -1 };
// the market picker's tabs (all, favourites, crypto, RWA) and categories, remembered; a search looks in every market
let mktTab = load("mktTab", "all"), mktCat = load("mktCat", "");
const mktInTab = (m) => (mktTab === "favs" ? favs.includes(m.symbol) : mktTab === "all" ? true : m.asset_type === mktTab);
function renderMarketFilters(q) {
  const scope = markets.filter(mktInTab);
  const cats = CATEGORIES.filter(([k]) => scope.some((m) => (m.categories || []).includes(k)));
  if (mktCat && !cats.some(([k]) => k === mktCat)) mktCat = "";
  $("#mktTabs").classList.toggle("off", !!q);
  $("#mktTabs").innerHTML = TABS.filter(([k]) => k !== "spread").map(([k, label]) => {
    const n = k === "all" ? markets.length : k === "favs" ? favs.filter((x) => bySymbol[x]).length : markets.filter((m) => m.asset_type === k).length;
    return `<button data-mtab="${k}" class="${mktTab === k ? "active" : ""}">${t(label)}<span>${n}</span></button>`;
  }).join("");
  $("#mktCats").innerHTML = `<button data-mcat="" class="${mktCat ? "" : "active"}">${t("Tutte")}</button>` +
    cats.map(([k, label, group], i) => (i && group !== cats[i - 1][2] ? '<i class="pk-cat-sep" aria-hidden="true"></i>' : "")
      + `<button data-mcat="${k}" class="${mktCat === k ? "active" : ""}">${t(label)}</button>`).join("");
}
function renderMarkets() {
  loadFarmRecent(); // the last 6 hours' funding
  const q = $("#mktSearch").value.trim().toUpperCase();
  renderMarketFilters(q);
  const rows = markets.filter((m) => (q ? m.symbol.includes(q) : mktInTab(m) && (!mktCat || (m.categories || []).includes(mktCat)))).map((m) => {
    const p = prices[m.id] || {};
    const x = farmOf(m);
    return { m, symbol: m.symbol, price: p.last || p.mark || 0, change: p.change || 0, volume: p.volume || m.volume_usd, oi: p.oi || 0, funding: p.funding || 0,
      past: x.past, hot: x.hot, x, day: farmDay(x.earn) };
  });
  rows.sort((a, b) => (a[mktSort.key] > b[mktSort.key] ? 1 : -1) * mktSort.dir);
  $("#mktTable tbody").innerHTML = rows.slice(0, 250).map((r) => `<tr data-sym="${r.symbol}">
      <td><button class="star${favs.includes(r.symbol) ? " on" : ""}" data-star="${r.symbol}">★</button></td>
      <td class="mk"><span class="sym">${ico(r.symbol)}${r.symbol}</span></td><td class="r">${fp(r.price, r.m)}</td><td class="r ${cls(r.change)}">${fpct(r.change)}</td>
      <td class="r">${fcompact(r.volume)}</td><td class="r">${fcompact(r.oi)}</td><td class="r ${r.funding < 0 ? "down" : ""}">${r.funding.toFixed(4)}%</td>
      <td class="r">${farmHours(r.past, r.hot)}</td>${farmDayCell(r.x)}
      <td class="r"><span class="open-btn">${t("Apri nel grafico →")}</span></td></tr>`).join("");
}

// ================= funding over the last 6 hours (the Markets page's columns) =================
// Lighter's funding is a % per hour, paid every hour: positive, longs pay shorts; negative, shorts pay longs.
// Besides the rate now, Markets shows the last 6 hours (from the server, read once an hour): how many of them
// were past FARM_MIN, and what the side that collects got a day on $1,000 on their average (the rate now
// until they arrive): a steadier guess than one hour, and below zero when the side mostly paid.
const FARM_MIN = 0.01; // % per hour
let farmRecent = { at: 0, hours: 6, rates: {} }, farmRecentAt = 0;

function loadFarmRecent() {
  if (Date.now() - farmRecentAt < 5 * 60000) return;
  farmRecentAt = Date.now();
  api("/funding_recent").then((r) => { farmRecent = r; if (curView === "markets") renderMarkets(); }).catch(() => { farmRecentAt = 0; });
}

// one mark per past hour, oldest first: filled when past FARM_MIN, in the colour of who collected it; then how many
function farmHours(past, hot) {
  const marks = past.map((x) => `<i class="${Math.abs(x) >= FARM_MIN ? (x > 0 ? "hot dn" : "hot up") : ""}" title="${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(4)}%"></i>`).join("");
  return `<span class="farm-hours">${marks}</span><span class="farm-hot">${past.length ? `${hot}/${past.length}` : "—"}</span>`;
}

// a market's funding now and in the last 6 hours: which side collects and what it got on average (% per hour)
function farmOf(m) {
  const p = prices[m.id] || {}, f = p.funding || 0, past = farmRecent.rates[m.id] || [];
  const hot = past.filter((x) => Math.abs(x) >= FARM_MIN).length;
  const avg = past.length ? past.reduce((s, x) => s + x, 0) / past.length : f;
  // positive funding: the shorts collect. Below FARM_MIN now, the rate now is too small to tell: the hours' average says
  const short = Math.abs(f) >= FARM_MIN || !past.length ? f > 0 : avg > 0;
  return { f, past, hot, short, earn: short ? avg : -avg };
}
// what the collecting side gets in a day on $1,000 (before fees)
const farmDay = (earn) => (1000 * earn / 100) * 24;
const farmDayCell = (x) => { const day = farmDay(x.earn);
  return `<td class="r ${day < 0 ? "down" : "up"}" title="${t("Lato che incassa")}: ${x.short ? "Short" : "Long"}">${day < 0 ? "−" : "+"}${fusd(Math.abs(day))}</td>`; };

// ================= automations =================
// events of the market chosen in the event-trade form, high impact for it first among those of the same day
function renderEventSelect() {
  const sel = $("#eventSelect");
  const keep = sel.value;
  const now = Date.now() / 1000;
  const m = byId[+$("#eventForm").elements.market_id.value];
  const sym = m && m.symbol;
  // an event trade fires at the event's time: earnings without a time can't be used
  sel.innerHTML = events.filter((e) => e.ts > now && e.impact !== "Holiday" && e.when !== "time not given" && (!sym || eventFor(e, sym))).map((e) =>
    `<option value="${e.id}">${new Date(e.ts * 1000).toLocaleString(LOCALE, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${e.country ? e.country + " " : ""}${esc(e.title)} (${impactFor(e, sym)})${e.approx ? " · " + t("orario indicativo") : ""}</option>`).join("");
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function formToRule(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (v === "" || form.querySelector(`[name="${k}"]`).closest(".hidden")) continue;
    out[k] = ["event_id", "mode"].includes(k) ? v : +v;
  }
  return out;
}

async function loadRules() {
  const rules = await api("/rules").catch(() => []);
  $("#rulesCount").textContent = rules.length ? t(rules.length === 1 ? "{n} regola" : "{n} regole", { n: rules.length }) : "";
  const box = $("#rules");
  if (!rules.length) { box.innerHTML = `<div class="empty" style="padding:8px 0">${t("Nessuna regola. Crea uno stop gestito o un trade su evento.")}</div>`; return; }
  box.innerHTML = rules.map((r) => {
    const status = r.type === "event_trade" ? r.status : r.type === "chase" || r.type === "iceberg" ? `${+(r.state.filled || 0)}/${+r.qty}` : r.state && r.state.stop ? "stop " + r.state.stop : t("in attesa");
    const when = r.event_ts ? new Date(r.event_ts * 1000).toLocaleString(LOCALE, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " · " : "";
    return `<div class="rule"><div class="top"><span>${esc(r.description)}</span><span class="badge ${esc(r.status || "")}">${esc(status)}</span></div>
      <div class="sub">${when}${r.enabled ? t("attiva") : t("in pausa")}${r.note ? " · " + esc(r.note) : ""}</div>
      <div class="actions"><button data-toggle="${r.id}" data-en="${r.enabled ? 1 : 0}">${r.enabled ? t("Pausa") : t("Riattiva")}</button><button data-del="${r.id}" data-ck="del:${r.id}">${t("Elimina")}</button></div></div>`;
  }).join("");
}

async function loadLimits() {
  const r = await api("/limits").catch(() => null);
  if (!r) return;
  loadLimits.last = r;
  const f = $("#limitsForm");
  for (const [k, v] of Object.entries(r.limits)) if (f.elements[k]) f.elements[k].value = v;
  for (const box of $$("[data-on]", f)) box.checked = !!r.limits.on[box.dataset.on];
  $("#hardCap").classList.toggle("hidden", !r.hard_cap_usd);
  if (r.hard_cap_usd) $("#hardCap").textContent = t("Tetto fisso del server: ${cap} per ordine (MAX_NOTIONAL_USD).", { cap: r.hard_cap_usd.toLocaleString("en-US") });
  $("#dailyPnl").textContent = info.trading && r.limits.on.daily_loss_pct && r.daily_pnl !== null ? t("PnL di oggi {pnl}", { pnl: fusd(r.daily_pnl) }) : t("facoltativi");
  info.limits = { ...info.limits, ...r.limits };
  renderLimitValues();
  renderAccount();
}

// next to each % limit: what it is worth in dollars right now; limits switched off are dimmed
function renderLimitValues() {
  const r = loadLimits.last;
  for (const box of $$("#limitsForm .field [data-on]")) box.closest(".field").classList.toggle("off", !box.checked);
  for (const el of $$("#limitsForm [data-eq]")) {
    const base = r && (el.dataset.eq === "daily_loss_pct" ? r.day_start_equity : r.equity);
    const pct = +$("#limitsForm").elements[el.dataset.eq].value;
    el.textContent = base && pct > 0 ? ` ≈ ${fusd((base * pct) / 100, 0)}` : "";
  }
}

// ---------- leverage: a wheel on the ticket's button ----------
// Mouse wheel or finger on the button turn a drum right there, no window to open: whole numbers and, beside them,
// tenths, like a date picker. Down towards the maximum, up towards 1x, and it stops dead at both ends. A change is
// sent once the drum has rested for a moment, because on Lighter each one is a transaction; an order about to go
// out sends a waiting one first. Cross or isolated is a separate choice, always on the ticket's first row.
const LEV_ROW = 26, LEV_STEP_DEG = 20, LEV_SEND_MS = 800, LEV_IDLE_CLOSE_MS = 1400;
const LEV_RADIUS = LEV_ROW / (2 * Math.tan((LEV_STEP_DEG / 2) * Math.PI / 180));
const lev = { open: false, pinned: false, market: null, max: 1, cols: [{ pos: 0, target: 0, n: 1 }, { pos: 0, target: 0, n: 10 }], cross: true, raf: 0, last: 0,
  drag: null, sendTimer: 0, closeTimer: 0, snapTimer: 0, pending: null, sending: null };

// the market's settings, with a change that is on its way counted as made
function levSet(m) {
  const set = account && account.settings && account.settings[m.id];
  const p = lev.pending;
  if (!p || p.id !== m.id) return set;
  // the account showing it ends the wait, but not while an earlier change of ours may still be on its way over it
  const settled = !lev.lastSent || lev.lastSent.id !== p.id || (lev.lastSent.leverage === p.leverage && lev.lastSent.cross === p.cross);
  if ((settled && !lev.sendTimer && set && set.leverage === p.leverage && set.cross === p.cross) || Date.now() - p.at > 15000) { lev.pending = null; return set; }
  return { leverage: p.leverage, cross: p.cross };
}

function levMax(m) {
  const cap = info.limits && info.limits.on && info.limits.on.leverage_cap ? info.limits.leverage_cap : Infinity;
  return Math.max(1, Math.floor(Math.min(m.max_leverage || 50, cap)));
}

function levPlace() {
  const r = $("#tkLev").getBoundingClientRect(), box = $("#levDrum");
  // the drum's centre row sits on the button, as if the button had become the wheel
  const top = r.top + r.height / 2 - box.offsetHeight / 2;
  box.style.top = Math.max(4, Math.min(innerHeight - box.offsetHeight - 4, top)) + "px";
  // between Long and Short: it opens centred on the button
  const left = r.left + r.width / 2 - box.offsetWidth / 2;
  box.style.left = Math.max(4, Math.min(innerWidth - box.offsetWidth - 4, left)) + "px";
}

// what the two columns read; at the maximum there are no tenths left
const levAtMax = () => Math.round(lev.cols[0].pos) + 1 >= lev.max;
const levValue = () => +(Math.round(lev.cols[0].pos) + 1 + (levAtMax() ? 0 : Math.round(lev.cols[1].pos) / 10)).toFixed(1);

function levLoad(value) {
  const tenths = Math.round(Math.max(1, Math.min(lev.max, value)) * 10);
  lev.cols[0].pos = lev.cols[0].target = Math.floor(tenths / 10) - 1;
  lev.cols[1].pos = lev.cols[1].target = tenths % 10;
  lev.last = levValue();
}

function levOpen(pinned) {
  const m = activeMarket();
  if (!m || activePair()) return false;
  if (!info.trading) { toast(t("Sola lettura: nessuna API key"), true); return false; }
  if (lev.open) { lev.pinned = lev.pinned || pinned; return true; }
  const set = levSet(m);
  lev.market = m;
  lev.max = levMax(m);
  lev.cols[0].n = lev.max;
  lev.cross = set ? set.cross !== false : true;
  levLoad(set ? set.leverage : Math.min(m.default_leverage || 5, lev.max));
  lev.open = true;
  lev.pinned = pinned;
  $("#levCyl").innerHTML = lev.cols.map((c, k) => `<div class="lev-col" data-col="${k}">${Array.from({ length: c.n }, (_, i) => `<div class="lev-row" data-row="${i}">${k ? `.${i}x` : i + 1}</div>`).join("")}</div>`).join("");
  $("#levDrum").classList.remove("hidden");
  levPlace();
  levDraw();
  return true;
}

// the drum on the value it is heading for, at once
function levSettle() {
  if (!lev.open) return;
  lev.drag = null;
  for (const c of lev.cols) c.target = c.pos = Math.round(c.target);
  levDraw();
}

function levClose() {
  if (!lev.open) return;
  levSettle();
  lev.open = lev.pinned = false;
  cancelAnimationFrame(lev.raf);
  lev.raf = 0;
  clearTimeout(lev.closeTimer);
  clearTimeout(lev.snapTimer);
  $("#levDrum").classList.add("hidden");
  if (lev.sendTimer) levSend(); // what is showing is what gets set
}

function levDraw() {
  // at the maximum the tenths go back to .0 by themselves
  if (levAtMax() && lev.cols[1].target !== 0) { lev.cols[1].target = 0; levAnimate(); }
  lev.cols.forEach((c, k) => {
    $$(`#levCyl .lev-col[data-col="${k}"] .lev-row`).forEach((el, i) => {
      const angle = (c.pos - i) * LEV_STEP_DEG;
      const seen = Math.abs(angle) < 80;
      el.style.visibility = seen ? "visible" : "hidden";
      if (!seen) return;
      el.style.transform = `translateZ(${-LEV_RADIUS}px) rotateX(${angle}deg) translateZ(${LEV_RADIUS}px)`;
      el.style.opacity = Math.max(0.12, Math.cos(angle * Math.PI / 180) ** 2);
      el.classList.toggle("on", Math.abs(c.pos - i) < 0.5);
    });
  });
  const value = levValue();
  if (value !== lev.last) {
    lev.last = value;
    levChanged();
    if (touchUI() && navigator.vibrate) navigator.vibrate(4); // a tick under the finger
  }
}

// the button and the ticket follow at once; the change goes out when the drum rests
function levChanged() {
  lev.pending = { id: lev.market.id, leverage: lev.last, cross: lev.cross, at: Date.now() };
  renderTicket();
  updateTicketSummary();
  clearTimeout(lev.sendTimer);
  lev.sendTimer = setTimeout(levSend, LEV_SEND_MS);
}

// cross or isolated: one click, one transaction, so it goes out at once at the leverage already set
function levMode(cross) {
  const m = activeMarket();
  if (!m || activePair()) return;
  if (!info.trading) return toast(t("Sola lettura: nessuna API key"), true);
  const set = levSet(m);
  if ((set ? set.cross !== false : true) === cross) return;
  lev.cross = cross;
  lev.market = m;
  const value = lev.open ? lev.last : set ? set.leverage : Math.min(m.default_leverage || 5, levMax(m));
  lev.pending = { id: m.id, leverage: value, cross, at: Date.now() };
  renderTicket();
  updateTicketSummary();
  levSend();
}

const levMoving = () => lev.cols.some((c) => c.pos !== c.target);

function levAnimate() {
  if (lev.raf || !lev.open) return;
  const step = () => {
    lev.raf = 0;
    if (!lev.open) return;
    for (const c of lev.cols) {
      c.pos += (c.target - c.pos) * 0.3;
      if (Math.abs(c.target - c.pos) < 0.004) c.pos = c.target;
    }
    levDraw();
    if (levMoving()) lev.raf = requestAnimationFrame(step);
  };
  lev.raf = requestAnimationFrame(step);
}

// a hard stop at both ends: nothing goes past them and nothing springs back
const levClamp = (k, v) => Math.max(0, Math.min(k && levAtMax() ? 0 : lev.cols[k].n - 1, v));

function levRest() {
  clearTimeout(lev.closeTimer);
  if (!lev.pinned) lev.closeTimer = setTimeout(levClose, LEV_IDLE_CLOSE_MS);
}

async function levSend() {
  clearTimeout(lev.sendTimer);
  // still turning, or held by a finger: only the value it comes to rest on goes out
  if (lev.open && (lev.drag || levMoving())) { lev.sendTimer = setTimeout(levSend, 200); return; }
  lev.sendTimer = 0;
  const p = lev.pending;
  if (!p) return;
  const m = byId[p.id], set = account && account.settings && account.settings[p.id];
  // compared with what was sent last, if it's so recent the account may not show it yet: going straight back still counts
  const sent = lev.lastSent && lev.lastSent.id === p.id && Date.now() - lev.lastSent.at < 15000 ? lev.lastSent : set;
  if (sent && sent.leverage === p.leverage && sent.cross === p.cross) { lev.pending = null; return; }
  lev.lastSent = { id: p.id, leverage: p.leverage, cross: p.cross, at: Date.now() };
  const run = api(`/leverage?market_id=${p.id}&leverage=${p.leverage}&cross=${p.cross}`, { method: "POST" }).then(() => {
    toast(t("{sym}: leva impostata a {lev}x {mode}", { sym: m.symbol, lev: p.leverage, mode: p.cross ? "cross" : "isolated" }), "ok");
    return true;
  }).catch((e) => {
    toast(e.message, true);
    if (lev.pending === p) lev.pending = null;
    lev.lastSent = null;
    const now = levSet(m);
    lev.cross = now ? now.cross !== false : true;
    if (lev.open && lev.market.id === p.id) { // back to what the account really has
      levLoad(now ? now.leverage : Math.min(m.default_leverage || 5, lev.max));
      levDraw();
    }
    renderTicket();
    updateTicketSummary();
    return false;
  });
  lev.sending = run;
  const ok = await run;
  if (lev.sending === run) lev.sending = null;
  return ok;
}

// before an order: a change still waiting or on its way has to land first. False when it failed.
async function levFlush() {
  levSettle();
  if (lev.sendTimer) return (await levSend()) !== false;
  if (lev.sending) return (await lev.sending) !== false;
  return true;
}

function wireLevWheel() {
  const btn = $("#tkLev"), box = $("#levDrum");
  const colOf = (el) => { const c = el && el.closest && el.closest(".lev-col"); return c ? +c.dataset.col : 0; }; // on the button: whole numbers
  const onWheel = (e) => {
    if (!levOpen(lev.pinned)) return;
    e.preventDefault();
    const k = colOf(e.target), c = lev.cols[k];
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
    c.target = levClamp(k, c.target + px / 100); // one notch of a mouse wheel is one step
    levAnimate();
    clearTimeout(lev.snapTimer);
    lev.snapTimer = setTimeout(() => { for (const x of lev.cols) x.target = Math.round(x.target); levAnimate(); }, 120); // a trackpad rests on a value
    levRest();
  };
  btn.addEventListener("wheel", onWheel, { passive: false });
  box.addEventListener("wheel", onWheel, { passive: false });

  // a finger, or the mouse held down: the drum follows it; a short flick carries on and stops at the ends
  const down = (e) => {
    if (e.button) return;
    const k = colOf(e.target);
    lev.drag = { k, y: e.clientY, from: lev.open ? lev.cols[k].target : null, moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0, target: e.target, onBtn: e.currentTarget === btn };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = lev.drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientY - d.y) < 4) return;
      if (!levOpen(lev.pinned)) { lev.drag = null; return; }
      d.moved = true;
      if (d.from === null) d.from = lev.cols[d.k].target;
      clearTimeout(lev.closeTimer);
    }
    e.preventDefault();
    const c = lev.cols[d.k];
    c.target = c.pos = levClamp(d.k, d.from + (d.y - e.clientY) / LEV_ROW); // finger up: the rows go up, towards the maximum
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (d.lastY - e.clientY) / LEV_ROW / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    levDraw();
  };
  const up = (e) => {
    const d = lev.drag;
    if (!d) return;
    lev.drag = null;
    if (!d.moved) { // a tap: on the button it opens or closes the drum, on a row it picks that row
      if (d.onBtn) { if (lev.open) levClose(); else levOpen(true); return; }
      const row = d.target.closest && d.target.closest("[data-row]");
      if (row) { lev.cols[d.k].target = levClamp(d.k, +row.dataset.row); levAnimate(); }
      return;
    }
    const flick = e.timeStamp - d.lastT < 80 ? d.v * 220 : 0, c = lev.cols[d.k];
    c.target = Math.round(levClamp(d.k, c.target + flick));
    levAnimate();
    levRest();
  };
  for (const el of [btn, box]) {
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", () => { lev.drag = null; });
  }
  $("#tkMode").onclick = (e) => { const b = e.target.closest("[data-cross]"); if (b) levMode(b.dataset.cross === "1"); };
  btn.addEventListener("click", (e) => { if (e.detail === 0) { if (lev.open) levClose(); else levOpen(true); } }); // from the keyboard
  document.addEventListener("pointerdown", (e) => { if (lev.open && !e.target.closest("#levDrum, #tkLev")) levClose(); });
  document.addEventListener("keydown", (e) => {
    if (!lev.open) return;
    if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); levClose(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      lev.cols[0].target = levClamp(0, Math.round(lev.cols[0].target) + (e.key === "ArrowDown" ? 1 : -1));
      levAnimate();
      levRest();
    }
  }, true);
  window.addEventListener("resize", () => { if (lev.open) levPlace(); });
  document.addEventListener("scroll", () => { if (lev.open && !lev.drag) levPlace(); }, true);
}

function renderArmed(armed) {
  info.armed = armed;
  const b = $("#armedBtn");
  b.classList.toggle("on", armed);
  $("span", b).textContent = armed ? "Auto ON" : "Auto OFF";
  $("span", b).dataset.ck = "armed";
  markConfirm();
  $("#autoState").textContent = armed ? t("Le automazioni sono attive: il server può inviare ordini.") : t("Interruttore generale spento: nessuna regola invia ordini.");
  // trailing controls say whether they're running
  if (account) renderPositions();
  if ($("#tkTrailBox").children.length) trailHint($("#tkTrailBox"));
}

// ================= activity log =================
let logSeq = 0;
function addLogs(entries) {
  entries = entries.filter((l) => l.seq > logSeq);
  if (!entries.length) return;
  logSeq = entries[entries.length - 1].seq;
  for (const box of [$("#btab-log"), $("#activityLog")]) {
    if (box.querySelector(".empty")) box.innerHTML = "";
    for (const l of entries) {
      const row = document.createElement("div");
      row.className = "row " + l.level;
      row.innerHTML = `<time>${new Date(l.ts * 1000).toLocaleTimeString(LOCALE)}</time><span>${esc(l.msg)}</span>`;
      box.prepend(row);
    }
    while (box.children.length > 300) box.lastChild.remove();
  }
  loadRules();
  loadEventRules();
}

// ================= live socket =================
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => setStatus(true);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "tick") onTick(msg);
  };
  ws.onclose = () => { setStatus(false); setTimeout(connect, 2000); };
}
// a tick: from the live socket every second, or the snapshot the page asked for while it opened
function onTick(msg) {
    prices = msg.prices;
    lastTick = Date.now();
    if (Live.on) {
      const a = Live.auto();
      msg.account = Live.account();
      msg.stops = a.stops || {};
      msg.exits = a.exits || {};
      msg.working = a.working || {};
      msg.logs = Live.logs(logSeq);
      msg.armed = !!a.armed;
      document.body.classList.toggle("browser-auto", !!a.on);
      if (Live.tick()) { fetchOpenOrders(true).catch(() => {}); if (!$("#btab-trades").classList.contains("hidden")) loadTrades(); }
    } else if (Paper.on) {
      const moved = Paper.tick();
      msg.account = Paper.account();
      msg.stops = Paper.stops();
      msg.exits = Paper.exits();
      msg.logs = Paper.logs(logSeq);
      if (moved) { fetchOpenOrders(true).catch(() => {}); if (!$("#btab-trades").classList.contains("hidden")) loadTrades(); }
    }
    const stopsChanged = JSON.stringify(msg.stops || {}) !== JSON.stringify(stops) || JSON.stringify(msg.exits || {}) !== JSON.stringify(exits);
    stops = msg.stops || {};
    exits = msg.exits || {};
    working = msg.working || {};
    const accChanged = stopsChanged || JSON.stringify(msg.account) !== JSON.stringify(account);
    account = msg.account;
    accountPageFollow();
    panels.forEach((p) => p.tick());
    renderMarketBar();
    renderTicker();
    renderTitle();
    updateTicketSummary();
    if (accChanged) renderAccount();
    else if (account) renderPositions();
    if (msg.armed !== info.armed) renderArmed(msg.armed);
    if (msg.logs.length) addLogs(msg.logs);
    checkAlerts();
    checkAutoAlerts();
    if (!$("#view-markets").classList.contains("hidden") && Date.now() - (renderMarkets.at || 0) > 2000) {
      renderMarkets.at = Date.now();
      renderMarkets();
    }
}

let feedOk = false;
function setStatus(ok) {
  feedOk = ok;
  // shown only while the live prices are cut off (the footer already says they're live)
  $("#statusPill").innerHTML = `<i class="dot warn"></i><span>${t("Riconnessione…")}</span>`;
  $("#statusPill").classList.toggle("hidden", ok);
}

// ================= automations page =================
// What the automations are, and how far they run from Lighter: the server's round trip to Lighter (its price
// feed's keepalive ping and Lighter's recent answer times), next to this browser's own trip to Lighter and
// to LighterDeck, measured when the page opens. The rules and limits forms are the personal deck's, live only.
const autoOpsShown = () => !info.public && !Paper.on;
const lat = { ws: null, api: null, you: null, deck: null, loc: "", at: 0 };
const fmtMs = (v) => (v === null || v === undefined ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)}<small>ms</small>`);
function renderLatency() {
  $("#latWs").innerHTML = fmtMs(lat.ws);
  $("#latApi").innerHTML = fmtMs(lat.api);
  $("#latYou").innerHTML = fmtMs(lat.you);
  $("#latDeck").innerHTML = fmtMs(lat.deck);
  if (lat.fast) $("#axNote").textContent = t("Il motore reagisce a ogni cambio del miglior prezzo nel book dei mercati con una regola attiva, cioè ogni pochi millisecondi; il conto si rilegge ogni 3 secondi e uno stop si sposta al massimo una volta al secondo.");
  if (lat.ws === null) { $("#latWhy").textContent = ""; return; } // the first ping comes within 10 seconds
  const ms = lat.ws < 10 ? lat.ws.toFixed(1) : Math.round(lat.ws);
  // "why so low" only where it is low: a deck run far from Lighter says how far it is instead
  let why = lat.ws >= 50 ? t("Il server di questo LighterDeck è a {ms} ms da Lighter: più è vicino ai server di Lighter, prima partono gli ordini automatici.", { ms })
    : lat.loc
    ? t("Il server di LighterDeck sta a {loc}, accanto ai server di Lighter. Un ordine automatico parte da lì e arriva a Lighter senza passare dal tuo computer né dalla tua connessione.", { loc: esc(lat.loc) })
    : t("Il server di LighterDeck sta accanto ai server di Lighter. Un ordine automatico parte da lì e arriva a Lighter senza passare dal tuo computer né dalla tua connessione.");
  if (lat.ws < 50 && lat.you !== null && lat.ws && lat.you / lat.ws >= 2) {
    why += "<br>" + t("Dalla tua connessione lo stesso viaggio richiede {you} ms: <b>{x} volte</b> tanto.", { you: Math.round(lat.you), x: Math.round(lat.you / lat.ws) });
  }
  $("#latWhy").innerHTML = why;
}
// the fastest of a few back-to-back requests: the first one also pays for opening the connection
async function timeFetch(url, n = 4) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try { await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) }); } catch { continue; }
    const d = performance.now() - t0;
    if (i > 0 || n === 1) best = best === null ? d : Math.min(best, d);
  }
  return best;
}
async function loadServerLatency() {
  const r = await api("/latency").catch(() => null);
  if (!r) return;
  Object.assign(lat, { ws: r.ws_ms, api: r.api_ms, loc: r.location || "", fast: !!r.engine_fast, at: Date.now() });
  renderLatency();
  renderFooterLatency();
}
// the status bar: the server's round trip to Lighter, on every page
function renderFooterLatency() {
  const el = $("#sbLat");
  el.classList.toggle("hidden", lat.ws === null);
  if (lat.ws !== null) el.textContent = t("Server → Lighter {ms} ms", { ms: lat.ws < 10 ? lat.ws.toFixed(1) : Math.round(lat.ws) });
}
let latBusy = false;
async function measureLatency() {
  if (latBusy) return;
  latBusy = true;
  try {
    await loadServerLatency();
    lat.deck = await timeFetch("/api/latency");
    renderLatency();
    // a tiny call Lighter always answers itself: its root page comes from the nearest CDN cache instead
    if (info.lighter_url) lat.you = await timeFetch(info.lighter_url + "/api/v1/nextNonce?account_index=0&api_key_index=0");
    lat.at = Date.now();
    renderLatency();
  } finally {
    latBusy = false;
  }
}
function renderAutoPage() {
  $("#autoOps").classList.toggle("hidden", !autoOpsShown());
  $("#autoState").classList.toggle("hidden", !autoOpsShown()); // the deck's own engine state
  const cta = $("#axCta"), a = Live.on ? Live.auto() : {};
  let html;
  if (!info.public) {
    html = Paper.on
      ? `<b>${t("Sei in paper trading")}</b><p>${t("In paper le automazioni girano in questo browser, mentre la pagina è aperta. Passa al live per usare quelle del server.")}</p>`
      : `<b>${info.armed ? `<span class="on">${t("Auto acceso")}</span>` : t("Auto spento")}</b><p>${t("Il motore di questo deck gira sul server: le regole qui sotto partono anche a pagina chiusa, quando Auto è acceso.")}</p>`;
  } else if (!Live.on) {
    html = `<b>${t("Prova le automazioni")}</b><p>${Paper.on ? t("Sei in paper trading: trailing stop, uscite a scaglioni e breakeven girano in questo browser, con soldi simulati.") : ""} ${info.browser_automations ? t("Collega una chiave per farle girare sul server, anche a pagina chiusa.") : t("Collega una chiave per usarle con il tuo conto Lighter.")}</p><button class="primary" type="button" data-ax="key">${t("Collega una chiave")}</button>`;
  } else if (info.browser_automations && !a.on) {
    html = `<b>${t("Porta le automazioni sul server")}</b><p>${t("Affida al server una seconda chiave API, cifrata: le automazioni partono da lì, a pochi millisecondi da Lighter, anche a pagina chiusa. Puoi cancellarla quando vuoi.")}</p><button class="primary" type="button" data-ax="key">${t("Attiva le automazioni")}</button>`;
  } else if (info.browser_automations) {
    html = `<b class="on">${t("Automazioni attive sul server")}</b><p>${t("La tua chiave per le automazioni è sul server, cifrata. Accendi Auto in alto per farle partire.")}</p>`;
  } else {
    html = `<b>${t("Automazioni nella pagina")}</b><p>${t("Su questo sito le automazioni girano nel tuo browser, mentre la pagina è aperta.")}</p>`;
  }
  cta.innerHTML = html;
  renderLatency();
}
function wireAutoPage() {
  $("#axCta").addEventListener("click", (e) => { if (e.target.closest('[data-ax="key"]')) openKeyDialog(); });
  loadServerLatency();
  setInterval(() => { if (!document.hidden) loadServerLatency(); }, 10000); // the server's figures move on (status bar too)
}

// ================= changelog page =================
// The story so far, from changelog.json (written in English, newest first): a numbers strip, a timeline
// of the releases with their groups of changes, and an index on the left that follows the scroll.
let changelog = null;
function loadChangelog() {
  if (changelog) { renderChangelog(); return; }
  fetch("changelog.json?v=4").then((r) => r.json()).then((d) => { changelog = d; renderChangelog(); }).catch(() => {});
}
// **bold**, *highlight*, `code`
const logMd = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>");
const logDay = (d) => new Date(d + "T12:00:00Z");
const logDate = (d, o = { day: "numeric", month: "short", year: "numeric" }) => logDay(d).toLocaleDateString(LOCALE, o);
function logItems(items) {
  return `<ul>${items.map((it) => {
    if (typeof it === "string") return `<li>${logMd(it)}</li>`;
    const table = it.table ? `<table class="log-table"><thead><tr>${it.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${it.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
    return `<li>${logMd(it.t)}${it.sub ? logItems(it.sub) : ""}${table}</li>`;
  }).join("")}</ul>`;
}
function renderChangelog() {
  const d = changelog;
  if (!d) return;
  const rels = d.releases, shipped = rels.filter((r) => r.v), latest = shipped[0], next = rels.find((r) => !r.v);
  const count = (items) => items.reduce((n, it) => n + 1 + (typeof it === "object" && it.sub ? count(it.sub) : 0), 0);
  const nextCount = next ? next.groups.reduce((n, g) => n + count(g.items), 0) : 0;
  $("#logLang").classList.toggle("hidden", LANG === "en");
  $("#logStats").innerHTML = [
    [t("Ultima versione"), "v" + latest.v, logDate(latest.date)],
    [t("In arrivo"), nextCount, t("modifiche dopo la {v}", { v: latest.v })],
  ].map(([k, v, s]) => `<div><span class="k">${esc(k)}</span><b>${esc(v)}</b><small>${esc(s)}</small></div>`).join("");
  const id = (r) => "log-" + (r.v ? r.v.replace(/\./g, "-") : "next");
  $("#logNav").innerHTML = rels.map((r) => `<a href="#${id(r)}" data-to="${id(r)}">${r.v ? "v" + esc(r.v) : esc(t("Prossima"))}<span>${esc(logDate(r.date, { day: "numeric", month: "short" }))}</span></a>`).join("")
    + `<a href="#log-origin" data-to="log-origin">${esc(t("Giorno uno"))}<span>${esc(logDate(d.origin.date, { day: "numeric", month: "short" }))}</span></a>`;
  $("#logList").innerHTML = rels.map((r) => {
    const when = r.v ? logDate(r.date)
      : t("dal {a} al {b}", { a: logDate(r.from, { day: "numeric", month: "short" }), b: logDate(r.date, { day: "numeric", month: "short" }) });
    return `<section class="log-rel${r.v ? (r === latest ? " latest" : "") : " next"}" id="${id(r)}">
      <header><span class="log-v">${r.v ? "v" + esc(r.v) : esc(t("Prossima versione"))}</span><span class="log-date">${esc(when)}</span></header>
      <p class="log-intro">${logMd(r.intro)}</p>
      <div class="log-tags">${r.tags.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
      <div class="log-groups">${r.groups.map((g) => `<div class="log-group"><h3>${esc(g.h)}</h3>${logItems(g.items)}</div>`).join("")}</div>
    </section>`;
  }).join("") + `<section class="log-origin" id="log-origin"><header><span class="log-v">${esc(t("Giorno uno"))}</span><span class="log-date">${esc(logDate(d.origin.date))}</span></header>
      <p>${logMd(d.origin.text)}</p></section>`;
  logSpy();
}
// the index marks the release at the top of the page
function logSpy() {
  const page = $("#logPage"), top = page.getBoundingClientRect().top + 60;
  let on = null;
  $$("#logList > section").forEach((s) => { if (s.getBoundingClientRect().top <= top) on = s.id; });
  on = on || ($("#logList > section") || {}).id;
  $$("#logNav a").forEach((a) => a.classList.toggle("on", a.dataset.to === on));
}
function wireChangelog() {
  $("#sbLog").onclick = (e) => { e.preventDefault(); switchView("log"); }; // from the status bar, in place
  $("#logPage").addEventListener("scroll", logSpy, { passive: true });
  $("#logNav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-to]");
    if (!a) return;
    e.preventDefault();
    const el = document.getElementById(a.dataset.to);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ================= ui wiring =================
// ---------- addresses ----------
// every page has its own path and the trade page names its market (/trade/WTI), so a link opens the
// same view, the browser's back button walks between pages, and a market can be shared directly
const ROUTES = { trade: "trade", markets: "markets", calendar: "cal", changelog: "log", account: "account", automations: "auto", activity: "activity" };
const PATH_OF = Object.fromEntries(Object.entries(ROUTES).map(([path, view]) => [view, path]));
let curView = "trade";
function routeFromUrl() {
  const [, page, sym] = location.pathname.split("/");
  return { view: ROUTES[page] || (page === "farming" ? "markets" : null), sym: sym ? symFromUrl(decodeURIComponent(sym).toUpperCase()) : null };
}
// the market in the address: a symbol, or "ETH-BTC" for a spread
const symFromUrl = (s) => (s && s.includes("-") && pairOf(s.replace("-", "/")) ? s.replace("-", "/") : s);
function syncUrl(push) {
  const m = activeMarket(), pr = activePair();
  const name = pr ? `${pr[0].symbol}-${pr[1].symbol}` : m && m.symbol;
  const path = "/" + PATH_OF[curView] + (curView === "trade" && name ? "/" + encodeURIComponent(name) : "");
  if (location.pathname !== path) history[push ? "pushState" : "replaceState"](null, "", path + location.search);
}

function switchView(v, opts = {}) {
  if ((info.public || Paper.on) && v === "activity") v = "trade"; // live account only
  $$("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  if (v === "markets") renderMarkets();
  if (v === "cal") renderCalPage();
  if (v === "log") loadChangelog();
  if (v === "account") loadAccountPage();
  if (v === "auto") { renderAutoPage(); measureLatency(); if (autoOpsShown()) { loadRules(); loadLimits(); } }
  store("view", v);
  curView = v;
  if (!opts.fromUrl) syncUrl(true);
}

function switchBottom(t) {
  $$("#bottomTabs [data-btab]").forEach((b) => b.classList.toggle("active", b.dataset.btab === t));
  $$(".btab").forEach((s) => s.classList.toggle("hidden", s.id !== "btab-" + t));
  fitBottomEmpty();
  if (t === "orders") loadOrders();
  if (t === "trades") loadTrades();
  if (t === "funding") loadFundingPaid();
  if (t === "alerts") renderAlerts();
}

function wire() {
  $$("#views button").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  // the logo goes back to Trade without reloading (a real link, so a new tab still works)
  $("#logoHome").onclick = (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); switchView("trade"); };
  $("#tfs").onclick = (e) => { const b = e.target.closest("[data-tf]"); if (b) setTf(b.dataset.tf); };
  $("#tfMoreBtn").onclick = (e) => { e.stopPropagation(); toggleTfMenu(); };
  $("#tfMenu").onclick = (e) => {
    e.stopPropagation();
    const pick = e.target.closest("[data-pick]"), show = e.target.closest("[data-show]");
    if (pick) { setTf(pick.dataset.pick); toggleTfMenu(false); }
    if (show) {
      const t = show.dataset.show;
      if (shownTfs.includes(t)) { if (shownTfs.length > 1) shownTfs = shownTfs.filter((x) => x !== t); }
      else shownTfs = ALL_TFS.filter((x) => x === t || shownTfs.includes(x)); // keep natural order
      store("tfs", shownTfs);
      renderTfs();
    }
  };
  $("#tfReset").onclick = (e) => { e.stopPropagation(); shownTfs = [...DEFAULT_TFS]; store("tfs", shownTfs); renderTfs(); };
  document.addEventListener("click", () => { toggleTfMenu(false); $("#elMenu").classList.add("hidden"); });
  $("#stFundBtn").onclick = (e) => { e.stopPropagation(); toggleFunding(); };
  $("#fundClose").onclick = () => toggleFunding(false);
  $("#fundPop").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-d]");
    if (b) { fundView.days = +b.dataset.d; loadFundingHistory(); }
  };
  document.addEventListener("click", () => fundView.open && toggleFunding(false));
  $("#elBtn").onclick = (e) => {
    e.stopPropagation();
    const menu = $("#elMenu");
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) { renderChartEls(); fitInView(menu); }
  };
  $("#elMenu").onclick = (e) => { e.stopPropagation(); const b = e.target.closest("[data-el]"); if (b) toggleChartEl(b.dataset.el); };
  $$("#layouts button").forEach((b) => (b.onclick = () => { layout = b.dataset.layout; store("layout", layout); buildCharts(); }));
  $("#obToggle").onclick = () => toggleBook(!showBook);
  $("#tapeToggle").onclick = () => toggleTape(!showTape);
  $("#mktSelect").onclick = (e) => {
    if (e.target.closest("#mkStar")) { // the star: in or out of the favourites, without opening the list
      const pr = activePair(), sym = pr ? `${pr[0].symbol}/${pr[1].symbol}` : activeMarket().symbol;
      toggleFav(sym);
      renderMkStar(sym);
      return;
    }
    $("#picker").classList.contains("hidden") ? openPalette() : closePalette();
  };
  wireTickerDrag();
  wireTickerScroll();
  wireTickerPeek();
  wireChangelog();
  wireAutoPage();
  wireToolbarFit();
  $("#ticker").onclick = (e) => { // from Markets or Calendar too: it opens Trade on that chart
    if (Date.now() - tickerDragEnd < 300) return;
    const b = e.target.closest("[data-sym]");
    if (!b) return;
    setSymbol(b.dataset.sym);
    if (curView !== "trade") switchView("trade");
  };

  // market picker lives in picker.js
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    else if (e.key === "Escape") closePalette();
  });

  // ticket
  $$("#sideSel [data-side]").forEach((b) => (b.onclick = () => { ticket.side = b.dataset.side; renderTicket(); }));
  $$("#kindSel button").forEach((b) => (b.onclick = () => {
    ticket.kind = b.dataset.kind;
    if (ticket.kind === "limit" && !$("#tkPrice").value) fillMid();
    renderTicket();
  }));
  $("#tkUnit").onchange = () => {
    renderTicket();
    $("#tkSize").value = ""; // the old number means something else in the new unit
    updateTicketSummary();
  };
  ["#tkSize", "#tkPrice"].forEach((s) => ($(s).oninput = updateTicketSummary));
  $("#tkPct").oninput = (e) => sizeFromPct(+e.target.value);
  $("#tkPctIn").oninput = (e) => { if (e.target.value === "") { $("#tkSize").value = ""; updateTicketSummary(); } else sizeFromPct(+e.target.value); };
  $("#tkPct").onchange = (e) => e.target.blur(); // let go: it follows the size again
  // each click adds to the size (4 × $100 = $400); clear the field to start again
  $("#tkChips").onclick = (e) => {
    if (e.target.closest("[data-max]")) {
      const m = activeMarket(), ref = m && ticketRef(m, prices[m.id]);
      if (m && riskNeedsStop(ref)) return ticketMsg(t("Imposta lo stop-loss: il rischio si calcola da lì"), "err");
      return sizeFromPct(100);
    }
    const b = e.target.closest("[data-v]");
    if (!b) return;
    const m = activeMarket(), unit = $("#tkUnit").value;
    let v = (+$("#tkSize").value || 0) + +b.dataset.v;
    v = unit === "base" && m ? +v.toFixed(m.size_decimals) : +v.toFixed(2);
    if (unit === "equity_pct") v = Math.min(100, v);
    $("#tkSize").value = v;
    updateTicketSummary();
  };
  $("#tkMid").onclick = fillMid;
  $("#tkProtectionToggle").onclick = toggleTicketProtection;
  // % / $ beside the SL and TP distances: a click picks one (the hidden select keeps the value the code reads)
  const syncUnitSeg = (seg) => {
    const v = $("#" + seg.dataset.unitFor).value;
    seg.querySelectorAll("[data-u]").forEach((b) => { b.classList.toggle("active", b.dataset.u === v); b.setAttribute("aria-checked", String(b.dataset.u === v)); });
  };
  $$(".unit-seg").forEach((seg) => {
    syncUnitSeg(seg);
    seg.onclick = (e) => {
      const b = e.target.closest("[data-u]"), sel = $("#" + seg.dataset.unitFor);
      if (!b || sel.value === b.dataset.u) return;
      sel.value = b.dataset.u;
      sel.dispatchEvent(new Event("change"));
      syncUnitSeg(seg);
    };
  });
  for (const id of ["Sl", "Tp"]) {
    const move = $(`#tk${id}Move`);
    move.oninput = () => {
      const m = activeMarket();
      if (!m) return;
      const ref = ticketRef(m, prices[m.id]), qty = ticketQuantity(ref);
      syncExitEditor(id, m, ref, qty && +qty.toFixed(m.size_decimals), true);
      updateTicketSummary();
    };
    move.onblur = updateTicketSummary;
    $(`#tk${id}Unit`).onchange = () => {
      move.setCustomValidity("");
      exitAnchor[id].on = "price"; // the old number means something else in the new unit: keep the price, show its distance
      updateTicketSummary();
    };
    $(`#tk${id}Exec`).onchange = updateTicketSummary;
    $(`#tk${id}Limit`).oninput = updateTicketSummary;
    $(`#tk${id}`).oninput = () => {
      move.setCustomValidity("");
      exitAnchor[id].on = "price";
      updateTicketSummary();
    };
  }
  $("#tkExec").onclick = (e) => (info.trading ? executeTicket(e.detail > 0) : openKeyDialog());
  $("#tkSlip").value = load("slipBps", 50);
  $(".ticket").addEventListener("click", (e) => { const b = e.target.closest("[data-slip]"); if (b) editSlip(b); });
  ["#tkSl", "#tkTp"].forEach((s) => $(s).addEventListener("wheel", wheelStop, { passive: false }));
  ["#tkSlMove", "#tkTpMove"].forEach((s) => $(s).addEventListener("wheel", wheelMove, { passive: false }));
  ["#tkReduce", "#tkPost"].forEach((s) => ($(s).onchange = updateTicketSummary));
  wireLevWheel();
  $("#limitsForm").oninput = renderLimitValues;
  $("#limitsForm").onsubmit = async (e) => {
    e.preventDefault();
    const patch = { on: {} };
    for (const el of e.target.elements) {
      if (el.dataset.on) patch.on[el.dataset.on] = el.checked;
      else if (el.name) patch[el.name] = +el.value;
    }
    try { await api("/limits", { method: "PATCH", body: JSON.stringify(patch) }); toast(t("Limiti salvati")); loadLimits(); }
    catch (err) { toast(err.message, true); }
  };

  // bottom tables
  $$("#bottomTabs [data-btab]").forEach((b) => (b.onclick = () => { setBottomFold(false); switchBottom(b.dataset.btab); }));
  $("#bottomFold").onclick = () => setBottomFold(!$("#bottom").classList.contains("folded"));
  setBottomFold(load("bottomFold", false));
  // resting on a close button shows what it would give back (on phones there's no hover, and it takes two taps anyway)
  $("#btab-positions").addEventListener("mouseover", (e) => {
    const b = e.target.closest("[data-close]");
    const pos = b && account && account.positions.find((p) => p.market_id === +b.dataset.close);
    if (!pos) return;
    const mark = prices[pos.market_id] && prices[pos.market_id].mark;
    marginView.hover = { market_id: pos.market_id, delta: (-pos.size * +b.dataset.f) / 100, price: mark || Math.abs(pos.value / pos.size), leverage: pos.leverage, cross: pos.cross };
    marginView.hoverEl = b;
    renderMargin();
  });
  $("#btab-positions").addEventListener("mouseout", (e) => {
    if (!marginView.hoverEl || !e.target.closest("[data-close]")) return;
    marginView.hover = marginView.hoverEl = null;
    renderMargin();
  });
  $("#accMgLegend").onclick = (e) => { const b = e.target.closest("[data-sym]"); if (b) setSymbol(b.dataset.sym); };
  $("#btab-positions").onclick = async (e) => {
    const ps = e.target.closest("[data-pstop]");
    if (ps && info.trading) return editPairStop(ps);
    const pc = e.target.closest("[data-pclose]");
    if (pc) {
      const f = +pc.dataset.f;
      if (f === 100 && !askConfirm(`pclose:${pc.dataset.pclose}`, t("Chiudi la coppia"))) return;
      if (f < 100 && !askConfirm(`pclose:${pc.dataset.pclose}:${f}`, t("Conferma {f}%", { f }))) return;
      return closePair(pc.dataset.pclose, f);
    }
    const up = e.target.closest("[data-unpair]");
    if (up) { pairs = await api(`/pairs/${encodeURIComponent(up.dataset.unpair)}`, { method: "DELETE" }).catch((err) => { toast(err.message, true); return pairs; }); return renderPositions(); }
    const gb = e.target.closest("[data-pairfrom]");
    if (gb) { e.stopPropagation(); return openPairGroup(gb, +gb.dataset.pairfrom); }
    const v = e.target.closest("[data-psl]");
    if (v && info.trading) { e.stopPropagation(); return openSltpPop(v); }
    const r = e.target.closest("[data-reverse]");
    if (r) return reversePosition(+r.dataset.reverse);
    const b = e.target.closest("[data-close]");
    if (!b) return;
    const mid = +b.dataset.close, f = +b.dataset.f;
    if (f === 100 && !askConfirm(`close:${mid}`, t("Chiudi tutto"))) return;
    if (f < 100 && !askConfirm(`close:${mid}:${f}`, t("Conferma {f}%", { f }))) return;
    try { await api(`/close?market_id=${mid}&fraction=${f / 100}`, { method: "POST" }); toast(t("Chiusura {f}%: ordine accettato", { f }), "ok"); } catch (err) { toast(err.message, true); }
  };
  $("#btab-alerts").onchange = (e) => {
    const c = e.target.closest("[data-auto]");
    if (!c) return;
    autoAlertsOn[c.dataset.auto] = c.checked;
    store("autoAlerts", autoAlertsOn);
    if (c.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  };
  $("#btab-alerts").onclick = (e) => {
    const x = e.target.closest("[data-alert-del]");
    if (x) removeAlert(x.dataset.alertDel);
    if (e.target.closest("[data-alert-clear]")) { alertsFired = []; store("alertsFired", alertsFired); renderAlerts(); }
  };
  $("#btab-orders").onclick = async (e) => {
    const b = e.target.closest("[data-cancel]");
    if (!b) return;
    const [mid, oi] = b.dataset.cancel.split(":");
    if (touchUI() && !askConfirm(`cancel:${mid}:${oi}`, t("Conferma"))) return;
    try { await api(`/cancel_order?market_id=${mid}&order_index=${oi}`, { method: "POST" }); toast(t("Ordine annullato")); loadOrders(true); } catch (err) { toast(err.message, true); }
  };

  // calendar
  $("#calOpen").onclick = () => switchView("cal");
  $("#accOpen").onclick = () => switchView("account");
  $("#acKey").onclick = () => openKeyDialog();
  $("#acLive").onclick = () => $("#paperLive").onclick();
  $("#acReset").onclick = () => { // the same start over as the paper dialog, with the balance it began with
    const bal = Paper.summary().balance;
    if (!askConfirm("acReset", t("Conferma: ricomincia con {bal}", { bal: fusd(bal, 0) }))) return;
    Paper.reset(bal);
    setPaper(true);
    acc.cache = {}; acc.mcache = {}; acc.data = null; acc.mkt = null;
    loadAccountPage();
    toast(t("Paper trading ripartito con {bal}", { bal: fusd(bal, 0) }));
  };
  $("#acDays").onclick = (e) => { const b = e.target.closest("[data-days]"); if (b) { acc.days = +b.dataset.days; store("acc.days", acc.days); loadAccountPage(); } };
  $("#acMode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { acc.mode = b.dataset.mode; store("acc.mode", acc.mode); renderAccountChart(); } };
  $("#acPrev").onclick = () => { acc.month = shiftMonth(acc.month, -1); acc.day = null; renderPnlCalendar(); };
  $("#acNext").onclick = () => { acc.month = shiftMonth(acc.month, 1); acc.day = null; renderPnlCalendar(); };
  $("#acCal").onclick = (e) => { const b = e.target.closest("[data-day]"); if (b) showDayFills(b.dataset.day); };
  $("#econOpen").onclick = () => { cp.scope = "mkt"; cp.market = activeMarket() && activeMarket().symbol; saveCp(); switchView("cal"); };
  // a country in the market hours: only its events (again: all of them)
  const pickCountry = (e) => {
    const r = e.target.closest("[data-cc]");
    if (!r) return false;
    cp.country = cp.country === r.dataset.cc ? null : r.dataset.cc;
    renderCalPage();
    return true;
  };
  $("#cpCount").onclick = pickCountry;
  // the same rows on the Trade page open the Calendar on that country
  $("#ctab-sessions").onclick = (e) => {
    const r = e.target.closest("[data-cc]");
    if (r) { cp.country = r.dataset.cc; switchView("cal"); }
  };
  $("#ctab-sessions").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#ctab-sessions").onclick(e); } };
  $("#cpSessions").onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && pickCountry(e)) e.preventDefault(); };
  $("#cpFilters").onclick = (e) => {
    if (pickCountry(e)) return;
    const b = e.target.closest("button");
    if (!b) return;
    const flip = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    if (b.dataset.scope) cp.scope = b.dataset.scope;
    if (b.dataset.type) cp.types = flip(cp.types, b.dataset.type);
    if (b.dataset.imp) cp.impacts = flip(cp.impacts, b.dataset.imp);
    if (b.dataset.range) cp.range = b.dataset.range;
    saveCp();
    renderCalPage();
  };
  // typing a market's name picks it (and the "One" filter); emptying the box goes back to all markets
  const cpPick = (v, final) => {
    v = v.trim().toUpperCase();
    if (!v) { if (final || cp.scope === "mkt") { cp.scope = "all"; saveCp(); renderCalPage(); } return; }
    if (bySymbol[v]) { cp.scope = "mkt"; cp.market = v; saveCp(); renderCalPage(); }
    else if (final) { $("#cpMarket").value = cp.scope === "mkt" ? cp.market || "" : ""; } // not a market: back to the chosen one
  };
  const mbox = $("#cpMarket"), pop = $("#cpMkPop");
  const cpChoose = (sym) => { cp.scope = "mkt"; cp.market = sym; saveCp(); mbox.value = sym; closeCpPop(); mbox.blur(); renderCalPage(); };
  mbox.onfocus = () => { mbox.select(); openCpPop(); };
  mbox.onclick = () => openCpPop();
  mbox.oninput = (e) => { cpPop.typing = true; cpPick(e.target.value, false); openCpPop(); renderCpPop(); };
  mbox.onchange = (e) => cpPick(e.target.value, true);
  mbox.onkeydown = (e) => {
    if (e.key === "Enter") { const first = $("#cpMkPop [data-cpmk]"); if (first && !bySymbol[mbox.value.trim().toUpperCase()]) cpChoose(first.dataset.cpmk); else { closeCpPop(); mbox.blur(); } }
    if (e.key === "Escape") { mbox.value = ""; cpPick("", true); closeCpPop(); mbox.blur(); }
  };
  pop.onmousedown = (e) => e.preventDefault(); // the box keeps the focus while the panel is used
  pop.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.cpstar) { toggleCalFav(b.dataset.cpstar); return renderCpPop(); } // the panel stays open
    if (b.dataset.cpmk) return cpChoose(b.dataset.cpmk);
    if (b.dataset.cptab !== undefined) { cpPop.tab = b.dataset.cptab; cpPop.cat = ""; }
    if (b.dataset.cpcat !== undefined) cpPop.cat = b.dataset.cpcat;
    renderCpPop();
  };
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#cpMkPop, #cpMarket")) closeCpPop(); });
  $("#cpSearch").oninput = renderCalPage;
  $("#cpList").onclick = (e) => {
    const s = e.target.closest("[data-cpsym]");
    if (s) { cp.scope = "mkt"; cp.market = s.dataset.cpsym; saveCp(); renderCalPage(); }
  };
  $("#cpTz").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop().replace("_", " ") + " · " + utcOffset();
  $$("#calTabs button").forEach((b) => (b.onclick = () => {
    $$("#calTabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".ctab").forEach((c) => c.classList.toggle("hidden", c.id !== "ctab-" + b.dataset.ctab));
  }));
  $("#eventForm").elements.market_id.addEventListener("change", renderEventSelect);
  // your own events: anything no feed covers (a token unlock, a network upgrade, a listing)
  $("#evAddBtn").onclick = () => {
    const f = $("#evForm");
    f.classList.toggle("hidden");
    if (f.classList.contains("hidden")) return;
    f.reset();
    const m = cp.scope === "mkt" && cp.market ? bySymbol[cp.market] : activeMarket();
    f.elements.markets.value = m ? m.symbol : "";
    f.elements.title.focus();
  };
  $("#evCancel").onclick = () => $("#evForm").classList.add("hidden");
  $("#evForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const ts = Math.floor(new Date(f.elements.when.value).getTime() / 1000);
    const body = { title: f.elements.title.value, ts, impact: f.elements.impact.value,
      markets: f.elements.markets.value.split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase()) };
    try {
      if (info.public) { // the public site keeps your events in this browser only
        if (!body.title.trim() || !body.markets.length || body.markets.some((s) => !bySymbol[s]) || !ts) throw new Error(t("Controlla titolo, data e mercati."));
        const assets = body.markets.map((s) => `sym:${s}`);
        store("myEvents", [...myEvents(), { id: "my" + Date.now().toString(36), title: body.title.trim().slice(0, 80), country: "", ts, impact: body.impact,
          source: "custom", assets, impact_by: Object.fromEntries(assets.map((a) => [a, body.impact])), markets: body.markets }]);
      } else await api("/custom_events", { method: "POST", body: JSON.stringify(body) });
      f.classList.add("hidden");
      toast(t("Evento aggiunto"));
      loadCalendar();
    } catch (err) { toast(err.message, true); }
  };
  const deleteEvent = async (e) => {
    const b = e.target.closest("[data-delev]");
    if (!b || !askConfirm(`delev:${b.dataset.delev}`, t("Elimina"))) return;
    try {
      if (info.public) store("myEvents", myEvents().filter((x) => x.id !== b.dataset.delev));
      else await api(`/custom_events/${b.dataset.delev}`, { method: "DELETE" });
      toast(t("Evento eliminato"));
      loadCalendar();
    }
    catch (err) { toast(err.message, true); }
  };
  $("#econList").addEventListener("click", deleteEvent);
  $("#cpList").addEventListener("click", deleteEvent);
  $("#calTz").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop().replace("_", " ") + " · " + utcOffset();

  // markets page
  $("#mktSearch").oninput = renderMarkets;
  $(".mkt-filters").onclick = (e) => {
    const b = e.target.closest("[data-mtab], [data-mcat]");
    if (!b) return;
    if (b.dataset.mtab) { mktTab = b.dataset.mtab; mktCat = ""; store("mktTab", mktTab); }
    if (b.dataset.mcat !== undefined) mktCat = b.dataset.mcat;
    store("mktCat", mktCat);
    renderMarkets();
  };
  $$("#mktTable th[data-sort]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    mktSort = { key: k, dir: mktSort.key === k ? -mktSort.dir : k === "symbol" ? 1 : -1 };
    renderMarkets();
  }));
  $("#mktTable tbody").onclick = (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const s = star.dataset.star;
      favs = favs.includes(s) ? favs.filter((x) => x !== s) : [...favs, s];
      store("favs", favs);
      renderMarkets();
      renderTicker();
      return;
    }
    const tr = e.target.closest("tr[data-sym]");
    if (tr) { setSymbol(tr.dataset.sym); switchView("trade"); }
  };

  // a pending confirm goes away with Esc, a click on anything else, or a change in the ticket
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { cancelConfirm(); panels.forEach((p) => p.hold && p.endMove(false)); if (fundView.open) toggleFunding(false); } });
  document.addEventListener("mousedown", (e) => {
    if (pendingConfirm && !e.target.closest(`[data-ck="${pendingConfirm.key}"], #armedBtn`)) cancelConfirm();
  });
  for (const ev of ["input", "change"]) $(".ticket").addEventListener(ev, () => { if (pendingConfirm && pendingConfirm.key === "order") cancelConfirm(); });
  // changing the ticket (size, slider, price, side, type…) makes the last answer stale
  for (const ev of ["input", "change"]) $(".ticket").addEventListener(ev, (e) => { if (!e.target.closest("#tkMsg")) hideTicketMsg(); });
  $(".ticket").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && !b.closest("#tkMsg") && b.id !== "tkExec" && !b.classList.contains("execute")) hideTicketMsg();
  });

  // automations
  $("#armedBtn").onclick = async () => {
    const next = !info.armed;
    if (next && !askConfirm("armed", t("Conferma Auto ON"))) return;
    try { const r = await api(`/armed?armed=${next}`, { method: "POST" }); renderArmed(r.armed); } catch (e) { toast(e.message, true); }
  };
  $("#modeSelect").onchange = (e) => {
    const br = e.target.value === "breakout";
    $$(".m-breakout").forEach((x) => x.classList.toggle("hidden", !br));
    $$(".m-fixed").forEach((x) => x.classList.toggle("hidden", br));
  };
  for (const [sel, type] of [["#stopForm", "managed_stop"], ["#eventForm", "event_trade"]]) {
    $(sel).onsubmit = async (e) => {
      e.preventDefault();
      try { await api("/rules", { method: "POST", body: JSON.stringify({ type, ...formToRule(e.target) }) }); toast(t("Regola aggiunta")); loadRules(); }
      catch (err) { toast(err.message, true); }
    };
  }
  $("#rules").onclick = async (e) => {
    const tog = e.target.closest("[data-toggle]"), d = e.target.closest("[data-del]");
    if (tog) await api(`/rules/${tog.dataset.toggle}`, { method: "PATCH", body: JSON.stringify({ enabled: tog.dataset.en !== "1" }) });
    if (d && !askConfirm(`del:${d.dataset.del}`, t("Conferma"))) return;
    if (d) {
      await api(`/rules/${d.dataset.del}`, { method: "DELETE" });
      toast(t("Regola eliminata: un ordine stop già piazzato resta su Lighter."));
    }
    if (tog || d) loadRules();
  };
}

function fillMid() {
  const m = activeMarket();
  const p = m && prices[m.id];
  if (p && p.bid && p.ask) $("#tkPrice").value = ((p.bid + p.ask) / 2).toFixed(decimals(m));
  updateTicketSummary();
}

function utcOffset() {
  const o = -new Date().getTimezoneOffset() / 60;
  return "UTC" + (o >= 0 ? "+" : "") + o;
}

function clock() {
  const d = new Date();
  $("#sbClock").textContent = `${hhmm(d, true)} ${utcOffset()}`;
  // "Live data" turns amber when no prices have come for a few seconds (the server sends them every second)
  const stale = !lastTick || Date.now() - lastTick > 5000, live = $(".statusbar .live");
  live.classList.toggle("stale", stale);
  live.title = stale ? t("Nessun prezzo da più di 5 secondi") : "";
}

// ================= scaled exits: TP1, TP2... each closing a share of the order =================
// One plan per market on the server (or the paper engine): sized reduce-only take-profits, and the
// stop to breakeven once TP1 fills. Two to five levels; what the shares leave open stays in the position.
let exits = {};
const TP_SPLITS = { 2: [50, 50], 3: [33, 33, 34], 4: [25, 25, 25, 25], 5: [20, 20, 20, 20, 20] };

function readTpLevels() {
  const box = $("#tkTpBox");
  if (box.classList.contains("hidden")) return null;
  const rows = [...box.querySelectorAll(".tp-row")];
  return rows.map((r) => ({ price: +r.querySelector("[data-tp-price]").value || null, pct: +r.querySelector("[data-tp-pct]").value || 0 }));
}

function renderTpLevels(levels) {
  const on = !!levels, box = $("#tkTpBox"), tp = $("#tkTp");
  $("#tkScaled").checked = on;
  // the single take-profit stays where it is, handing over to the levels below
  tp.disabled = on;
  tp.placeholder = "—"; // ticked or not, the box under it says which
  if (on) { tp.value = ""; $("#tkTpOut").textContent = ""; $("#tkTpOut").className = "sltp-out"; $("#tkTpMove").value = ""; }
  box.classList.toggle("hidden", !on);
  if (!on) { box.innerHTML = ""; updateTicketSummary(); return; }
  const be = $("#tkTpBe") ? $("#tkTpBe").checked : load("tpBe", true);
  box.innerHTML = `<div class="tp-head"><span>${t("Livelli")}</span><div class="tk-mode tp-count">${[2, 3, 4, 5].map((n) =>
      `<button type="button" data-tp-split="${n}" class="${levels.length === n ? "active" : ""}">${n}</button>`).join("")}</div></div>
    ${levels.map((l, i) => `<div class="tp-row"><b>TP${i + 1}</b><input data-tp-price type="number" step="any" autocomplete="off" placeholder="${t("prezzo")}" value="${l.price || ""}">
      <label class="tp-share"><input data-tp-pct type="number" min="0" max="100" step="any" autocomplete="off" title="${t("Quota %")}" value="${l.pct}"><span>%</span></label>
      ${levels.length > 2 ? `<button type="button" class="tp-x" data-tp-del="${i}" title="${t("Togli il livello")}">×</button>` : "<span></span>"}</div>`).join("")}
    <div class="checks tp-foot"><label><input type="checkbox" id="tkTpBe" ${be ? "checked" : ""}> ${t("Dopo TP1 stop a breakeven")}</label></div>
    <p class="trail-hint" id="tkTpHint"></p>`;
  tpHint();
  updateTicketSummary();
}

// equal shares for n levels, keeping the prices already typed
function splitTpLevels(n) {
  const cur = readTpLevels() || [{ price: +$("#tkTp").value || null }];
  renderTpLevels(TP_SPLITS[n].map((pct, i) => ({ price: cur[i] ? cur[i].price : null, pct })));
}

function tpHint() {
  const levels = readTpLevels(), hint = $("#tkTpHint");
  if (!levels || !hint) return;
  const rest = 100 - levels.reduce((s, l) => s + l.pct, 0);
  const parts = [];
  if (rest > 0.05) parts.push(t("Il {pct}% resta aperto", { pct: +rest.toFixed(1) }) + ($("#tkTrail").checked ? " " + t("con il trailing.") : "."));
  else if (rest < -0.05) parts.push(t("Le quote superano il 100%."));
  const needsAuto = $("#tkTpBe").checked || ticket.kind === "limit";
  if (!autoOn() && needsAuto) parts.push(t("Auto è OFF: il breakeven dopo TP1 (e i TP di un limit) parte quando lo attivi."));
  hint.textContent = parts.join(" ");
  hint.classList.toggle("warn", rest < -0.05 || (!autoOn() && needsAuto));
}

function wireTpLevels() {
  $("#tkScaled").onchange = (e) => {
    if (e.target.checked) return splitTpLevels(2);
    const first = (readTpLevels() || [])[0]; // back to one take-profit, at the first level's price
    renderTpLevels(null);
    $("#tkTp").value = first && first.price ? first.price : "";
    updateTicketSummary();
  };
  const box = $("#tkTpBox");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tpSplit) splitTpLevels(+b.dataset.tpSplit);
    else if (b.dataset.tpDel !== undefined) {
      const lv = readTpLevels().filter((_, i) => i !== +b.dataset.tpDel);
      renderTpLevels(TP_SPLITS[lv.length].map((pct, i) => ({ price: lv[i].price, pct })));
    }
  });
  box.addEventListener("input", () => { tpHint(); updateTicketSummary(); });
  // Enter in a level's fields sends the order, like the other ticket fields
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[type=number]")) { e.preventDefault(); $("#tkExec").click(); } });
  box.addEventListener("change", (e) => { if (e.target.id === "tkTpBe") { store("tpBe", e.target.checked); tpHint(); updateTicketSummary(); } });
  $("#tkTrail").addEventListener("change", tpHint);
}

// ================= trailing stop (ticket + open positions) =================
// The server keeps one managed stop per market; it trails while automations are ON (Auto).
let stops = {};
const TRAIL_UNITS = [["pnl", "% PnL"], ["pct", "% prezzo"], ["price", "$"], ["atr", "× ATR"]];
const TRAIL_DEFAULT = { mode: "pnl", value: 10 };

function trailToStop(tr) { // ticket/editor values -> the server's field names
  return { [`trail_${tr.mode}`]: tr.value, trail_activate_pct: tr.activate_pct, breakeven_at_pct: tr.breakeven_at_pct };
}

function trailLabel(s, m) {
  return s.trail_pnl ? `${s.trail_pnl}% PnL` : s.trail_pct ? `${s.trail_pct}%` : s.trail_price ? `$${fp(s.trail_price, m)}` : s.trail_atr ? `${s.trail_atr}× ATR` : "BE";
}

function trailForm(v) {
  const unit = TRAIL_UNITS.map(([k, u]) => `<option value="${k}" ${v.mode === k ? "selected" : ""}>${t(u)}</option>`).join("");
  return `<div class="trail-dist"><div class="field sm"><label title="${t("Distanza dal prezzo migliore")}">${t("Distanza")}</label><input data-tr="value" type="number" min="0" step="any" value="${v.value ?? ""}" placeholder="${v.mode === "atr" ? "1.5" : v.mode === "price" ? "" : "1"}"></div>
      <select data-tr="mode">${unit}</select></div>
    <div class="two"><div class="field sm"><label>${t("Parte da PnL +%")}</label><input data-tr="activate_pct" type="number" min="0" step="any" value="${v.activate_pct || ""}" placeholder="0"></div>
      <div class="field sm"><label>${t("Breakeven a PnL +%")}</label><input data-tr="breakeven_at_pct" type="number" min="0" step="any" value="${v.breakeven_at_pct ?? ""}" placeholder="${t("Opzionale")}"></div></div>
    <p class="trail-hint" data-tr="hint"></p>`;
}

function trailHint(box) {
  const mode = box.querySelector('[data-tr="mode"]').value;
  const parts = [mode === "atr" ? t("ATR(14) su candele da 15 minuti: la distanza si adatta alla volatilità.") : mode === "price" ? t("Distanza fissa in dollari dal prezzo migliore.")
    : mode === "pnl" ? t("Quanto PnL cedi dal punto migliore, con la leva della posizione.") : t("Distanza in % dal prezzo migliore raggiunto.")];
  parts.push(t("Lo stop si muove solo a tuo favore."));
  const hint = box.querySelector('[data-tr="hint"]');
  hint.textContent = parts.join(" ") + (autoOn() ? "" : " " + t("Auto è OFF: il trailing parte quando lo attivi."));
  hint.classList.toggle("warn", !autoOn());
}

function readTrail(box) {
  const val = (k) => box.querySelector(`[data-tr="${k}"]`).value;
  const tr = { mode: val("mode"), value: +val("value"), activate_pct: +val("activate_pct") || 0 };
  if (+val("breakeven_at_pct") > 0) tr.breakeven_at_pct = +val("breakeven_at_pct");
  return tr.value > 0 ? tr : null;
}

function mountTrailForm(box, values, onChange) {
  box.innerHTML = trailForm(values);
  trailHint(box);
  box.oninput = box.onchange = () => { trailHint(box); onChange && onChange(); };
}

function renderTicketTrail() {
  const on = $("#tkTrail").checked && !$("#tkReduce").checked;
  $("#tkTrail").closest(".checks").classList.toggle("hidden", $("#tkReduce").checked);
  $("#tkTrailBox").classList.toggle("hidden", !on);
  if (on && !$("#tkTrailBox").children.length) {
    mountTrailForm($("#tkTrailBox"), load("trailPrefs", TRAIL_DEFAULT), () => {
      const tr = readTrail($("#tkTrailBox"));
      if (tr) store("trailPrefs", tr);
      updateTicketSummary();
    });
    // in the ticket the unit sits inside the distance field, like the SL/TP %/USD menus
    const box = $("#tkTrailBox");
    box.querySelector(".trail-dist .field").append(box.querySelector('[data-tr="mode"]'));
  }
  updateTicketSummary();
}

function trailButton(marketId, m) {
  const s = stops[marketId];
  if (!s) return `<button class="trail-btn" data-trail="${marketId}">+ ${t("Trailing")}</button>`;
  const paused = !autoOn() || !s.enabled;
  const title = paused ? t("Auto è OFF: il trailing è fermo") : t("Stop gestito attivo");
  return `<button class="trail-btn on${paused ? " paused" : ""}" data-trail="${marketId}" title="${title}">${trailLabel(s, m)}${s.stop ? " · " + fp(s.stop, m) : ""}</button>${runsIcon("trail")}`;
}

function openTrailPop(marketId, anchor) {
  const m = byId[marketId], s = stops[marketId];
  const pop = $("#trailPop");
  pop.dataset.market = marketId;
  $("#trailPopTitle").textContent = t("Trailing stop · {sym}", { sym: m.symbol });
  const v = s ? { mode: s.trail_pnl ? "pnl" : s.trail_pct ? "pct" : s.trail_price ? "price" : "atr", value: s.trail_pnl || s.trail_pct || s.trail_price || s.trail_atr,
    activate_pct: s.trail_activate_pct, breakeven_at_pct: s.breakeven_at_pct } : load("trailPrefs", TRAIL_DEFAULT);
  $("#trailPopBody").innerHTML = `<div class="trail-box"></div>`;
  mountTrailForm($("#trailPopBody .trail-box"), v);
  $("#trailPopRemove").classList.toggle("hidden", !s);
  $("#trailPopError").classList.add("hidden");
  pop.classList.remove("hidden");
  // open above the button, kept inside the window
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + "px";
  pop.style.top = Math.max(12, r.top - h - 8 < 12 ? r.bottom + 8 : r.top - h - 8) + "px";
  pop.querySelector('[data-tr="value"]').focus();
}

function closeTrailPop() { $("#trailPop").classList.add("hidden"); }

function wireTrail() {
  $("#tkTrail").onchange = renderTicketTrail;
  wireTpLevels();
  wireBadges();
  wireSltpPop();
  wireCardTables();
  wireAdvOrders();
  wirePairGroup();
  wireEventTrades();
  $("#mktSpread").onclick = openSpreadPicker;
  $("#alertCount").textContent = alerts.length;
  $("#tkReduce").addEventListener("change", renderTicketTrail);
  $("#btab-positions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-trail]");
    if (b) { e.stopPropagation(); openTrailPop(+b.dataset.trail, b); }
  });
  $("#trailPopClose").onclick = $("#trailPopCancel").onclick = closeTrailPop;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTrailPop(); });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#trailPop, [data-trail]")) closeTrailPop(); });
  const done = (res) => { stops = res.stops; closeTrailPop(); renderPositions(); };
  const fail = (err) => { $("#trailPopError").textContent = err.message; $("#trailPopError").classList.remove("hidden"); };
  $("#trailPopSave").onclick = async () => {
    const id = $("#trailPop").dataset.market, tr = readTrail($("#trailPopBody .trail-box"));
    if (!tr) return fail(new Error(t("Inserisci la distanza del trailing.")));
    try {
      const res = await api(`/trail/${id}`, { method: "PUT", body: JSON.stringify(tr) });
      store("trailPrefs", tr);
      done(res);
      toast(res.armed ? t("Trailing attivo su {sym}", { sym: byId[id].symbol }) : t("Trailing salvato: parte quando attivi Auto."));
    } catch (err) { fail(err); }
  };
  $("#trailPopRemove").onclick = async () => {
    const id = $("#trailPop").dataset.market;
    try {
      done(await api(`/trail/${id}`, { method: "DELETE" }));
      toast(t("Trailing rimosso: lo stop già piazzato resta su Lighter."));
    } catch (err) { fail(err); }
  };
}

// ================= resizable bottom panel =================
const BOTTOM_DEFAULT = 160; // the tabs, the column titles and two positions; drag the bar for more
function setBottomHeight(h) {
  const room = $("#bottom").parentElement.clientHeight; // 0 while the trade view is hidden
  if (room) h = Math.min(h, room - 220); // keep room for the charts
  h = Math.round(Math.max(90, h));
  $("#bottom").style.setProperty("--bottom-h", h + "px");
  return h;
}

function wireBottomSplit() {
  const bar = $("#bottomSplit");
  setBottomHeight(load("bottomH", BOTTOM_DEFAULT));
  bar.onpointerdown = (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("drag");
    document.body.classList.add("resizing");
    const bottomEdge = $("#bottom").getBoundingClientRect().bottom;
    bar.onpointermove = (ev) => setBottomHeight(bottomEdge - ev.clientY);
    bar.onpointerup = () => {
      bar.onpointermove = bar.onpointerup = null;
      bar.classList.remove("drag");
      document.body.classList.remove("resizing");
      store("bottomH", Math.round($("#bottom").getBoundingClientRect().height));
    };
  };
  bar.ondblclick = () => store("bottomH", setBottomHeight(BOTTOM_DEFAULT));
  window.addEventListener("resize", () => setBottomHeight(load("bottomH", BOTTOM_DEFAULT)));
}

// ================= API key dialog =================
let keyFindTimer = 0;
const walletProviders = new Map(); // uuid -> { info, provider }
window.addEventListener("eip6963:announceProvider", (e) => {
  walletProviders.set(e.detail.info.uuid, e.detail);
  $("#keyWallet").classList.remove("hidden");
  $("#keyCreate").classList.remove("hidden");
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
setTimeout(() => { // older wallets only inject window.ethereum
  if (!walletProviders.size && window.ethereum) {
    walletProviders.set("injected", { info: { name: "Browser wallet" }, provider: window.ethereum });
    $("#keyWallet").classList.remove("hidden");
    $("#keyCreate").classList.remove("hidden");
  }
}, 500);

// "Create a key with my wallet": the wallet's account, a free key index (3 and up: 0-2 belong to Lighter's
// app), a key made in this browser and registered with one signature, then connected like a pasted one
async function createWithWallet(provider) {
  keyError("");
  if (info.public && !$("#keyTerms").checked) return keyError(t("Spunta i Termini d'uso qui sotto per continuare"));
  const btn = $("#keyCreateBtn"), label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = t("Collegamento al wallet…");
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error(t("Il wallet non ha condiviso nessun indirizzo"));
    $("#keyAddress").value = address;
    $("#keyAccount").value = "";
    await $("#keyFind").onclick();
    if ($("#keyAccount").value === "") throw new Error(t("Nessun account Lighter per questo wallet"));
    const account_index = +$("#keyAccount").value;
    const used = await api("/api_keys?account_index=" + account_index).catch(() => []);
    let api_key_index = 3;
    while (used.includes(api_key_index)) api_key_index++;
    if (api_key_index > 254) throw new Error(t("Nessun indice libero per una nuova chiave"));
    btn.textContent = t("Preparazione…");
    const made = await Live.createKey({ account_index, api_key_index, provider, address,
      step: (s) => { btn.textContent = s === "sign" ? t("Firma nel wallet…") : t("Registrazione su Lighter…"); } });
    btn.textContent = t("Collegamento…");
    $("#keyIndex").value = made.api_key_index;
    $("#keyPrivate").value = made.key;
    $("#keyForm").requestSubmit(); // checked and kept like a pasted key
  } catch (e) {
    keyError(e && e.code === 4001 ? t("Richiesta rifiutata nel wallet") : (e && e.message) || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function useWallet(provider) {
  keyError("");
  try {
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) return keyError(t("Il wallet non ha condiviso nessun indirizzo"));
    $("#keyAddress").value = address;
    $("#keyFind").onclick().catch(() => {}); // shown in the dialog already
  } catch (e) {
    keyError(e.code === 4001 ? t("Richiesta rifiutata nel wallet") : e.message);
  }
}

function openKeyDialog(justConnected = false) {
  const browser = !!info.public, on = browser ? Live.on : info.trading;
  $("#keyModal").classList.toggle("browser", browser);
  $("#keyTerms").required = browser;
  $("#keyTerms").checked = load("termsAccepted", null) === TERMS_VERSION;
  $("#keyConnected").classList.toggle("hidden", !on);
  $("#keyForm").classList.toggle("hidden", on);
  $("#keyTitle").textContent = on ? t("API key collegata") : t("Collega un'API key");
  if (on) {
    $("#keyOk").classList.toggle("hidden", justConnected !== true);
    const k = browser ? Live.info() : info;
    $("#keyFactAcc").textContent = "#" + k.account_index;
    $("#keyFactIdx").textContent = k.api_key_index == null ? "—" : "#" + k.api_key_index;
    $("#keyFactWhere").textContent = browser ? t("questo browser") : info.credentials === "env" ? t("file env del server") : "data/credentials.json";
    renderKeyEquity();
    $("#keyEnvNote").classList.toggle("hidden", browser || info.credentials !== "env");
    renderKeyAuto();
    $("#keyRemove").classList.toggle("hidden", !browser && info.credentials === "env");
    showKeyConfirm(false);
  }
  $("#keyError").classList.add("hidden");
  $("#keyAccounts").innerHTML = "";
  pasteOpen($("#keyPrivate").value.trim() !== "" || $("#keyAddress").value.trim() !== "");
  $("#keyMobileHint").classList.toggle("hidden", !browser || walletProviders.size > 0 || !matchMedia("(pointer: coarse)").matches);
  keyReady();
  $("#keyShade").classList.remove("hidden");
  $("#keyModal").classList.remove("hidden");
  // the cursor in the first field, but not on a phone or tablet, where it would pop the keyboard over the dialog
  if (!on && !touchUI()) $(browser || info.account_index == null ? "#keyAddress" : "#keyIndex").focus();
}

// with a wallet, "or paste a key you already have" opens the paste fields (folded until then)
function pasteOpen(open) {
  $("#keyForm").classList.toggle("paste-closed", !open);
  $("#keyPasteBtn").setAttribute("aria-expanded", String(open));
}
$("#keyPasteBtn").onclick = () => {
  const open = $("#keyForm").classList.contains("paste-closed");
  pasteOpen(open);
  if (open && !touchUI()) $("#keyAddress").focus();
};

// Verify and connect lights up once it has what it needs: the key, an account (or an address to find it) and,
// on the public site, the terms ticked
function keyReady() {
  const addr = /^0x[0-9a-fA-F]{40}$/.test($("#keyAddress").value.trim()), acc = $("#keyAccount").value !== "";
  const ready = $("#keyPrivate").value.trim().length > 20 && (addr || acc) && (!info.public || $("#keyTerms").checked);
  $("#keySubmit").classList.toggle("ready", ready);
}

// the terms accepted when a key was connected (terms.html); a new date asks again
const TERMS_VERSION = "2026-11-03";

// automations on the server for a browser key: on with key #N, or the form to hand one over
function renderKeyAuto() {
  const show = !!info.public && !!info.browser_automations && Live.on, a = Live.auto();
  $("#keyAuto").classList.toggle("hidden", !show);
  if (!show) return;
  $("#keyAutoState").textContent = a.on ? t("attive · API key #{n}", { n: a.api_key_index }) : t("spente");
  $("#keyAutoState").className = a.on ? "up" : "muted";
  $("#keyAutoForm").classList.toggle("hidden", !!a.on);
  $("#keyAutoOff").classList.toggle("hidden", !a.on);
  $("#keyAutoError").classList.add("hidden");
}

function renderKeyEquity() {
  $("#keyFactEq").textContent = account ? fusd(account.total_value) : t("caricamento…");
}

function showKeyConfirm(show) {
  $("#keyConfirm").classList.toggle("hidden", !show);
  $("#keyActions").classList.toggle("hidden", show);
}

// closing the dialog without connecting: back to paper on a live site (its default)
function dismissKeyDialog() {
  closeKeyDialog();
  if (liveFirst() && !Live.on && !Paper.on) setPaper(true);
}

function closeKeyDialog() {
  $("#keyShade").classList.add("hidden");
  $("#keyModal").classList.add("hidden");
  $("#keyPrivate").value = $("#keyAutoPrivate").value = ""; // never keep a key in the page longer than needed
}

function keyError(msg) {
  const box = $("#keyError");
  box.textContent = msg;
  box.classList.toggle("hidden", !msg);
}

// the browser key connected or removed: live with it; without it, paper where the site has no live trading
function browserKeyChanged() {
  document.body.classList.toggle("browser-key", Live.on);
  setPaper(!Live.on && !liveFirst());
}

function credentialsChanged(newInfo) {
  info = { ...info, ...newInfo };
  liveTrading = info.trading;
  info.trading = Paper.on || liveTrading;
  account = null;
  renderArmed(info.armed);
  renderAccount();
  loadOrders(true);
}

// the network badge: blue on the testnet; on the mainnet green when orders are real (a connected account,
// not paper), neutral grey when nothing real is at stake (paper, read-only: it only says where prices come from)
// the same LighterDeck on Lighter's other networks: the badge opens them, on the same page and market
// the exchanges the menu switches between, each a LighterDeck site of its own (info.network_sites); the testnet
// still runs for the tests but isn't offered
const NETWORKS = { mainnet: ["Lighter Core", "L'exchange principale di Lighter"],
  robinhood: ["Lighter Robinhood", "Lighter su Robinhood Chain: mercati, conti e chiavi propri"] };
const NET_NAMES = { ...Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [k, v[0]])), testnet: "Testnet" };
function renderNetMenu() {
  const sites = (info && info.network_sites) || {};
  const ids = Object.keys(NETWORKS).filter((id) => sites[id]);
  const on = ids.length > 1;
  $(".net-pick").classList.toggle("switch", on);
  if (!on) return;
  $("#netMenu").innerHTML = ids.map((id) => `<button type="button" data-net="${id}" class="${id === info.network ? "active" : ""}">
      <i class="net-dot ${id}"></i><span>${NETWORKS[id][0]}</span><span class="check">✓</span></button>`).join("");
  $("#netBadge").onclick = (e) => {
    e.stopPropagation();
    $("#themeMenu").classList.add("hidden"); $("#langMenu").classList.add("hidden");
    $("#netMenu").classList.toggle("hidden");
    fitInView($("#netMenu"));
  };
  $("#netMenu").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-net]");
    if (!b) return;
    $("#netMenu").classList.add("hidden");
    if (b.dataset.net !== info.network) location.href = sites[b.dataset.net] + location.pathname + location.search;
  };
  if (!renderNetMenu.wired) document.addEventListener("click", () => $("#netMenu").classList.add("hidden"));
  renderNetMenu.wired = true;
}

function renderNetBadge() {
  if (!info) return;
  const real = !Paper.on && (Live.on || (!info.public && liveTrading));
  const cls = info.network === "testnet" ? "testnet" : real ? "real" : "";
  for (const el of [$("#netBadge")]) el.className = "net" + (cls ? " " + cls : "");
  $("#netBadge").title = info.network === "testnet" ? t("Rete di prova di Lighter: niente soldi veri")
    : real ? t("Rete vera di Lighter: gli ordini sono reali") : t("Prezzi dalla rete vera di Lighter; qui non si muovono soldi veri");
}

// ================= paper trading =================
// live prices, simulated money (paper.js). A public site without live trading always runs it; one with
// live trading (BROWSER_TRADING) puts the visitor's own Lighter account first and keeps paper as a choice.
let liveTrading = false;
const autoOn = () => Paper.on || info.armed;
const liveFirst = () => !!(info && info.public && info.browser_trading);
const paperOnly = () => !!info.public && !info.browser_trading;

// paper at start: the choice made last time; on a live site a visitor who already has a paper account keeps it
function paperAtStart() {
  if (paperOnly()) return true;
  const chosen = load("paper", null);
  if (chosen !== null) return chosen;
  return liveFirst();
}

function setPaper(on) {
  Paper.on = !Live.on && (paperOnly() || on);
  if (!paperOnly()) store("paper", Paper.on);
  info.trading = Paper.on || liveTrading || Live.on;
  document.body.classList.toggle("paper", Paper.on);
  account = Paper.on ? Paper.account() : Live.on ? Live.account() : null;
  stops = Paper.on ? Paper.stops() : {};
  exits = Paper.on ? Paper.exits() : {};
  pairs = [];
  eventRules = [];
  loadEventRules();
  openOrders = {};
  logSeq = 0;
  for (const box of [$("#btab-log"), $("#activityLog")]) box.innerHTML = `<div class="empty">${t("Nessuna attività.")}</div>`;
  if (Paper.on) addLogs(Paper.logs(0));
  else api("/logs").then(addLogs).catch(() => {});
  if ((Paper.on || Live.on) && ["auto", "activity", "account"].includes(curView)) switchView("trade");
  renderAccount();
  loadOrders(true);
  if (!$("#btab-trades").classList.contains("hidden")) loadTrades();
  if (!$("#btab-funding").classList.contains("hidden")) loadFundingPaid();
}

// under the ticket's button, on a live site: the way to paper when nothing is connected
function renderTicketSwitch() {
  const el = $("#tkSwitch");
  const show = liveFirst() && !Live.on && !Paper.on && !info.trading; // from paper, Paper / Live does it
  el.classList.toggle("hidden", !show);
  if (show) el.textContent = t("Oppure prova in paper trading");
}

// a live site's first visit: how to connect; closing it keeps the paper account the site starts in
function liveIntro() {
  if (!liveFirst() || Live.on || load("liveIntro", false) || !load("residence", false)) return;
  store("liveIntro", true);
  openKeyDialog();
}

function renderPaperModal() {
  const s = Paper.summary(), pnl = s.equity - s.balance;
  $("#paperEq").textContent = fusd(s.equity);
  $("#paperPnl").textContent = `${fusd(pnl)} · ${fpct(pnl / s.balance * 100)}`;
  $("#paperPnl").className = cls(pnl);
  $("#paperCount").textContent = s.trades;
  $("#paperSince").textContent = new Date(s.start).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
  $$("#paperBal button").forEach((b) => b.classList.toggle("active", +b.dataset.bal === (renderPaperModal.bal || s.balance)));
  $("#paperLive").classList.toggle("hidden", !!info.public && !info.browser_trading);
}

function openPaperModal() {
  renderPaperModal.bal = null;
  renderPaperModal();
  $("#paperVeil").classList.remove("hidden");
  $("#paperModal").classList.remove("hidden");
}

function closePaperModal() {
  $("#paperVeil").classList.add("hidden");
  $("#paperModal").classList.add("hidden");
  cancelConfirm();
}

function wirePaper() {
  $("#paperClose").onclick = $("#paperVeil").onmousedown = closePaperModal;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#paperModal").classList.contains("hidden")) closePaperModal(); });
  $("#paperBal").onclick = (e) => {
    const b = e.target.closest("[data-bal]");
    if (b) { renderPaperModal.bal = +b.dataset.bal; renderPaperModal(); }
  };
  $("#paperReset").onclick = () => {
    const bal = renderPaperModal.bal || Paper.summary().balance;
    if (!askConfirm("paperReset", t("Conferma: ricomincia con {bal}", { bal: fusd(bal, 0) }))) return;
    Paper.reset(bal);
    setPaper(true);
    renderPaperModal();
    toast(t("Paper trading ripartito con {bal}", { bal: fusd(bal, 0) }));
  };
  $("#paperLive").onclick = () => {
    closePaperModal();
    if (info.public) return openKeyDialog(); // live needs a key, kept in this browser
    setPaper(false);
    toast(liveTrading ? t("Trading live: ordini veri su Lighter") : t("Sola lettura"));
  };
  $("#tkSwitch").onclick = () => {
    if (Paper.on) return openKeyDialog();
    setPaper(true);
    toast(t("Paper trading: prezzi veri, soldi finti"));
  };
  $("#keyPaper").onclick = () => {
    closeKeyDialog();
    if (Live.on) { Live.disconnect(); document.body.classList.remove("browser-key"); } // paper instead of the browser key
    setPaper(true);
    toast(t("Paper trading: prezzi veri, soldi finti"));
  };
}

// ================= keyboard shortcuts =================
// single keys, off while typing or with a dialog open; closing and cancelling ask for a second press
const HOTKEYS = [
  ["B", "Buy / Long: lato acquisto e cursore sulla size"],
  ["S", "Sell / Short: lato vendita e cursore sulla size"],
  ["M", "Ordine market"],
  ["L", "Ordine limit al prezzo medio"],
  ["Enter", "Invia l'ordine dal ticket (di nuovo per confermare)"],
  ["F", "Chiudi la posizione del mercato (due volte)"],
  ["H", "Chiudi metà posizione (due volte)"],
  ["R", "Reverse della posizione (due volte)"],
  ["C", "Annulla i limit del mercato (due volte)"],
  ["A", "Alert al prezzo sotto il mouse"],
  ["U", "Apri e chiudi i dettagli del funding"],
  ["1–9 0", "Il preferito n. 1–10 nel grafico selezionato"],
  ["Shift 1–4", "Seleziona il grafico"],
  ["[ ]", "Timeframe precedente / successivo"],
  ["Ctrl ↑ →", "Timeframe più grande, tra quelli nella barra"],
  ["Ctrl ↓ ←", "Timeframe più piccolo, tra quelli nella barra"],
  ["/", "Cerca mercato"],
  ["?", "Questo elenco"],
];

// the key next to the control it drives: a small badge (desktop only, via CSS) and the tooltip
function applyKeyHints() {
  const hint = (el, key, title) => { if (!el) return; if (key) el.dataset.key = key; if (title) el.title = title; };
  hint($('#sideSel [data-side="buy"]'), null, t("Buy / Long · B"));
  hint($('#sideSel [data-side="sell"]'), null, t("Sell / Short · S"));
  hint($('#kindSel [data-kind="market"]'), null, t("Market · M"));
  hint($('#kindSel [data-kind="limit"]'), null, t("Limit al prezzo medio · L"));
  hint($("#tkExec"), null, t("Invia · Enter"));
  hint($("#mktSelect"), null, t("Cerca mercato · / o Ctrl+K"));
  hint($("#tfs"), null, t("Timeframe · [ e ] · Ctrl con le frecce"));
  panels.forEach((p) => hint($(".ttl", p.el), null, t("Grafico {n} · Shift+{n} · clic per cambiare mercato", { n: p.idx + 1 })));
  hint($("#hkOpen"), null, t("Scorciatoie da tastiera · ?"));
  hint($("#stFundBtn"), null, t("Dettagli funding · U"));
}

// once, after the first order sent with the mouse on a computer
function keyboardTip() {
  if (load("kbdTip", false) || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  store("kbdTip", true);
  setTimeout(() => toast(t("Puoi farlo da tastiera: premi ? per le scorciatoie")), 1500);
}

function renderHotkeys() {
  $("#hkList").innerHTML = HOTKEYS.map(([k, d]) => `<dt>${k.split(" ").map((x) => `<kbd>${esc(x)}</kbd>`).join(" ")}</dt><dd>${esc(t(d))}</dd>`).join("");
}

function toggleHotkeys(open) {
  const show = open ?? $("#hkModal").classList.contains("hidden");
  if (show) renderHotkeys();
  $("#hkVeil").classList.toggle("hidden", !show);
  $("#hkModal").classList.toggle("hidden", !show);
}

// first press arms the action (and lights the matching button), a second within a few seconds runs it
function hotkeyConfirm(key, text) {
  if (askConfirm(key, text)) return true;
  toast(text);
  return false;
}

async function hotkeyClose(m, fraction) {
  const pos = account && account.positions.find((p) => p.market_id === m.id);
  if (!pos) return toast(t("Nessuna posizione su {sym}", { sym: m.symbol }), true);
  const key = fraction >= 1 ? `close:${m.id}` : `hk:half:${m.id}`;
  if (!hotkeyConfirm(key, t(fraction >= 1 ? "Premi di nuovo F: chiudi {sym}" : "Premi di nuovo H: chiudi metà {sym}", { sym: m.symbol }))) return;
  try { await api(`/close?market_id=${m.id}&fraction=${fraction}`, { method: "POST" }); toast(t("Chiusura {f}%: ordine accettato", { f: Math.round(fraction * 100) }), "ok"); }
  catch (err) { toast(err.message, true); }
}

// one market order for twice the size: the other side, same size; a second click or press confirms
async function reversePosition(mid, viaKey = false) {
  const m = byId[mid], pos = account && account.positions.find((p) => p.market_id === mid);
  if (!pos) return toast(t("Nessuna posizione su {sym}", { sym: m.symbol }), true);
  const to = pos.size > 0 ? "Short" : "Long";
  const ok = viaKey ? hotkeyConfirm(`reverse:${mid}`, t("Premi di nuovo R: reverse {sym} a {side}", { sym: m.symbol, side: to }))
    : askConfirm(`reverse:${mid}`, t("Conferma → {side}", { side: to }));
  if (!ok) return;
  try { await api(`/reverse?market_id=${mid}`, { method: "POST" }); toast(t("Reverse accettato: {sym} {side}", { sym: m.symbol, side: to }), "ok"); loadOrders(true); }
  catch (err) { toast(err.message, true); }
}

async function hotkeyCancel(m) {
  const armed = pendingConfirm && pendingConfirm.key === `hk:cancel:${m.id}`;
  if (!armed) await fetchOpenOrders(true).catch(() => {});
  const limits = (openOrders[m.id] || []).filter((o) => orderKind(o) === "LIMIT");
  if (!limits.length) return toast(t("Nessun limit aperto su {sym}", { sym: m.symbol }), true);
  if (!hotkeyConfirm(`hk:cancel:${m.id}`, t("Premi di nuovo C: annulla {n} limit su {sym}", { n: limits.length, sym: m.symbol }))) return;
  let done = 0;
  for (const o of limits) {
    try { await api(`/cancel_order?market_id=${m.id}&order_index=${o.order_index}`, { method: "POST" }); done++; }
    catch (err) { toast(err.message, true); }
  }
  if (done) toast(t("{n} limit annullati su {sym}", { n: done, sym: m.symbol }));
  loadOrders(true);
}

// to the next timeframe shown in the toolbar, larger (dir 1) or smaller (-1), by duration; from one that isn't
// shown (picked in More) it goes to the nearest shown one on that side
function stepTf(dir) {
  const at = ALL_TFS.indexOf(panelCfg[activeIdx].tf);
  const shown = ALL_TFS.filter((x) => shownTfs.includes(x));
  const next = dir > 0 ? shown.find((x) => ALL_TFS.indexOf(x) > at) : shown.reverse().find((x) => ALL_TFS.indexOf(x) < at);
  if (next) setTf(next);
}

function wireHotkeys() {
  $("#hkOpen").onclick = () => toggleHotkeys(true);
  $("#hkClose").onclick = $("#hkVeil").onmousedown = () => toggleHotkeys(false);
  // Enter in the ticket's fields sends the order, like the button (which asks to confirm)
  for (const id of ["#tkSize", "#tkPctIn", "#tkPrice", "#tkSl", "#tkTp"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#tkExec").click(); } });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#hkModal").classList.contains("hidden")) return toggleHotkeys(false);
    const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
    const dialog = $$(".modal, .picker, #trailPop, #sltpPop").some((x) => !x.classList.contains("hidden"));
    // Ctrl (Cmd on a Mac) with the arrows: through the timeframes shown in the toolbar, up or right to a larger one.
    // Held down it keeps stepping; in a field the arrows keep moving the cursor by word.
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !typing && !dialog && curView === "trade") {
      e.preventDefault();
      return stepTf(step);
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (typing) return;
    if (dialog) return;
    if (curView !== "trade" && e.key !== "?") return;
    const m = activeMarket(), k = e.key;
    const focusSize = () => { $("#tkSize").focus(); $("#tkSize").select(); };
    const act = {
      b: () => { ticket.side = "buy"; renderTicket(); focusSize(); },
      s: () => { ticket.side = "sell"; renderTicket(); focusSize(); },
      m: () => { ticket.kind = "market"; renderTicket(); },
      l: () => { ticket.kind = "limit"; fillMid(); renderTicket(); },
      f: () => m && hotkeyClose(m, 1),
      h: () => m && hotkeyClose(m, 0.5),
      r: () => m && reversePosition(m.id, true),
      c: () => m && hotkeyCancel(m),
      a: () => (hoverPanel && hoverPanel.pointerPrice ? addAlert(hoverPanel.market, hoverPanel.pointerPrice) : toast(t("Punta il mouse sul grafico, al prezzo dell'alert, e premi A."))),
      u: () => toggleFunding(),
      "/": openPalette,
      "?": () => toggleHotkeys(),
      "[": () => stepTf(-1),
      "]": () => stepTf(1),
    }[k.length === 1 ? k.toLowerCase() : k];
    if (act) { e.preventDefault(); act(); return; }
    // Shift + 1–4: the chart (by the key's place, whatever symbol Shift gives it on this keyboard);
    // 1–9 and 0: that favourite into the chart selected now
    const digit = /^Digit[0-9]$/.test(e.code) ? +e.code.slice(5) : /^[0-9]$/.test(k) ? +k : null;
    if (digit === null) return;
    if (e.shiftKey) {
      if (digit >= 1 && digit <= panels.length) { e.preventDefault(); setActive(digit - 1); }
      return;
    }
    const sym = shownFavs()[(digit + 9) % 10];
    if (sym) { e.preventDefault(); setSymbol(sym); }
  });
}

function wireKeyDialog() {
  $("#accountPill").onclick = $("#accSwitch").onclick = (e) => {
    const b = e.target.closest("[data-acct]");
    if (!b || b.disabled) return;
    if (b.dataset.acct === "paper") return Paper.on ? openPaperModal() : $("#keyPaper").onclick();
    if (Paper.on) return $("#paperLive").onclick();
    if (!info.public || Live.on || liveFirst()) openKeyDialog();
  };
  $("#keyClose").onclick = dismissKeyDialog;
  $("#keyShade").onmousedown = dismissKeyDialog;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#keyModal").classList.contains("hidden")) dismissKeyDialog(); });
  // browser wallets (EIP-6963, with window.ethereum as fallback): only the address is read
  $("#keyWallet").onclick = () => {
    const list = [...walletProviders.values()];
    if (list.length === 1) return useWallet(list[0].provider);
    $("#keyWallets").innerHTML = list.map((w, i) =>
      `<button type="button" class="chip" data-wallet="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ""}${esc(w.info.name)}</button>`).join("");
    $("#keyWallets").classList.toggle("hidden");
  };
  $("#keyCreateBtn").onclick = () => {
    const list = [...walletProviders.values()];
    if (list.length === 1) return createWithWallet(list[0].provider);
    $("#keyCreateWallets").innerHTML = list.map((w, i) =>
      `<button type="button" class="chip" data-wallet="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ""}${esc(w.info.name)}</button>`).join("");
    $("#keyCreateWallets").classList.toggle("hidden");
  };
  $("#keyCreateWallets").onclick = (e) => {
    const b = e.target.closest("[data-wallet]");
    if (!b) return;
    $("#keyCreateWallets").classList.add("hidden");
    createWithWallet([...walletProviders.values()][+b.dataset.wallet].provider);
  };
  $("#keyWallets").onclick = (e) => {
    const b = e.target.closest("[data-wallet]");
    if (!b) return;
    $("#keyWallets").classList.add("hidden");
    useWallet([...walletProviders.values()][+b.dataset.wallet].provider);
  };
  $("#keyFind").onclick = async () => {
    keyError("");
    $("#keyAccounts").innerHTML = "";
    try {
      const list = await api("/accounts_for_address?address=" + encodeURIComponent($("#keyAddress").value.trim()));
      // the account picked for you: the one with the most money, the main one (lowest index) on a tie
      const pick = list.slice().sort((a, b) => b.collateral - a.collateral || a.index - b.index)[0];
      if (pick) $("#keyAccount").value = pick.index;
      const main = Math.min(...list.map((a) => a.index));
      $("#keyAccounts").innerHTML = list.length < 2 ? "" : list.map((a) =>
        `<button type="button" class="chip${a === pick ? " active" : ""}" data-acc="${a.index}">#${a.index} · ${fusd(a.collateral, 0)}${a.index === main ? "" : " · " + t("subaccount")}</button>`).join("");
    } catch (e) { keyError(e.message); throw e; }
  };
  $("#keyAccounts").onclick = (e) => {
    const b = e.target.closest("[data-acc]");
    if (!b) return;
    $("#keyAccount").value = b.dataset.acc;
    $$("#keyAccounts [data-acc]").forEach((x) => x.classList.toggle("active", x === b));
  };
  $("#keyAccount").addEventListener("input", () => $$("#keyAccounts [data-acc]").forEach((x) => x.classList.toggle("active", x.dataset.acc === $("#keyAccount").value)));
  // a pasted (or typed) wallet address looks for its accounts by itself
  $("#keyAddress").addEventListener("input", () => {
    clearTimeout(keyFindTimer);
    if (/^0x[0-9a-fA-F]{40}$/.test($("#keyAddress").value.trim())) keyFindTimer = setTimeout(() => $("#keyFind").onclick().catch(() => {}), 300);
  });
  for (const ev of ["input", "change"]) $("#keyForm").addEventListener(ev, keyReady);
  $("#keyForm").onsubmit = async (e) => {
    e.preventDefault();
    keyError("");
    const btn = $("#keySubmit");
    btn.disabled = true;
    btn.textContent = t("Verifica in corso…");
    // one try: the key stays in this browser (checked with Lighter from here) or goes to this deck's server
    const tryKey = async (cred) => {
      if (info.public) {
        await Live.connect({ ...cred, key: $("#keyPrivate").value }, $("#keyRemember").checked);
        store("termsAccepted", TERMS_VERSION);
        browserKeyChanged();
        return;
      }
      credentialsChanged(await api("/credentials", { method: "POST", body: JSON.stringify({ ...cred, private_key: $("#keyPrivate").value }) }));
    };
    try {
      if ($("#keyAccount").value === "") { // the account from the wallet address, if it wasn't looked up yet
        if (!/^0x[0-9a-fA-F]{40}$/.test($("#keyAddress").value.trim())) {
          throw new Error(t("Inserisci l'indirizzo del wallet o l'indice dell'account"));
        }
        clearTimeout(keyFindTimer);
        btn.textContent = t("Cerco l'account…");
        await $("#keyFind").onclick();
        if ($("#keyAccount").value === "") throw new Error(t("Nessun account Lighter per questo wallet"));
      }
      const account_index = +$("#keyAccount").value;
      btn.textContent = t("Controllo la chiave con Lighter…");
      if ($("#keyIndex").value !== "") await tryKey({ account_index, api_key_index: +$("#keyIndex").value });
      else { // no index given: the account's keys, newest first, until one takes this private key
        btn.textContent = t("Cerco l'indice della chiave…");
        const indexes = await api("/api_keys?account_index=" + account_index);
        let found = null;
        for (const api_key_index of indexes) {
          try { await tryKey({ account_index, api_key_index }); found = api_key_index; break; } catch {}
        }
        if (found === null) throw new Error(t("Nessuna API key dell'account #{acc} accetta questa chiave privata: controlla di averla copiata per intero", { acc: account_index }));
        $("#keyIndex").value = found;
      }
      $("#keyPrivate").value = "";
      openKeyDialog(true);
    } catch (err) {
      keyError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = t("Verifica e collega");
    }
  };
  $("#keyAutoForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#keyAutoSubmit"), box = $("#keyAutoError");
    btn.disabled = true;
    btn.textContent = t("Verifica in corso…");
    try {
      await Live.autoOn(+$("#keyAutoIndex").value, $("#keyAutoPrivate").value.trim());
      $("#keyAutoPrivate").value = "";
      document.body.classList.add("browser-auto");
      renderKeyAuto();
      toast(t("Automazioni attive: accendi Auto per farle partire"));
    } catch (err) {
      box.textContent = err.message;
      box.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = t("Attiva le automazioni");
    }
  };
  $("#keyAutoOff").onclick = async (e) => {
    if (!askConfirm("autoOff", t("Conferma: disattiva e cancella"))) return;
    try {
      await Live.autoOff();
      document.body.classList.remove("browser-auto");
      renderKeyAuto();
      toast(t("Automazioni disattivate: la chiave è stata cancellata dal server"));
    } catch (err) { toast(err.message, true); }
  };
  $("#keyRemove").onclick = () => showKeyConfirm(true);
  $("#keyCancel").onclick = () => showKeyConfirm(false);
  $("#keyConfirmBtn").onclick = async () => {
    if (info.public) {
      Live.disconnect();
      closeKeyDialog();
      browserKeyChanged();
      toast(t("API key scollegata: torni al paper trading"));
      return;
    }
    try {
      const res = await api("/credentials", { method: "DELETE" });
      closeKeyDialog();
      credentialsChanged(res);
      toast(t("API key scollegata: sola lettura"));
    } catch (err) { toast(err.message, true); }
  };
}

// ================= init =================
// the language button: the usual "translate" sign (Material Symbols, Apache 2.0) and the current language;
// the menu lists every language in its own name, with the English one under it
const TRANSLATE_ICON = '<svg class="lang-ico" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>';

function renderLangBtn() {
  const cur = LANGS.find((l) => l.id === LANG) || LANGS[0];
  $("#langBtn").innerHTML = TRANSLATE_ICON;
  $("#langBtn").title = t("Lingua") + " · " + cur.name;
  $("#langMenu").innerHTML = LANGS.map((l) => `<button data-lang="${l.id}" class="${l.id === LANG ? "active" : ""}">
      <span class="lang-code">${l.short}</span><span>${l.name}</span><span class="check">✓</span></button>`).join("");
}

// redraw every piece of text built in JavaScript; charts, prices and the book keep running
function rerenderLanguage() {
  renderLangBtn();
  renderNetMenu();
  applyTheme(document.documentElement.dataset.theme);
  setStatus(feedOk);
  renderArmed(info.armed);
  renderTfs();
  renderTicket();
  renderAccount();
  applyKeyHints();
  renderSessions();
  renderEcon();
  renderChangelog();
  if (curView === "auto") renderAutoPage();
  renderEventSelect();
  loadRules();
  renderMarkets();
  panels.forEach((p) => { p.ttlFor = null; p.renderLegend(); p.drawLines(); });
  if (!$("#elMenu").classList.contains("hidden")) renderChartEls();
  fillPickerSorts();
  if (!$("#picker").classList.contains("hidden")) renderPicker();
  if (!$("#btab-orders").classList.contains("hidden")) loadOrders();
  if (!$("#btab-trades").classList.contains("hidden")) loadTrades();
  if (!$("#view-auto").classList.contains("hidden")) loadLimits();
  for (const box of [$("#btab-log"), $("#activityLog")]) {
    const empty = box.querySelector(".empty");
    if (empty) empty.textContent = t("Nessuna attività.");
  }
}

async function init() {
  translateDom();
  renderLangBtn();
  $("#langBtn").onclick = (e) => { e.stopPropagation(); $("#themeMenu").classList.add("hidden"); $("#langMenu").classList.toggle("hidden"); fitInView($("#langMenu")); };
  $("#langMenu").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-lang]");
    if (b) { $("#langMenu").classList.add("hidden"); setLang(b.dataset.lang); }
  };
  document.addEventListener("click", () => $("#langMenu").classList.add("hidden"));
  onLangChange = rerenderLanguage;
  // while the server restarts (a deploy) it doesn't answer for a few seconds: wait for it instead of asking
  // for a token, which is only for one our server refused. A request that hangs (a slow or flaky network far
  // away) is dropped after a while and tried again, and after a few tries the page says what went wrong
  // instead of spinning forever.
  for (let i = 0; ; i++) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 12000);
    try {
      info = await api("/info", { signal: ac.signal });
      break;
    } catch (e) {
      if (e.status === 401 && e.message === "bad token") {
        const token = prompt(t("Token di accesso LighterDeck:"));
        if (token) { store("token", token); location.reload(); }
        return;
      }
      const why = e.name === "AbortError" ? t("nessuna risposta")
        : e.status ? `HTTP ${e.status}` : t("rete non raggiungibile");
      if (i >= 2) toast(t("Non riesco a raggiungere il server ({why}): riprovo…").replace("{why}", why), true);
      else if (i === 1) toast(t("Il server si sta riavviando, riprovo…"));
      await new Promise((ok) => setTimeout(ok, 2000));
    } finally { clearTimeout(tm); }
  }
  // the market list may already be here (index.html started it early): the scripts after this one
  // (picker.js) must have run before the page is wired
  if (document.readyState === "loading") await new Promise((ok) => document.addEventListener("DOMContentLoaded", ok, { once: true }));
  markets = info.markets;
  liveTrading = info.trading;
  if (info.public && info.browser_trading && Live.saved()) {
    // the saved key needs Lighter's signer from the server: if it can't be loaded (the server restarting), try
    // again for about half a minute rather than falling back to paper. The key stays saved either way.
    for (let i = 0; ; i++) {
      try { await Live.restore(); break; } catch {
        if (i >= 15) { toast(t("Non riesco a ricollegare la chiave: ricarica la pagina tra poco"), true); break; }
        if (i === 0) toast(t("Ricollego la chiave…"));
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    }
    document.body.classList.toggle("browser-key", Live.on);
  }
  Paper.on = !Live.on && paperAtStart();
  info.trading = Paper.on || liveTrading || Live.on;
  document.body.classList.toggle("live-first", liveFirst());
  document.body.classList.toggle("paper", Paper.on);
  applyPublic();
  bySymbol = Object.fromEntries(markets.map((m) => [m.symbol, m]));
  byId = Object.fromEntries(markets.map((m) => [m.id, m]));
  panelCfg = panelCfg.map((c) => (bySymbol[c.symbol] ? c : { ...c, symbol: "BTC" }));
  const opts = markets.map((m) => `<option value="${m.id}">${m.symbol}</option>`).join("");
  $$(".marketSelect").forEach((s) => (s.innerHTML = opts));
  renderEventSelect();
  const net = NET_NAMES[info.network] || "Lighter Core";
  $("#netBadge").textContent = net;
  $("#sbNet").textContent = net;
  renderNetMenu();
  renderArmed(info.armed);

  try { localStorage.removeItem("ld.mode"); } catch {} // left by the old Simple / Pro switch
  wire();
  wireKeyDialog();
  wirePaper();
  liveIntro();
  wireHotkeys();
  wireSelMenus();
  applyKeyHints();
  $("#bottom").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (b) goToMarket(b.dataset.goto);
    const tag = e.target.closest(".mode-tag"); // a phone has no hover: the tag explains itself on a tap
    if (tag) toast(tag.title);
  });
  wireBottomSplit();
  wireTrail();
  wirePosPress();
  applyTheme(load("theme", "ghiaccio")); // first visit: Ice (Ghiaccio)
  $("#themeBtn").onclick = (e) => { e.stopPropagation(); $("#langMenu").classList.add("hidden"); $("#themeMenu").classList.toggle("hidden"); fitInView($("#themeMenu")); };
  $("#themeMenu").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-theme]");
    if (b) { applyTheme(b.dataset.theme); $("#themeMenu").classList.add("hidden"); }
  };
  document.addEventListener("click", () => $("#themeMenu").classList.add("hidden"));
  // the address decides the page and the market: /trade/WTI opens WTI on the selected chart
  const route = routeFromUrl();
  if (route.sym && (bySymbol[route.sym] || pairOf(route.sym))) panelCfg[activeIdx].symbol = route.sym;
  buildCharts();
  document.documentElement.classList.remove("booting");
  toggleBook(showBook);
  toggleTape(showTape);
  renderAccount();
  const lastView = load("view", "trade");
  switchView(route.view || (location.pathname === "/" && $("#view-" + lastView) ? lastView : "trade"), { fromUrl: true }); // a page since removed: trade
  syncUrl(false);
  window.addEventListener("popstate", () => {
    const r = routeFromUrl();
    if (r.sym && (bySymbol[r.sym] || pairOf(r.sym)) && panelCfg[activeIdx].symbol !== r.sym) setSymbol(r.sym);
    switchView(r.view || "trade", { fromUrl: true });
  });
  renderSessions();
  const calendarLoaded = loadCalendar();
  loadRules();
  if (Live.on) account = Live.account();
  if (Paper.on) {
    addLogs(Paper.logs(0));
    // orders that would have filled while the page was closed, from the candles of the time away
    Paper.catchUp().then((n) => {
      if (n) toast(t("Paper: {n} esecuzioni mentre eri via", { n }));
      account = Paper.account();
      stops = Paper.stops();
      exits = Paper.exits();
      addLogs(Paper.logs(logSeq));
      renderAccount();
      fetchOpenOrders(true).catch(() => {});
    }).catch(() => {});
  } else api("/logs").then(addLogs).catch(() => {});
  for (const box of [$("#btab-log"), $("#activityLog")]) if (!box.children.length) box.innerHTML = `<div class="empty">${t("Nessuna attività.")}</div>`;
  // prices at once: the snapshot index.html already asked for, until the live socket's first tick
  api("/tick").then((m) => { if (!lastTick) onTick(m); }).catch(() => {});
  connect();
  await calendarLoaded;
  if (chartEls.orders) fetchOpenOrders().catch(() => {});

  setInterval(clock, 250);
  setInterval(renderSessions, 30 * 1000);
  setInterval(renderEcon, 60 * 1000);
  wireBook();
  wireBtabY();
  setInterval(renderBook, 200); // the stream updates ~20x/s; redraw at most 5x/s
  // the Orders tab refreshes every 5 s; with the tab closed the chart lines refresh every 10 s
  let orderPolls = 0;
  setInterval(() => {
    if (!$("#btab-orders").classList.contains("hidden")) loadOrders();
    else if (chartEls.orders && info.trading && ++orderPolls % 2 === 0) fetchOpenOrders().catch(() => {});
  }, 5000);
  setInterval(loadCalendar, 10 * 60 * 1000);
  setInterval(() => { if (!$("#btab-alerts").classList.contains("hidden")) renderAlerts(); }, 30000); // "5m ago" moves on
  setInterval(() => panels.forEach((p) => p.load()), 15 * 60 * 1000);
  // after a sleep the charts missed the candles in between: they would join the old ones to the new price,
  // or stay frozen behind a request the sleep cut. Coming back reloads them, whichever way the sleep shows:
  // - a phone or a background tab: the page was hidden for a while;
  // - a computer that slept with the page in view: the timers stopped, so a 5-second beat comes late;
  // - a page the browser froze or kept in its back/forward cache and brings back as it was.
  const wake = () => {
    panels.forEach((p) => p.load());
    if (chartEls.orders && info.trading) fetchOpenOrders(true).catch(() => {});
    loadCalendar().catch(() => {});
  };
  let hiddenAt = 0, beat = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!hiddenAt || Date.now() - hiddenAt < 15000) return;
    hiddenAt = 0;
    beat = Date.now();
    wake();
  });
  setInterval(() => {
    const gap = Date.now() - beat;
    beat = Date.now();
    if (gap > 30000 && !document.hidden) wake();
  }, 5000);
  addEventListener("pageshow", (e) => { if (e.persisted) { beat = Date.now(); wake(); } });
  document.addEventListener("resume", () => { beat = Date.now(); wake(); }); // Chromium: a frozen page thawed
}

init();
