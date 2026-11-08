"use strict";
// Paper trading: Lighter's live prices, simulated money. The engine runs in this browser and keeps its
// state in localStorage. It answers the same /api calls as the server (orders, closes, SL/TP, trailing,
// open orders, fills), so the ticket, the positions table and the chart lines work unchanged.
// Orders execute while LighterDeck is open; on the next visit the time away is replayed from candles.
const Paper = (() => {
  const KEY = "ld.paper.state";
  const MAX_TRADES = 500;
  const ATR_TF = "15m", ATR_LEN = 14, ATR_TTL = 300000; // same trailing ATR as the server's engine
  const MIN_STOP_STEP_PCT = 0.05;

  const fresh = (balance) => ({
    v: 1, balance, cash: balance, start: Date.now(), seen: Date.now(), hour: Math.floor(Date.now() / 3600000),
    positions: {}, orders: [], trades: [], stops: {}, exits: {}, pairs: [], rules: [], settings: {}, logs: [], next: 1, logSeq: 0,
  });
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(10000); } catch { S = fresh(10000); }
  S.exits ||= {};
  S.pairs ||= [];
  S.rules ||= [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

  let replay = null;      // prices while the time away is replayed: { [market]: {mark, bid, ask} }
  let replayFill = null;  // during replay a trigger fills at its own level unless the bar opened past it
  const atr = {};         // market -> { at, value }
  let changed = false;
  let auto = false;       // inside step(): fills the user didn't click get a toast

  const err = (msg) => { throw new Error(msg); };
  const mkt = (id) => byId[id] || err(t("Mercato sconosciuto"));
  const px = (id) => (replay && replay[id]) || prices[id] || null;
  const markOf = (id) => { const p = px(id); return p && p.mark ? p.mark : null; };
  const roundSize = (v, m) => +v.toFixed(m.size_decimals);
  const roundPrice = (v, m) => +v.toFixed(m.price_decimals);
  const lev = (id) => (S.settings[id] && S.settings[id].leverage) || mkt(id).default_leverage || 1;
  const isolated = (id) => !!(S.settings[id] && S.settings[id].cross === false);
  const now = () => (replay ? replay.at : Date.now());

  function note(msg, level = "info") {
    S.logs.push({ seq: ++S.logSeq, ts: now() / 1000, msg, level });
    if (S.logs.length > 200) S.logs.splice(0, S.logs.length - 200);
    if (auto && !replay) toast(msg, level === "error");
  }

  // ---------- account ----------
  // Cross positions share the account's collateral; an isolated one stands on its own margin (entry value /
  // leverage), so its loss can't reach the rest and its liquidation price is its own.
  function account() {
    const positions = [];
    let upnl = 0, im = 0, mmr = 0, isoEquity = 0;
    for (const [id, p] of Object.entries(S.positions)) {
      const m = byId[id];
      if (!m) continue;
      const mark = markOf(id) || p.entry;
      const u = (mark - p.entry) * p.size, value = Math.abs(p.size) * mark, iso = isolated(id);
      const margin = iso ? Math.abs(p.size) * p.entry / lev(id) : value / lev(id);
      upnl += u;
      im += margin;
      if (iso) isoEquity += margin + u;
      else mmr += value * m.mmf;
      positions.push({ market_id: +id, symbol: m.symbol, size: p.size, entry: p.entry, value, upnl: u, rpnl: p.rpnl || 0,
        margin, leverage: lev(id), cross: !iso, mark });
    }
    const total = S.cash + upnl, crossTotal = total - isoEquity;
    for (const p of positions) {
      const mmf = byId[p.market_id].mmf;
      p.liq = (p.cross ? Formulas.liquidationPrice(p.size, p.mark, mmf, crossTotal, mmr) : Formulas.isolatedLiquidation(p.size, p.entry, p.margin, mmf)) || 0;
    }
    // resting orders that add exposure lock their margin too
    const locked = S.orders.filter((o) => o.type === "limit" && !o.reduce_only)
      .reduce((s, o) => s + o.remaining * o.price / lev(o.market_id), 0);
    const settings = {};
    for (const [id, s] of Object.entries(S.settings)) settings[id] = { leverage: s.leverage, cross: s.cross !== false };
    return { index: "Paper", paper: true, collateral: S.cash, total_value: total, available: Math.max(0, total - im - locked),
      maintenance: mmr, cross_value: crossTotal, positions: positions.map(({ mark, ...p }) => p), settings };
  }

  // ---------- fills ----------
  // signed qty at price; realized PnL is booked on the part that reduces the position
  function fill(id, qty, price, role, orderId) {
    const m = mkt(id);
    const pos = S.positions[id] || { size: 0, entry: 0, rpnl: 0 };
    const fee = Math.abs(qty) * price * ((role === "maker" ? m.maker_fee : m.taker_fee) || 0);
    let pnl = 0;
    const newSize = roundSize(pos.size + qty, m);
    if (pos.size && Math.sign(qty) !== Math.sign(pos.size)) {
      pnl = (price - pos.entry) * Math.min(Math.abs(qty), Math.abs(pos.size)) * Math.sign(pos.size);
      if (newSize && Math.sign(newSize) !== Math.sign(pos.size)) pos.entry = price; // flipped
    } else if (newSize) {
      pos.entry = (Math.abs(pos.size) * pos.entry + Math.abs(qty) * price) / Math.abs(newSize);
    }
    const flipped = pos.size && (!newSize || Math.sign(newSize) !== Math.sign(pos.size));
    pos.size = newSize;
    pos.rpnl = (pos.rpnl || 0) + pnl;
    S.cash += pnl - fee;
    if (newSize) S.positions[id] = pos; else delete S.positions[id];
    // position-tied SL/TP and the managed stop end with the position (as on Lighter)
    if (flipped) {
      S.orders = S.orders.filter((o) => !(o.market_id === +id && o.trigger_price));
      if (S.stops[id]) S.stops[id].state = {};
      if (!newSize) delete S.stops[id];
      delete S.exits[id];
    }
    S.trades.unshift({ ts: now(), market_id: +id, symbol: m.symbol, side: qty > 0 ? "buy" : "sell", size: Math.abs(qty),
      price, usd: Math.abs(qty) * price, role, pnl, fee, order_id: orderId || S.next++ });
    if (S.trades.length > MAX_TRADES) S.trades.length = MAX_TRADES;
    changed = true;
  }

  function addTriggers(id, isAsk, sl, tp) {
    for (const [trigger, type] of [[tp, "take-profit"], [sl, "stop-loss"]]) {
      if (!trigger) continue;
      S.orders.push({ order_index: S.next++, client_order_index: 0, market_id: +id, is_ask: isAsk, type, price: trigger,
        trigger_price: trigger, remaining: 0, reduce_only: true, status: "open", ts: now() });
    }
  }

  // scaled exits: one sized reduce-only take-profit per level (isAsk: the closing side)
  function addExits(id, isAsk, levels, be) {
    if (!levels) return;
    S.exits[id] = { be_after_tp1: !!be, be_done: false, levels: levels.map((l) => {
      const oi = S.next++;
      S.orders.push({ order_index: oi, client_order_index: 0, market_id: +id, is_ask: isAsk, type: "take-profit", price: l.price,
        trigger_price: l.price, remaining: l.qty, reduce_only: true, status: "open", ts: now() });
      return { price: l.price, qty: l.qty, oi, done: false };
    }) };
  }

  function exitFilled(id, oi) {
    const x = S.exits[id], lv = x && x.levels.find((l) => l.oi === oi);
    if (!lv) return;
    lv.done = true;
    if (x.be_after_tp1 && !x.be_done && lv === x.levels[0]) {
      x.be_done = true;
      if (S.stops[id]) { S.stops[id].be_now = true; S.stops[id].state.stop = S.stops[id].state.stop ?? null; }
      else S.stops[id] = { id: "paper-" + id, be_now: true, state: {} };
      note(t("Paper: TP1 eseguito su {sym}, stop a breakeven", { sym: byId[id].symbol }), "warning");
    }
  }

  function exits() {
    const out = {};
    for (const [id, x] of Object.entries(S.exits))
      out[id] = { levels: x.levels.map(({ price, qty, done }) => ({ price, qty, done })), be_after_tp1: x.be_after_tp1, placed: true };
    return out;
  }

  // the server's exit_levels(): 2-5 levels, shares up to 100%, the last takes what is left
  function exitLevels(o, m, size, side, ref, mark, checkSides) {
    const lv = o.tp_levels;
    if (!(lv.length >= 2 && lv.length <= 5)) err(t("Da 2 a 5 livelli di take-profit"));
    const total = lv.reduce((s, l) => s + l.pct, 0);
    if (lv.some((l) => !(l.pct > 0)) || total > 100.0001) err(t("Le quote dei TP vanno sopra lo 0% e in totale fino al 100%"));
    const out = [];
    lv.forEach((l, i) => {
      const name = `TP${i + 1}`;
      if (!l.price && checkSides) err(`${name}: ${t("inserisci il prezzo")}`);
      const price = l.price ? roundPrice(l.price, m) : ref;
      if (l.price && checkSides) {
        for (const [refName, r] of [[t("prezzo d'entrata"), ref], ...(mark ? [["mark price", mark]] : [])])
          if (side > 0 ? price <= r : price >= r)
            err(`${name}: ` + t(side > 0 ? "{what} deve stare sopra il {ref} ({price})" : "{what} deve stare sotto il {ref} ({price})", { what: t("Il take-profit"), ref: refName, price: +r.toPrecision(10) }));
      }
      const last = i === lv.length - 1 && total > 99.9999;
      const qty = roundSize(last ? size - out.reduce((s, x) => s + x.qty, 0) : size * l.pct / 100, m);
      if (qty < m.min_base || qty * price < m.min_quote)
        err(t("{name}: {qty} {sym} è sotto il minimo dell'exchange ({base} {sym} o {quote} USD). Usa meno livelli o una size più grande.", { name, qty, sym: m.symbol, base: m.min_base, quote: m.min_quote }));
      out.push({ price, qty });
    });
    return out;
  }

  // margin needed for the exposure an order adds (reducing needs none)
  function checkMargin(id, qty, price) {
    const pos = S.positions[id];
    const cur = pos ? pos.size : 0;
    const added = Math.max(0, Math.abs(cur + qty) - Math.abs(cur));
    const need = added * price / lev(id);
    if (need > account().available + 1e-9)
      err(t("Margine insufficiente: servono {need}, disponibili {have}", { need: fusd(need), have: fusd(account().available) }));
  }

  // ---------- orders (the server's /api/preview and /api/order) ----------
  // a scale order's prices and each one's share of the size
  function scalePrices(o, m) {
    const n = o.scale_count;
    if (!(n >= 2 && n <= 20)) err(t("Scale: da 2 a 20 ordini"));
    if (!(o.scale_from > 0 && o.scale_to > 0) || o.scale_from === o.scale_to) err(t("Scale: inserisci i due prezzi"));
    if (o.unit === "risk_usd") err(t("Scale: usa USD, quantità o % capitale"));
    const lo = Math.min(o.scale_from, o.scale_to), hi = Math.max(o.scale_from, o.scale_to);
    const prices = Array.from({ length: n }, (_, i) => roundPrice(lo + (hi - lo) * i / (n - 1), m));
    const weights = prices.map((_, i) => (o.scale_dist === "low" ? n - i : o.scale_dist === "high" ? i + 1 : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    return { prices, shares: weights.map((w) => w / total) };
  }

  // ctx: where prices and the account come from; live trading with the key in the browser (live.js)
  // sizes its orders here too, with Lighter's account
  function plan(o, checkSides = true, ctx = { px, account }) {
    const m = mkt(o.market_id);
    const side = o.side === "buy" ? 1 : -1;
    const p = ctx.px(m.id);
    const markOf = (id) => { const q = ctx.px(id); return q && q.mark ? q.mark : null; };
    if (["conditional", "twap", "scale", "chase", "iceberg"].includes(o.kind) && (o.sl_price || o.tp_price || o.trail || o.tp_levels)) err(t("SL, TP e trailing si aggiungono alla posizione dopo l'ordine"));
    const scale = o.kind === "scale" ? scalePrices(o, m) : null;
    let ref;
    if (o.kind === "limit" || o.kind === "iceberg") {
      if (!o.price) err(t("Gli ordini limit richiedono un prezzo"));
      ref = o.price;
    } else if (o.kind === "conditional") {
      if (!(o.trigger_price > 0)) err(t("Inserisci il prezzo di attivazione"));
      if (o.cond_exec === "limit" && !o.price) err(t("Gli ordini limit richiedono un prezzo"));
      ref = o.cond_exec === "limit" ? o.price : o.trigger_price;
    } else if (scale) {
      ref = scale.prices.reduce((s, x, i) => s + x * scale.shares[i], 0);
    } else {
      ref = p && (side > 0 ? p.ask : p.bid) || markOf(m.id);
      if (!ref) err(t("Nessun prezzo per questo mercato in questo momento"));
    }
    let size;
    if (o.unit === "base") size = o.size;
    else if (o.unit === "risk_usd") {
      if (!o.sl_price || o.sl_price === ref) err(t("La size a rischio fisso richiede uno stop-loss lontano dall'entrata"));
      size = o.size / Math.abs(ref - o.sl_price);
    } else if (o.unit === "equity_pct") {
      const acc = ctx.account();
      if (!acc || !(o.size > 0 && o.size <= 100)) err(t("La % del capitale richiede l'account caricato e un valore tra 0 e 100"));
      size = acc.total_value * o.size / 100 / ref;
    } else size = o.size / ref;
    size = roundSize(size, m);
    if (size <= 0) err(t("Size sotto la precisione del mercato"));
    if (o.reduce_only && (o.sl_price || o.tp_price || o.trail || o.tp_levels)) err(t("Le chiusure reduce-only non possono avere SL/TP"));
    if (o.tp_levels && o.tp_price) err(t("Usa un solo take-profit o i livelli, non entrambi"));
    if (!o.reduce_only && (size < m.min_base || size * ref < m.min_quote))
      err(t("Ordine sotto il minimo dell'exchange ({base} {sym} o {quote} USD)", { base: m.min_base, sym: m.symbol, quote: m.min_quote }));
    if (checkSides) {
      const mark = o.kind === "market" ? markOf(m.id) : null;
      const refs = [[t("prezzo d'entrata"), ref], ...(mark ? [["mark price", mark]] : [])];
      for (const [trigger, isSl] of [[o.sl_price, true], [o.tp_price, false]]) {
        if (!trigger) continue;
        const name = isSl ? t("Lo stop-loss") : t("Il take-profit");
        const below = isSl === side > 0;
        for (const [refName, r] of refs) {
          if (below ? trigger >= r : trigger <= r)
            err(t(below ? "{what} deve stare sotto il {ref} ({price})" : "{what} deve stare sopra il {ref} ({price})", { what: name, ref: refName, price: +r.toPrecision(10) }));
        }
      }
    }
    const levels = o.tp_levels ? exitLevels(o, m, size, side, ref, o.kind === "market" ? markOf(m.id) : null, checkSides) : null;
    const slip = o.slippage_bps ?? 50;
    let worst = o.kind === "limit" || o.kind === "iceberg" || (o.kind === "conditional" && o.cond_exec === "limit") ? ref : ref * (1 + side * slip / 10000);
    const extra = {};
    if (o.kind === "chase" && o.chase_minutes != null && !(o.chase_minutes > 0 && o.chase_minutes <= 1440)) err(t("Il tempo del chase va fino a 24 ore"));
    if (o.kind === "iceberg") {
      if (!(o.ice_slice >= 1 && o.ice_slice <= 50)) err(t("La fetta dell'iceberg va dall'1% al 50%"));
      const small = size * o.ice_slice / 100 * 0.8;
      if (small < m.min_base || small * ref < m.min_quote) err(t("Iceberg: una fetta è sotto il minimo dell'exchange ({base} {sym} o {quote} USD). Usa una fetta o una size più grande.", { base: m.min_base, sym: m.symbol, quote: m.min_quote }));
    }
    if (o.kind === "twap") {
      if (!(o.twap_minutes >= 5 && o.twap_minutes <= 1440)) err(t("La durata del TWAP va da 5 minuti a 24 ore"));
      worst = o.price || ref * (1 + side * 0.03); // no price given: Lighter's 3% maximum slippage for a TWAP
    } else if (o.kind === "conditional") {
      const at = markOf(m.id) || ref;
      extra.cond_stop = side > 0 ? o.trigger_price > at : o.trigger_price < at; // Lighter's stop types, or its take-profit ones
    } else if (scale) {
      let left = size;
      extra.scale_levels = scale.prices.map((price, i) => {
        const qty = roundSize(i === scale.prices.length - 1 ? left : size * scale.shares[i], m);
        left -= qty;
        if (qty < m.min_base || qty * price < m.min_quote) err(t("Scale: {qty} {sym} a {price} è sotto il minimo dell'exchange ({base} {sym} o {quote} USD). Usa meno ordini o una size più grande.", { qty, sym: m.symbol, price, base: m.min_base, quote: m.min_quote }));
        return { price, qty };
      });
      if (checkSides) for (const x of extra.scale_levels) {
        if ((side > 0 && p && p.ask && x.price >= p.ask) || (side < 0 && p && p.bid && x.price <= p.bid)) err(t("Scale: {price} attraverserebbe il prezzo e verrebbe eseguito subito", { price: x.price }));
      }
    }
    return { size, side, ref, worst: roundPrice(worst, m), notional: size * ref, slippage_bps: slip, ...(levels ? { tp_levels: levels } : {}), ...extra };
  }

  const chaseTarget = (best, isAsk, cap) => (cap ? (isAsk ? Math.max(best, cap) : Math.min(best, cap)) : best);

  // the next slice of an iceberg: each a little different, as on the server's engine
  function nextSlice(o, m) {
    const least = Math.max(m.min_base, m.min_quote / o.price), ice = o.ice;
    let qty = Math.max(roundSize(ice.total * ice.pct / 100 * (0.8 + Math.random() * 0.4), m), roundSize(least + 10 ** -m.size_decimals, m));
    if (ice.left - qty < least) qty = ice.left;
    ice.left = roundSize(ice.left - qty, m);
    return { ...o, order_index: S.next++, remaining: qty, ts: now() };
  }

  function placeOrder(o) {
    const pl = plan(o);
    const m = mkt(o.market_id), id = m.id, qty = pl.side * pl.size, p = px(id);
    if (o.kind === "conditional") {
      const limit = o.cond_exec === "limit";
      S.orders.push({ order_index: S.next++, client_order_index: 0, market_id: id, is_ask: pl.side < 0, type: (pl.cond_stop ? "stop-loss" : "take-profit") + (limit ? "-limit" : ""),
        price: pl.worst, trigger_price: roundPrice(o.trigger_price, m), remaining: pl.size, reduce_only: !!o.reduce_only, status: "open", cond: true, ts: now() });
      note(t("Paper: condizionale {side} {size} {sym} a {price}", { side: o.side, size: pl.size, sym: m.symbol, price: fp(o.trigger_price, m) }));
      changed = true;
      save();
      return { ok: true, size: pl.size, armed: true };
    }
    if (o.kind === "twap") {
      S.orders.push({ order_index: S.next++, client_order_index: 0, market_id: id, is_ask: pl.side < 0, type: "twap", price: pl.worst, trigger_price: 0, remaining: pl.size,
        total: pl.size, start: now(), end: now() + o.twap_minutes * 60000, reduce_only: !!o.reduce_only, status: "open", ts: now() });
      note(t("Paper: TWAP {side} {size} {sym} in {min} minuti", { side: o.side, size: pl.size, sym: m.symbol, min: o.twap_minutes }));
      changed = true;
      save();
      return { ok: true, size: pl.size, armed: true };
    }
    if (o.kind === "chase" || o.kind === "iceberg") {
      if (!o.reduce_only) checkMargin(id, qty, pl.ref);
      const base = { client_order_index: 0, market_id: id, is_ask: pl.side < 0, type: "limit", trigger_price: 0, reduce_only: !!o.reduce_only, status: "open", ts: now() };
      if (o.kind === "chase") {
        const best = pl.side > 0 ? p && p.bid : p && p.ask;
        const price = roundPrice(chaseTarget(best || pl.ref, pl.side < 0, o.chase_cap), m);
        S.orders.push({ ...base, order_index: S.next++, price, remaining: pl.size, post_only: true,
          chase: { cap: o.chase_cap || null, until: o.chase_minutes ? now() + o.chase_minutes * 60000 : null, then_market: !!o.chase_market },
          working: { kind: "chase", qty: pl.size, filled: 0 } });
        note(t("Paper: chase {side} {size} {sym} da {price}", { side: o.side, size: pl.size, sym: m.symbol, price: fp(price, m) }));
      } else {
        const ice = { pct: o.ice_slice, left: pl.size, total: pl.size };
        S.orders.push(nextSlice({ ...base, price: roundPrice(o.price, m), post_only: !!o.post_only, ice, working: { kind: "iceberg", qty: pl.size, filled: 0 } }, m));
        note(t("Paper: iceberg {side} {size} {sym} a {price}", { side: o.side, size: pl.size, sym: m.symbol, price: fp(o.price, m) }));
      }
      changed = true;
      save();
      return { ok: true, size: pl.size, armed: true };
    }
    if (o.kind === "scale") {
      if (!o.reduce_only) checkMargin(id, qty, pl.ref);
      for (const x of pl.scale_levels) {
        S.orders.push({ order_index: S.next++, client_order_index: 0, market_id: id, is_ask: pl.side < 0, type: "limit", price: x.price, trigger_price: 0, remaining: x.qty,
          reduce_only: !!o.reduce_only, status: "open", post_only: !!o.post_only, ts: now() });
      }
      note(t("Paper: scale {side} {size} {sym}, {n} ordini", { side: o.side, size: pl.size, sym: m.symbol, n: pl.scale_levels.length }));
      changed = true;
      save();
      return { ok: true, size: pl.size, armed: true };
    }
    if (o.trail) trailFields(o.trail);
    let fillQty = qty;
    if (o.reduce_only) {
      const pos = S.positions[id];
      if (!pos || Math.sign(pos.size) === pl.side) err(t("Nessuna posizione da ridurre su {sym}", { sym: m.symbol }));
      fillQty = pl.side * Math.min(pl.size, Math.abs(pos.size));
    } else checkMargin(id, qty, pl.ref);
    const crosses = o.kind === "limit" && p && (pl.side > 0 ? p.ask && o.price >= p.ask : p.bid && o.price <= p.bid);
    if (o.kind === "limit" && !crosses) {
      S.orders.push({ order_index: S.next++, client_order_index: 0, market_id: id, is_ask: pl.side < 0, type: "limit",
        price: roundPrice(o.price, m), trigger_price: 0, remaining: pl.size, reduce_only: !!o.reduce_only, status: "open",
        post_only: !!o.post_only, sl: o.sl_price || null, tp: o.tp_price || null, trail: o.trail || null,
        exits: pl.tp_levels || null, be: o.be_after_tp1 !== false, ts: now() });
      note(t("Paper: limit {side} {size} {sym} a {price}", { side: o.side, size: pl.size, sym: m.symbol, price: fp(o.price, m) }));
    } else {
      if (crosses && o.post_only) err(t("Il post-only attraverserebbe il prezzo e verrebbe eseguito subito"));
      const price = o.kind === "limit" ? (pl.side > 0 ? p.ask : p.bid) : pl.ref;
      fill(id, fillQty, price, "taker");
      if (!o.reduce_only) {
        addTriggers(id, pl.side > 0, o.sl_price, o.tp_price); // a long closes by selling
        addExits(id, pl.side > 0, pl.tp_levels, o.be_after_tp1 !== false);
        if (o.trail) setStop(id, o.trail);
      }
      note(t("Paper: {side} {size} {sym} a {price}", { side: o.side, size: Math.abs(fillQty), sym: m.symbol, price: fp(price, m) }));
    }
    changed = true;
    save();
    return { ok: true, size: pl.size, armed: true };
  }

  function closePosition(id, fraction) {
    const m = mkt(id), pos = S.positions[id];
    if (!pos) err(t("Nessuna posizione"));
    const size = fraction >= 1 ? pos.size : roundSize(pos.size * fraction, m);
    if (!size) err(t("Size sotto la precisione del mercato"));
    const p = px(id), price = (size > 0 ? p && p.bid : p && p.ask) || markOf(id);
    if (!price) err(t("Nessun prezzo per questo mercato in questo momento"));
    fill(id, -size, price, "taker");
    note(t("Paper: chiuso {pct}% {sym} a {price}", { pct: Math.round(Math.min(fraction, 1) * 100), sym: m.symbol, price: fp(price, m) }));
    save();
    return { ok: true };
  }

  // close and open the other side, same size, in one market order (as Lighter's Reverse)
  function reversePosition(id) {
    const m = mkt(id), pos = S.positions[id];
    if (!pos) err(t("Nessuna posizione"));
    const p = px(id), price = (pos.size > 0 ? p && p.bid : p && p.ask) || markOf(id);
    if (!price) err(t("Nessun prezzo per questo mercato in questo momento"));
    const size = pos.size;
    fill(id, -2 * size, price, "taker"); // the flip ends the old SL/TP
    delete S.stops[id];
    note(t("Paper: reverse {sym} a {price}", { sym: m.symbol, price: fp(price, m) }));
    save();
    return { ok: true, size: -size };
  }

  // several markets at once: in paper they all fill, as a batch that went through
  function basketOrder(r) {
    const legs = r.legs || [];
    if (legs.length < 2 || legs.length > 10 || new Set(legs.map((x) => x.market_id)).size !== legs.length) err(t("Il basket vuole da 2 a {n} mercati diversi", { n: 10 }));
    const plans = legs.map((x) => {
      try { return plan({ market_id: x.market_id, side: x.side, kind: "market", size: x.size_usd, unit: "usd", slippage_bps: r.slippage_bps }); }
      catch (e) { err(`${mkt(x.market_id).symbol}: ${e.message}`); }
    });
    const need = plans.reduce((s, p, i) => s + p.notional / lev(legs[i].market_id), 0), have = account().available;
    if (need > have) err(t("Margine insufficiente per il basket: servono {need}, disponibili {have}", { need: fusd(need), have: fusd(have) }));
    const out = legs.map((x, i) => {
      fill(x.market_id, plans[i].side * plans[i].size, plans[i].ref, "taker");
      return { market_id: x.market_id, symbol: mkt(x.market_id).symbol, side: x.side, size: plans[i].size, filled: plans[i].size };
    });
    note(t("Paper: basket di {n} mercati", { n: legs.length }));
    changed = true;
    save();
    return { ok: true, legs: out };
  }

  // both legs of a spread: the same dollar value bought on one market and sold on the other
  function pairOrder(r) {
    if (r.long_id === r.short_id) err(t("Scegli due mercati diversi"));
    const legs = [[r.long_id, "buy"], [r.short_id, "sell"]].map(([market_id, side]) =>
      ({ market_id, side, kind: "market", size: r.size_usd / 2, unit: "usd", slippage_bps: r.slippage_bps }));
    const plans = legs.map((o) => plan(o));
    const need = plans.reduce((s, p, i) => s + p.notional / lev(legs[i].market_id), 0), have = account().available;
    if (need > have + 1e-9) err(t("Margine insufficiente per le due gambe: servono {need}, disponibili {have}", { need: fusd(need), have: fusd(have) }));
    const done = [];
    for (const o of legs) {
      try {
        const res = placeOrder(o);
        done.push({ market_id: o.market_id, symbol: mkt(o.market_id).symbol, side: o.side, size: res.size, price: S.trades[0].price });
      } catch (e) {
        if (!done.length) throw e;
        return { ok: false, error: e.message, filled: done, failed: { market_id: o.market_id, symbol: mkt(o.market_id).symbol } };
      }
    }
    addPair(r.long_id, r.short_id, done[0].size, done[1].size, done[0].price, done[1].price);
    return { ok: true, legs: done };
  }

  // pairs, as the server's /api/pairs: each with its own quantities and entry prices, since a market's
  // position can be bigger than the pair's leg
  function addPair(longId, shortId, lq, sq, le, se) {
    S.pairs.push({ id: `${longId}-${shortId}-${Date.now()}`, long_id: longId, short_id: shortId,
      long_qty: lq, short_qty: sq, long_entry: le, short_entry: se, at: now() / 1000 });
    changed = true;
  }

  function pairs() {
    const pos = (id) => S.positions[id] || { size: 0, entry: 0 };
    // a pair recorded before quantities were kept: its legs are the fills in the 20 seconds before it (both legs go out within a second or two)
    for (const p of S.pairs) {
      if (p.long_qty !== undefined) continue;
      for (const [key, id, side] of [["long", p.long_id, "buy"], ["short", p.short_id, "sell"]]) {
        const fs = S.trades.filter((x) => x.market_id === +id && x.side === side && x.ts >= p.at * 1000 - 20000 && x.ts <= p.at * 1000 + 5000);
        const qty = fs.reduce((s, x) => s + x.size, 0);
        p[`${key}_qty`] = qty || Math.abs(pos(id).size);
        p[`${key}_entry`] = qty ? fs.reduce((s, x) => s + x.size * x.price, 0) / qty : pos(id).entry;
      }
    }
    // what each position still has for the pairs, oldest first: two pairs never count the same units
    const free = {};
    for (const [id, p] of Object.entries(S.positions)) free[id] = Math.abs(p.size);
    S.pairs = S.pairs.filter((p) => {
      p.long_qty = pos(p.long_id).size > 0 ? Math.min(p.long_qty, free[p.long_id] || 0) : 0;
      p.short_qty = pos(p.short_id).size < 0 ? Math.min(p.short_qty, free[p.short_id] || 0) : 0;
      if (p.long_qty <= 1e-12 || p.short_qty <= 1e-12) return false;
      free[p.long_id] -= p.long_qty;
      free[p.short_id] -= p.short_qty;
      return true;
    });
    return S.pairs.map((p) => ({ ...p }));
  }

  // SL/TP on a pair's ratio (long leg over short leg), as the server's: SL below the ratio, TP above
  function setPairStops(id, b) {
    const p = pairs() && S.pairs.find((x) => x.id === id) || err(t("Coppia non trovata"));
    const a = markOf(p.long_id), c = markOf(p.short_id), ratio = a && c ? a / c : null;
    if (ratio && b.sl && b.sl >= ratio) err(t("Lo SL della coppia deve stare sotto il rapporto attuale ({r}), altrimenti scatterebbe subito", { r: +ratio.toPrecision(6) }));
    if (ratio && b.tp && b.tp <= ratio) err(t("Il TP della coppia deve stare sopra il rapporto attuale ({r}), altrimenti scatterebbe subito", { r: +ratio.toPrecision(6) }));
    p.sl = b.sl || null;
    p.tp = b.tp || null;
    changed = true;
    save();
    return { pairs: pairs(), armed: true };
  }

  function stepPairs() {
    for (const p of pairs()) {
      if (!p.sl && !p.tp) continue;
      const a = markOf(p.long_id), c = markOf(p.short_id);
      if (!a || !c) continue;
      const ratio = a / c, hit = p.sl && ratio <= p.sl ? "SL" : p.tp && ratio >= p.tp ? "TP" : null;
      if (!hit) continue;
      closePair(p.id, 1);
      note(t("Paper: {kind} della coppia {sym} a {r}", { kind: hit, sym: `${mkt(p.long_id).symbol}/${mkt(p.short_id).symbol}`, r: +ratio.toPrecision(6) }), hit === "SL" ? "warning" : "info");
    }
  }

  // ---------- event trades, as the server's engine: long/short at the release, or a breakout of the range
  // of the minutes before it; the entry goes out with SL/TP and, if set, the trailing stop ----------
  const RULE_FIELDS = ["mode", "size_usd", "stop_pct", "tp_pct", "delay_s", "range_minutes", "buffer_pct", "window_minutes", "trail_pct", "breakeven_at_pct"];
  const describe = (r) => `${(byId[r.market_id] || {}).symbol} ${r.mode} on ${r.event_title} $${r.size_usd}`;

  function addRule(b) {
    if (b.type !== "event_trade") err(t("In paper ci sono solo i trade su evento"));
    if (!byId[b.market_id]) err(t("Mercato sconosciuto"));
    if (!(b.size_usd > 0)) err(t("Inserisci una size valida."));
    if (!(b.event_ts > now() / 1000)) err(t("L'evento è già passato"));
    const r = { id: "p" + S.next++, type: "event_trade", market_id: +b.market_id, event_id: b.event_id, event_ts: b.event_ts,
      event_title: b.event_title, status: "waiting", enabled: true, created: now() / 1000 };
    for (const k of RULE_FIELDS) if (b[k] !== undefined && b[k] !== null && b[k] !== "") r[k] = k === "mode" ? b[k] : +b[k];
    S.rules.push(r);
    note(t("Paper: trade su evento impostato: {d}", { d: describe(r) }));
    changed = true;
    save();
    return { ...r, description: describe(r) };
  }

  function enterEvent(r, side) {
    const m = mkt(r.market_id);
    if (S.positions[m.id]) { r.status = "skipped"; note(t("Paper: {d}: posizione già aperta, saltato", { d: describe(r) }), "warning"); return; }
    const ref = markOf(m.id);
    try {
      placeOrder({ market_id: m.id, side: side > 0 ? "buy" : "sell", kind: "market", size: r.size_usd, unit: "usd",
        sl_price: r.stop_pct ? roundPrice(ref * (1 - side * r.stop_pct / 100), m) : undefined,
        tp_price: r.tp_pct ? roundPrice(ref * (1 + side * r.tp_pct / 100), m) : undefined });
      r.status = "done";
      note(t("Paper: {side} {sym} su {ev}", { side: side > 0 ? "LONG" : "SHORT", sym: m.symbol, ev: r.event_title }), "warning");
      if (r.trail_pct || r.breakeven_at_pct)
        S.stops[m.id] = { id: "paper-" + m.id, ...(r.trail_pct ? { trail_pct: r.trail_pct } : {}), ...(r.breakeven_at_pct ? { breakeven_at_pct: r.breakeven_at_pct } : {}), trail_activate_pct: 0, state: {} };
    } catch (e) {
      r.status = "blocked";
      note(t("Paper: {d}: bloccato ({err})", { d: describe(r), err: e.message }), "error");
    }
  }

  function loadRange(r) {
    r.loading = true;
    const minutes = r.range_minutes || 15;
    fetch(`/api/candles?market_id=${r.market_id}&resolution=1m&count=${minutes + 5}`).then((x) => x.json()).then((bars) => {
      const pre = bars.filter((c) => c.time >= r.event_ts - minutes * 60 && c.time < r.event_ts);
      r.loading = false;
      if (!pre.length) { r.status = "expired"; note(t("Paper: {d}: niente candele per il range", { d: describe(r) }), "error"); save(); return; }
      r.high = Math.max(...pre.map((c) => c.high));
      r.low = Math.min(...pre.map((c) => c.low));
      r.status = "window";
      note(t("Paper: range prima di {ev}: {lo} – {hi}", { ev: r.event_title, lo: fp(r.low, byId[r.market_id]), hi: fp(r.high, byId[r.market_id]) }));
      save();
    }).catch(() => { r.loading = false; });
  }

  function stepEvents() {
    const t0 = now() / 1000;
    for (const r of S.rules) {
      if (!["waiting", "window"].includes(r.status) || !byId[r.market_id]) continue;
      if (r.mode === "long" || r.mode === "short") {
        const at = r.event_ts + (r.delay_s || 0);
        if (t0 < at) continue;
        if (t0 > at + 120) { r.status = "expired"; note(t("Paper: {d}: entrata mancata (pagina chiusa)", { d: describe(r) }), "warning"); changed = true; continue; }
        enterEvent(r, r.mode === "long" ? 1 : -1);
        changed = true;
        continue;
      }
      if (t0 < r.event_ts) continue;
      if (r.high === undefined) {
        // the range comes from candles; while the time away is replayed there is no fetching, so it is missed
        if (replay) { r.status = "expired"; note(t("Paper: {d}: entrata mancata (pagina chiusa)", { d: describe(r) }), "warning"); changed = true; }
        else if (!r.loading) loadRange(r);
        continue;
      }
      if (t0 > r.event_ts + (r.window_minutes || 30) * 60) { r.status = "expired"; note(t("Paper: {d}: nessun breakout, scaduto", { d: describe(r) })); changed = true; continue; }
      const mark = markOf(r.market_id), buf = (r.buffer_pct ?? 0.05) / 100;
      if (mark > r.high * (1 + buf)) { enterEvent(r, 1); changed = true; }
      else if (mark < r.low * (1 - buf)) { enterEvent(r, -1); changed = true; }
    }
  }

  // close a share of a pair: that share of each leg's own quantity, at the bid/ask
  function closePair(id, fraction) {
    const p = pairs().find((x) => x.id === id) || err(t("Coppia non trovata"));
    const f = Math.min(Math.max(fraction, 0), 1);
    for (const [key, mid, sign] of [["long", p.long_id, 1], ["short", p.short_id, -1]]) {
      const m = mkt(mid), size = roundSize(p[`${key}_qty`] * f, m), q = px(mid);
      if (!(size > 0)) continue;
      fill(mid, -sign * size, (sign > 0 ? q && q.bid : q && q.ask) || markOf(mid), "taker");
      const rec = S.pairs.find((x) => x.id === id);
      if (rec) rec[`${key}_qty`] = roundSize(rec[`${key}_qty`] - size, m);
    }
    if (f >= 0.999) S.pairs = S.pairs.filter((x) => x.id !== id);
    note(t("Paper: chiuso {pct}% della coppia {sym}", { pct: Math.round(f * 100), sym: `${mkt(p.long_id).symbol}/${mkt(p.short_id).symbol}` }));
    save();
    return { ok: true };
  }

  const findOrder = (id, oi) => S.orders.find((o) => o.market_id === +id && o.order_index === +oi)
    || err(t("Ordine non trovato: forse è già stato eseguito o annullato"));

  function moveOrder({ market_id, order_index, price }) {
    const m = mkt(market_id), o = findOrder(market_id, order_index), p = px(market_id) || {};
    price = roundPrice(price, m);
    if (price <= 0) err(t("Prezzo non valido"));
    if (o.type === "twap") err(t("Un TWAP non si sposta: annullalo e inviane un altro"));
    if (o.trigger_price) {
      const isSl = /^stop/.test(o.type), below = isSl === o.is_ask, mark = p.mark;
      if (mark && (below ? price >= mark : price <= mark)) {
        const what = isSl ? t("Lo stop-loss") : t("Il take-profit");
        err(t(below ? "{what} deve stare sotto il prezzo mark ({mark}), altrimenti scatterebbe subito" : "{what} deve stare sopra il prezzo mark ({mark}), altrimenti scatterebbe subito", { what, mark: +mark.toPrecision(10) }));
      }
      o.price = o.cond ? roundPrice(o.price * price / o.trigger_price, m) : price; // a conditional keeps its gap
      o.trigger_price = price;
    } else {
      if ((!o.is_ask && p.ask && price >= p.ask) || (o.is_ask && p.bid && price <= p.bid))
        err(t("Il limite attraverserebbe il prezzo e verrebbe eseguito subito"));
      o.price = price;
    }
    changed = true;
    save();
    return { ok: true, price };
  }

  function positionSltp({ market_id, kind, price, order_index }) {
    if (order_index !== null && order_index !== undefined) {
      if (price) return moveOrder({ market_id, order_index, price });
      findOrder(market_id, order_index);
      S.orders = S.orders.filter((o) => !(o.market_id === +market_id && o.order_index === +order_index));
      changed = true;
      save();
      return { ok: true };
    }
    const m = mkt(market_id), pos = S.positions[market_id];
    if (!pos) err(t("Nessuna posizione"));
    price = roundPrice(price || 0, m);
    if (price <= 0) err(t("Prezzo non valido"));
    const isSl = kind === "sl", below = isSl === pos.size > 0, mark = markOf(market_id);
    if (mark && (below ? price >= mark : price <= mark)) {
      const what = isSl ? t("Lo stop-loss") : t("Il take-profit");
      err(t(below ? "{what} deve stare sotto il prezzo mark ({mark}), altrimenti scatterebbe subito" : "{what} deve stare sopra il prezzo mark ({mark}), altrimenti scatterebbe subito", { what, mark: +mark.toPrecision(10) }));
    }
    addTriggers(market_id, pos.size > 0, isSl ? price : null, isSl ? null : price);
    changed = true;
    save();
    return { ok: true, price };
  }

  function cancelOrder(id, oi) {
    findOrder(id, oi);
    S.orders = S.orders.filter((o) => !(o.market_id === +id && o.order_index === +oi));
    changed = true;
    save();
    return { ok: true };
  }

  function setLeverage(id, leverage, cross = true) {
    const m = mkt(id);
    if (!(leverage >= 1) || (m.max_leverage && leverage > m.max_leverage)) err(t("Leva fuori dai limiti del mercato"));
    const prev = S.settings[id];
    // as on Lighter, an open position keeps its margin mode
    if (S.positions[id] && (prev ? prev.cross !== false : true) !== cross) err(t("Chiudi la posizione per passare tra cross e isolated"));
    S.settings[id] = { leverage, cross };
    if (account().available <= 0 && Object.keys(S.positions).length) { if (prev) S.settings[id] = prev; else delete S.settings[id]; err(t("Margine insufficiente per questa leva")); }
    changed = true;
    save();
    return { ok: true };
  }

  // ---------- managed (trailing) stop, the same rules as the server's engine ----------
  const TRAIL_RANGES = { pnl: [0.1, 1000], pct: [0.05, 50], price: [1e-9, 1e12], atr: [0.1, 20] };
  function trailFields(tr) {
    const range = TRAIL_RANGES[tr.mode] || err(t("Tipo di trailing sconosciuto"));
    if (!(tr.value >= range[0] && tr.value <= range[1])) err(t("Distanza del trailing fuori dai limiti ({lo}–{hi})", { lo: range[0], hi: range[1] }));
    if (!(tr.activate_pct >= 0 && tr.activate_pct <= 1000) || (tr.breakeven_at_pct != null && !(tr.breakeven_at_pct > 0 && tr.breakeven_at_pct <= 1000)))
      err(t("Attivazione e breakeven vanno tra 0 e 1000% di PnL"));
    const f = { [`trail_${tr.mode}`]: tr.value, trail_activate_pct: tr.activate_pct || 0 };
    if (tr.breakeven_at_pct) f.breakeven_at_pct = tr.breakeven_at_pct;
    return f;
  }

  function setStop(id, tr) {
    if (!tr) { delete S.stops[id]; changed = true; return; }
    const old = S.stops[id];
    S.stops[id] = { id: "paper-" + id, ...trailFields(tr), ...(old && old.be_now ? { be_now: true } : {}), state: old ? { ...old.state, stop: null } : {} };
    changed = true;
  }

  function stops() {
    const out = {};
    for (const [id, s] of Object.entries(S.stops)) {
      const { state, ...f } = s;
      out[id] = { ...f, enabled: true, stop: state.stop ?? null, best: state.best ?? null };
    }
    return out;
  }

  function loadAtr(id) {
    const a = atr[id];
    if (a && (a.loading || Date.now() - a.at < ATR_TTL)) return;
    atr[id] = { ...(a || {}), loading: true };
    fetch(`/api/candles?market_id=${id}&resolution=${ATR_TF}&count=${ATR_LEN + 2}`).then((r) => r.json()).then((bars) => {
      bars = bars.slice(-(ATR_LEN + 1));
      const ranges = bars.slice(1).map((b, i) => Math.max(b.high, bars[i].close) - Math.min(b.low, bars[i].close));
      atr[id] = { at: Date.now(), value: ranges.length ? ranges.reduce((s, v) => s + v, 0) / ranges.length : null };
    }).catch(() => { atr[id] = { at: Date.now() - ATR_TTL + 30000, value: a && a.value }; });
  }

  function stepStop(id, s) {
    const pos = S.positions[id], mark = markOf(id);
    if (!pos || !mark) return;
    const st = s.state, side = Math.sign(pos.size);
    if (st.side !== side || st.entry !== pos.entry) Object.assign(st, { side, entry: pos.entry, best: mark, stop: null });
    // the stop fires first, then the best price moves on (a bar's path keeps this order)
    if (st.stop && (side > 0 ? mark <= st.stop : mark >= st.stop)) {
      const m = byId[id], p = px(id);
      const price = replayFill ? replayFill(st.stop, mark) : (side > 0 ? p.bid : p.ask) || mark;
      fill(id, -pos.size, price, "taker");
      const trails = s.trail_pnl || s.trail_pct || s.trail_price || s.trail_atr;
      note(t(trails ? "Paper: trailing stop eseguito su {sym} a {price}" : "Paper: stop a breakeven eseguito su {sym} a {price}", { sym: m.symbol, price: fp(price, m) }), "warning");
      return;
    }
    st.best = side > 0 ? Math.max(st.best, mark) : Math.min(st.best, mark);
    const profit = (st.best - pos.entry) / pos.entry * 100 * side * lev(id); // PnL % on margin, like the server
    const cands = [];
    if (s.be_now || (s.breakeven_at_pct && profit >= s.breakeven_at_pct)) cands.push(pos.entry * (1 + side * 0.05 / 100));
    if (profit >= (s.trail_activate_pct || 0)) {
      let dist = null;
      if (s.trail_pnl) dist = st.best * s.trail_pnl / 100 / lev(id);
      else if (s.trail_pct) dist = st.best * s.trail_pct / 100;
      else if (s.trail_price) dist = s.trail_price;
      else if (s.trail_atr) { loadAtr(id); dist = atr[id] && atr[id].value ? s.trail_atr * atr[id].value : null; }
      if (dist) cands.push(st.best - side * dist);
    }
    if (!cands.length) return;
    let want = side > 0 ? Math.max(...cands) : Math.min(...cands);
    if (st.stop != null) want = side > 0 ? Math.max(want, st.stop) : Math.min(want, st.stop); // never loosen
    want = roundPrice(want, byId[id]);
    if (st.stop == null || Math.abs(want - st.stop) / st.stop * 100 >= MIN_STOP_STEP_PCT) { st.stop = want; changed = true; }
  }

  // ---------- one pass over the live prices ----------
  function step() {
    auto = true;
    try { stepAll(); } finally { auto = false; }
  }

  // a TWAP fills evenly over its time, at the market's price as long as that is within its limit
  const TWAP_FEE = 0.0001; // Lighter's standard plan
  function stepTwap(o, p, m, pos) {
    const t0 = now(), done = Math.min(1, (t0 - o.start) / (o.end - o.start));
    let due = roundSize(o.total * done - (o.total - o.remaining), m);
    if (t0 >= o.end) due = o.remaining;
    const price = (o.is_ask ? p.bid : p.ask) || p.mark;
    const within = o.is_ask ? price >= o.price : price <= o.price;
    if (due >= 10 ** -m.size_decimals && due * price >= 1 && within) {
      let qty = (o.is_ask ? -1 : 1) * Math.min(due, o.remaining);
      if (o.reduce_only) qty = pos && Math.sign(pos.size) !== Math.sign(qty) ? Math.sign(qty) * Math.min(Math.abs(qty), Math.abs(pos.size)) : 0;
      if (qty) {
        try {
          if (!o.reduce_only) checkMargin(o.market_id, qty, price);
          fill(o.market_id, qty, price, "taker", o.order_index);
          S.cash -= Math.abs(qty) * price * TWAP_FEE;
          o.remaining = roundSize(o.remaining - Math.abs(qty), m);
          changed = true;
        } catch { o.remaining = 0; note(t("Paper: TWAP su {sym} fermato: margine insufficiente", { sym: m.symbol }), "error"); }
      }
    }
    if (t0 >= o.end || o.remaining < 10 ** -m.size_decimals) {
      S.orders.splice(S.orders.indexOf(o), 1);
      changed = true;
      note(t("Paper: TWAP su {sym} finito", { sym: m.symbol }));
    }
  }

  function stepAll() {
    for (const o of [...S.orders]) {
      const p = px(o.market_id), m = byId[o.market_id];
      if (!p || !m || !S.orders.includes(o)) continue;
      const pos = S.positions[o.market_id];
      if (o.type === "limit") {
        if (o.chase) {
          if (o.chase.until && now() >= o.chase.until) { // time up: cancelled, or what's left at market
            S.orders.splice(S.orders.indexOf(o), 1);
            changed = true;
            const closes = o.reduce_only && (!pos || Math.sign(pos.size) === (o.is_ask ? -1 : 1));
            if (o.chase.then_market && !closes) {
              const size = o.reduce_only ? Math.min(o.remaining, Math.abs(pos.size)) : o.remaining, at = o.is_ask ? p.bid : p.ask;
              fill(o.market_id, (o.is_ask ? -1 : 1) * size, at, "taker");
              note(t("Paper: chase scaduto, {size} {sym} a market", { size, sym: m.symbol }));
            } else note(t("Paper: chase scaduto, {size} {sym} non eseguiti", { size: o.remaining, sym: m.symbol }));
            continue;
          }
          const best = o.is_ask ? p.ask : p.bid, target = best && roundPrice(chaseTarget(best, o.is_ask, o.chase.cap), m);
          if (target && target !== o.price) { o.price = target; changed = true; save(); }
        }
        // a chase sits at the best price: it fills when a trade reaches it
        const hit = o.is_ask ? p.bid && p.bid >= o.price : p.ask && p.ask <= o.price;
        const traded = o.chase && now() - o.ts > 1500 && p.last && (o.is_ask ? p.last >= o.price : p.last <= o.price);
        if (!hit && !traded) continue;
        let qty = (o.is_ask ? -1 : 1) * o.remaining;
        S.orders.splice(S.orders.indexOf(o), 1);
        if (o.reduce_only) {
          if (!pos || Math.sign(pos.size) === Math.sign(qty)) { changed = true; continue; }
          qty = Math.sign(qty) * Math.min(Math.abs(qty), Math.abs(pos.size));
        }
        fill(o.market_id, qty, o.price, "maker", o.order_index);
        if (!o.reduce_only) {
          addTriggers(o.market_id, !o.is_ask, o.sl, o.tp);
          addExits(o.market_id, !o.is_ask, o.exits, o.be);
          if (o.trail) setStop(o.market_id, o.trail);
        }
        note(t("Paper: limit eseguito {side} {size} {sym} a {price}", { side: o.is_ask ? "sell" : "buy", size: Math.abs(qty), sym: m.symbol, price: fp(o.price, m) }));
        if (o.ice && o.ice.left > 0) { // the next slice shows only now
          o.working.filled = roundSize(o.ice.total - o.ice.left, m);
          S.orders.push(nextSlice(o, m));
          changed = true;
          save();
        }
        continue;
      }
      if (o.type === "twap") { stepTwap(o, p, m, pos); continue; }
      if (o.cond) { // a conditional order: when the mark gets there, a market order or a resting limit
        const isStop = /^stop/.test(o.type), below = isStop === o.is_ask;
        if (!(below ? p.mark <= o.trigger_price : p.mark >= o.trigger_price)) continue;
        changed = true;
        if (/limit$/.test(o.type)) { Object.assign(o, { type: "limit", trigger_price: 0, cond: false }); continue; }
        S.orders.splice(S.orders.indexOf(o), 1);
        let qty = (o.is_ask ? -1 : 1) * o.remaining;
        if (o.reduce_only) {
          if (!pos || Math.sign(pos.size) === Math.sign(qty)) continue;
          qty = Math.sign(qty) * Math.min(Math.abs(qty), Math.abs(pos.size));
        }
        const price = replayFill ? replayFill(o.trigger_price, p.mark) : (o.is_ask ? p.bid : p.ask) || p.mark;
        try {
          if (!o.reduce_only) checkMargin(o.market_id, qty, price);
          fill(o.market_id, qty, price, "taker", o.order_index);
          note(t("Paper: condizionale eseguito {side} {size} {sym} a {price}", { side: o.is_ask ? "sell" : "buy", size: Math.abs(qty), sym: m.symbol, price: fp(price, m) }));
        } catch (e) { note(e.message, "error"); }
        continue;
      }
      // SL/TP: reduce-only triggers on the mark price; gone once there is nothing left to close
      if (!pos || Math.sign(pos.size) !== (o.is_ask ? 1 : -1)) { S.orders.splice(S.orders.indexOf(o), 1); changed = true; continue; }
      const isSl = o.type === "stop-loss", below = isSl === o.is_ask;
      if (!(below ? p.mark <= o.trigger_price : p.mark >= o.trigger_price)) continue;
      S.orders.splice(S.orders.indexOf(o), 1);
      const price = replayFill ? replayFill(o.trigger_price, p.mark) : (o.is_ask ? p.bid : p.ask) || p.mark;
      // a sized trigger (a scaled exit) closes its part; a position-tied one the whole position
      fill(o.market_id, o.remaining ? -Math.sign(pos.size) * Math.min(o.remaining, Math.abs(pos.size)) : -pos.size, price, "taker", o.order_index);
      note(t(isSl ? "Paper: stop-loss eseguito su {sym} a {price}" : "Paper: take-profit eseguito su {sym} a {price}", { sym: m.symbol, price: fp(price, m) }), isSl ? "warning" : "info");
      if (!isSl) exitFilled(o.market_id, o.order_index);
    }
    for (const [id, s] of Object.entries(S.stops)) {
      if (S.positions[id]) stepStop(id, s);
      else if (s.state && s.state.side) delete S.stops[id]; // the position it managed has closed
    }
    // hourly funding at the current rate (% per hour, positive: longs pay shorts)
    const hour = Math.floor(now() / 3600000);
    if (hour > S.hour) {
      const hours = Math.min(hour - S.hour, 24 * 30);
      for (const [id, pos] of Object.entries(S.positions)) {
        const p = px(id);
        if (!p || !p.mark || !p.funding) continue;
        const pay = pos.size * p.mark * p.funding / 100 * hours;
        S.cash -= pay;
        pos.funding = (pos.funding || 0) - pay;
      }
      S.hour = hour;
      changed = true;
    }
    stepPairs();
    stepEvents();
    // liquidation: an isolated position when its own margin is used up; the cross ones together when the
    // account's (cross) equity falls to their maintenance requirement
    let acc = account();
    for (const p of acc.positions.filter((x) => !x.cross)) {
      const mark = markOf(p.market_id);
      if (mark && p.margin + p.upnl <= Math.abs(p.size) * mark * byId[p.market_id].mmf) {
        fill(p.market_id, -p.size, mark, "taker");
        note(t("Paper: {sym} isolated liquidato al prezzo mark", { sym: byId[p.market_id].symbol }), "error");
      }
    }
    acc = account();
    const cross = acc.positions.filter((x) => x.cross);
    if (cross.length && acc.cross_value <= acc.maintenance) {
      for (const p of cross) fill(p.market_id, -p.size, markOf(p.market_id) || p.entry, "taker");
      S.orders = S.orders.filter((o) => o.type === "limit" && !o.reduce_only);
      note(t("Paper: account liquidato, posizioni chiuse al prezzo mark"), "error");
    }
  }

  // ---------- replaying the time away from candles ----------
  async function catchUp() {
    const gap = Date.now() - S.seen;
    const ids = [...new Set([...Object.keys(S.positions), ...S.orders.map((o) => String(o.market_id))])].filter((id) => byId[id]);
    if (gap < 20000 || !ids.length) { S.seen = Date.now(); return 0; }
    const [res, secs] = gap <= 16 * 3600000 ? ["1m", 60] : gap <= 10 * 86400000 ? ["15m", 900] : ["1h", 3600];
    const count = Math.min(1000, Math.ceil(gap / 1000 / secs) + 2);
    const series = await Promise.all(ids.map((id) => fetch(`/api/candles?market_id=${id}&resolution=${res}&count=${count}`)
      .then((r) => (r.ok ? r.json() : [])).catch(() => [])));
    const from = Math.floor(S.seen / 1000) - secs;
    const byTime = new Map();
    series.forEach((bars, i) => {
      for (const b of bars) if (b.time >= from) (byTime.get(b.time) || byTime.set(b.time, []).get(b.time)).push([ids[i], b]);
    });
    const before = S.trades.length ? S.trades[0].ts : 0;
    replay = { at: S.seen };
    for (const id of ids) { const p = prices[id] || {}; replay[id] = { mark: p.mark, bid: p.mark, ask: p.mark, funding: p.funding }; }
    try {
      for (const time of [...byTime.keys()].sort((a, b) => a - b)) {
        for (const [id, b] of byTime.get(time)) {
          // inside a bar: open, the nearer extreme, the other one, close
          const path = b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
          path.forEach((v, k) => {
            replay[id] = { mark: v, bid: v, ask: v, funding: (prices[id] || {}).funding };
            replay.at = Math.max(S.seen, (time + secs * k / 4) * 1000);
            replayFill = (level, at) => (k === 0 ? at : level);
            step();
          });
        }
      }
    } finally { replay = null; replayFill = null; }
    S.seen = Date.now();
    save();
    return S.trades.filter((x) => x.ts > before).length;
  }

  // ---------- the /api calls it answers ----------
  function route(path, opts = {}) {
    const [p, q = ""] = path.split("?");
    const qs = new URLSearchParams(q);
    const method = (opts.method || "GET").toUpperCase();
    const body = () => JSON.parse(opts.body || "{}");
    const run = (fn) => { try { const r = fn(); save(); return Promise.resolve(r); } catch (e) { return Promise.reject(e); } };
    if (p === "/preview" && method === "POST") return run(() => { try { return { ok: true, ...plan(body(), qs.get("live") !== "true") }; } catch (e) { return { ok: false, error: e.message }; } });
    if (p === "/order" && method === "POST") return run(() => placeOrder(body()));
    if (p === "/pair_order" && method === "POST") return run(() => pairOrder(body()));
    if (p === "/basket" && method === "POST") return run(() => basketOrder(body()));
    if (p === "/rules" && method === "GET") return run(() => S.rules.map((r) => ({ ...r, description: describe(r) })));
    if (p === "/rules" && method === "POST") return run(() => addRule(body()));
    const rule = p.match(/^\/rules\/(.+)$/);
    if (rule && method === "DELETE") return run(() => { S.rules = S.rules.filter((r) => r.id !== decodeURIComponent(rule[1])); changed = true; return { ok: true }; });
    if (rule && method === "PATCH") return run(() => { const r = S.rules.find((x) => x.id === decodeURIComponent(rule[1])); if (r) Object.assign(r, body()); return r; });
    if (p === "/pairs" && method === "GET") return run(pairs);
    if (p === "/pairs" && method === "POST") return run(() => {
      const b = body(), size = (id) => (S.positions[id] ? S.positions[id].size : 0);
      if (!(size(b.long_id) > 0 && size(b.short_id) < 0)) err(t("Serve una posizione long e una short aperte"));
      const l = S.positions[b.long_id], s = S.positions[b.short_id], taken = {};
      for (const p of pairs()) { taken[p.long_id] = (taken[p.long_id] || 0) + p.long_qty; taken[p.short_id] = (taken[p.short_id] || 0) + p.short_qty; }
      const lq = l.size - (taken[b.long_id] || 0), sq = -s.size - (taken[b.short_id] || 0);
      if (lq <= 1e-12 || sq <= 1e-12) err(t("Queste posizioni sono già tutte in coppia"));
      addPair(b.long_id, b.short_id, lq, sq, l.entry, s.entry);
      return pairs();
    });
    const pairStops = p.match(/^\/pairs\/(.+)\/stops$/);
    if (pairStops && method === "PUT") return run(() => setPairStops(decodeURIComponent(pairStops[1]), body()));
    const pairClose = p.match(/^\/pairs\/(.+)\/close$/);
    if (pairClose && method === "POST") return run(() => closePair(decodeURIComponent(pairClose[1]), +qs.get("fraction") || 1));
    const pairDel = p.match(/^\/pairs\/(.+)$/);
    if (pairDel && method === "DELETE") return run(() => { S.pairs = S.pairs.filter((x) => x.id !== decodeURIComponent(pairDel[1])); return pairs(); });
    if (p === "/reverse" && method === "POST") return run(() => reversePosition(+qs.get("market_id")));
    if (p === "/close" && method === "POST") return run(() => closePosition(+qs.get("market_id"), +qs.get("fraction") || 1));
    if (p === "/cancel_order" && method === "POST") return run(() => cancelOrder(+qs.get("market_id"), +qs.get("order_index")));
    if (p === "/cancel_all" && method === "POST") return run(() => { S.orders = []; changed = true; return { ok: true }; });
    if (p === "/move_order" && method === "POST") return run(() => moveOrder(body()));
    if (p === "/position_sltp" && method === "POST") return run(() => positionSltp(body()));
    if (p === "/leverage" && method === "POST") return run(() => setLeverage(+qs.get("market_id"), +qs.get("leverage"), qs.get("cross") !== "false"));
    if (p === "/open_orders") return run(() => S.orders.map(({ sl, tp, trail, post_only, ts, ...o }) => ({ ...o, symbol: byId[o.market_id] ? byId[o.market_id].symbol : String(o.market_id),
      remaining: o.remaining || Math.abs((S.positions[o.market_id] || {}).size || 0) })));
    if (p === "/trades") return run(() => (qs.has("market_id") ? S.trades.filter((x) => x.market_id === +qs.get("market_id")) : S.trades).slice(0, 100));
    const trail = p.match(/^\/trail\/(\d+)$/);
    if (trail && method === "PUT") return run(() => {
      if (!S.positions[trail[1]]) err(t("Nessuna posizione"));
      setStop(trail[1], body());
      return { stops: stops(), armed: true };
    });
    if (trail && method === "DELETE") return run(() => { setStop(trail[1], null); return { stops: stops(), armed: true }; });
    return undefined; // not a trading call: the server answers it
  }

  return {
    on: false,
    route, account, stops, exits, catchUp, plan,
    tick() { // once a second with the live prices; true when orders or positions changed
      changed = false;
      step();
      S.seen = Date.now();
      save();
      return changed;
    },
    logs: (after) => S.logs.filter((l) => l.seq > after),
    summary: () => ({ balance: S.balance, start: S.start, trades: S.trades.length, equity: account().total_value }),
    reset(balance) { S = fresh(balance); save(); },
  };
})();
