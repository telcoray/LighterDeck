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
const C = { green: "#2bd9a4", red: "#f2546d" };

// ---------- themes: colours live in CSS variables (style.css), charts read them from there ----------
const THEMES = [ // Classic first, then alphabetical
  { id: "classic", name: "Classic", note: "i colori di Lighter" },
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
  panels.forEach((p) => p.chart.applyOptions(chartTheme()));
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
let layout = load("layout", "4");
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

// ================= charts =================
class Panel {
  constructor(idx) {
    this.idx = idx;
    this.el = document.createElement("div");
    this.el.className = "panel";
    this.el.innerHTML = `<div class="chart"></div>
      <div class="legend"><span class="ttl"></span><i class="dot"></i><span class="ohlc"></span></div>
      <div class="ev-tip hidden"></div>
      <div class="drag-ok hidden"></div>
      <div class="chart-menu hidden"></div>`;
    this.el.addEventListener("mousedown", () => setActive(this.idx));
    $(".ttl", this.el).addEventListener("click", (e) => { e.stopPropagation(); setActive(this.idx); openPalette(); });
    this.chart = LightweightCharts.createChart($(".chart", this.el), {
      autoSize: true,
      layout: { background: { color: "transparent" }, fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8 },
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
      if (!keep.length) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...keep), maxValue: Math.max(r.priceRange.maxValue, ...keep) } };
    } });
    this.wireDrag();
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
  }

  get cfg() { return panelCfg[this.idx]; }
  get market() { return bySymbol[this.cfg.symbol]; }

  async load() {
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
    this.loadFills(true);
    this.drawMarkers();
    this.drawLines();
    this.renderLegend();
  }

  renderLegend() {
    const m = this.market;
    if (this.ttlFor !== this.cfg.symbol + this.cfg.tf) { // avoid reloading the logo on every tick
      this.ttlFor = this.cfg.symbol + this.cfg.tf;
      $(".ttl", this.el).innerHTML = `${ico(this.cfg.symbol, "sm")}<b>${esc(this.cfg.symbol)}</b> · ${tfLabel(this.cfg.tf)} · Lighter`;
    }
    const b = this.hover || this.last;
    if (!b) { $(".ohlc", this.el).textContent = ""; return; }
    const ch = b.close - b.open, pct = b.open ? (ch / b.open) * 100 : 0;
    const c = cls(ch);
    $(".ohlc", this.el).innerHTML =
      `<span>O<em class="${c}">${fp(b.open, m)}</em></span><span>H<em class="${c}">${fp(b.high, m)}</em></span>` +
      `<span>L<em class="${c}">${fp(b.low, m)}</em></span><span>C<em class="${c}">${fp(b.close, m)}</em></span>` +
      `<em class="${c}">${ch >= 0 ? "+" : ""}${fp(ch, m).replace("—", "0")} (${fpct(pct)})</em>`;
  }

  tick() {
    const m = this.market;
    const p = m && prices[m.id];
    if (!p || !this.last) return;
    const price = p.last || p.mark;
    if (!price) return;
    const barTime = barStart(this.cfg.tf, Math.floor(Date.now() / 1000));
    if (barTime > this.last.time) this.last = { time: barTime, open: price, high: price, low: price, close: price, volume: 0 };
    else this.last = { ...this.last, close: price, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price) };
    this.data.set(this.last.time, this.last);
    this.series.update(this.last);
    if (!this.hover) this.renderLegend();
    const s = stops[m.id];
    if (this.stopLine && s && s.stop) this.stopLine.applyOptions({ title: this.stopTitle(s) });
    if (this.markLine && p.mark) this.markLine.applyOptions({ price: p.mark });
  }

  drawMarkers() {
    const now = Date.now() / 1000;
    // one discreet dot per bar that had high-impact news for this market
    const bars = new Map();
    const sym = this.market && this.market.symbol;
    for (const e of events) {
      if (!sym || !eventFor(e, sym) || impactFor(e, sym) !== "High" || e.ts > now) continue;
      const t = barStart(this.cfg.tf, e.ts);
      bars.set(t, (bars.get(t) || []).concat(e));
    }
    if (!chartEls.events) bars.clear();
    this.eventBars = bars;
    const markers = [...bars.entries()].map(([time]) => ({
      time, position: "belowBar", shape: "circle", size: 0.4, color: "rgba(232,177,74,.8)",
      text: "",
    }));
    // your fills: an arrow under the bar for buys, over it for sells, one per side and bar
    const first = this.data.size ? this.data.keys().next().value : Infinity;
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
  renderEventTip(p, bar) {
    const tip = $(".ev-tip", this.el);
    const evs = bar && this.eventBars.get(bar.time);
    const fs = bar && this.fillBars.get(bar.time);
    const lowY = bar && this.series.priceToCoordinate(bar.low), highY = bar && this.series.priceToCoordinate(bar.high);
    const nearLow = lowY !== null && p.point && p.point.y >= lowY - 6 && p.point.y <= lowY + 34;
    const nearHigh = highY !== null && p.point && p.point.y <= highY + 6 && p.point.y >= highY - 34;
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
    const m = this.market;
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
        // the managed stop's own order is drawn by the stop line below
        if (chartEls.stop && s && s.stop && kind === "SL" && Math.abs(o.trigger_price - s.stop) < tick * 1.5) continue;
        const price = o.trigger_price || o.price;
        const line = add({ price, color: kind === "SL" ? C.red : kind === "TP" ? C.green : cssVar("--text-2"),
          lineStyle: kind === "LIMIT" ? 0 : 2, title: `${kind} ${fsize(o.remaining, m)}` });
        this.dragOrders.push({ line, price, label: kind, order: o });
      }
    }
    if (pos && s && chartEls.stop) {
      const dir = Math.sign(pos.size), amber = cssVar("--amber"), lev = pos.leverage || 1;
      // activation and breakeven are PnL % on margin: the price moves that much divided by the leverage
      if (s.stop) this.stopLine = add({ price: s.stop, color: amber, lineWidth: 2, title: this.stopTitle(s) });
      else if (s.trail_activate_pct) add({ price: pos.entry * (1 + dir * s.trail_activate_pct / 100 / lev), color: amber, lineStyle: 2, title: t("trailing da qui") });
      if (s.breakeven_at_pct && (!s.stop || (s.stop - pos.entry) * dir < 0)) add({ price: pos.entry * (1 + dir * s.breakeven_at_pct / 100 / lev), color: amber, lineStyle: 3, title: "BE" });
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
      if (line && l.kind !== "trail") this.dragPreview.push({ line, price: l.price, label: l.label || l.kind.toUpperCase(), kind: l.kind, input: l.input, preview: true });
    }
    if (d.liq) add(d.liq, C.red, t("LIQ stimata"), 3);
  }

  // Drag SL/TP/limit lines with the mouse. Ticket preview lines fill the ticket fields; real orders show a
  // small "Move / Cancel" box by the line and only change on Lighter after Move. The trailing stop isn't draggable.
  wireDrag() {
    const box = $(".chart", this.el);
    const yOf = (e) => e.clientY - box.getBoundingClientRect().top;
    const near = (y) => { // closest draggable line within 5 px of the pointer
      let best = null, gap = 6;
      for (const d of [...this.dragOrders, ...this.dragPreview]) {
        const ly = this.series.priceToCoordinate(d.price);
        if (ly !== null && Math.abs(ly - y) < gap) { best = d; gap = Math.abs(ly - y); }
      }
      return best;
    };
    // capture phase: the chart never sees a press that grabs a line, so it doesn't pan at the same time
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || this.hold) return;
      const d = near(yOf(e));
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      this.drag = { ...d, from: d.price, to: d.price };
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      document.body.classList.add("dragging-line");
    }, true);
    box.addEventListener("mousemove", (e) => {
      if (!this.drag) box.style.cursor = !this.hold && near(yOf(e)) ? "ns-resize" : "";
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      const p = this.series.coordinateToPrice(yOf(e));
      if (p === null || p <= 0) return;
      const price = +p.toFixed(decimals(this.market));
      this.drag.to = price;
      this.drag.line.applyOptions({ price, title: `${this.drag.label} → ${fp(price, this.market)}` });
    });
    document.addEventListener("mouseup", (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      document.body.classList.remove("dragging-line");
      if (d.to === d.from) { this.drawLines(); this.drawPreview(); return; }
      if (d.alert) { moveAlert(d.alert.id, d.to); return; }
      if (d.preview) {
        (d.input || $({ sl: "#tkSl", tp: "#tkTp", limit: "#tkPrice" }[d.kind])).value = d.to;
        this.drawLines();
        updateTicketSummary();
        return;
      }
      this.askMove(d, yOf(e));
    });
    $(".drag-ok", this.el).addEventListener("click", (e) => {
      const b = e.target.closest("[data-mv]");
      if (b) this.endMove(b.dataset.mv === "ok");
    });
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
      const y = e.clientY - box.getBoundingClientRect().top;
      const raw = this.series.coordinateToPrice(y);
      const m = this.market;
      if (raw === null || raw <= 0 || !m) return;
      setActive(this.idx);
      this.menuPrice = +raw.toFixed(decimals(m));
      const items = [...this.lineMenuItems(m, y), ...this.orderMenuItems(m, this.menuPrice)];
      if (!items.length) return;
      menu.innerHTML = `<div class="cm-price">${fp(this.menuPrice, m)}</div>` + items.map((it, i) =>
        `<button data-cm="${i}" class="${it.cls || ""}${it.line && !(items[i + 1] || {}).line ? " line-last" : ""}">${esc(it.label)}${it.note ? `<small>${esc(it.note)}</small>` : ""}</button>`).join("");
      this.menuItems = items;
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
    if (this.stopLine && s && near(s.stop)) {
      items.push({ line: true, label: t("Ferma il trailing (lo stop resta a {price})", { price: fp(s.stop, m) }), run: () => chartStopTrail(m) });
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
    items.push({ label: t("Alert a {price}", { price: at }), cls: "alert", note: "A", run: () => addAlert(m, price) });
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
  ["liq", "Prezzo di liquidazione"], ["mark", "Linea prezzo mark"], ["events", "Eventi macro"], ["fills", "I tuoi fill"], ["alerts", "Alert di prezzo"], ["preview", "Anteprima ticket"],
];
let chartEls = { orders: true, stop: true, position: true, liq: true, mark: false, events: true, fills: true, alerts: true, preview: true, ...load("chartEls", {}) };
let openOrders = {}; // market id -> open orders on Lighter, shared by the chart lines and the Orders tab
const fade = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c + "b0" : c); // hex colour at ~70% for provisional lines
const orderKind = (o) => (/stop/i.test(o.type) ? "SL" : /take/i.test(o.type) ? "TP" : "LIMIT");

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
  if (k === "preview") updateTicketSummary();
  if (k === "orders" && chartEls.orders) fetchOpenOrders().catch(() => {});
  if (k === "fills") panels.forEach((p) => p.loadFills(true));
}

