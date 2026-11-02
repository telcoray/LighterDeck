"use strict";
// Market picker: search, recents, crypto/RWA tabs, categories, sorting, list or grid view.
// Uses the globals defined in app.js (markets, prices, favs, setSymbol, formatters…).

const CATEGORIES = [
  ["NEW", "Nuovi"], ["MAJOR", "Majors"], ["PRE_LAUNCH", "Pre-launch"], ["DEFI", "DeFi"],
  ["STOCK", "Azioni"], ["ETF", "ETF / Indici"], ["FX", "Forex"], ["COMMODITIES", "Materie prime"],
  ["KRW", "KRW"], ["PRE_IPO", "Pre-IPO"], ["COMPUTE", "Compute"], ["LAYER_1", "Layer 1"],
  ["LAYER_2", "Layer 2"], ["MEMES", "Meme"], ["AI", "AI"], ["BONDS", "Bond"],
];
const TABS = [["all", "Tutti"], ["favs", "Preferiti"], ["CRYPTO", "Crypto"], ["RWA", "RWA"], ["spread", "Spread"]];
// the Spread tab: these classic pairs plus the ones starred, ordered by how stretched they are (|z|)
const SUGGESTED_PAIRS = ["ETH/BTC", "SOL/ETH", "XAU/XAG", "WTI/BRENTOIL", "US100/US500", "NVDA/AMD", "MU/SNDK",
  "SAMSUNGUSD/SKHYNIXUSD", "GOOGL/MSFT", "COIN/HOOD", "XPT/XAU"];
let favPairs = load("favPairs", []);
const spreadZ = {}; // pair -> { at, z } on 1h bars
const candleCache = {}; // market id -> { at, bars } (1h, for the scanner)
const SORTS = [
  ["oi", "Open interest"], ["volume", "Volume 24h"], ["change", "Variazione 24h"],
  ["price", "Prezzo"], ["funding", "Funding"], ["symbol", "Nome"], ["created", "Più recenti"],
];

const pk = {
  tab: load("pk.tab", "all"),
  cat: "",
  sort: load("pk.sort", { key: "oi", dir: -1 }),
  view: load("pk.view", "list"),
  sel: 0,
  rows: [],
};
let recents = load("recents", []);

const spreadList = () => [...new Set([...favPairs, ...SUGGESTED_PAIRS])].filter((s) => pairOf(s));

function pickerRows() {
  const q = $("#pkSearch").value.trim().toUpperCase();
  if (pk.tab === "spread" && !q) {
    const z = (s) => (spreadZ[s] && spreadZ[s].z !== null ? Math.abs(spreadZ[s].z) : -1);
    return spreadList().map((s) => ({ symbol: s, pair: pairOf(s), id: -1 })).sort((a, b) => z(b.symbol) - z(a.symbol));
  }
  // "ETH/BTC" (or ETH-BTC, ETH:BTC): the spread chart of the two
  const pm = q.match(/^([A-Z0-9]+)\s*[/:-]\s*([A-Z0-9]+)$/);
  if (pm && pairOf(`${pm[1]}/${pm[2]}`)) return [{ symbol: `${pm[1]}/${pm[2]}`, pair: pairOf(`${pm[1]}/${pm[2]}`), id: -1 }];
  let list = markets.filter((m) => {
    if (q) return m.symbol.toUpperCase().includes(q) || (m.name || "").toUpperCase().includes(q);
    if (pk.tab === "favs" && !favs.includes(m.symbol)) return false;
    if ((pk.tab === "CRYPTO" || pk.tab === "RWA") && m.asset_type !== pk.tab) return false;
    if (pk.cat && !(m.categories || []).includes(pk.cat)) return false;
    return true;
  });
  const val = (m) => {
    const p = prices[m.id] || {};
    switch (pk.sort.key) {
      case "symbol": return m.symbol;
      case "price": return p.last || p.mark || 0;
      case "change": return p.change || 0;
      case "volume": return p.volume || m.volume_usd || 0;
      case "funding": return p.funding || 0;
      case "created": return m.created_at || 0;
      default: return p.oi || 0;
    }
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (va > vb ? 1 : va < vb ? -1 : 0) * pk.sort.dir;
  });
  // favourites go on top in every tab and category (the sort is stable, so each group keeps its order);
  // a search ranks exact and prefix matches before them
  const fav = (m) => favs.includes(m.symbol);
  list.sort((a, b) => (q ? (b.symbol === q) - (a.symbol === q) || b.symbol.startsWith(q) - a.symbol.startsWith(q) : 0) || fav(b) - fav(a));
  return list;
}

