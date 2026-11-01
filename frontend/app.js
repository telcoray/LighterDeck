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
let panelCfg = load("panels", [
  { symbol: "BTC", tf: "1h" }, { symbol: "ETH", tf: "1h" }, { symbol: "SOL", tf: "1h" }, { symbol: "HYPE", tf: "1h" },
]);
let layout = load("layout", "4");
let activeIdx = Math.min(load("active", 0), 3);
let favs = load("favs", ["BTC", "ETH", "SOL", "HYPE", "XRP"]);
let showBook = load("book", false);
const ticket = { side: "buy", kind: "market" };

function load(k, d) { try { const v = localStorage.getItem("ld." + k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function store(k, v) { try { localStorage.setItem("ld." + k, JSON.stringify(v)); } catch {} }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
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
      <div class="drag-ok hidden"></div>`;
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
    this.data = new Map();
    this.eventBars = new Map();
    this.chart.subscribeCrosshairMove((p) => {
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
    const candles = await api(`/candles?market_id=${m.id}&resolution=${this.cfg.tf}&count=600`).catch((e) => { toast(e.message, true); return []; });
    if (token !== this.loadToken) return;
    this.data = new Map(candles.map((c) => [c.time, c]));
    this.series.setData(candles);
    this.vol.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(43,217,164,.28)" : "rgba(242,84,109,.28)" })));
    this.last = candles[candles.length - 1] || null;
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
    const markers = [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([time]) => ({
      time, position: "belowBar", shape: "circle", size: 0.4, color: "rgba(232,177,74,.8)",
      text: "",
    }));
    this.series.setMarkers(markers);
  }

  // box with the events behind a dot, shown while the pointer is on or near it
  renderEventTip(p, bar) {
    const tip = $(".ev-tip", this.el);
    const evs = bar && this.eventBars.get(bar.time);
    const lowY = evs && this.series.priceToCoordinate(bar.low);
    if (!evs || lowY === null || !p.point || p.point.y < lowY - 6 || p.point.y > lowY + 34) {
      tip.classList.add("hidden");
      return;
    }
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
      const dir = Math.sign(pos.size), amber = cssVar("--amber");
      if (s.stop) this.stopLine = add({ price: s.stop, color: amber, lineWidth: 2, title: this.stopTitle(s) });
      else if (s.trail_activate_pct) add({ price: pos.entry * (1 + dir * s.trail_activate_pct / 100), color: amber, lineStyle: 2, title: t("trailing da qui") });
      if (s.breakeven_at_pct && (!s.stop || (s.stop - pos.entry) * dir < 0)) add({ price: pos.entry * (1 + dir * s.breakeven_at_pct / 100), color: amber, lineStyle: 3, title: "BE" });
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
      if (line && l.kind !== "trail") this.dragPreview.push({ line, price: l.price, label: l.kind.toUpperCase(), kind: l.kind, preview: true });
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
      if (d.preview) {
        $({ sl: "#tkSl", tp: "#tkTp", limit: "#tkPrice" }[d.kind]).value = d.to;
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

  // "TRAIL 1% · 0.84%": distance and current gap between the price and the managed stop
  stopTitle(s) {
    const q = prices[this.market.id], px = q && (q.last || q.mark);
    const gap = px ? ` · ${(Math.abs(px - s.stop) / px * 100).toFixed(2)}%` : "";
    return `${!info.armed || !s.enabled ? "OFF " : ""}TRAIL ${trailLabel(s, this.market)}${gap}`;
  }

  destroy() { this.chart.remove(); this.el.remove(); }
}

function savePanels() { store("panels", panelCfg); }

// ---------- Chart elements menu: which lines and marks every chart draws ----------
const CHART_ELEMENTS = [
  ["orders", "Linee ordini"], ["stop", "Stop gestito"], ["position", "Linea posizione"],
  ["liq", "Prezzo di liquidazione"], ["mark", "Linea prezzo mark"], ["events", "Eventi macro"], ["preview", "Anteprima ticket"],
];
let chartEls = { orders: true, stop: true, position: true, liq: true, mark: false, events: true, preview: true, ...load("chartEls", {}) };
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
  ex.textContent = info.trading ? `${ticket.side === "buy" ? "Buy / Long" : "Sell / Short"} ${m.symbol}` : t("Sola lettura · collega un'API key");
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
  if (+$("#tkTp").value) body.tp_price = +$("#tkTp").value;
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
  for (const [id, isSL] of [["Sl", true], ["Tp", false]]) {
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
  draft.lines.push(...trailDraft(m, side, entry));
  setTicketDraft(draft);
}

// where the ticket's trailing stop would sit right after the fill (ATR needs candles: start and breakeven only)
function trailDraft(m, side, entry) {
  const tr = $("#tkTrail").checked && !$("#tkReduce").checked && readTrail($("#tkTrailBox"));
  if (!tr || !entry) return [];
  const out = [];
  const dist = tr.mode === "pct" ? entry * tr.value / 100 : tr.mode === "price" ? tr.value : null;
  const label = `TRAIL ${trailLabel(trailToStop(tr), m)}`;
  if (tr.activate_pct) out.push({ kind: "trail", dashed: true, price: entry * (1 + side * tr.activate_pct / 100), title: `${label} · ${t("trailing da qui")}` });
  else if (dist) out.push({ kind: "trail", price: entry - side * dist, title: label });
  if (tr.breakeven_at_pct) out.push({ kind: "trail", dashed: true, price: entry * (1 + side * tr.breakeven_at_pct / 100), title: "BE" });
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

async function executeTicket() {
  const m = activeMarket();
  const size = +$("#tkSize").value;
  if (!m || !(size > 0)) return ticketMsg(t("Inserisci una size valida."), "err");
  const body = ticketBody();
  if (ticket.kind === "limit" && !body.price) return ticketMsg(t("Inserisci il prezzo limite."), "err");
  if (body.trail === null) return ticketMsg(t("Inserisci la distanza del trailing."), "err");
  const label = `${ticket.side === "buy" ? "LONG" : "SHORT"} ${m.symbol} · ${$("#tkNotional").textContent} · ${ticket.kind}`
    + (body.trail ? ` · trailing ${trailLabel(trailToStop(body.trail), m)}` : "");
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
      + (body.trail && !r.armed ? " " + t("Trailing impostato: parte quando attivi Auto.") : ""), "ok");
    previewTicket.sentKey = JSON.stringify(body);
    updateTicketSummary();
    loadOrders(true);
  } catch (e) {
    ticketMsg(e.message, "err");
  } finally {
    btn.disabled = !info.trading;
  }
}

// ================= account / bottom tables =================
function renderAccount() {
  const has = !!account;
  $("#accIdx").textContent = has ? "#" + account.index : "";
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
  pill.innerHTML = info.trading ? `<i class="dot"></i><span>${t("Account #{n}", { n: info.account_index })}</span>` : `<i class="dot off"></i><span>${t("Sola lettura")}</span>`;
  pill.classList.toggle("muted", !info.trading);
  if (info.trading && !$("#keyModal").classList.contains("hidden")) renderKeyEquity();
  pill.title = info.trading ? t("API key collegata") : t("Collega un'API key");
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
  return `${one("tp")}<span class="sltp-sep">/</span>${one("sl")}`;
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
  box.innerHTML = `<table class="table"><thead><tr><th>${t("Mercato")}</th><th class="r">Size</th><th class="r">${t("Valore")}</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">${t("Liquidazione")}</th><th class="r" title="${t("La percentuale è calcolata sul margine iniziale.")}">${t("PnL non realizzato")}</th><th class="r">TP / SL</th><th>${t("Trailing")}</th><th>${t("Chiudi a mercato")}</th></tr></thead><tbody>${
    list.map((p) => {
      const m = byId[p.market_id];
      const mark = prices[p.market_id] ? prices[p.market_id].mark : 0;
      // PnL % on the initial margin (entry value / leverage), as Lighter and the ticket show it
      const margin = p.leverage ? (Math.abs(p.size) * p.entry) / p.leverage : 0;
      const pct = margin ? (p.upnl / margin) * 100 : 0;
      return `<tr><td class="mk">${esc(p.symbol)}<small class="${p.size > 0 ? "up" : "down"}">${p.size > 0 ? "Long" : "Short"}${p.leverage ? " · " + p.leverage + "x" : ""}</small></td>
        <td class="r ${p.size > 0 ? "up" : "down"}">${fsize(p.size, m)}</td><td class="r main">${fusd(p.value)}</td><td class="r">${fp(p.entry, m)}</td><td class="r main">${fp(mark, m)}</td>
        <td class="r liq">${fp(p.liq, m)}</td><td class="r pnl ${cls(p.upnl)}">${fusd(p.upnl)}<small>${isFinite(pct) ? fpct(pct) : ""}</small></td>
        <td class="r sltp">${sltpCell(p, m)}</td>
        <td>${trailButton(p.market_id, m)}</td>
        <td><span class="qbtn">${[25, 50, 75, 100].map((f) => `<button data-close="${p.market_id}" data-f="${f}"${f === 100 ? ` class="all" data-ck="close:${p.market_id}"` : ""}>${f}%</button>`).join("")}</span></td></tr>`;
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
  panels.forEach((p) => p.drawLines());
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
      return `<tr><td class="mk">${esc(o.symbol)}</td><td>${esc(o.type)}</td><td class="${o.is_ask ? "down" : "up"}">${o.is_ask ? "Sell" : "Buy"}</td>
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
        <td class="mk">${esc(r.symbol)}${count}</td><td class="${r.side === "buy" ? "up" : "down"}">${r.side === "buy" ? "Buy" : "Sell"}</td>
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

const SESSIONS = [
  { name: "Stati Uniti", ex: "NYSE", tz: "America/New_York", open: [9, 30], close: [16, 0] },
  { name: "Regno Unito", ex: "LSE", tz: "Europe/London", open: [8, 0], close: [16, 30] },
  { name: "Germania", ex: "Xetra", tz: "Europe/Berlin", open: [9, 0], close: [17, 30] },
  { name: "Giappone", ex: "TSE", tz: "Asia/Tokyo", open: [9, 0], close: [15, 30] },
  { name: "Hong Kong", ex: "HKEX", tz: "Asia/Hong_Kong", open: [9, 30], close: [16, 0] },
  { name: "Australia", ex: "ASX", tz: "Australia/Sydney", open: [10, 0], close: [16, 0] },
];

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

function sessionStatus(s, now) {
  for (let dayOff = 0; dayOff < 8; dayOff++) {
    const z = zoned(now + dayOff * 86400000, s.tz);
    if (z.wd === "Sat" || z.wd === "Sun") continue;
    const open = wallToUtc(z.y, z.mo, z.d, s.open[0], s.open[1], s.tz);
    const close = wallToUtc(z.y, z.mo, z.d, s.close[0], s.close[1], s.tz);
    if (now < open) return { open: false, at: open };
    if (now < close) return { open: true, at: close };
  }
  return { open: false, at: null };
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
  const rows = SESSIONS.map((s) => ({ s, st: sessionStatus(s, now) }))
    .sort((a, b) => (b.st.open - a.st.open) || (a.st.at - b.st.at));
  const local = (t) => new Date(t).toLocaleString(LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  $("#ctab-sessions").innerHTML = rows.map(({ s, st }) => `<div class="cal-row">
      <div><div class="t">${t(s.name)}</div><div class="s">${s.ex} · ${st.open ? t("chiude") : t("apre")} ${st.at ? local(st.at) : ""}</div></div>
      <div class="w ${st.open ? "open" : st.at - now < 3600000 ? "soon" : ""}">${st.open ? t("aperto · {d}", { d: dur(st.at - now) }) : t("tra {d}", { d: dur(st.at - now) })}</div>
    </div>`).join("");
}

function renderEcon() {
  const f = load("econf", "mkt");
  const m = activeMarket(), sym = f === "mkt" && m ? m.symbol : null;
  $("#econMkt").textContent = m ? m.symbol : t("Mercato");
  $$("#econFilter button").forEach((b) => b.classList.toggle("active", b.dataset.f === f));
  const now = Date.now() / 1000;
  const keep = (e) => {
    if (sym) return eventFor(e, sym) && ["High", "Medium"].includes(impactFor(e, sym));
    return f === "h" ? e.impact === "High" : f === "usd" ? e.country === "USD" && e.impact !== "Holiday" : e.impact === "High" || e.impact === "Medium";
  };
  const list = events.filter((e) => e.ts > now - 3 * 3600 && keep(e)).slice(0, 40);
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

async function loadCalendar() {
  events = await api("/calendar").catch(() => events);
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
    const stopsChanged = JSON.stringify(msg.stops || {}) !== JSON.stringify(stops);
    stops = msg.stops || {};
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
function switchView(v) {
  $$("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  if (v === "markets") renderMarkets();
  if (v === "auto") { loadRules(); loadLimits(); }
  store("view", v);
}

function switchBottom(t) {
  $$("#bottomTabs button").forEach((b) => b.classList.toggle("active", b.dataset.btab === t));
  $$(".btab").forEach((s) => s.classList.toggle("hidden", s.id !== "btab-" + t));
  if (t === "orders") loadOrders();
  if (t === "trades") loadTrades();
}

function wire() {
  $$("#views button").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
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
  $("#tkExec").onclick = () => (info.trading ? executeTicket() : openKeyDialog());
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
    const b = e.target.closest("[data-close]");
    if (!b) return;
    const mid = +b.dataset.close, f = +b.dataset.f;
    if (f === 100 && !askConfirm(`close:${mid}`, t("Chiudi tutto"))) return;
    try { await api(`/close?market_id=${mid}&fraction=${f / 100}`, { method: "POST" }); toast(t("Chiusura {f}% inviata", { f })); } catch (err) { toast(err.message, true); }
  };
  $("#btab-orders").onclick = async (e) => {
    const b = e.target.closest("[data-cancel]");
    if (!b) return;
    const [mid, oi] = b.dataset.cancel.split(":");
    try { await api(`/cancel_order?market_id=${mid}&order_index=${oi}`, { method: "POST" }); toast(t("Ordine annullato")); loadOrders(true); } catch (err) { toast(err.message, true); }
  };

  // calendar
  $$("#calTabs button").forEach((b) => (b.onclick = () => {
    $$("#calTabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".ctab").forEach((c) => c.classList.toggle("hidden", c.id !== "ctab-" + b.dataset.ctab));
  }));
  $("#econFilter").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) { store("econf", b.dataset.f); renderEcon(); } };
  $("#eventForm").elements.market_id.addEventListener("change", renderEventSelect);
  // your own events: anything no feed covers (a token unlock, a network upgrade, a listing)
  $("#evAddBtn").onclick = () => {
    const f = $("#evForm");
    f.classList.toggle("hidden");
    if (f.classList.contains("hidden")) return;
    f.reset();
    const m = activeMarket();
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
      await api("/custom_events", { method: "POST", body: JSON.stringify(body) });
      f.classList.add("hidden");
      toast(t("Evento aggiunto"));
      loadCalendar();
    } catch (err) { toast(err.message, true); }
  };
  $("#econList").onclick = async (e) => {
    const b = e.target.closest("[data-delev]");
    if (!b || !askConfirm(`delev:${b.dataset.delev}`, t("Elimina"))) return;
    try { await api(`/custom_events/${b.dataset.delev}`, { method: "DELETE" }); toast(t("Evento eliminato")); loadCalendar(); }
    catch (err) { toast(err.message, true); }
  };
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

// ================= trailing stop (ticket + open positions) =================
// The server keeps one managed stop per market; it trails while automations are ON (Auto).
let stops = {};
const TRAIL_UNITS = [["pct", "%"], ["price", "$"], ["atr", "× ATR"]];

function trailToStop(tr) { // ticket/editor values -> the server's field names
  return { [`trail_${tr.mode}`]: tr.value, trail_activate_pct: tr.activate_pct, breakeven_at_pct: tr.breakeven_at_pct };
}

function trailLabel(s, m) {
  return s.trail_pct ? `${s.trail_pct}%` : s.trail_price ? `$${fp(s.trail_price, m)}` : s.trail_atr ? `${s.trail_atr}× ATR` : "BE";
}

function trailForm(v) {
  const unit = TRAIL_UNITS.map(([k, u]) => `<option value="${k}" ${v.mode === k ? "selected" : ""}>${u}</option>`).join("");
  return `<div class="trail-dist"><div class="field sm"><label>${t("Distanza dal prezzo migliore")}</label><input data-tr="value" type="number" min="0" step="any" value="${v.value ?? ""}" placeholder="${v.mode === "atr" ? "1.5" : v.mode === "price" ? "" : "1"}"></div>
      <select data-tr="mode">${unit}</select></div>
    <div class="two"><div class="field sm"><label>${t("Parte da +% profitto")}</label><input data-tr="activate_pct" type="number" min="0" step="any" value="${v.activate_pct || ""}" placeholder="0"></div>
      <div class="field sm"><label>${t("Breakeven a +%")}</label><input data-tr="breakeven_at_pct" type="number" min="0" step="any" value="${v.breakeven_at_pct ?? ""}" placeholder="${t("Opzionale")}"></div></div>
    <p class="trail-hint" data-tr="hint"></p>`;
}

function trailHint(box) {
  const mode = box.querySelector('[data-tr="mode"]').value;
  const parts = [mode === "atr" ? t("ATR(14) su candele da 15 minuti: la distanza si adatta alla volatilità.") : mode === "price" ? t("Distanza fissa in dollari dal prezzo migliore.") : t("Distanza in % dal prezzo migliore raggiunto.")];
  parts.push(t("Lo stop si muove solo a tuo favore."));
  const hint = box.querySelector('[data-tr="hint"]');
  hint.textContent = parts.join(" ") + (info.armed ? "" : " " + t("Auto è OFF: il trailing parte quando lo attivi."));
  hint.classList.toggle("warn", !info.armed);
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
    mountTrailForm($("#tkTrailBox"), load("trail", { mode: "pct", value: 1 }), () => {
      const tr = readTrail($("#tkTrailBox"));
      if (tr) store("trail", tr);
      updateTicketSummary();
    });
  }
  updateTicketSummary();
}

function trailButton(marketId, m) {
  const s = stops[marketId];
  if (!s) return `<button class="trail-btn" data-trail="${marketId}">+ ${t("Trailing")}</button>`;
  const paused = !info.armed || !s.enabled;
  const title = paused ? t("Auto è OFF: il trailing è fermo") : t("Stop gestito attivo");
  return `<button class="trail-btn on${paused ? " paused" : ""}" data-trail="${marketId}" title="${title}">${trailLabel(s, m)}${s.stop ? " · " + fp(s.stop, m) : ""}</button>`;
}

function openTrailPop(marketId, anchor) {
  const m = byId[marketId], s = stops[marketId];
  const pop = $("#trailPop");
  pop.dataset.market = marketId;
  $("#trailPopTitle").textContent = t("Trailing stop · {sym}", { sym: m.symbol });
  const v = s ? { mode: s.trail_pct ? "pct" : s.trail_price ? "price" : "atr", value: s.trail_pct || s.trail_price || s.trail_atr,
    activate_pct: s.trail_activate_pct, breakeven_at_pct: s.breakeven_at_pct } : load("trail", { mode: "pct", value: 1 });
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
      store("trail", tr);
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
  account = null;
  renderArmed(info.armed);
  renderAccount();
  loadOrders(true);
}

function wireKeyDialog() {
  $("#accountPill").onclick = () => openKeyDialog();
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
  bySymbol = Object.fromEntries(markets.map((m) => [m.symbol, m]));
  byId = Object.fromEntries(markets.map((m) => [m.id, m]));
  panelCfg = panelCfg.map((c) => (bySymbol[c.symbol] ? c : { ...c, symbol: "BTC" }));
  const opts = markets.map((m) => `<option value="${m.id}">${m.symbol}</option>`).join("");
  $$(".marketSelect").forEach((s) => (s.innerHTML = opts));
  renderEventSelect();
  const net = info.network === "testnet" ? "Testnet" : "Mainnet";
  $("#netBadge").textContent = net;
  $("#sbNet").textContent = net;
  renderArmed(info.armed);

  wire();
  wireKeyDialog();
  wireBottomSplit();
  wireTrail();
  applyTheme(load("theme", "champagne"));
  $("#themeBtn").onclick = (e) => { e.stopPropagation(); $("#themeMenu").classList.toggle("hidden"); };
  $("#themeMenu").onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-theme]");
    if (b) { applyTheme(b.dataset.theme); $("#themeMenu").classList.add("hidden"); }
  };
  document.addEventListener("click", () => $("#themeMenu").classList.add("hidden"));
  buildCharts();
  toggleBook(showBook);
  renderAccount();
  switchView(load("view", "trade"));
  renderSessions();
  await loadCalendar();
  loadRules();
  api("/logs").then(addLogs).catch(() => {});
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