// ---------- timeframe toolbar + "More" menu ----------
function setTf(tf) {
  panelCfg[activeIdx].tf = tf;
  savePanels();
  panels[activeIdx].load();
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
  if (show) renderTfs();
}

function buildCharts() {
  panels.forEach((p) => p.destroy());
  panels = [];
  const n = { "1": 1, "2v": 2, "2h": 2, "4": 4 }[layout];
  if (activeIdx >= n) activeIdx = 0;
  const box = $("#charts");
  box.className = "charts l" + layout;
  for (let i = 0; i < n; i++) {
    const p = new Panel(i);
    box.appendChild(p.el);
    panels.push(p);
    p.load();
  }
  $$("#layouts button").forEach((b) => b.classList.toggle("active", b.dataset.layout === layout));
  applyKeyHints();
  setActive(activeIdx);
}

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
  const m = activeMarket(), q = m && prices[m.id];
  const px = q && (q.last || q.mark);
  document.title = px ? `${fp(px, m)} • ${m.symbol} • LighterDeck` : "LighterDeck";
}

const activeMarket = () => bySymbol[panelCfg[activeIdx].symbol];

function setSymbol(sym) {
  if (!bySymbol[sym]) return;
  panelCfg[activeIdx].symbol = sym;
  savePanels();
  panels[activeIdx] && panels[activeIdx].load();
  setActive(activeIdx);
  if (chartEls.orders && info.trading) fetchOpenOrders().catch(() => {});
}