function renderPickerChrome() {
  const scope = markets.filter((m) =>
    pk.tab === "favs" ? favs.includes(m.symbol) : pk.tab === "all" ? true : m.asset_type === pk.tab);
  $("#pkTabs").innerHTML = TABS.map(([k, label]) => {
    const n = k === "all" ? markets.length : k === "favs" ? favs.filter((s) => bySymbol[s]).length : k === "spread" ? spreadList().length : markets.filter((m) => m.asset_type === k).length;
    return `<button data-tab="${k}" class="${pk.tab === k ? "active" : ""}">${t(label)}<span>${n}</span></button>`;
  }).join("");
  const cats = CATEGORIES.filter(([k]) => scope.some((m) => (m.categories || []).includes(k)));
  if (pk.cat && !cats.some(([k]) => k === pk.cat)) pk.cat = "";
  $("#pkCats").innerHTML = `<button data-cat="" class="${pk.cat ? "" : "active"}">${t("Tutte")}</button>` +
    cats.map(([k, label]) => `<button data-cat="${k}" class="${pk.cat === k ? "active" : ""}">${t(label)}</button>`).join("");
  requestAnimationFrame(updateCatArrows);
  const known = (s) => bySymbol[s] || pairOf(s);
  $("#pkRecents").innerHTML = recents.filter(known).map((s) =>
    `<span class="chip" data-sym="${s}">${ico(s.split("/")[0], "sm")}${esc(s)}<button data-unrecent="${s}" title="${t("Rimuovi")}">×</button></span>`).join("");
  $("#pkRecentsRow").classList.toggle("hidden", !recents.some(known));
  $("#pkSort").value = pk.sort.key;
  $("#pkDir").textContent = pk.sort.dir < 0 ? "↓" : "↑";
  $$("#pkViews button").forEach((b) => b.classList.toggle("active", b.dataset.view === pk.view));
}

function levBadge(m) { return m.max_leverage ? `<span class="lev-b">${Math.round(m.max_leverage)}x</span>` : ""; }

function renderPickerList() {
  pk.rows = pickerRows();
  pk.sel = Math.min(pk.sel, Math.max(0, pk.rows.length - 1));
  $("#pkCount").textContent = t("{n} mercati", { n: pk.rows.length });
  const active = activeMarket();
  const box = $("#pkList");
  box.className = "pk-list " + pk.view;
  if (!pk.rows.length) { box.innerHTML = `<div class="empty">${t("Nessun mercato trovato.")}</div>`; return; }
  if (pk.rows[0].pair) return renderSpreadRows(box);
  const star = (m) => `<button class="star${favs.includes(m.symbol) ? " on" : ""}" data-star="${m.symbol}" title="${t("Preferito")}">★</button>`;
  if (pk.view === "grid") {
    box.innerHTML = pk.rows.map((m, i) => {
      const p = prices[m.id] || {};
      return `<div class="pk-card${i === pk.sel ? " sel" : ""}${active && active.id === m.id ? " current" : ""}" data-i="${i}">
        <div class="top"><span class="sym">${ico(m.symbol)}<b>${esc(m.symbol)}</b>${levBadge(m)}</span>${star(m)}</div>
        <div class="px"><span class="num">${fp(p.last || p.mark, m)}</span> <span class="num ${cls(p.change || 0)}">${fpct(p.change || 0)}</span></div>
        <div class="meta">Vol ${fcompact(p.volume || m.volume_usd)} · OI ${fcompact(p.oi)}</div></div>`;
    }).join("");
  } else {
    const head = SORTS.slice(0, 5).reduce((o, [k]) => ({ ...o, [k]: pk.sort.key === k ? (pk.sort.dir < 0 ? " ↓" : " ↑") : "" }), {});
    box.innerHTML = `<div class="pk-row pk-head"><span></span><span data-sort="symbol">${t("Mercato")}</span><span class="r" data-sort="price">${t("Prezzo")}${head.price}</span>
        <span class="r" data-sort="change">24h${head.change}</span><span class="r" data-sort="volume">Volume${head.volume}</span>
        <span class="r" data-sort="oi">Open interest${head.oi}</span><span class="r" data-sort="funding">Funding${head.funding}</span></div>` +
      pk.rows.map((m, i) => {
        const p = prices[m.id] || {};
        return `<div class="pk-row${i === pk.sel ? " sel" : ""}${active && active.id === m.id ? " current" : ""}" data-i="${i}">
          ${star(m)}<span class="sym">${ico(m.symbol)}<b>${esc(m.symbol)}</b>${levBadge(m)}${m.asset_type === "RWA" ? `<span class="rwa">RWA</span>` : ""}<small>${esc(m.name !== m.symbol ? m.name : "")}</small></span>
          <span class="r num">${fp(p.last || p.mark, m)}</span><span class="r num ${cls(p.change || 0)}">${fpct(p.change || 0)}</span>
          <span class="r num">${fcompact(p.volume || m.volume_usd)}</span><span class="r num">${fcompact(p.oi)}</span>
          <span class="r num ${(p.funding || 0) < 0 ? "down" : ""}">${(p.funding || 0).toFixed(4)}%</span></div>`;
      }).join("");
  }
}

