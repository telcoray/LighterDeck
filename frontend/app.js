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
const DEFAULT_TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"];
let shownTfs = load("tfs", DEFAULT_TFS).filter((t) => ALL_TFS.includes(t));

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
  $("#themeName").textContent = t(theme.name);
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
let showBook = load("book", false);
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
  const r = await fetch("/api" + path, { ...opts, headers: { "Content-Type": "application/json", "X-Token": TOKEN, "X-Lang": LANG, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), 3500);
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
// market logo (cached by the backend) with the initial underneath as fallback
function ico(sym, size = "") {
  const m = bySymbol[sym];
  const img = m && m.has_logo ? `<img src="/logo/${encodeURIComponent(sym)}" alt="" loading="lazy" onerror="this.remove()">` : "";
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
    this.series = this.chart.addCandlestickSeries({
      upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: C.green, wickDownColor: C.red,
      priceLineStyle: 2, priceLineWidth: 1, // last-price line and label take the candle colour
    });
    this.vol = this.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    this.lines = [];
    this.dragOrders = [];  // open orders on this chart that can be dragged: { line, price, label, order }
    this.dragPreview = []; // ticket preview lines that can be dragged: { line, price, label, kind, preview }
    // order, preview and trailing lines near the price stay in view instead of sitting off-screen
    this.series.applyOptions({ autoscaleInfoProvider: (original) => {
      const r = original();
      const last = this.last && this.last.close;
      if (!r || !r.priceRange || !last) return r;
      const keep = [...this.dragOrders, ...this.dragPreview].map((d) => d.price)
        .concat(this.stopLine ? [this.stopLine.options().price] : [])
        .filter((p) => Math.abs(p - last) / last < 0.15); // a typo far away doesn't squash the chart
      let lo = Math.min(r.priceRange.minValue, ...keep), hi = Math.max(r.priceRange.maxValue, ...keep);
      // the mouse wheel over the price scale stretches or squeezes the prices around the middle
      if (this.yZoom !== 1) { const mid = (lo + hi) / 2, half = (hi - lo) / 2 * this.yZoom; lo = mid - half; hi = mid + half; }
      return { ...r, priceRange: { minValue: lo, maxValue: hi } };
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
    const candles = await api(`/candles?market_id=${m.id}&resolution=${this.cfg.tf}&count=600`).catch((e) => { toast(e.message, true); return []; });
    if (token !== this.loadToken) return;
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
    const get = (m) => api(`/candles?market_id=${m.id}&resolution=${this.cfg.tf}&count=600`).catch((e) => { toast(e.message, true); return []; });
    const [ca, cb] = await Promise.all([get(a), get(b)]);
    if (token !== this.loadToken) return;
    // bars both markets have; a ratio's true high and low aren't known, so they come from the bar's
    // open, close and the two highs and lows over each other
    const byTime = new Map(cb.map((c) => [c.time, c]));
    const candles = [];
    for (const x of ca) {
      const y = byTime.get(x.time);
      if (!y || !y.open || !y.close || !y.high || !y.low) continue;
      const o = x.open / y.open, c = x.close / y.close, h = x.high / y.high, l = x.low / y.low;
      candles.push({ time: x.time, open: o, close: c, high: Math.max(o, c, h, l), low: Math.min(o, c, h, l) });
    }
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
    const add = (o) => { const l = this.series.createPriceLine({ lineWidth: 1, lineStyle: 0, ...o }); this.lines.push(l); return l; };
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
  labelGap() {
    const spacing = this.chart.timeScale().options().barSpacing || 8;
    const ctx = (Panel.measure ||= document.createElement("canvas").getContext("2d"));
    ctx.font = "11px 'JetBrains Mono', monospace"; // the chart's own label font
    let need = 0;
    for (const l of [...(this.lines || []), ...(this.previewLines || [])]) {
      const o = l.options();
      if (!o.title) continue;
      const n = Math.ceil((ctx.measureText(o.title).width + 16) / spacing) + 1;
      if (n <= need) continue;
      const bars = [...this.data.values()].slice(-(n + 10)); // a margin, so the gap doesn't flicker as the price moves
      if (bars.length && o.price >= Math.min(...bars.map((b) => b.low)) && o.price <= Math.max(...bars.map((b) => b.high))) need = n;
    }
    return need;
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
    if (barTime > this.last.time) this.last = { time: barTime, open: price, high: price, low: price, close: price };
    else this.last = { ...this.last, close: price, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price) };
    this.data.set(this.last.time, this.last);
    this.series.update(this.last);
    this.updateZ();
    if (!this.hover) this.renderLegend();
  }

  tick() {
    this.keepGap();
    if (this.pair) return this.tickPair();
    const m = this.market;
    const p = m && prices[m.id];
    if (!p || !this.last) return;
    const price = p.mark || p.last; // the mark moves between trades, as on Lighter's chart (history merges it too)
    if (!price) return;
    const barTime = barStart(this.cfg.tf, Math.floor(Date.now() / 1000));
    if (barTime > this.last.time) this.last = { time: barTime, open: price, high: price, low: price, close: price, volume: 0 };
    else this.last = { ...this.last, close: price, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price) };
    this.data.set(this.last.time, this.last);
    this.series.update(this.last);
    if (!this.hover) this.renderLegend();
    setBadges($(".chart-ctx", this.el), m, 3);
    const s = stops[m.id];
    if (this.stopLine && s && s.stop) this.stopLine.applyOptions({ title: this.stopTitle(s) });
    if (this.markLine && p.mark) this.markLine.applyOptions({ price: p.mark });
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
    const add = (o) => { const l = this.series.createPriceLine({ lineWidth: 1, lineStyle: 0, ...o }); this.lines.push(l); return l; };
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
      const line = this.series.createPriceLine({ price, color: fade(color), lineWidth: 1, lineStyle: style, title });
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
      this.drag.line.applyOptions({ price, title: `${this.drag.label} → ${fp(price, fm)}` });
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
    document.addEventListener("mousedown", (e) => { if (!e.target.closest(".chart-menu")) this.closeOrderMenu(); });
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
const CHART_ELEMENTS = [
  ["orders", "Linee ordini"], ["stop", "Stop gestito"], ["position", "Linea posizione"],
  ["liq", "Prezzo di liquidazione"], ["mark", "Linea prezzo mark"], ["events", "Eventi macro"], ["fills", "I tuoi fill"], ["alerts", "Alert di prezzo"], ["zscore", "Z-score degli spread"], ["preview", "Anteprima ticket"],
];
let chartEls = { orders: true, stop: true, position: true, liq: true, mark: false, events: true, fills: true, alerts: true, zscore: true, preview: true, ...load("chartEls", {}) };
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
  if (k === "preview") updateTicketSummary();
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
  if (showBook) loadBook();
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
function renderMarketBar() {
  const pr = activePair();
  if (pr) return renderPairBar(pr);
  const m = activeMarket();
  if (!m) return;
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
  $("#mkSym").textContent = sym;
  if ($("#mkIco").dataset.sym !== a.symbol) {
    $("#mkIco").outerHTML = ico(a.symbol).replace('<i class="mk-ico"', `<i class="mk-ico" id="mkIco" data-sym="${a.symbol}"`);
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
      crosshair: { mode: 0, vertLine: { style: 2 }, horzLine: { style: 2 } },
      handleScroll: false, handleScale: false,
    });
    fundView.cum = fundView.chart.addLineSeries({ priceScaleId: "left", lineWidth: 1.5, priceFormat: pct, lastValueVisible: false, priceLineVisible: false });
    fundView.rate = fundView.chart.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 1.5, priceFormat: pct, priceLineVisible: false });
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

function renderTicker() {
  if (tickerDrag) return; // don't rebuild the row under the pointer
  const box = $("#ticker");
  const active = panelCfg[activeIdx].symbol;
  box.innerHTML = favs.filter((s) => bySymbol[s] || pairOf(s)).map((s) => {
    const pr = pairOf(s);
    if (pr) { // a spread: its ratio and the ratio's 24h change, as in the market bar
      const [pa, pb] = [prices[pr[0].id], prices[pr[1].id]];
      const xa = pa && (pa.last || pa.mark), xb = pb && (pb.last || pb.mark), r = xa && xb ? xa / xb : null;
      const chg = pa && pb ? ((1 + pa.change / 100) / (1 + pb.change / 100) - 1) * 100 : null;
      return `<button class="tk${active === s ? " active" : ""}" data-sym="${esc(s)}">
        <span class="pair-ico">${ico(pr[0].symbol, "xs")}${ico(pr[1].symbol, "xs")}</span><b>${esc(s)}</b><span class="num">${r ? fp(r, { price_decimals: ratioDecimals(r) }) : "—"}</span>
        <span class="chg ${chg !== null ? cls(chg) : ""}">${chg !== null ? fpct(chg) : ""}</span></button>`;
    }
    const m = bySymbol[s];
    const p = prices[m.id];
    return `<button class="tk${active === s ? " active" : ""}" data-sym="${s}">
      ${ico(s, "xs")}<b>${s}</b><span class="num">${p ? fp(p.last || p.mark, m) : "—"}</span>
      <span class="chg ${p ? cls(p.change) : ""}">${p ? fpct(p.change) : ""}</span></button>`;
  }).join("");
}

// favourites row: drag an item sideways to reorder (a plain click still selects the market)
let tickerDrag = null, tickerDragEnd = 0;
function wireTickerDrag() {
  const box = $("#ticker");
  box.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tk");
    if (!el || e.button !== 0) return;
    tickerDrag = { el, x0: e.clientX, left0: el.offsetLeft, moved: false, id: e.pointerId };
  });
  box.addEventListener("pointermove", (e) => {
    const d = tickerDrag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x0) < 5) return;
      d.moved = true;
      d.el.classList.add("dragging");
      document.body.classList.add("reordering");
      try { box.setPointerCapture(e.pointerId); } catch {}
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
const book = { ws: null, market: null, asks: new Map(), bids: new Map(), nonce: null, dirty: false, live: false };

function bookConnect() {
  if (book.ws || !info.ws_url) return;
  const ws = new WebSocket(info.ws_url);
  book.ws = ws;
  ws.onopen = () => bookSubscribe(activeMarket());
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
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
    if (showBook) setTimeout(bookConnect, 2000);
  };
}