// ================= market bar / ticker =================
function renderMarketBar() {
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
  f.className = p.funding >= 0 ? "" : "down";
  if (fundView.open && $("#fundPop").dataset.mid !== String(m.id)) { $("#fundPop").dataset.mid = m.id; loadFundingHistory(); }
  $("#stOi").textContent = fcompact(p.oi);
}

// ---------- funding details ----------
// Lighter pays funding every hour; the estimate in the market bar is the % per hour, positive when longs pay
const fundView = { open: false, days: 7, chart: null, rate: null, cum: null, timer: null };
const fpctf = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}%`;

function toggleFunding(open = !fundView.open) {
  fundView.open = open;
  $("#fundPop").classList.toggle("hidden", !open);
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
  const active = activeMarket();
  box.innerHTML = favs.filter((s) => bySymbol[s]).map((s) => {
    const m = bySymbol[s];
    const p = prices[m.id];
    return `<button class="tk${active && active.symbol === s ? " active" : ""}" data-sym="${s}">
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
    if (!el.classList.contains("confirming")) el.dataset.ckText = el.textContent;
    el.classList.add("confirming");
    el.textContent = pendingConfirm.text;
  }
}

function cancelConfirm() {
  if (!pendingConfirm) return;
  for (const el of $$(`[data-ck="${pendingConfirm.key}"]`)) {
    el.classList.remove("confirming");
    el.textContent = el.dataset.ckText;
  }
  pendingConfirm = null;
}