// spreads: ratio, its 24h change and the z-score of the last 50 hourly closes
function renderSpreadRows(box) {
  box.className = "pk-list list";
  const star = (s) => `<button class="star${favPairs.includes(s) ? " on" : ""}" data-star="${s}" title="${t("Preferito")}">★</button>`;
  box.innerHTML = `<div class="pk-row pk-head"><span></span><span>Spread</span><span class="r">${t("Rapporto")}</span><span class="r">24h</span>
      <span class="r" title="${t("Distanza dalla media delle ultime {n} candele, in deviazioni standard", { n: Z_LEN })}">z (1h)</span><span></span><span></span></div>` +
    pk.rows.map((row, i) => {
      const [a, b] = row.pair, pa = prices[a.id] || {}, pb = prices[b.id] || {};
      const r = (pa.last || pa.mark) / (pb.last || pb.mark);
      const chg = pa.change !== undefined && pb.change !== undefined ? ((1 + pa.change / 100) / (1 + pb.change / 100) - 1) * 100 : null;
      const z = spreadZ[row.symbol] ? spreadZ[row.symbol].z : undefined;
      return `<div class="pk-row pk-pair${i === pk.sel ? " sel" : ""}" data-i="${i}">${star(row.symbol)}
        <span class="sym"><span class="pair-ico">${ico(a.symbol)}${ico(b.symbol)}</span><b>${esc(row.symbol)}</b><small>${t("Spread: {a} diviso {b}", { a: a.symbol, b: b.symbol })}</small></span>
        <span class="r num">${r ? fp(r, { price_decimals: ratioDecimals(r) }) : "—"}</span>
        <span class="r num ${chg !== null ? cls(chg) : ""}">${chg !== null ? fpct(chg) : "—"}</span>
        <span class="r num ${z !== undefined && z !== null && Math.abs(z) >= 2 ? "zhot" : ""}">${z === undefined ? "…" : z === null ? "—" : (z >= 0 ? "+" : "−") + Math.abs(z).toFixed(2)}</span><span></span><span></span></div>`;
    }).join("");
  loadSpreadZ(pk.rows.map((r) => r.symbol));
}

