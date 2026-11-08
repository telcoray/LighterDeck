"use strict";
// Live trading with the API key kept in this browser: orders are signed here by Lighter's own signer
// (signer/, WebAssembly) and sent straight to Lighter, so the key never reaches LighterDeck's server.
// It answers the same /api calls the server would (like paper.js), so the rest of the app is unchanged.
// Trailing stops, breakeven, scaled exits and event trades have to run with the page closed: they go to
// the visitor's engine on the server (backend/users.py), which signs with a second, dedicated key the
// visitor hands over when turning automations on. Pairs aren't there yet.
const Live = (() => {
  const STORE = "ld.live.key";
  const URL_ = "https://mainnet.zklighter.elliot.ai";
  const CHAIN_ID = 304; // mainnet
  const SLIP = 0.005;   // worst-price margin of closes and SL/TP, as the server's MAX_SLIPPAGE_PCT
  const ORDERS_TTL = 4000;
  // order types and time in force, as the signer numbers them
  const LIMIT = 0, MARKET = 1, STOP_LOSS = 2, STOP_LOSS_LIMIT = 3, TAKE_PROFIT = 4, TAKE_PROFIT_LIMIT = 5, TWAP = 6;
  const IOC = 0, GTT = 1, POST_ONLY = 2;
  const OTO = 1, OTOCO = 3;

  let cred = null;          // { account_index, api_key_index, key }
  let ready = null;         // the signer, once loaded
  let acc = null, accAt = 0, timer = null;
  let nonce = null, queue = Promise.resolve();
  let auth = { token: null, until: 0 };
  let fees = null, feesAt = 0; // this account's own rates (its plan, not the market's listing)
  const orders = {};        // market -> { at, list }
  const logs = [];
  let seq = 0, changed = false;
  // the visitor's automations on the server: { on, api_key_index, armed, stops, exits }
  let auto = { on: false }, autoSeq = 0, autoTimer = null;

  const err = (msg) => { throw new Error(msg); };
  const mkt = (id) => byId[id] || err(t("Mercato sconosciuto"));
  const note = (msg, level = "info") => { logs.push({ seq: ++seq, ts: Date.now() / 1000, msg, level }); if (logs.length > 200) logs.shift(); };

  // ---------- units: display <-> the integers the signer takes ----------
  const realSizeDec = (m) => m.size_decimals - (m.multiplier < 1 ? 1 : 0);
  const realPriceDec = (m) => m.price_decimals - (m.multiplier > 1 ? 1 : 0);
  const sizeInt = (m, size) => Math.round(Math.abs(size) / m.multiplier * 10 ** realSizeDec(m));
  const priceInt = (m, price) => Math.round(price * m.multiplier * 10 ** realPriceDec(m));
  const roundPrice = (m, p) => +p.toFixed(m.price_decimals);
  const dispPrice = (m, real) => +real / (m ? m.multiplier : 1);
  const dispSize = (m, real) => +real * (m ? m.multiplier : 1);
  const coi = () => Date.now() % 2 ** 47;

  // ---------- Lighter's REST API ----------
  async function get(path, params = {}, withAuth = false) {
    const r = await fetch(`${URL_}/api/v1/${path}?${new URLSearchParams(params)}`, withAuth ? { headers: { authorization: await token() } } : {});
    const body = await r.json().catch(() => ({}));
    if (!r.ok || (body.code && body.code !== 200)) throw new Error(body.message || `${path}: ${r.status}`);
    return body;
  }

  async function token() {
    if (auth.token && Date.now() < auth.until - 60000) return auth.token;
    const until = Date.now() + 10 * 60000;
    const r = sign("CreateAuthToken", Math.floor(until / 1000));
    auth = { token: r.authToken, until };
    return auth.token;
  }

  // the visitor's automations on LighterDeck's server: who is asking is proven with a Lighter auth token
  async function server(path, opts = {}) {
    const r = await fetch("/api/u" + path, { ...opts, headers: { "Content-Type": "application/json", "X-Lang": LANG, "X-Lighter-Auth": await token() } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || r.statusText);
    return body;
  }

  async function pollAuto() {
    if (!info.browser_automations || !cred) return;
    const st = await server(`/status?after=${autoSeq}`);
    for (const l of st.logs || []) { autoSeq = Math.max(autoSeq, l.seq); logs.push({ seq: ++seq, ts: l.ts, msg: l.msg, level: l.level }); }
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    const was = JSON.stringify(auto);
    auto = { on: !!st.on, api_key_index: st.api_key_index, armed: !!st.armed, stops: st.stops || {}, exits: st.exits || {} };
    if (JSON.stringify(auto) !== was) changed = true;
  }

  const needAuto = () => { if (!auto.on) err(t("Attiva le automazioni (pill dell'account → Automazioni) per usare trailing, TP multipli ed eventi.")); };

  // ---------- the signer ----------
  async function loadSigner() {
    if (!ready) ready = (async () => {
      await new Promise((ok, ko) => {
        if (window.Go) return ok();
        const s = document.createElement("script");
        s.src = "/signer/wasm_exec.js";
        s.onload = ok;
        s.onerror = () => ko(new Error(t("Impossibile caricare il firmatario di Lighter")));
        document.head.appendChild(s);
      });
      const res = await fetch("/signer/lighter-signer.wasm.gz");
      if (!res.ok) throw new Error(t("Impossibile caricare il firmatario di Lighter"));
      const bytes = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      const go = new Go();
      const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
      go.run(instance); // registers CreateClient, SignCreateOrder, … on window
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  // every Sign* function ends with (…, nonce, apiKeyIndex, accountIndex); CreateAuthToken with the last two
  function sign(fn, ...args) {
    const r = window[fn](...args, cred.api_key_index, cred.account_index);
    if (!r || r.error) err(r ? r.error : t("Firma non riuscita"));
    return r;
  }

  // one transaction at a time, each with the next nonce; after a failure the nonce is asked again
  function send(build) {
    const run = queue.then(async () => {
      if (nonce === null) nonce = (await get("nextNonce", { account_index: cred.account_index, api_key_index: cred.api_key_index })).nonce;
      try {
        const tx = build(nonce);
        const r = await fetch(`${URL_}/api/v1/sendTx`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ tx_type: tx.txType, tx_info: tx.txInfo }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body.code !== 200) err(body.message || `sendTx: ${r.status}`);
        nonce++;
        changed = true;
        return body;
      } catch (e) {
        nonce = null;
        throw e;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // ---------- orders, as the server's lighter_api.py builds them ----------
  const createOrder = (m, o) => send((n) => sign("SignCreateOrder", m.id, o.coi, o.base, o.price, o.isAsk ? 1 : 0, o.type, o.tif,
    o.reduce ? 1 : 0, o.trigger || 0, o.expiry, 0, 0, 0, 0, 0, 0, n));

  function marketOrder(m, size, ref, reduce = false, slip = SLIP) {
    const isAsk = size < 0, worst = roundPrice(m, ref * (isAsk ? 1 - slip : 1 + slip));
    return createOrder(m, { coi: coi(), base: sizeInt(m, size), price: priceInt(m, worst), isAsk, type: MARKET, tif: IOC, reduce, expiry: 0 });
  }

  function limitOrder(m, size, price, reduce = false, post = false) {
    return createOrder(m, { coi: coi(), base: sizeInt(m, size), price: priceInt(m, roundPrice(m, price)), isAsk: size < 0, type: LIMIT,
      tif: post ? POST_ONLY : GTT, reduce, expiry: -1 });
  }

  // the opening order with exchange-native SL/TP attached (OTO / OTOCO): position-tied, Lighter cancels
  // them when the position closes or flips
  function entry(m, size, kind, price, sl, tp, slip, post) {
    const isAsk = size < 0, c = coi();
    const tif = kind === "market" ? IOC : post ? POST_ONLY : GTT;
    const list = [{ MarketIndex: m.id, ClientOrderIndex: c, BaseAmount: sizeInt(m, size), Price: priceInt(m, roundPrice(m, price)),
      IsAsk: isAsk ? 1 : 0, Type: kind === "market" ? MARKET : LIMIT, TimeInForce: tif, ReduceOnly: 0, TriggerPrice: 0, OrderExpiry: kind === "market" ? 0 : -1 }];
    for (const [trigger, type] of [[tp, TAKE_PROFIT], [sl, STOP_LOSS]]) {
      if (!trigger) continue;
      const worst = isAsk ? trigger * (1 + slip) : trigger * (1 - slip);
      list.push({ MarketIndex: m.id, ClientOrderIndex: c + list.length, BaseAmount: 0, Price: priceInt(m, roundPrice(m, worst)),
        IsAsk: isAsk ? 0 : 1, Type: type, TimeInForce: IOC, ReduceOnly: 1, TriggerPrice: priceInt(m, roundPrice(m, trigger)), OrderExpiry: -1 });
    }
    if (list.length === 1) {
      const o = list[0];
      return createOrder(m, { coi: c, base: o.BaseAmount, price: o.Price, isAsk, type: o.Type, tif, reduce: false, expiry: o.OrderExpiry });
    }
    return send((n) => sign("SignCreateGroupedOrders", list.length === 3 ? OTOCO : OTO, list, 0, 0, 0, 0, 0, 0, n));
  }

  function stopOrder(m, posSize, trigger, kind) {
    const isAsk = posSize > 0, worst = roundPrice(m, trigger * (isAsk ? 1 - SLIP : 1 + SLIP));
    return createOrder(m, { coi: coi(), base: sizeInt(m, posSize), price: priceInt(m, worst), isAsk, type: kind === "sl" ? STOP_LOSS : TAKE_PROFIT,
      tif: IOC, reduce: true, trigger: priceInt(m, roundPrice(m, trigger)), expiry: -1 });
  }

  const modifyOrder = (m, oi, size, price, trigger = 0) => send((n) => sign("SignModifyOrder", m.id, oi, sizeInt(m, size),
    priceInt(m, roundPrice(m, price)), trigger ? priceInt(m, roundPrice(m, trigger)) : 0, 0, 0, 0, 0, 0, 0, n, 0));
  const cancelOrder = (m, oi) => send((n) => sign("SignCancelOrder", m.id, oi, 0, n));
  const cancelAll = () => send((n) => sign("SignCancelAllOrders", 0, 0, 255, 0, n));
  const updateLeverage = (m, lev, cross) => send((n) => sign("SignUpdateLeverage", m.id, Math.floor(10000 / lev), cross ? 0 : 1, 0, n));

  // ---------- reads ----------
  async function refresh() {
    const data = await get("account", { by: "index", value: cred.account_index });
    const a = data.accounts[0];
    const positions = [], settings = {};
    for (const p of a.positions || []) {
      const m = byId[p.market_id];
      const size = +p.position * (p.sign >= 0 ? 1 : -1), imf = +(p.initial_margin_fraction || 0);
      if (imf) settings[p.market_id] = { leverage: +(100 / imf).toFixed(1), cross: (p.margin_mode || 0) === 0 };
      if (!size) continue;
      positions.push({
        market_id: p.market_id, symbol: p.symbol, size: dispSize(m, size), entry: dispPrice(m, p.avg_entry_price),
        value: +p.position_value, upnl: +p.unrealized_pnl, rpnl: +(p.realized_pnl || 0), liq: dispPrice(m, p.liquidation_price || 0),
        margin: +(p.allocated_margin || 0), leverage: imf ? +(100 / imf).toFixed(1) : null, cross: (p.margin_mode || 0) === 0,
      });
    }
    const next = { index: cred.account_index, collateral: +(a.collateral || 0), available: +(a.available_balance || 0),
      total_value: +(a.total_asset_value || 0), positions, settings, fees,
      cross_value: a.cross_asset_value != null ? +a.cross_asset_value : null,
      initial: a.cross_initial_margin_requirement != null ? +a.cross_initial_margin_requirement : null,
      maintenance: a.cross_maintenance_margin_requirement != null ? +a.cross_maintenance_margin_requirement : null };
    refreshFees();
    if (acc && JSON.stringify(acc.positions) !== JSON.stringify(positions)) changed = true;
    acc = next;
    accAt = Date.now();
    return acc;
  }

  // one fee tick is 1/1,000,000 (premium's 280 ticks are 0.028%); asked every 10 minutes
  async function refreshFees() {
    if (Date.now() - feesAt < 600000) return;
    feesAt = Date.now();
    try {
      const d = await get("accountLimits", { account_index: cred.account_index }, true);
      fees = { taker: d.current_taker_fee_tick / 1e6, maker: d.current_maker_fee_tick / 1e6, tier: d.user_tier_name || d.user_tier };
      if (acc) acc = { ...acc, fees };
      changed = true;
    } catch {} // the ticket falls back on the market's listed fees
  }

  async function activeOrders(id, fresh = false) {
    const hit = orders[id];
    if (!fresh && hit && Date.now() - hit.at < ORDERS_TTL) return hit.list;
    const m = byId[id];
    const data = await get("accountActiveOrders", { account_index: cred.account_index, market_id: id }, true);
    const list = (data.orders || []).map((o) => ({
      order_index: o.order_index, client_order_index: o.client_order_index, market_id: o.market_index, is_ask: o.is_ask, type: o.type,
      price: dispPrice(m, o.price), trigger_price: dispPrice(m, o.trigger_price || 0), remaining: dispSize(m, o.remaining_base_amount),
      reduce_only: o.reduce_only, status: o.status, symbol: m ? m.symbol : String(id),
    }));
    orders[id] = { at: Date.now(), list };
    return list;
  }

  // realized PnL of each fill from the position before it (the server's realized_pnl, see lighter_api.py)
  function realizedPnl(fills, positions) {
    const after = { ...positions };
    return fills.map((f) => {
      let signed = (after[f.market_id] || 0) - f.side * f.size;
      if (Math.abs(Math.abs(signed) - f.before) > Math.max(1e-9, f.before * 1e-6)) signed = Math.sign(signed || -f.side) * f.before;
      after[f.market_id] = signed;
      if (f.self_trade || f.before <= 0 || signed * f.side > 0) return null;
      const closed = Math.min(f.size, f.before), entryPx = f.entry_quote / f.before;
      return +((signed > 0 ? 1 : -1) * closed * (f.price - entryPx)).toFixed(6);
    });
  }

  async function trades(marketId) {
    const params = { account_index: cred.account_index, sort_by: "timestamp", limit: 100 };
    if (marketId !== null) params.market_id = marketId;
    const raw = (await get("trades", params, true)).trades || [];
    const fills = [];
    const out = raw.map((x) => {
      const buyer = x.bid_account_id === cred.account_index, m = byId[x.market_id];
      const role = x.is_maker_ask !== buyer ? "maker" : "taker";
      fills.push({ market_id: x.market_id, side: buyer ? 1 : -1, size: +x.size, price: +x.price, before: +(x[`${role}_position_size_before`] || 0),
        entry_quote: +(x[`${role}_entry_quote_before`] || 0), self_trade: x.bid_account_id === x.ask_account_id });
      return { ts: x.timestamp, market_id: x.market_id, symbol: m ? m.symbol : String(x.market_id), order_id: buyer ? x.bid_id : x.ask_id,
        side: buyer ? "buy" : "sell", size: dispSize(m, x.size), price: dispPrice(m, x.price), usd: +x.usd_amount, role };
    });
    const real = {};
    for (const p of (acc || {}).positions || []) if (marketId === null || p.market_id === marketId) real[p.market_id] = p.size / (byId[p.market_id] || { multiplier: 1 }).multiplier;
    realizedPnl(fills, real).forEach((pnl, i) => (out[i].pnl = pnl));
    return out;
  }

  // ---------- the /api calls, as the server answers them ----------
  const position = (id) => ((acc || {}).positions || []).find((p) => p.market_id === +id);
  const quote = (id, side) => { const p = prices[id] || {}; return (side > 0 ? p.ask : p.bid) || p.mark || err(t("Nessun prezzo per questo mercato in questo momento")); };
  const plan = (o, checkSides) => Paper.plan(o, checkSides, { px: (id) => prices[id] || null, account: () => acc });
  const notYet = () => err(t("Le coppie non sono ancora disponibili con la chiave nel browser."));

  function sideError(price, below, mark, isSl) {
    if (mark && (below ? price >= mark : price <= mark)) {
      const what = isSl ? t("Lo stop-loss") : t("Il take-profit");
      err(t(below ? "{what} deve stare sotto il prezzo mark ({mark}), altrimenti scatterebbe subito" : "{what} deve stare sopra il prezzo mark ({mark}), altrimenti scatterebbe subito", { what, mark: +mark.toPrecision(10) }));
    }
  }

  async function placeOrder(o) {
    if (o.trail || o.tp_levels) needAuto();
    const pl = plan(o, true), m = mkt(o.market_id), signed = pl.size * pl.side;
    const before = (position(m.id) || {}).size || 0;
    if (o.kind === "conditional") { // waits for the mark, then a market order or a limit (lighter_api.conditional_order)
      const limit = o.cond_exec === "limit";
      await createOrder(m, { coi: coi(), base: sizeInt(m, signed), price: priceInt(m, roundPrice(m, pl.worst)), isAsk: signed < 0,
        type: pl.cond_stop ? (limit ? STOP_LOSS_LIMIT : STOP_LOSS) : (limit ? TAKE_PROFIT_LIMIT : TAKE_PROFIT), tif: limit ? GTT : IOC,
        reduce: !!o.reduce_only, trigger: priceInt(m, roundPrice(m, o.trigger_price)), expiry: -1 });
      note(`conditional ${o.side} ${pl.size} ${m.symbol} @ ${o.trigger_price}`, "warning");
      return { ok: true, size: pl.size, armed: auto.armed };
    }
    if (o.kind === "twap") { // Lighter splits it over the time, never past the price
      await createOrder(m, { coi: coi(), base: sizeInt(m, signed), price: priceInt(m, roundPrice(m, pl.worst)), isAsk: signed < 0, type: TWAP, tif: GTT,
        reduce: !!o.reduce_only, expiry: Date.now() + o.twap_minutes * 60000 });
      note(`twap ${o.side} ${pl.size} ${m.symbol} over ${o.twap_minutes}m`, "warning");
      return { ok: true, size: pl.size, armed: auto.armed };
    }
    if (o.kind === "scale") { // several limits, each its own transaction
      for (const [i, x] of pl.scale_levels.entries()) {
        try { await limitOrder(m, x.qty * pl.side, x.price, !!o.reduce_only, !!o.post_only); }
        catch (e) { err(t("Scale: {i} ordini su {n} inviati, poi: {err}", { i, n: pl.scale_levels.length, err: e.message })); }
      }
      note(`scale ${o.side} ${pl.size} ${m.symbol}, ${pl.scale_levels.length} orders`, "warning");
      return { ok: true, size: pl.size, armed: auto.armed };
    }
    if (o.reduce_only) {
      if (o.kind === "limit") await limitOrder(m, signed, o.price, true, o.post_only);
      else await marketOrder(m, signed, pl.ref, true, pl.slippage_bps / 10000);
    } else await entry(m, signed, o.kind, pl.worst, o.sl_price, o.tp_price, pl.slippage_bps / 10000, o.post_only);
    note(`${o.kind} ${o.side} ${pl.size} ${m.symbol} @ ~${pl.ref}` + (o.sl_price ? ` SL ${o.sl_price}` : "") + (o.tp_price ? ` TP ${o.tp_price}` : ""), "warning");
    // the order is on Lighter; the server's engine takes over what follows it
    const after = [];
    if (pl.tp_levels) after.push(server("/exit_plan", { method: "POST", body: JSON.stringify({ market_id: m.id, levels: pl.tp_levels,
      be_after_tp1: o.be_after_tp1 !== false, before, size: signed }) }));
    if (o.trail) after.push(server(`/trail/${m.id}`, { method: "PUT", body: JSON.stringify(o.trail) }));
    try { await Promise.all(after); } catch (e) { err(t("Ordine inviato, ma le automazioni non sono partite: {err}", { err: e.message })); }
    if (after.length) pollAuto().catch(() => {});
    return { ok: true, size: pl.size, armed: auto.armed };
  }

  async function closePosition(id, fraction) {
    const pos = position(id) || err(t("Nessuna posizione")), m = mkt(id);
    const size = fraction >= 1 ? pos.size : +(pos.size * fraction).toFixed(m.size_decimals);
    await marketOrder(m, -size, quote(id, size > 0 ? -1 : 1), true);
    note(`close ${Math.round(Math.min(fraction, 1) * 100)}% ${m.symbol} (${size})`, "warning");
    return { ok: true };
  }

  // close and open the other side in one market order; the old side's SL/TP are cancelled after
  async function reversePosition(id) {
    const pos = position(id) || err(t("Nessuna posizione")), m = mkt(id);
    const old = (await activeOrders(id, true)).filter((o) => o.reduce_only && o.trigger_price);
    await marketOrder(m, -2 * pos.size, quote(id, pos.size > 0 ? -1 : 1), false);
    for (const o of old) await cancelOrder(m, o.order_index).catch(() => {}); // position-tied ones are gone with the flip
    delete orders[id];
    note(`reverse ${m.symbol}: ${pos.size} -> ${-pos.size}`, "warning");
    return { ok: true, size: -pos.size };
  }

  async function moveOrder({ market_id, order_index, price }) {
    const m = mkt(market_id);
    const o = (await activeOrders(market_id, true)).find((x) => x.order_index === +order_index) || err(t("Ordine non trovato: forse è già stato eseguito o annullato"));
    price = roundPrice(m, price);
    if (price <= 0) err(t("Prezzo non valido"));
    if (o.type === "twap") err(t("Un TWAP non si sposta: annullalo e inviane un altro"));
    const p = prices[market_id] || {};
    if (o.trigger_price) {
      const isSl = /stop/.test(o.type);
      sideError(price, isSl === o.is_ask, p.mark, isSl); // a reduce-only sell closes a long: its SL sits below
      await modifyOrder(m, o.order_index, o.remaining, o.price ? o.price * price / o.trigger_price : price, price);
    } else {
      if ((!o.is_ask && p.ask && price >= p.ask) || (o.is_ask && p.bid && price <= p.bid)) err(t("Il limite attraverserebbe il prezzo e verrebbe eseguito subito"));
      await modifyOrder(m, o.order_index, o.remaining, price);
    }
    delete orders[market_id];
    return { ok: true, price };
  }

  async function positionSltp({ market_id, kind, price, order_index }) {
    const m = mkt(market_id);
    if (order_index !== null && order_index !== undefined) {
      if (price) return moveOrder({ market_id, order_index, price });
      await cancelOrder(m, +order_index);
      delete orders[market_id];
      return { ok: true };
    }
    const pos = position(market_id) || err(t("Nessuna posizione"));
    price = roundPrice(m, price || 0);
    if (price <= 0) err(t("Prezzo non valido"));
    sideError(price, (kind === "sl") === pos.size > 0, (prices[market_id] || {}).mark, kind === "sl");
    await stopOrder(m, pos.size, price, kind);
    delete orders[market_id];
    return { ok: true, price };
  }

  async function setLeverage(id, lev, cross) {
    const m = mkt(id);
    if (!(lev >= 1) || (m.max_leverage && lev > m.max_leverage)) err(t("Leva fuori dai limiti del mercato"));
    await updateLeverage(m, lev, cross);
    note(`${m.symbol} leverage ${lev}x ${cross ? "cross" : "isolated"}`, "warning");
    return { ok: true };
  }

  function route(path, opts = {}) {
    const [p, q = ""] = path.split("?");
    const qs = new URLSearchParams(q);
    const method = (opts.method || "GET").toUpperCase();
    const body = () => JSON.parse(opts.body || "{}");
    const run = (fn) => { try { return Promise.resolve(fn()).then((r) => { if (method !== "GET") refresh().catch(() => {}); return r; }); } catch (e) { return Promise.reject(e); } };
    if (p === "/preview" && method === "POST") return run(() => { try { return { ok: true, ...plan(body(), qs.get("live") !== "true") }; } catch (e) { return { ok: false, error: e.message }; } });
    if (p === "/order" && method === "POST") return run(() => placeOrder(body()));
    if (p === "/close" && method === "POST") return run(() => closePosition(+qs.get("market_id"), +qs.get("fraction") || 1));
    if (p === "/reverse" && method === "POST") return run(() => reversePosition(+qs.get("market_id")));
    if (p === "/cancel_order" && method === "POST") return run(async () => { await cancelOrder(mkt(qs.get("market_id")), +qs.get("order_index")); delete orders[+qs.get("market_id")]; return { ok: true }; });
    if (p === "/cancel_all" && method === "POST") return run(async () => { await cancelAll(); for (const k in orders) delete orders[k]; note("cancelled all open orders", "warning"); return { ok: true }; });
    if (p === "/move_order" && method === "POST") return run(() => moveOrder(body()));
    if (p === "/position_sltp" && method === "POST") return run(() => positionSltp(body()));
    if (p === "/leverage" && method === "POST") return run(() => setLeverage(+qs.get("market_id"), +qs.get("leverage"), qs.get("cross") !== "false"));
    if (p === "/open_orders") return run(async () => {
      const ids = [...new Set((qs.get("market_ids") || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number))];
      return (await Promise.all(ids.map((id) => activeOrders(id, qs.get("fresh") === "true")))).flat();
    });
    if (p === "/trades") return run(() => trades(qs.has("market_id") ? +qs.get("market_id") : null));
    if (p === "/fills") return run(() => []);
    if (p === "/logs") return run(() => logs.slice());
    const auto_ = (fn) => run(async () => { needAuto(); const r = await fn(); await pollAuto().catch(() => {}); return r; });
    const trail = p.match(/^\/trail\/(\d+)$/);
    if (trail && method === "PUT") return auto_(() => server(`/trail/${trail[1]}`, { method: "PUT", body: opts.body }));
    if (trail && method === "DELETE") return auto_(() => server(`/trail/${trail[1]}`, { method: "DELETE" }));
    if (p === "/armed" && method === "POST") return auto_(() => server(`/armed?${q}`, { method: "POST" }));
    if (p === "/rules" && method === "GET") return run(() => (auto.on ? server("/rules") : []));
    if (p === "/rules" && method === "POST") return auto_(() => server("/rules", { method: "POST", body: opts.body }));
    const rule = p.match(/^\/rules\/(.+)$/);
    if (rule) return auto_(() => server(`/rules/${rule[1]}`, { method, body: opts.body }));
    if (p === "/pairs" && method === "GET") return run(() => []);
    if (["/pair_order", "/pairs"].includes(p) || /^\/pairs\//.test(p)) return run(notYet);
    return undefined; // market data: the server answers it
  }

  // ---------- connecting a key ----------
  // checked with Lighter before it is kept: the key index must be registered on the account and an
  // auth token signed with this key must be accepted
  async function connect(c, remember) {
    await loadSigner();
    const res = window.CreateClient(URL_, c.key.trim(), CHAIN_ID, c.api_key_index, c.account_index);
    if (res && res.error) err(res.error);
    const prev = cred;
    cred = { account_index: c.account_index, api_key_index: c.api_key_index, key: c.key.trim() };
    auth = { token: null, until: 0 };
    try {
      await get("apikeys", { account_index: cred.account_index, api_key_index: cred.api_key_index }).catch(() =>
        err(t("Questa API key non è registrata sull'account #{acc}", { acc: cred.account_index })));
      await get("accountActiveOrders", { account_index: cred.account_index, market_id: 0 }, true).catch(() =>
        err(t("Lighter non accetta questa chiave privata per l'API key #{idx}", { idx: cred.api_key_index })));
    } catch (e) {
      cred = prev;
      throw e;
    }
    nonce = null;
    try {
      localStorage.removeItem(STORE);
      sessionStorage.removeItem(STORE);
      (remember ? localStorage : sessionStorage).setItem(STORE, JSON.stringify(cred));
    } catch {}
    await start();
    note(`browser key #${cred.api_key_index} connected to account #${cred.account_index}`, "warning");
  }

  async function start() {
    Live.on = true;
    await refresh().catch(() => {});
    clearInterval(timer);
    timer = setInterval(() => refresh().catch(() => {}), 2000);
    auto = { on: false };
    autoSeq = 0;
    await pollAuto().catch(() => {});
    clearInterval(autoTimer);
    autoTimer = setInterval(() => pollAuto().catch(() => {}), 3000);
  }

  // automations: the dedicated key goes to the server once, encrypted there; off deletes it
  async function autoOn(apiKeyIndex, key) {
    await server("/key", { method: "POST", body: JSON.stringify({ api_key_index: apiKeyIndex, private_key: key }) });
    await pollAuto();
  }

  async function autoOff() {
    await server("/key", { method: "DELETE" });
    auto = { on: false };
    changed = true;
  }

  // a key saved on this device (or in this tab) reconnects on load, without asking Lighter again
  async function restore() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORE) || localStorage.getItem(STORE) || "null"); } catch {}
    if (!saved) return false;
    try {
      await loadSigner();
      const res = window.CreateClient(URL_, saved.key, CHAIN_ID, saved.api_key_index, saved.account_index);
      if (res && res.error) err(res.error);
    } catch { return false; }
    cred = saved;
    await start();
    return true;
  }

  function disconnect() {
    Live.on = false;
    clearInterval(timer);
    clearInterval(autoTimer);
    auto = { on: false };
    cred = acc = null;
    fees = null;
    feesAt = 0;
    nonce = null;
    auth = { token: null, until: 0 };
    for (const k in orders) delete orders[k];
    try { localStorage.removeItem(STORE); sessionStorage.removeItem(STORE); } catch {}
  }

  return {
    on: false,
    route, connect, restore, disconnect, autoOn, autoOff,
    auto: () => auto,
    saved: () => { try { return !!(sessionStorage.getItem(STORE) || localStorage.getItem(STORE)); } catch { return false; } },
    info: () => (cred ? { account_index: cred.account_index, api_key_index: cred.api_key_index } : null),
    account: () => acc,
    stale: () => !acc || Date.now() - accAt > 10000,
    logs: (after) => logs.filter((l) => l.seq > after),
    tick() { const c = changed; changed = false; return c; }, // true after an order or a position change
  };
})();