// ================= ticket =================
function renderTicket() {
  const m = activeMarket();
  if (!m) return;
  $("#tkSym").textContent = m.symbol;
  const pos = account && account.positions.find((p) => p.market_id === m.id);
  const set = account && account.settings && account.settings[m.id];
  const lev = set ? set.leverage : m.default_leverage;
  $("#tkLev").textContent = `${lev ? lev + "x " : ""}${set && !set.cross ? "Isolated" : "Cross"}`;
  $("#tkAvail").textContent = account ? fusd(account.available) : "—";
  $("#tkPos").innerHTML = pos ? `<span class="${pos.size > 0 ? "up" : "down"}">${pos.size > 0 ? "Long" : "Short"} ${fsize(pos.size, m)}</span>` : "—";
  const unit = $("#tkUnit").value;
  $("#tkSizeUnit").textContent = { usd: "USD", base: m.symbol, equity_pct: "%", risk_usd: "USD" }[unit];
  const chips = {
    usd: [25, 50, 100, 250].map((v) => [v, "$" + v]),
    base: [1, 5, 10, 50].map((x) => +(x * 10 ** -Math.max(0, m.size_decimals - 2)).toFixed(m.size_decimals)).map((v) => [v, v]),
    equity_pct: [1, 2, 5, 10].map((v) => [v, v + "%"]),
    risk_usd: [5, 10, 25, 50].map((v) => [v, "$" + v]),
  }[unit];
  $("#tkChips").innerHTML = chips.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("");
  const isLimit = ticket.kind === "limit";
  $$(".limit-only").forEach((e) => e.classList.toggle("hidden", !isLimit));
  $$(".market-only").forEach((e) => e.classList.toggle("hidden", isLimit));
  $$("#sideSel button").forEach((b) => b.classList.toggle("active", b.dataset.side === ticket.side));
  $$("#kindSel button").forEach((b) => b.classList.toggle("active", b.dataset.kind === ticket.kind));
  const ex = $("#tkExec");
  ex.className = "execute" + (!info.trading ? " connect" : ticket.side === "sell" ? " sell" : "");
  ex.textContent = info.trading ? `${ticket.side === "buy" ? "Buy / Long" : "Sell / Short"} ${m.symbol}${Paper.on ? " · Paper" : ""}`
    : t("Sola lettura · collega un'API key");
  ex.disabled = false;
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

// local estimate, refined by the server preview (which also runs every risk check)
function updateTicketSummary() {
  const m = activeMarket();
  const p = m && prices[m.id];
  const size = +$("#tkSize").value;
  const unit = $("#tkUnit").value;
  const sl = +$("#tkSl").value;
  const ref = ticket.kind === "limit" && +$("#tkPrice").value ? +$("#tkPrice").value : p ? (ticket.side === "buy" ? p.ask : p.bid) || p.mark : 0;
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
  renderTicketEstimates(m, p, qty, ref);
  clearTimeout(updateTicketSummary.t);
  updateTicketSummary.t = setTimeout(previewTicket, 350);
}

// margin, fees, liquidation and SL/TP outcome (formulas.js, ported from lighter-ts)
function renderTicketEstimates(m, p, qty, entry) {
  const side = ticket.side === "buy" ? 1 : -1;
  const set = account && account.settings && account.settings[m.id];
  const leverage = (set && set.leverage) || m.default_leverage;
  const notional = qty ? qty * entry : 0;
  const isMaker = ticket.kind === "limit" && $("#tkPost").checked;
  const feeRate = isMaker ? m.maker_fee : m.taker_fee;
  const feeUsd = Formulas.fee(notional, feeRate);
  const reduce = $("#tkReduce").checked;
  $("#tkMargin").textContent = qty && !reduce ? `${fusd(Formulas.orderMargin(notional, leverage))} · ${leverage}x` : "—";
  $("#tkFee").textContent = qty ? `${fusd(feeUsd)} · ${(feeRate * 100).toFixed(3)}%` : "—";
  const mark = p && p.mark;
  const liq = Formulas.liquidationAfterOrder({
    account, market: m, side, qty, entry, mark, feeUsd,
    markOf: (id) => prices[id] && prices[id].mark, mmfOf: (id) => (byId[id] ? byId[id].mmf : m.mmf),
  });
  const liqEl = $("#tkLiq");
  liqEl.textContent = liq ? fp(liq, m) : account ? "—" : t("serve l'account");
  liqEl.className = liq && mark && Math.abs(liq - mark) / mark < 0.05 ? "down" : "";
  const draft = { market: m.id, side, entry, liq: qty && !reduce ? liq : null, lines: [] };
  if (ticket.kind === "limit" && +$("#tkPrice").value) draft.lines.push({ kind: "limit", price: entry, title: `LIMIT ${side > 0 ? "BUY" : "SELL"}${qty ? " " + fsize(qty, m) : ""}` });
  // The ticket's SL/TP are position-tied on Lighter (size 0): when they fire they close the whole position.
  // So with a position already open on this side, the outcome is for the position plus this order,
  // at their average entry; the side check still uses this order's price.
  const pos = account && account.positions.find((x) => x.market_id === m.id);
  const held = pos && !reduce && Math.sign(pos.size) === side ? Math.abs(pos.size) : 0;
  const totQty = (qty || 0) + held;
  const avgEntry = totQty ? ((qty || 0) * entry + (held ? held * pos.entry : 0)) / totQty : entry;
  const levels = readTpLevels();
  for (const [id, isSL] of levels ? [["Sl", true]] : [["Sl", true], ["Tp", false]]) {
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
  draft.lines.push(...trailDraft(m, side, entry, leverage));
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
    const msg = t("Alert {sym}: {price} raggiunto (ora {px})", { sym: a.symbol, price: m ? fp(a.price, m) : a.price, px: m ? fp(px, m) : px });
    toast(msg);
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("LighterDeck", { body: msg, tag: a.id }); } catch {}
    }
  }
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
  const row = (a, fired) => {
    const m = byId[a.market_id], px = lastPrice(a.market_id);
    const dist = !fired && px ? ((a.price - px) / px) * 100 : null;
    return `<tr><td class="mk">${gotoBtn(a.symbol)}</td><td>${a.dir > 0 ? t("sale a") : t("scende a")}</td><td class="r main">${m ? fp(a.price, m) : a.price}</td>
      <td class="r">${fired ? (m ? fp(a.px, m) : a.px) : px && m ? fp(px, m) : "—"}</td><td class="r ${dist !== null ? cls(dist) : ""}">${dist !== null ? fpct(dist) : "—"}</td>
      <td class="r muted">${new Date(fired ? a.at : a.created).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
      <td class="r">${fired ? `<span class="muted">${t("scattato")}</span>` : `<button class="xbtn" data-alert-del="${a.id}">${t("Togli")}</button>`}</td></tr>`;
  };
  const head = `<thead><tr><th>${t("Mercato")}</th><th>${t("Quando il prezzo")}</th><th class="r">${t("Livello")}</th><th class="r">${t("Prezzo")}</th><th class="r">${t("Distanza")}</th><th class="r">${t("Creato / scattato")}</th><th></th></tr></thead>`;
  if (!alerts.length && !alertsFired.length) {
    box.innerHTML = `<div class="empty">${t("Nessun alert. Click destro sul grafico → Alert, oppure punta il mouse a un prezzo e premi A.")}</div>`;
    return;
  }
  box.innerHTML = `<table class="table">${head}<tbody>${alerts.map((a) => row(a, false)).join("")}${alertsFired.map((a) => row(a, true)).join("")}</tbody></table>`
    + (alertsFired.length ? `<div class="alerts-foot"><button class="link" data-alert-clear>${t("Svuota gli alert scattati")}</button></div>` : "");
}