// the z of each listed spread, from 1h candles cached for 5 minutes
async function loadSpreadZ(list) {
  const fresh = (x) => x && Date.now() - x.at < 300000;
  const todo = list.filter((s) => !fresh(spreadZ[s]) && !(spreadZ[s] && spreadZ[s].loading));
  if (!todo.length) return;
  todo.forEach((s) => (spreadZ[s] = { ...(spreadZ[s] || {}), loading: true }));
  const bars = async (m) => {
    if (fresh(candleCache[m.id])) return candleCache[m.id].bars;
    const b = await api(`/candles?market_id=${m.id}&resolution=1h&count=${Z_LEN + 5}`).catch(() => []);
    candleCache[m.id] = { at: Date.now(), bars: b };
    return b;
  };
  await Promise.all(todo.map(async (s) => {
    const [a, b] = pairOf(s);
    const [ba, bb] = await Promise.all([bars(a), bars(b)]);
    const byTime = new Map(bb.map((c) => [c.time, c.close]));
    const closes = ba.filter((c) => byTime.get(c.time)).map((c) => c.close / byTime.get(c.time)).slice(-Z_LEN);
    let z = null;
    if (closes.length >= Z_LEN) {
      const { mean, sd } = zStats(closes);
      z = sd ? (closes[closes.length - 1] - mean) / sd : 0;
    }
    spreadZ[s] = { at: Date.now(), z };
  }));
  if (pk.tab === "spread" && !$("#picker").classList.contains("hidden")) renderPickerList();
}

function renderPicker() { renderPickerChrome(); renderPickerList(); }

function fillPickerSorts() {
  $("#pkSort").innerHTML = SORTS.map(([k, label]) => `<option value="${k}">${t(label)}</option>`).join("");
  $("#pkSort").value = pk.sort.key;
}

function placePicker() {
  const anchor = $("#mktSelect").getBoundingClientRect();
  const box = $("#picker");
  const narrow = innerWidth < 860;
  box.style.left = narrow ? "8px" : Math.max(8, anchor.left) + "px";
  box.style.top = anchor.bottom + 6 + "px";
  box.style.width = narrow ? `calc(100vw - 16px)` : Math.min(940, innerWidth - anchor.left - 16) + "px";
  box.style.maxHeight = innerHeight - anchor.bottom - 20 + "px";
}

// arrows appear only on the side that has hidden categories
function updateCatArrows() {
  const row = $("#pkCats"), end = row.scrollWidth - row.clientWidth;
  $("#pkCatsLeft").classList.toggle("hidden", row.scrollLeft <= 2);
  $("#pkCatsRight").classList.toggle("hidden", row.scrollLeft >= end - 2);
}

function scrollCats(dir) {
  const row = $("#pkCats");
  row.scrollLeft += dir * Math.max(120, row.clientWidth * 0.7);
}

function openPalette() {
  if ($("#view-trade").classList.contains("hidden")) switchView("trade");
  const box = $("#picker");
  box.classList.remove("hidden");
  $("#pickerShade").classList.remove("hidden");
  placePicker();
  $("#pkSearch").value = "";
  pk.sel = 0;
  if (pk.base && pk.tab === "spread") pk.tab = "all";
  $("#pkBase").classList.toggle("hidden", !pk.base);
  if (pk.base) $("#pkBase").innerHTML = `${t("Spread con {sym}: scegli il secondo mercato", { sym: `<b>${esc(pk.base)}</b>` })}<button class="xbtn" id="pkBaseOff" title="${t("Annulla")}">✕</button>`;
  renderPicker();
  const cur = pk.base ? -1 : pk.rows.findIndex((m) => m === activeMarket());
  if (cur >= 0) { pk.sel = cur; renderPickerList(); scrollSel(); }
  $("#pkSearch").focus();
  clearInterval(pk.timer);
  pk.timer = setInterval(() => { if (!document.querySelector("#pkList:hover")) renderPickerList(); }, 1500);
}

function closePalette() {
  pk.base = null;
  $("#picker").classList.add("hidden");
  $("#pickerShade").classList.add("hidden");
  clearInterval(pk.timer);
}

// a spread from the market bar's button: the current market over the one picked
function openSpreadPicker() {
  const pr = activePair(), m = activeMarket();
  if (!m) return;
  pk.base = pr ? pr[0].symbol : m.symbol;
  openPalette();
}

function pickMarket(sym) {
  if (pk.base && !sym.includes("/")) {
    if (sym === pk.base) return;
    sym = `${pk.base}/${sym}`;
  }
  recents = [sym, ...recents.filter((s) => s !== sym)].slice(0, 8);
  store("recents", recents);
  setSymbol(sym);
  closePalette();
}