function bookSubscribe(m, resync = false) {
  if (!book.ws || book.ws.readyState !== 1 || !m) return;
  if (book.market && (book.market.id !== m.id || resync)) {
    book.ws.send(JSON.stringify({ type: "unsubscribe", channel: `order_book/${book.market.id}` }));
  }
  book.market = m;
  book.nonce = null;
  book.asks.clear();
  book.bids.clear();
  book.ws.send(JSON.stringify({ type: "subscribe", channel: `order_book/${m.id}` }));
}

function loadBook() {
  if (!showBook) return;
  if (!book.ws) bookConnect();
  else if (!book.market || book.market !== activeMarket()) bookSubscribe(activeMarket());
}

function renderBook() {
  if (!book.dirty || !showBook || !book.market) return;
  book.dirty = false;
  const m = book.market;
  const depth = 14;
  const asks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, depth);
  const bids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, depth);
  const rows = (lvls, rev) => {
    let tot = 0;
    const withTot = lvls.map(([p, s]) => { tot += s; return [p, s, tot]; });
    const max = tot || 1;
    const html = withTot.map(([p, s, t]) => `<div class="lvl"><i style="width:${(t / max) * 100}%"></i><span>${fp(p, m)}</span><span>${fsize(s, m)}</span><span>${fsize(t, m)}</span></div>`);
    return (rev ? html.reverse() : html).join("");
  };
  $("#bookAsks").innerHTML = rows(asks, true);
  $("#bookBids").innerHTML = rows(bids, false);
  const a = asks[0] && asks[0][0], b = bids[0] && bids[0][0];
  if (a && b) {
    const spread = ((a - b) / ((a + b) / 2)) * 10000;
    $("#bookMid").innerHTML = `<span>${fp((a + b) / 2, m)}</span><small>spread ${spread.toFixed(1)} bps · live</small>`;
  }
}

function toggleBook(v) {
  showBook = v;
  store("book", v);
  $("#book").classList.toggle("hidden", !v);
  $("#obToggle").classList.toggle("active", v);
  if (v) loadBook();
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

function renderChips(chips) {
  const box = $("#tkChips");
  const html = chips.map(([v, label]) => `<button data-v="${v}" title="${t("Aggiunge {v} alla size: clicca più volte per sommare", { v: label })}">${label}</button>`).join("");
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; } // not under a click on the way
}

// what's held on the market in the ticket, among the account's figures
function setAccPos(html) {
  for (const id of ["#accPos", "#accPosDt"]) $(id).classList.toggle("hidden", !html);
  $("#accPos").innerHTML = html;
}