// ================= account / bottom tables =================
function renderAccount() {
  renderAccountHead();
  const has = !!account;
  $("#accIdx").textContent = has ? (Paper.on ? "Paper" : "#" + account.index) : "";
  $("#accEq").textContent = has ? account.total_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  $("#accAvail").textContent = has ? fusd(account.available) : "—";
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
    : info.trading ? `<i class="dot"></i><span>${t("Account #{n}", { n: info.account_index })}</span>` : `<i class="dot off"></i><span>${t("Sola lettura")}</span>`;
  pill.classList.toggle("muted", !info.trading);
  if (info.trading && !$("#keyModal").classList.contains("hidden")) renderKeyEquity();
  if (Paper.on && !$("#paperModal").classList.contains("hidden")) renderPaperModal();
  pill.title = Paper.on ? t("Paper trading") : info.trading ? t("API key collegata") : t("Collega un'API key");
  renderPositions();
  renderTicket();
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
    if (kind === "LIMIT" || o.is_ask !== p.size > 0) continue;
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
  box.innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th class="r">Size</th><th class="r">${t("Valore")}</th><th class="r" title="${t("Il tuo capitale impegnato: valore all'entrata diviso la leva.")}">${t("Margine")}</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">${t("Liquidazione")}</th><th class="r" title="${t("La percentuale è calcolata sul margine iniziale.")}">${t("PnL non realizzato")}</th><th class="r">TP / SL</th><th>${t("Trailing")}</th><th>${t("Chiudi a mercato")}</th></tr></thead><tbody>${
    list.map((p) => {
      const m = byId[p.market_id];
      const mark = prices[p.market_id] ? prices[p.market_id].mark : 0;
      // PnL % on the initial margin (entry value / leverage), as Lighter and the ticket show it
      const margin = p.leverage ? (Math.abs(p.size) * p.entry) / p.leverage : 0;
      const pct = margin ? (p.upnl / margin) * 100 : 0;
      return `<tr><td class="mk">${gotoBtn(p.symbol)}<small class="${p.size > 0 ? "up" : "down"}">${p.size > 0 ? "Long" : "Short"}</small></td>
        <td class="r ${p.size > 0 ? "up" : "down"}">${fsize(p.size, m)} <span class="unit-sym">${esc(p.symbol)}</span></td><td class="r main">${fusd(p.value)}</td>
        <td class="r">${margin ? fusd(margin) : "—"}${p.leverage ? `<small class="pos-lev">${p.leverage}x${p.cross === false ? " isolated" : ""}</small>` : ""}</td><td class="r">${fp(p.entry, m)}</td><td class="r main">${fp(mark, m)}</td>
        <td class="r liq">${fp(p.liq, m)}</td><td class="r pnl ${cls(p.upnl)}">${fusd(p.upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
        <td class="r sltp">${sltpCell(p, m)}</td>
        <td>${trailButton(p.market_id, m)}</td>
        <td><span class="qbtn">${[25, 50, 75, 100].map((f) => `<button data-close="${p.market_id}" data-f="${f}"${f === 100 ? ` class="all" data-ck="close:${p.market_id}" data-key="F" title="${t("Chiudi tutto · F")}"` : f === 50 ? ` title="${t("Chiudi metà · H")}"` : ""}>${f}%</button>`).join("")}<button class="rev" data-reverse="${p.market_id}" data-ck="reverse:${p.market_id}" data-key="R" title="${t("Reverse: chiude e apre il lato opposto, stessa size · R")}">⇄ Reverse</button></span></td></tr>`;
    }).join("")}</tbody></table>`;
  markConfirm();
}

// open orders on the markets in use (positions + charts); fresh skips the server's few-second cache
async function fetchOpenOrders(fresh = false) {
  if (!info.trading) { openOrders = {}; panels.forEach((p) => p.drawLines()); return []; }
  const ids = new Set([...(account ? account.positions.map((p) => p.market_id) : []), ...panelCfg.map((c) => bySymbol[c.symbol] && bySymbol[c.symbol].id)].filter((x) => x !== undefined));
  const list = await api(`/open_orders?market_ids=${[...ids].join(",")}${fresh ? "&fresh=1" : ""}`);
  openOrders = {};
  for (const o of list) (openOrders[o.market_id] ||= []).push(o);
  panels.forEach((p) => { p.drawLines(); p.loadFills(fresh); });
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
      return `<tr><td class="mk">${gotoBtn(o.symbol)}</td><td>${esc(o.type)}</td><td class="${o.is_ask ? "down" : "up"}">${o.is_ask ? "Sell" : "Buy"}</td>
        <td class="r">${fp(o.price, m)}</td><td class="r">${o.trigger_price ? fp(o.trigger_price, m) : "—"}</td><td class="r">${fsize(o.remaining, m)}</td>
        <td>${o.reduce_only ? t("sì") : "—"}</td><td class="r"><button class="xbtn" data-cancel="${o.market_id}:${o.order_index}">${t("Annulla")}</button></td></tr>`;
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
  if (!bySymbol[sym]) return;
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
const MARKET_ASSETS = { WTI: ["oil"], BRENTOIL: ["oil"], NATGAS: ["natgas"] };
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
  if (!mine.length) return e.impact;
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
  : t("prev. {f} · prec. {p}", { f: esc(e.forecast || "—"), p: esc(e.previous || "—") }));

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
  return `${Math.floor(h / 24)}${LANG === "en" ? "d" : "g"} ${h % 24}h`;
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
      <div class="s">${eventDetail(e)}</div></div>
      <div class="w ${left > 0 && left < 3600 ? "soon" : ""}">${eventTime(e, d)}<div class="s">${left > 0 ? t("tra {d}", { d: dur(left * 1000) }) : ""}${e.source === "custom" ? ` <button class="ev-del" data-delev="${e.id}" data-ck="delev:${e.id}" title="${t("Elimina")}">✕</button>` : ""}</div></div>
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
  const used = eq > 0 ? Math.max(0, Math.min(100, ((eq - avail) / eq) * 100)) : 0;
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
  bar.style.width = used + "%";
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
      <div class="ti"><b>${evLabel(e)}</b><span class="kind">${t(TYPE_LABEL[evType(e)])}</span><div class="s">${eventDetail(e)}</div></div>
      <div class="mk">${chips}${e.source === "custom" ? `<button class="ev-del" data-delev="${e.id}" data-ck="delev:${e.id}" title="${t("Elimina")}">✕</button>` : ""}</div>
    </div>`;
  }).join("") || `<div class="empty">${t("Nessun evento con questi filtri.")}</div>`;
  markConfirm();
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
    const status = r.type === "event_trade" ? r.status : r.state && r.state.stop ? "stop " + r.state.stop : t("in attesa");
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