function toggleFav(sym) {
  if (sym.includes("/")) {
    favPairs = favPairs.includes(sym) ? favPairs.filter((x) => x !== sym) : [...favPairs, sym];
    store("favPairs", favPairs);
    renderPicker();
    return;
  }
  favs = favs.includes(sym) ? favs.filter((x) => x !== sym) : [...favs, sym];
  store("favs", favs);
  renderTicker();
  renderPicker();
}

function scrollSel() {
  const el = $(`#pkList [data-i="${pk.sel}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function moveSel(d) {
  const cols = pk.view === "grid" ? Math.max(1, Math.floor($("#pkList").clientWidth / 210)) : 1;
  pk.sel = Math.max(0, Math.min(pk.rows.length - 1, pk.sel + d * cols));
  renderPickerList();
  scrollSel();
}

(function wirePicker() {
  $("#pkSearch").addEventListener("input", () => { pk.sel = 0; renderPickerList(); });
  $("#picker").addEventListener("keydown", (e) => {
    const inSearch = e.target.id === "pkSearch";
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter" && pk.rows[pk.sel]) { e.preventDefault(); pickMarket(pk.rows[pk.sel].symbol); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    else if (!inSearch && e.key.toLowerCase() === "f" && pk.rows[pk.sel]) toggleFav(pk.rows[pk.sel].symbol);
    else if (!inSearch && (e.key === "/" || e.key.toLowerCase() === "s")) { e.preventDefault(); $("#pkSearch").focus(); }
    else if (inSearch && e.key === "Tab") { e.preventDefault(); $("#pkList").focus(); }
  });
  $("#pickerShade").addEventListener("mousedown", closePalette);
  $("#pkBase").addEventListener("click", (e) => { if (e.target.closest("#pkBaseOff")) { pk.base = null; $("#pkBase").classList.add("hidden"); $("#pkSearch").focus(); } });
  $("#pkClose").addEventListener("click", closePalette);
  $("#picker").addEventListener("click", (e) => {
    const t = e.target;
    const star = t.closest("[data-star]");
    if (star) { e.stopPropagation(); toggleFav(star.dataset.star); return; }
    const un = t.closest("[data-unrecent]");
    if (un) { recents = recents.filter((s) => s !== un.dataset.unrecent); store("recents", recents); renderPickerChrome(); return; }
    const chip = t.closest(".chip[data-sym]");
    if (chip) { pickMarket(chip.dataset.sym); return; }
    const tab = t.closest("[data-tab]");
    if (tab) { pk.tab = tab.dataset.tab; pk.cat = ""; pk.sel = 0; store("pk.tab", pk.tab); renderPicker(); return; }
    const cat = t.closest("[data-cat]");
    if (cat) { pk.cat = cat.dataset.cat; pk.sel = 0; renderPicker(); return; }
    const sort = t.closest("[data-sort]");
    if (sort) {
      const k = sort.dataset.sort;
      pk.sort = { key: k, dir: pk.sort.key === k ? -pk.sort.dir : k === "symbol" ? 1 : -1 };
      store("pk.sort", pk.sort);
      renderPicker();
      return;
    }
    const view = t.closest("[data-view]");
    if (view && view.closest("#pkViews")) { pk.view = view.dataset.view; store("pk.view", pk.view); renderPicker(); return; }
    const row = t.closest("[data-i]");
    if (row) pickMarket(pk.rows[+row.dataset.i].symbol);
  });
  $("#pkSort").addEventListener("change", (e) => {
    pk.sort = { key: e.target.value, dir: e.target.value === "symbol" ? 1 : -1 };
    store("pk.sort", pk.sort);
    renderPicker();
  });
  $("#pkDir").addEventListener("click", () => { pk.sort.dir *= -1; store("pk.sort", pk.sort); renderPicker(); });
  $("#pkCats").addEventListener("scroll", updateCatArrows);
  $("#pkCatsLeft").addEventListener("click", () => scrollCats(-1));
  $("#pkCatsRight").addEventListener("click", () => scrollCats(1));
  $("#pkCats").addEventListener("wheel", (e) => { if (e.deltaY) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  addEventListener("resize", () => { if (!$("#picker").classList.contains("hidden")) { placePicker(); updateCatArrows(); } });
  fillPickerSorts();
})();