function renderTicket() {
  const pr = activePair();
  $(".ticket").classList.toggle("pair", !!pr);
  if (pr) return renderPairTicket(pr);
  $('#sideSel [data-side="buy"]').textContent = "Buy / Long";
  $('#sideSel [data-side="sell"]').textContent = "Sell / Short";
  const m = activeMarket();
  if (!m) return;
  $("#tkSym").textContent = m.symbol;
  const pos = account && account.positions.find((p) => p.market_id === m.id);
  const set = levSet(m);
  const levNow = set ? set.leverage : m.default_leverage;
  $("#tkLev").textContent = levNow ? `${levNow}x` : "—";
  const isolated = !!(set && !set.cross);
  $$("#tkMode [data-cross]").forEach((b) => {
    const on = (b.dataset.cross === "0") === isolated;
    b.classList.toggle("active", on);
    b.disabled = !!pos && !on; // an open position keeps its margin mode
    b.title = b.disabled ? t("Chiudi la posizione per passare tra cross e isolated")
      : t(b.dataset.cross === "1" ? "Cross: usa tutto il margine dell'account, e la liquidazione guarda tutto l'account" : "Isolated: rischia solo il margine di questa posizione");
  });
  setAccPos(pos ? `<span class="${pos.size > 0 ? "up" : "down"}">${pos.size > 0 ? "Long" : "Short"} ${fsize(pos.size, m)} ${esc(m.symbol)}</span>` : "");
  const unit = $("#tkUnit").value;
  $('#tkUnit option[value="base"]').textContent = m.symbol; // the menu is the size's unit
  $("#tkSizeUnit").textContent = { usd: "USD", base: m.symbol, equity_pct: "%", risk_usd: "USD" }[unit];
  renderChips(quickChips(unit, m));
  const showsLimit = hasLimitField(), showsMarket = ticket.kind === "market" || ticket.kind === "rfq" || (ticket.kind === "conditional" && ticketAdv.exec === "market");
  $$(".limit-only").forEach((e) => e.classList.toggle("hidden", !showsLimit));
  $$(".market-only").forEach((e) => e.classList.toggle("hidden", !showsMarket));
  $("#tkPost").closest("label").classList.toggle("hidden", !["limit", "scale", "iceberg"].includes(ticket.kind));
  $(".ticket").dataset.kind = ticket.kind;
  $$("#sideSel button").forEach((b) => b.classList.toggle("active", b.dataset.side === ticket.side));
  $$("#kindSel [data-kind]").forEach((b) => b.classList.toggle("active", b.dataset.kind === ticket.kind));
  $("#advBtn").classList.toggle("active", !isBasicKind());
  $("#advName").textContent = { conditional: t("Condizionale"), twap: "TWAP", scale: "Scale", chase: "Chase Limit", iceberg: "Iceberg", basket: "Basket", rfq: "RFQ" }[ticket.kind] || t("Avanzati");
  $$("#tkCondExec [data-exec]").forEach((b) => b.classList.toggle("active", b.dataset.exec === ticketAdv.exec));
  $$("#tkScaleDist [data-dist]").forEach((b) => b.classList.toggle("active", b.dataset.dist === ticketAdv.dist));
  const ex = $("#tkExec");
  ex.className = "execute" + (!info.trading ? " connect" : ticket.side === "sell" ? " sell" : "");
  ex.textContent = info.trading ? `${ticket.side === "buy" ? "Buy / Long" : "Sell / Short"} ${m.symbol}${Paper.on ? " · Paper" : ""}`
    : t("Sola lettura · collega un'API key");
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
  $('#sideSel [data-side="buy"]').textContent = `Long ${a.symbol} / Short ${b.symbol}`;
  $('#sideSel [data-side="sell"]').textContent = `Short ${a.symbol} / Long ${b.symbol}`;
  $$("#sideSel button").forEach((x) => x.classList.toggle("active", x.dataset.side === ticket.side));
  $("#tkSizeUnit").textContent = "USD";
  renderChips(quickChips("usd", a));
  $$(".market-only").forEach((e) => e.classList.remove("hidden"));
  const ex = $("#tkExec");
  const [l, s] = pairLegs();
  ex.className = "execute" + (!info.trading ? " connect" : ticket.side === "sell" ? " sell" : "");
  ex.textContent = info.trading ? `Long ${l.symbol} / Short ${s.symbol}${Paper.on ? " · Paper" : ""}` : t("Sola lettura · collega un'API key");
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
     <dt>${t("Commissioni stimate")}</dt><dd>${size > 0 ? fusd(tot("fee")) : "—"}</dd>`;
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
    (rows.length ? `<dt>${t("Valore ordine")}</dt><dd>${fusd(money((x) => x.usd))}</dd><dt>${t("Margine")}</dt><dd>${fusd(money((x) => x.usd / x.lev))}</dd>${fees ? `<dt>${t("Commissioni stimate")}</dt><dd>${fusd(fees)}</dd>` : ""}` : "");
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
    $("#tkChaseCapLabel").textContent = t(buy ? "Prezzo massimo" : "Prezzo minimo");
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

function updateTicketSummary() {
  if (activePair()) return updatePairSummary();
  if (ticket.kind === "basket") return updateBasketSummary();
  const m = activeMarket();
  const p = m && prices[m.id];
  const size = +$("#tkSize").value;
  const unit = $("#tkUnit").value;
  const sl = +$("#tkSl").value;
  const ref = m ? ticketRef(m, p) : 0;
  let qty = null;
  if (m && ref && size > 0) {
    if (unit === "usd") qty = size / ref;
    else if (unit === "base") qty = size;
    else if (unit === "equity_pct" && account) qty = (account.total_value * size) / 100 / ref;
    else if (unit === "risk_usd" && sl && sl !== ref) qty = size / Math.abs(ref - sl);
  }
  tpHint();
  $("#tkNotional").textContent = qty ? fusd(qty * ref) : "—";
  $("#tkQty").textContent = qty ? `${qty.toFixed(m.size_decimals)} ${m.symbol}` : "—";
  // the size is already in one of them: no need to repeat it
  $("#tkNotional").classList.toggle("hidden", unit === "usd");
  $("#tkQty").classList.toggle("hidden", unit === "base");
  syncSizeSlider(m, qty, ref);
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

function sizeFromPct(pct) {
  const m = activeMarket(), p = m && prices[m.id], unit = $("#tkUnit").value;
  const ref = ticketRef(m, p);
  const max = sliderMax(m, ref);
  if (!max || riskNeedsStop(ref)) return;
  const qty = max * Math.max(0, Math.min(100, pct)) / 100;
  const v = unit === "base" ? floorTo(qty, m.size_decimals)
    : unit === "equity_pct" ? floorTo(qty * ref / account.total_value * 100, 2)
    : unit === "risk_usd" ? floorTo(qty * Math.abs(ref - +$("#tkSl").value), 2)
    : floorTo(qty * ref, 2);
  $("#tkSize").value = v > 0 ? v : "";
  updateTicketSummary();
}

function syncSizeSlider(m, qty, ref) {
  const row = $("#tkPctRow"), max = sliderMax(m, ref), off = riskNeedsStop(ref);
  row.classList.toggle("hidden", !account);
  row.classList.toggle("sell", ticket.side === "sell");
  row.classList.toggle("off", off);
  row.title = off ? t("Imposta lo stop-loss: il rischio si calcola da lì") : "";
  const range = $("#tkPct"), box = $("#tkPctIn");
  range.disabled = box.disabled = off;
  const pct = max && qty ? Math.min(100, (qty / max) * 100) : 0;
  if (document.activeElement !== range || !range.matches(":active")) range.value = Math.round(pct);
  range.style.setProperty("--p", range.value + "%");
  if (document.activeElement !== box) box.value = qty ? Math.round(pct) : "";
}

// ---------- estimated price: the order walked through the book ----------
const estBook = { market: null, at: 0, asks: [], bids: [], busy: false };

function renderEstFill(m, qty, entry) {
  const buy = ticket.side === "buy", maxSlip = (+$("#tkSlip").value || 50) / 100;
  const slip = $("#tkEstSlip");
  const levels = estBook.market === m.id ? (buy ? estBook.asks : estBook.bids) : [];
  const maxText = t("max {m}%", { m: +maxSlip.toFixed(2) });
  estBook.last = null;
  if (!qty || !levels.length) {
    slip.textContent = maxText;
    slip.classList.remove("down");
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
  slip.textContent = `${t("stimato {e}%", { e: (deep ? "> " : "") + est.toFixed(2) })} · ${maxText}`;
  slip.classList.toggle("down", est >= maxSlip || deep);
  return avg;
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
  const hasStops = isBasicKind() && !reduce && (+$("#tkSl").value > 0 || +$("#tkTp").value > 0 || !!readTpLevels());
  for (const id of ["#tkTpslSlipDt", "#tkTpslSlip"]) $(id).classList.toggle("hidden", !hasStops);
  $("#tkTpslSlip").textContent = t("max {m}%", { m: +((+$("#tkSlip").value || 50) / 100).toFixed(2) });
  const mark = p && p.mark;
  const curPos = account && account.positions.find((x) => x.market_id === m.id);
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
  for (const [id, isSL] of !isBasicKind() ? [] : levels ? [["Sl", true]] : [["Sl", true], ["Tp", false]]) {
    const trigger = +$("#tk" + id).value;
    const out = $(`#tk${id}Out`);
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

function ticketMsg(text, kind) {
  const el = $("#tkMsg");
  el.textContent = text;
  el.className = "ticket-msg " + kind;
}

async function executeTicket(byMouse = false) {
  if (activePair()) return executePair(byMouse);
  if (ticket.kind === "basket") return executeBasket(byMouse);
  if (ticket.kind === "rfq") return executeRfq(byMouse);
  if (!(await levFlush())) return; // the leverage on screen didn't go through: no order on the wrong one
  const m = activeMarket();
  const size = +$("#tkSize").value;
  if (!m || !(size > 0)) return ticketMsg(t("Inserisci una size valida."), "err");
  const body = ticketBody();
  if (ticket.kind === "limit" && !body.price) return ticketMsg(t("Inserisci il prezzo limite."), "err");
  if (body.trail === null) return ticketMsg(t("Inserisci la distanza del trailing."), "err");
  const label = `${ticket.side === "buy" ? "LONG" : "SHORT"} ${m.symbol} · ${$("#tkNotional").textContent} · ${ticket.kind}`
    + (body.tp_levels ? ` · ${body.tp_levels.length} TP` : "") + (body.trail ? ` · trailing ${trailLabel(trailToStop(body.trail), m)}` : "");
  if (!(pendingConfirm && pendingConfirm.key === "order")) { // first click: full check, SL/TP sides included
    const r = await api("/preview", { method: "POST", body: JSON.stringify(body) }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return ticketMsg(r.error, "err");
    $("#tkMsg").className = "ticket-msg hidden";
  }
  if (!askConfirm("order", `${t("Conferma")} ${label}`)) return;
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
    toast(t("Chiusura {f}% inviata", { f: 100 }));
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
  $("#alertCount").textContent = alerts.length || "";
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
  renderAccountHead();
  const has = !!account;
  $("#accIdx").textContent = has ? (Paper.on ? "Paper" : "#" + account.index) : "";
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
  const pill = $("#accountPill");
  pill.innerHTML = Paper.on ? `<i class="dot paper"></i><span>Paper${has ? " · " + fusd(account.total_value, 0) : ""}</span>`
    : liveInfo ? `<i class="dot"></i><span>${t("Account #{n}", { n: liveInfo.account_index })}${has ? " · " + fusd(account.total_value, 0) : ""}</span>`
    : info.trading ? `<i class="dot"></i><span>${t("Account #{n}", { n: info.account_index })}</span>` : `<i class="dot off"></i><span>${t("Sola lettura")}</span>`;
  pill.classList.toggle("muted", !info.trading);
  if (info.trading && !$("#keyModal").classList.contains("hidden")) renderKeyEquity();
  if (Paper.on && !$("#paperModal").classList.contains("hidden")) renderPaperModal();
  pill.title = Paper.on ? t("Paper trading") : info.trading ? t("API key collegata") : t("Collega un'API key");
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
  const steps = x ? `<small class="tp-step" title="${t("Uscite scalari: livelli eseguiti")}">TP ${x.levels.filter((l) => l.done).length}/${x.levels.length}</small>` : "";
  return `${steps}${one("tp")}<span class="sltp-sep">/</span>${one("sl")}`;
}

// TP / SL edited in the row: Enter sends, Esc or clicking away cancels, an empty value removes it
let posEdit = null;
function editPositionStop(btn) {
  const [mid, k] = btn.dataset.psl.split(":");
  const p = account && account.positions.find((x) => x.market_id === +mid);
  if (!p) return;
  const cur = positionStops(p)[k];
  posEdit = { mid: +mid, k };
  const input = document.createElement("input");
  input.className = "sltp-in " + k;
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.placeholder = k.toUpperCase();
  input.value = cur ? cur.trigger_price : "";
  btn.replaceWith(input);
  input.focus();
  input.select();
  const end = () => { posEdit = null; renderPositions(); };
  input.onkeydown = async (e) => {
    if (e.key === "Escape") return end();
    if (e.key !== "Enter") return;
    const price = +input.value.trim();
    if ((!price && !cur) || (cur && price === cur.trigger_price)) return end();
    input.onblur = null;
    input.disabled = true;
    try {
      await api("/position_sltp", { method: "POST", body: JSON.stringify({ market_id: +mid, kind: k, price: price || null, order_index: cur ? cur.order_index : null }) });
      toast(price ? t("{kind} a {price}", { kind: k.toUpperCase(), price: fp(price, byId[+mid]) }) : t("{kind} rimosso", { kind: k.toUpperCase() }));
      posEdit = null;
      await fetchOpenOrders(true).catch(() => {});
    } catch (err) { toast(err.message, true); }
    end();
  };
  input.onblur = end;
}

function renderPositions() {
  if (posEdit) return; // don't rebuild the row under a TP/SL being typed
  const box = $("#btab-positions");
  const list = account ? account.positions : [];
  $("#posCount").textContent = list.length || "";
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
  box.innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th class="r">Size</th><th class="r">${t("Valore")}</th><th class="r" title="${t("Il tuo capitale impegnato: valore all'entrata diviso la leva.")}">${t("Margine")}</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">${t("Liquidazione")}</th><th class="r" title="${t("La percentuale è calcolata sul margine iniziale.")}">${t("PnL non realizzato")}</th><th class="r">TP / SL</th><th>${t("Trailing")}</th><th>${t("Chiudi a mercato")}</th></tr></thead><tbody>${
    rows.map((p) => {
      if (typeof p === "string") return p; // a pair's own row
      const m = byId[p.market_id];
      const mark = prices[p.market_id] ? prices[p.market_id].mark : 0;
      // PnL % on the initial margin (entry value / leverage), as Lighter and the ticket show it
      const margin = p.leverage ? (Math.abs(p.size) * p.entry) / p.leverage : 0;
      const pct = margin ? (p.upnl / margin) * 100 : 0;
      return `<tr><td class="mk">${gotoBtn(p.symbol)}${p.leverage ? `<span class="mk-lev">${p.leverage}x</span>` : ""}<small class="${p.size > 0 ? "up" : "down"}">${p.size > 0 ? "Long" : "Short"}${marginTag(p)}<button class="pair-add" data-pairfrom="${p.market_id}" title="${t("Fai una coppia con una posizione dal lato opposto")}">+ ${t("Coppia")}</button></small></td>
        <td class="r ${p.size > 0 ? "up" : "down"}">${fsize(p.size, m)} <span class="unit-sym">${esc(p.symbol)}</span>${paired[p.market_id] ? `<small class="pos-lev">${t("di cui {q} in coppia", { q: fsize(paired[p.market_id], m) })}</small>` : ""}</td><td class="r main">${fusd(p.value)}</td>
        <td class="r">${margin ? fusd(margin) : "—"}</td><td class="r">${fp(p.entry, m)}</td><td class="r main">${fp(mark, m)}</td>
        <td class="r liq" title="${p.cross === false ? t("Isolated: si liquida quando la perdita si mangia il margine di questa posizione.") : t("Cross: si liquida solo quando la perdita si mangia il collaterale di tutto l'account, non solo il margine di questa posizione. Per questo può essere molto lontana.")}">${fp(p.liq, m)}</td><td class="r pnl ${cls(p.upnl)}">${fusd(p.upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
        <td class="r sltp">${sltpCell(p, m)}</td>
        <td>${trailButton(p.market_id, m)}</td>
        <td><span class="qbtn">${[25, 50, 75, 100].map((f) => `<button data-close="${p.market_id}" data-f="${f}"${f === 100 ? ` class="all" data-ck="close:${p.market_id}" data-key="F" title="${t("Chiudi tutto · F")}"` : ` data-ck="close:${p.market_id}:${f}"${f === 50 ? ` title="${t("Chiudi metà · H")}"` : ""}`}>${f}%</button>`).join("")}<button class="rev" data-reverse="${p.market_id}" data-ck="reverse:${p.market_id}" data-key="R" title="${t("Reverse: chiude e apre il lato opposto, stessa size · R")}">⇄ Reverse</button></span></td></tr>`;
    }).join("")}</tbody></table>`;
  markConfirm();
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
    <td class="r ${g.side > 0 ? "up" : "down"}">${fsize(g.qty, g.m)} <span class="unit-sym">${esc(g.m.symbol)}</span></td><td class="r">${fusd(g.value)}</td><td class="r">${fusd(g.margin)}</td>
    <td class="r">${fp(g.entry, g.m)}</td><td class="r">${fp(g.mark, g.m)}</td><td class="r liq">${fp(liqOf(g.m), g.m)}</td><td class="r pnl ${cls(g.upnl)}">${fusd(g.upnl)}</td><td></td><td></td><td></td></tr>`;
  const stop = (k) => `<button class="sltp-v ${k}${x[k] ? "" : " none"}" data-pstop="${x.id}:${k}" title="${t(k === "tp" ? "Take-profit della coppia sul rapporto" : "Stop-loss della coppia sul rapporto")}">${x[k] ? fmt(x[k]) : "—"}</button>`;
  return `<tr class="pair-row"><td class="mk">${gotoBtn(sym)}<small class="up">${t("Coppia")}</small></td>
    <td class="r"><span class="up">L ${esc(ml.symbol)}</span> / <span class="down">S ${esc(ms.symbol)}</span></td>
    <td class="r main">${fusd(sum("value"))}<small class="pos-lev" title="${t("Funding all'ora delle due gambe insieme")}">funding ${fsmall(fundH)}/h</small></td>
    <td class="r">${margin ? fusd(margin) : "—"}</td><td class="r" title="${t("Rapporto all'entrata")}">${fmt(entry)}</td><td class="r main" title="${t("Rapporto attuale")}">${fmt(now)}</td>
    <td class="r liq" title="${t("La liquidazione più vicina fra le due gambe")}">${near ? `<span class="${near.pct < BADGE_LIQ ? "down" : ""}">${near.pct > 100 ? "> 100%" : near.pct.toFixed(1) + "%"}</span><small class="pos-lev">${esc(near.m.symbol)}</small>` : "—"}</td>
    <td class="r pnl ${cls(upnl)}">${fusd(upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
    <td class="r sltp">${stop("tp")}<span class="sltp-sep">/</span>${stop("sl")}</td><td></td>
    <td><span class="qbtn">${[50, 100].map((f) => `<button data-pclose="${x.id}" data-f="${f}" class="${f === 100 ? "all" : ""}" data-ck="pclose:${x.id}${f === 100 ? "" : ":" + f}">${f}%</button>`).join("")}<button class="unpair" data-unpair="${x.id}" title="${t("Separa: le due posizioni restano aperte, non più come coppia")}">${t("Separa")}</button></span></td></tr>`
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
    toast(t("Chiusura {f}% della coppia inviata", { f }));
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
      return `<tr><td class="mk">${gotoBtn(o.symbol)}</td><td>${workingOf(o) ? `${orderKind(o)} · ${+workingOf(o).filled}/${+workingOf(o).qty}` : esc(o.type)}</td><td class="${o.is_ask ? "down" : "up"}">${o.is_ask ? "Sell" : "Buy"}</td>
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
  ...Object.fromEntries(["BABA", "TENCENT", "XIAOMI", "BYD", "SMIC", "ZHIPU", "MINIMAX", "UNITREE", "CXMT", "POPMART", "XCU"].map((s) => [s, ["china"]])) };
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
  { name: "Stati Uniti", ex: "NYSE", code: "XNYS", tz: "America/New_York", open: [9, 30], close: [16, 0] },
  { name: "Regno Unito", ex: "LSE", code: "XLON", tz: "Europe/London", open: [8, 0], close: [16, 30] },
  { name: "Germania", ex: "Xetra", code: "XETR", tz: "Europe/Berlin", open: [9, 0], close: [17, 30] },
  { name: "Giappone", ex: "TSE", code: "XTKS", tz: "Asia/Tokyo", open: [9, 0], close: [15, 30], lunch: [[11, 30], [12, 30]] },
  { name: "Cina", ex: "SSE Shanghai", code: "XSHG", tz: "Asia/Shanghai", open: [9, 30], close: [15, 0], lunch: [[11, 30], [13, 0]] },
  { name: "Hong Kong", ex: "HKEX", code: "XHKG", tz: "Asia/Hong_Kong", open: [9, 30], close: [16, 0], lunch: [[12, 0], [13, 0]] },
  { name: "Australia", ex: "ASX", code: "XASX", tz: "Australia/Sydney", open: [10, 0], close: [16, 0] },
];
let exchangeHours = null;
fetch("exchange_hours.json?v=1").then((r) => r.json()).then((d) => { exchangeHours = d.exchanges; renderSessions(); }).catch(() => {});

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
      return { state: "closed", at: open, holiday };
    }
    if (bs && now >= bs && now < be) return { state: "lunch", at: be };
    return { state: "open", at: bs && now < bs ? bs : close, lunchNext: !!(bs && now < bs), close };
  }
  return { state: "closed", at: null };
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
    : `${st.holiday ? t("festività") + " · " : ""}${t("apre")} ${st.at ? local(st.at) : ""}`;
  const html = rows.map(({ s, st }) => `<div class="cal-row">
      <div><div class="t">${t(s.name)}</div><div class="s">${s.ex} · ${line(st)}</div></div>
      <div class="w ${st.state === "open" ? "open" : st.state === "lunch" || st.at - now < 3600000 ? "soon" : ""}">${
        st.state === "open" ? t("aperto · {d}", { d: dur(st.at - now) }) : st.state === "lunch" ? t("pausa · {d}", { d: dur(st.at - now) }) : t("tra {d}", { d: dur(st.at - now) })}</div>
    </div>`).join("");
  $("#ctab-sessions").innerHTML = html;
  $("#cpSessions").innerHTML = html;
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

async function loadAccountPage() {
  const has = !!info.trading;
  $("#acEmpty").classList.toggle("hidden", has);
  $("#acBody").classList.toggle("hidden", !has);
  if (!has) return;
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
  $("#acIdx").textContent = "#" + account.index;
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

function renderCalPage() {
  if ($("#view-cal").classList.contains("hidden")) return;
  const now = Date.now() / 1000, q = $("#cpSearch").value.trim().toLowerCase();
  const sym = cp.scope === "mkt" ? cp.market || (activeMarket() && activeMarket().symbol) : null;
  $$("#cpScope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === cp.scope));
  $$("#cpTypes button").forEach((b) => b.classList.toggle("active", cp.types.includes(b.dataset.type)));
  $$("#cpImpacts button").forEach((b) => b.classList.toggle("active", cp.impacts.includes(b.dataset.imp)));
  $$("#cpRange button").forEach((b) => b.classList.toggle("active", b.dataset.range === cp.range));
  const sel = $("#cpMarket");
  sel.disabled = cp.scope !== "mkt";
  if (sel.value !== sym && sym) sel.value = sym;
  const endOfToday = new Date().setHours(24, 0, 0, 0) / 1000;
  const inRange = (e) => cp.range === "past" ? e.ts < now
    : e.ts >= now - 3 * 3600 && (cp.range === "all" || e.ts < (cp.range === "today" ? endOfToday : now + +cp.range * 86400));
  const list = events.filter((e) => {
    if (!inRange(e) || !cp.types.includes(evType(e))) return false;
    const imp = sym ? impactFor(e, sym) : impactAny(e);
    if (!cp.impacts.includes(imp === "Holiday" ? "Low" : imp)) return false;
    if (sym && !eventFor(e, sym)) return false;
    return !q || `${e.title} ${e.country} ${e.name || ""} ${evMarkets(e).join(" ")}`.toLowerCase().includes(q);
  });
  if (cp.range === "past") list.reverse();
  $("#cpCount").textContent = t("{n} eventi", { n: list.length }) + (sym ? " · " + t("che muovono {sym}", { sym }) : "");
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
  if (info.blocked_country) { $("#geoPage").classList.remove("hidden"); return; }
  $("#pubGithub").href = info.github_url;
  $("#pubReferral").href = info.referral_url;
  $("#pubBar").classList.toggle("hidden", !!load("pubbarClosed", false));
  $("#pubClose").onclick = () => { store("pubbarClosed", true); $("#pubBar").classList.add("hidden"); };
  if (!load("residence", false)) { $("#resVeil").classList.remove("hidden"); $("#resModal").classList.remove("hidden"); }
  $("#resYes").onclick = () => { store("residence", true); $("#resVeil").classList.add("hidden"); $("#resModal").classList.add("hidden"); };
  $("#resNo").onclick = () => { $("#resVeil").classList.add("hidden"); $("#resModal").classList.add("hidden"); $("#geoPage").classList.remove("hidden"); };
  $("#accountPill").title = t("Versione pubblica in sola lettura");
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
function renderMarkets() {
  const q = $("#mktSearch").value.trim().toUpperCase();
  const rows = markets.filter((m) => !q || m.symbol.includes(q)).map((m) => {
    const p = prices[m.id] || {};
    return { m, symbol: m.symbol, price: p.last || p.mark || 0, change: p.change || 0, volume: p.volume || m.volume_usd, oi: p.oi || 0, funding: p.funding || 0 };
  });
  rows.sort((a, b) => (a[mktSort.key] > b[mktSort.key] ? 1 : -1) * mktSort.dir);
  $("#mktTable tbody").innerHTML = rows.slice(0, 250).map((r) => `<tr data-sym="${r.symbol}">
      <td><button class="star${favs.includes(r.symbol) ? " on" : ""}" data-star="${r.symbol}">★</button></td>
      <td class="mk"><span class="sym">${ico(r.symbol)}${r.symbol}</span></td><td class="r">${fp(r.price, r.m)}</td><td class="r ${cls(r.change)}">${fpct(r.change)}</td>
      <td class="r">${fcompact(r.volume)}</td><td class="r">${fcompact(r.oi)}</td><td class="r ${r.funding < 0 ? "down" : ""}">${r.funding.toFixed(4)}%</td>
      <td class="r"><span class="open-btn">${t("Apri nel grafico →")}</span></td></tr>`).join("");
}

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
  box.style.left = Math.max(4, Math.min(innerWidth - box.offsetWidth - 4, r.right - box.offsetWidth)) + "px";
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
    toast(t("{sym}: leva {lev}x {mode} inviata", { sym: m.symbol, lev: p.leverage, mode: p.cross ? "cross" : "isolated" }));
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
    if (msg.type !== "tick") return;
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
  };
  ws.onclose = () => { setStatus(false); setTimeout(connect, 2000); };
}

let feedOk = false;
function setStatus(ok) {
  feedOk = ok;
  $("#statusPill").innerHTML = ok ? `<i class="dot"></i><span>${t("Pronto")}</span>` : `<i class="dot warn"></i><span>${t("Riconnessione…")}</span>`;
}

// ================= ui wiring =================
// ---------- addresses ----------
// every page has its own path and the trade page names its market (/trade/WTI), so a link opens the
// same view, the browser's back button walks between pages, and a market can be shared directly
const ROUTES = { trade: "trade", markets: "markets", calendar: "cal", account: "account", automations: "auto", activity: "activity" };
const PATH_OF = Object.fromEntries(Object.entries(ROUTES).map(([path, view]) => [view, path]));
let curView = "trade";
function routeFromUrl() {
  const [, page, sym] = location.pathname.split("/");
  return { view: ROUTES[page] || null, sym: sym ? symFromUrl(decodeURIComponent(sym).toUpperCase()) : null };
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
  if ((info.public || Paper.on) && ["auto", "activity", "account"].includes(v)) v = "trade"; // live account only
  $$("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  if (v === "markets") renderMarkets();
  if (v === "cal") renderCalPage();
  if (v === "account") loadAccountPage();
  if (v === "auto") { loadRules(); loadLimits(); }
  store("view", v);
  curView = v;
  if (!opts.fromUrl) syncUrl(true);
}

function switchBottom(t) {
  $$("#bottomTabs button").forEach((b) => b.classList.toggle("active", b.dataset.btab === t));
  $$(".btab").forEach((s) => s.classList.toggle("hidden", s.id !== "btab-" + t));
  if (t === "orders") loadOrders();
  if (t === "trades") loadTrades();
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
  $("#mktSelect").onclick = () => ($("#picker").classList.contains("hidden") ? openPalette() : closePalette());
  wireTickerDrag();
  $("#ticker").onclick = (e) => { if (Date.now() - tickerDragEnd < 300) return; const b = e.target.closest("[data-sym]"); if (b) setSymbol(b.dataset.sym); };

  // market picker lives in picker.js
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    else if (e.key === "Escape") closePalette();
  });

  // ticket
  $$("#sideSel button").forEach((b) => (b.onclick = () => { ticket.side = b.dataset.side; renderTicket(); }));
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
  $("#tkExec").onclick = (e) => (info.trading ? executeTicket(e.detail > 0) : openKeyDialog());
  ["#tkSl", "#tkTp", "#tkSlip"].forEach((s) => ($(s).oninput = updateTicketSummary));
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
  $$("#bottomTabs button").forEach((b) => (b.onclick = () => switchBottom(b.dataset.btab)));
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
    if (v && info.trading) return editPositionStop(v);
    const r = e.target.closest("[data-reverse]");
    if (r) return reversePosition(+r.dataset.reverse);
    const b = e.target.closest("[data-close]");
    if (!b) return;
    const mid = +b.dataset.close, f = +b.dataset.f;
    if (f === 100 && !askConfirm(`close:${mid}`, t("Chiudi tutto"))) return;
    if (f < 100 && !askConfirm(`close:${mid}:${f}`, t("Conferma {f}%", { f }))) return;
    try { await api(`/close?market_id=${mid}&fraction=${f / 100}`, { method: "POST" }); toast(t("Chiusura {f}% inviata", { f })); } catch (err) { toast(err.message, true); }
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
  $("#accOpen").onclick = () => (Paper.on ? openPaperModal() : switchView("account"));
  $("#acDays").onclick = (e) => { const b = e.target.closest("[data-days]"); if (b) { acc.days = +b.dataset.days; store("acc.days", acc.days); loadAccountPage(); } };
  $("#acMode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { acc.mode = b.dataset.mode; store("acc.mode", acc.mode); renderAccountChart(); } };
  $("#acPrev").onclick = () => { acc.month = shiftMonth(acc.month, -1); acc.day = null; renderPnlCalendar(); };
  $("#acNext").onclick = () => { acc.month = shiftMonth(acc.month, 1); acc.day = null; renderPnlCalendar(); };
  $("#acCal").onclick = (e) => { const b = e.target.closest("[data-day]"); if (b) showDayFills(b.dataset.day); };
  $("#econOpen").onclick = () => { cp.scope = "mkt"; cp.market = activeMarket() && activeMarket().symbol; saveCp(); switchView("cal"); };
  $("#cpFilters").onclick = (e) => {
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
  $("#cpMarket").onchange = (e) => { cp.market = e.target.value; saveCp(); renderCalPage(); };
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
  $("#sbClock").textContent = d.toISOString().slice(11, 19) + " UTC";
  $("#sbAge").textContent = lastTick ? t("Prezzi ricevuti {ms} ms fa", { ms: Math.max(0, Date.now() - lastTick) }) : t("In attesa di prezzi");
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
  tp.placeholder = t(on ? "Uscite scalari" : "Opzionale");
  if (on) { tp.value = ""; $("#tkTpOut").textContent = ""; $("#tkTpOut").className = "sltp-out"; }
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
  return `<div class="trail-dist"><div class="field sm"><label>${t("Distanza dal prezzo migliore")}</label><input data-tr="value" type="number" min="0" step="any" value="${v.value ?? ""}" placeholder="${v.mode === "atr" ? "1.5" : v.mode === "price" ? "" : "1"}"></div>
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
  }
  updateTicketSummary();
}