let levCross = true;
function openLeverage() {
  const m = activeMarket();
  const box = $("#levBox");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  const set = account && account.settings && account.settings[m.id];
  const cap = info.limits && info.limits.on && info.limits.on.leverage_cap ? info.limits.leverage_cap : null;
  $("#levInput").value = set ? Math.round(set.leverage) : Math.min(m.default_leverage || 5, cap || Infinity);
  $("#levInput").max = m.max_leverage || 50;
  levCross = set ? set.cross : true;
  $$(".levmode button").forEach((b) => b.classList.toggle("active", (b.dataset.cross === "1") === levCross));
  $("#levHint").textContent = cap ? t("{sym}: massimo dell'exchange {max}x, tuo limite {cap}x.", { sym: m.symbol, max: m.max_leverage || "—", cap })
    : t("{sym}: massimo dell'exchange {max}x.", { sym: m.symbol, max: m.max_leverage || "—" });
  box.classList.remove("hidden");
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
    if (Paper.on) {
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
  return { view: ROUTES[page] || null, sym: sym ? decodeURIComponent(sym).toUpperCase() : null };
}
function syncUrl(push) {
  const m = activeMarket();
  const path = "/" + PATH_OF[curView] + (curView === "trade" && m ? "/" + encodeURIComponent(m.symbol) : "");
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
    if (!menu.classList.contains("hidden")) renderChartEls();
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
  $("#tkChips").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) { $("#tkSize").value = b.dataset.v; updateTicketSummary(); } };
  $("#tkMid").onclick = fillMid;
  $("#tkExec").onclick = (e) => (info.trading ? executeTicket(e.detail > 0) : openKeyDialog());
  ["#tkSl", "#tkTp", "#tkSlip"].forEach((s) => ($(s).oninput = updateTicketSummary));
  ["#tkReduce", "#tkPost"].forEach((s) => ($(s).onchange = updateTicketSummary));
  $("#tkLev").onclick = openLeverage;
  $$(".levmode button").forEach((b) => (b.onclick = () => {
    levCross = b.dataset.cross === "1";
    $$(".levmode button").forEach((x) => x.classList.toggle("active", x === b));
  }));
  $("#levApply").onclick = async () => {
    const m = activeMarket();
    const lev = Math.round(+$("#levInput").value);
    if (!info.trading) return toast(t("Sola lettura: nessuna API key"), true);
    try {
      await api(`/leverage?market_id=${m.id}&leverage=${lev}&cross=${levCross}`, { method: "POST" });
      toast(t("{sym}: leva {lev}x {mode} inviata", { sym: m.symbol, lev, mode: levCross ? "cross" : "isolated" }));
      $("#levBox").classList.add("hidden");
    } catch (e) { toast(e.message, true); }
  };
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
  $("#btab-positions").onclick = async (e) => {
    const v = e.target.closest("[data-psl]");
    if (v && info.trading) return editPositionStop(v);
    const r = e.target.closest("[data-reverse]");
    if (r) return reversePosition(+r.dataset.reverse);
    const b = e.target.closest("[data-close]");
    if (!b) return;
    const mid = +b.dataset.close, f = +b.dataset.f;
    if (f === 100 && !askConfirm(`close:${mid}`, t("Chiudi tutto"))) return;
    try { await api(`/close?market_id=${mid}&fraction=${f / 100}`, { method: "POST" }); toast(t("Chiusura {f}% inviata", { f })); } catch (err) { toast(err.message, true); }
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
  const on = !!levels, box = $("#tkTpBox");
  $("#tkTpField").classList.toggle("hidden", on);
  $("#tkTpField").parentElement.classList.toggle("tp-solo", on);
  box.classList.toggle("hidden", !on);
  if (!on) { box.innerHTML = ""; updateTicketSummary(); return; }
  const be = $("#tkTpBe") ? $("#tkTpBe").checked : load("tpBe", true);
  box.innerHTML = `<div class="tp-head"><span>${t("Uscite scalari")}</span><span class="tp-presets">${[2, 3, 4].map((n) =>
      `<button type="button" data-tp-split="${n}" class="${levels.length === n ? "active" : ""}">${n} × ${Math.floor(100 / n)}%</button>`).join("")}</span>
      <button type="button" class="tp-x" data-tp-off title="${t("Torna a un solo take-profit")}">×</button></div>
    ${levels.map((l, i) => `<div class="tp-row"><div class="field sm"><label>TP${i + 1} · ${t("prezzo")}</label><input data-tp-price type="number" step="any" autocomplete="off" value="${l.price || ""}"></div>
      <div class="field sm"><label>${t("Quota %")}</label><input data-tp-pct type="number" min="0" max="100" step="any" autocomplete="off" value="${l.pct}"></div>
      ${levels.length > 2 ? `<button type="button" class="tp-x" data-tp-del="${i}" title="${t("Togli il livello")}">×</button>` : "<span></span>"}</div>`).join("")}
    <div class="tp-foot">${levels.length < 5 ? `<button type="button" class="link" data-tp-more>+ ${t("livello")}</button>` : "<span></span>"}
      <label><input type="checkbox" id="tkTpBe" ${be ? "checked" : ""}> ${t("Dopo TP1 stop a breakeven")}</label></div>
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
  $("#tkTpAdd").onclick = () => splitTpLevels(2);
  const box = $("#tkTpBox");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tpSplit) splitTpLevels(+b.dataset.tpSplit);
    else if (b.dataset.tpMore !== undefined) splitTpLevels(readTpLevels().length + 1);
    else if (b.dataset.tpDel !== undefined) {
      const lv = readTpLevels().filter((_, i) => i !== +b.dataset.tpDel);
      renderTpLevels(TP_SPLITS[lv.length].map((pct, i) => ({ price: lv[i].price, pct })));
    } else if (b.dataset.tpOff !== undefined) {
      const first = readTpLevels()[0];
      $("#tkTp").value = first && first.price ? first.price : "";
      renderTpLevels(null);
    }
  });
  box.addEventListener("input", updateTicketSummary);
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
  const on = info.trading;
  $("#keyConnected").classList.toggle("hidden", !on);
  $("#keyForm").classList.toggle("hidden", on);
  $("#keyTitle").textContent = on ? t("API key collegata") : t("Collega un'API key");
  if (on) {
    $("#keyOk").classList.toggle("hidden", justConnected !== true);
    $("#keyFactAcc").textContent = "#" + info.account_index;
    $("#keyFactIdx").textContent = info.api_key_index == null ? "—" : "#" + info.api_key_index;
    $("#keyFactWhere").textContent = info.credentials === "env" ? t("file env del server") : "data/credentials.json";
    renderKeyEquity();
    $("#keyEnvNote").classList.toggle("hidden", info.credentials !== "env");
    $("#keyRemove").classList.toggle("hidden", info.credentials === "env");
    showKeyConfirm(false);
  }
  $("#keyError").classList.add("hidden");
  $("#keyAccounts").innerHTML = "";
  $("#keyShade").classList.remove("hidden");
  $("#keyModal").classList.remove("hidden");
  if (!on) $(info.account_index == null ? "#keyAddress" : "#keyIndex").focus();
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
  $("#keyPrivate").value = ""; // never keep the key in the page longer than needed
}

function keyError(msg) {
  const box = $("#keyError");
  box.textContent = msg;
  box.classList.toggle("hidden", !msg);
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
  Paper.on = !!info.public || on;
  if (!info.public) store("paper", Paper.on);
  info.trading = Paper.on || liveTrading;
  document.body.classList.toggle("paper", Paper.on);
  account = Paper.on ? Paper.account() : null;
  stops = Paper.on ? Paper.stops() : {};
  exits = Paper.on ? Paper.exits() : {};
  openOrders = {};
  logSeq = 0;
  for (const box of [$("#btab-log"), $("#activityLog")]) box.innerHTML = `<div class="empty">${t("Nessuna attività.")}</div>`;
  if (Paper.on) addLogs(Paper.logs(0));
  else api("/logs").then(addLogs).catch(() => {});
  if (Paper.on && ["auto", "activity", "account"].includes(curView)) switchView("trade");
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
  $("#paperLive").classList.toggle("hidden", !!info.public);
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
  $("#paperLive").onclick = () => { closePaperModal(); setPaper(false); toast(liveTrading ? t("Trading live: ordini veri su Lighter") : t("Sola lettura")); };
  $("#keyPaper").onclick = $("#keyPaper2").onclick = () => { closeKeyDialog(); setPaper(true); toast(t("Paper trading: prezzi veri, soldi finti")); };
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
  for (const id of ["#tkSize", "#tkPrice", "#tkSl", "#tkTp"]) {
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
  $("#accountPill").onclick = () => (Paper.on ? openPaperModal() : !info.public && openKeyDialog());
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
      const res = await api("/credentials", { method: "POST", body: JSON.stringify({
        account_index: +$("#keyAccount").value, api_key_index: +$("#keyIndex").value, private_key: $("#keyPrivate").value,
      }) });
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
  $("#keyRemove").onclick = () => showKeyConfirm(true);
  $("#keyCancel").onclick = () => showKeyConfirm(false);
  $("#keyConfirmBtn").onclick = async () => {
    try {
      const res = await api("/credentials", { method: "DELETE" });
      closeKeyDialog();
      credentialsChanged(res);
      toast(t("API key scollegata: sola lettura"));
    } catch (err) { toast(err.message, true); }
  };
}

// ================= init =================
// flags drawn as SVG: Windows browsers show emoji flags as plain letters
const FLAGS = {
  it: '<rect width="3" height="2" fill="#fff"/><rect width="1" height="2" fill="#009246"/><rect x="2" width="1" height="2" fill="#ce2b37"/>',
  en: '<rect width="3" height="2" fill="#012169"/><path d="M0 0L3 2M3 0L0 2" stroke="#fff" stroke-width=".4"/><path d="M0 0L3 2M3 0L0 2" stroke="#c8102e" stroke-width=".15"/><path d="M1.5 0V2M0 1H3" stroke="#fff" stroke-width=".6"/><path d="M1.5 0V2M0 1H3" stroke="#c8102e" stroke-width=".35"/>',
};

function renderLangBtn() {
  const other = LANGS.find((l) => l.id !== LANG);
  $("#langBtn").innerHTML = `<svg class="flag" viewBox="0 0 3 2" preserveAspectRatio="none">${FLAGS[other.id]}</svg>${other.short}`;
  $("#langBtn").title = other.name;
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
  $("#langBtn").onclick = () => setLang(LANGS.find((l) => l.id !== LANG).id);
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
  Paper.on = !!info.public || load("paper", false);
  info.trading = Paper.on || liveTrading;
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

  wire();
  wireKeyDialog();
  wirePaper();
  wireHotkeys();
  applyKeyHints();
  $("#bottom").addEventListener("click", (e) => { const b = e.target.closest("[data-goto]"); if (b) goToMarket(b.dataset.goto); });
  wireBottomSplit();
  wireTrail();
  applyTheme(load("theme", "fosforo")); // first visit: Phosphor
  $("#themeBtn").onclick = (e) => { e.stopPropagation(); $("#themeMenu").classList.toggle("hidden"); };
  $("#themeMenu").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-theme]");
    if (b) { applyTheme(b.dataset.theme); $("#themeMenu").classList.add("hidden"); }
  };
  document.addEventListener("click", () => $("#themeMenu").classList.add("hidden"));
  // the address decides the page and the market: /trade/WTI opens WTI on the selected chart
  const route = routeFromUrl();
  if (route.sym && bySymbol[route.sym]) panelCfg[activeIdx].symbol = route.sym;
  buildCharts();
  toggleBook(showBook);
  renderAccount();
  switchView(route.view || (location.pathname === "/" ? load("view", "trade") : "trade"), { fromUrl: true });
  syncUrl(false);
  window.addEventListener("popstate", () => {
    const r = routeFromUrl();
    if (r.sym && bySymbol[r.sym] && activeMarket() && activeMarket().symbol !== r.sym) setSymbol(r.sym);
    switchView(r.view || "trade", { fromUrl: true });
  });
  renderSessions();
  await loadCalendar();
  loadRules();
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
  setInterval(() => panels.forEach((p) => p.load()), 15 * 60 * 1000);
}

init();