function trailButton(marketId, m) {
  const s = stops[marketId];
  if (!s) return `<button class="trail-btn" data-trail="${marketId}">+ ${t("Trailing")}</button>`;
  const paused = !autoOn() || !s.enabled;
  const title = paused ? t("Auto è OFF: il trailing è fermo") : t("Stop gestito attivo");
  return `<button class="trail-btn on${paused ? " paused" : ""}" data-trail="${marketId}" title="${title}">${trailLabel(s, m)}${s.stop ? " · " + fp(s.stop, m) : ""}</button>`;
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
  wireCardTables();
  wireAdvOrders();
  wirePairGroup();
  wireEventTrades();
  $("#mktSpread").onclick = openSpreadPicker;
  $("#alertCount").textContent = alerts.length || "";
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
const BOTTOM_DEFAULT = 210;
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
const walletProviders = new Map(); // uuid -> { info, provider }
window.addEventListener("eip6963:announceProvider", (e) => {
  walletProviders.set(e.detail.info.uuid, e.detail);
  $("#keyWallet").classList.remove("hidden");
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
setTimeout(() => { // older wallets only inject window.ethereum
  if (!walletProviders.size && window.ethereum) {
    walletProviders.set("injected", { info: { name: "Browser wallet" }, provider: window.ethereum });
    $("#keyWallet").classList.remove("hidden");
  }
}, 500);

async function useWallet(provider) {
  keyError("");
  try {
    const [address] = await provider.request({ method: "eth_requestAccounts" });
    if (!address) return keyError(t("Il wallet non ha condiviso nessun indirizzo"));
    $("#keyAddress").value = address;
    $("#keyFind").click();
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
  $("#keyShade").classList.remove("hidden");
  $("#keyModal").classList.remove("hidden");
  if (!on) $(browser || info.account_index == null ? "#keyAddress" : "#keyIndex").focus();
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

// the browser key connected or removed: live with it, paper without
function browserKeyChanged() {
  document.body.classList.toggle("browser-key", Live.on);
  setPaper(!Live.on);
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

// ================= paper trading =================
// live prices, simulated money (paper.js): the public site always runs it, the personal deck can switch
let liveTrading = false;
const autoOn = () => Paper.on || info.armed;

function setPaper(on) {
  Paper.on = !Live.on && (!!info.public || on);
  if (!info.public) store("paper", Paper.on);
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
  $("#keyPaper").onclick = $("#keyPaper2").onclick = () => {
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
  ["1–4", "Seleziona il grafico"],
  ["[ ]", "Timeframe precedente / successivo"],
  ["/", "Cerca mercato"],
  ["?", "Questo elenco"],
];

// the key next to the control it drives: a small badge (desktop only, via CSS) and the tooltip
function applyKeyHints() {
  const hint = (el, key, title) => { if (!el) return; if (key) el.dataset.key = key; if (title) el.title = title; };
  hint($('#sideSel [data-side="buy"]'), "B", t("Buy / Long · B"));
  hint($('#sideSel [data-side="sell"]'), "S", t("Sell / Short · S"));
  hint($('#kindSel [data-kind="market"]'), "M", t("Market · M"));
  hint($('#kindSel [data-kind="limit"]'), "L", t("Limit al prezzo medio · L"));
  hint($("#tkExec"), "↵", t("Invia · Enter"));
  hint($("#mktSelect"), null, t("Cerca mercato · / o Ctrl+K"));
  hint($("#tfs"), null, t("Timeframe · [ e ]"));
  panels.forEach((p) => hint($(".ttl", p.el), null, t("Grafico {n} · tasto {n} · clic per cambiare mercato", { n: p.idx + 1 })));
  hint($("#hkOpen"), null, t("Scorciatoie da tastiera · ?"));
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
  try { await api(`/close?market_id=${m.id}&fraction=${fraction}`, { method: "POST" }); toast(t("Chiusura {f}% inviata", { f: Math.round(fraction * 100) })); }
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
  try { await api(`/reverse?market_id=${mid}`, { method: "POST" }); toast(t("Reverse inviato: {sym} {side}", { sym: m.symbol, side: to })); loadOrders(true); }
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

function stepTf(dir) {
  const cur = panelCfg[activeIdx].tf;
  const list = shownTfs.includes(cur) ? shownTfs : ALL_TFS;
  const next = list[list.indexOf(cur) + dir];
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    if ($$(".modal, .picker, #trailPop").some((x) => !x.classList.contains("hidden"))) return;
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
      "/": openPalette,
      "?": () => toggleHotkeys(),
      "[": () => stepTf(-1),
      "]": () => stepTf(1),
    }[k.length === 1 ? k.toLowerCase() : k];
    if (act) { e.preventDefault(); act(); return; }
    if (/^[1-4]$/.test(k) && +k <= panels.length) { e.preventDefault(); setActive(+k - 1); }
  });
}

function wireKeyDialog() {
  $("#accountPill").onclick = () => (Paper.on ? openPaperModal() : (!info.public || Live.on) && openKeyDialog());
  $("#keyClose").onclick = closeKeyDialog;
  $("#keyShade").onmousedown = closeKeyDialog;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#keyModal").classList.contains("hidden")) closeKeyDialog(); });
  // browser wallets (EIP-6963, with window.ethereum as fallback): only the address is read
  $("#keyWallet").onclick = () => {
    const list = [...walletProviders.values()];
    if (list.length === 1) return useWallet(list[0].provider);
    $("#keyWallets").innerHTML = list.map((w, i) =>
      `<button type="button" class="chip" data-wallet="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ""}${esc(w.info.name)}</button>`).join("");
    $("#keyWallets").classList.toggle("hidden");
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
      if (list.length === 1) $("#keyAccount").value = list[0].index;
      $("#keyAccounts").innerHTML = list.map((a) =>
        `<button type="button" class="chip" data-acc="${a.index}">#${a.index} · ${fusd(a.collateral, 0)}</button>`).join("");
    } catch (e) { keyError(e.message); }
  };
  $("#keyAccounts").onclick = (e) => { const b = e.target.closest("[data-acc]"); if (b) $("#keyAccount").value = b.dataset.acc; };
  $("#keyForm").onsubmit = async (e) => {
    e.preventDefault();
    keyError("");
    const btn = $("#keySubmit");
    btn.disabled = true;
    btn.textContent = t("Verifica in corso…");
    try {
      const cred = { account_index: +$("#keyAccount").value, api_key_index: +$("#keyIndex").value };
      if (info.public) { // the key stays here: checked with Lighter from this browser
        await Live.connect({ ...cred, key: $("#keyPrivate").value }, $("#keyRemember").checked);
        store("termsAccepted", TERMS_VERSION);
        $("#keyPrivate").value = "";
        browserKeyChanged();
        openKeyDialog(true);
        return;
      }
      const res = await api("/credentials", { method: "POST", body: JSON.stringify({ ...cred, private_key: $("#keyPrivate").value }) });
      $("#keyPrivate").value = "";
      credentialsChanged(res);
      openKeyDialog(true);
    } catch (err) {
      keyError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = t("Verifica e collega");
    }
  };
  $("#keyDone").onclick = closeKeyDialog;
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
  $("#langBtn").innerHTML = TRANSLATE_ICON + cur.short;
  $("#langBtn").title = t("Lingua") + " · " + cur.name;
  $("#langMenu").innerHTML = LANGS.map((l) => `<button data-lang="${l.id}" class="${l.id === LANG ? "active" : ""}">
      <span class="lang-code">${l.short}</span><span>${l.name}${l.english !== l.name ? `<small>${l.english}</small>` : ""}</span><span class="check">✓</span></button>`).join("");
}

// redraw every piece of text built in JavaScript; charts, prices and the book keep running
function rerenderLanguage() {
  renderLangBtn();
  applyTheme(document.documentElement.dataset.theme);
  setStatus(feedOk);
  renderArmed(info.armed);
  renderTfs();
  renderTicket();
  renderAccount();
  applyKeyHints();
  renderSessions();
  renderEcon();
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
  try {
    info = await api("/info");
  } catch (e) {
    const token = prompt(t("Token di accesso LighterDeck:"));
    if (token) { store("token", token); location.reload(); }
    return;
  }
  markets = info.markets;
  liveTrading = info.trading;
  if (info.public && info.browser_trading && Live.saved()) {
    try { await Live.restore(); } catch {}
    document.body.classList.toggle("browser-key", Live.on);
  }
  Paper.on = !Live.on && (!!info.public || load("paper", false));
  info.trading = Paper.on || liveTrading || Live.on;
  document.body.classList.toggle("paper", Paper.on);
  applyPublic();
  bySymbol = Object.fromEntries(markets.map((m) => [m.symbol, m]));
  byId = Object.fromEntries(markets.map((m) => [m.id, m]));
  panelCfg = panelCfg.map((c) => (bySymbol[c.symbol] ? c : { ...c, symbol: "BTC" }));
  const opts = markets.map((m) => `<option value="${m.id}">${m.symbol}</option>`).join("");
  $$(".marketSelect").forEach((s) => (s.innerHTML = opts));
  $("#cpMarket").innerHTML = markets.map((m) => `<option value="${m.symbol}">${m.symbol}</option>`).join("");
  renderEventSelect();
  const net = info.network === "testnet" ? "Testnet" : "Mainnet";
  $("#netBadge").textContent = net;
  $("#sbNet").textContent = net;
  renderArmed(info.armed);

  try { localStorage.removeItem("ld.mode"); } catch {} // left by the old Simple / Pro switch
  wire();
  wireKeyDialog();
  wirePaper();
  wireHotkeys();
  applyKeyHints();
  $("#bottom").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (b) goToMarket(b.dataset.goto);
    const tag = e.target.closest(".mode-tag"); // a phone has no hover: the tag explains itself on a tap
    if (tag) toast(tag.title);
  });
  wireBottomSplit();
  wireTrail();
  applyTheme(load("theme", "ambra")); // first visit: Ambra
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
  toggleBook(showBook);
  renderAccount();
  switchView(route.view || (location.pathname === "/" ? load("view", "trade") : "trade"), { fromUrl: true });
  syncUrl(false);
  window.addEventListener("popstate", () => {
    const r = routeFromUrl();
    if (r.sym && (bySymbol[r.sym] || pairOf(r.sym)) && panelCfg[activeIdx].symbol !== r.sym) setSymbol(r.sym);
    switchView(r.view || "trade", { fromUrl: true });
  });
  renderSessions();
  await loadCalendar();
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
  connect();
  if (chartEls.orders) fetchOpenOrders().catch(() => {});

  setInterval(clock, 250);
  setInterval(renderSessions, 30 * 1000);
  setInterval(renderEcon, 60 * 1000);
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
  // a phone that slept (screen off, tab in the background) missed the candles in between: the chart
  // would join the old ones to the new price with a gap. Coming back after a while reloads them.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!hiddenAt || Date.now() - hiddenAt < 15000) return;
    hiddenAt = 0;
    panels.forEach((p) => p.load());
    if (chartEls.orders && info.trading) fetchOpenOrders(true).catch(() => {});
    loadCalendar().catch(() => {});
  });
}

init();
