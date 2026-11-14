// Real orders on Lighter's TESTNET through the browser-key path (frontend/live.js: signed in this page by Lighter's
// WebAssembly signer, sent straight to Lighter), with the same /api calls the ticket makes.
//
// Run a local instance on the testnet (LIGHTER_URL=https://testnet.zklighter.elliot.ai PUBLIC_MODE=1
// BROWSER_TRADING=1), connect a testnet API key in the page, then in the browser console:
//
//   await (await import("/tests/browser_testnet.js")).run()            every scenario
//   await (await import("/tests/browser_testnet.js")).run("limit")     only the ones named
//
// It refuses to run anywhere but on a testnet. Orders are the smallest each market accepts; everything on the
// account is cancelled and closed at the start, after each scenario and at the end ('history' alone only reads).
// Trailing, scaled exits, Chase and Iceberg run on the server with a second key: hand one over in the page
// (account pill, Automations) and they are tested too; without it those scenarios are skipped.
const AUTO = ["trailing", "scaled_exits", "chase", "iceberg"];
const SCENARIOS = ["account", "leverage", "margin_mode", "limit", "entry", "limit_exits", "conditional", "twap", "scale", "basket", "reverse", "rfq", "history", ...AUTO];
const READS = new Set(["history"]);

export async function run(...names) {
  if (typeof info === "undefined" || !info || info.network !== "testnet" || !/testnet/.test(info.lighter_url || "")) throw new Error("Refusing to run: this instance is not on a testnet.");
  if (!Live.on) throw new Error("Connect a testnet API key in the page first.");
  names = names.length ? names : SCENARIOS;
  const unknown = names.filter((n) => !SCENARIOS.includes(n));
  if (unknown.length) throw new Error(`Unknown: ${unknown.join(", ")}. Known: ${SCENARIOS.join(", ")}`);

  const results = [];
  let current = "setup";
  const say = (status, text, detail) => { results.push({ status, scenario: current, text, ...(detail !== undefined ? { detail } : {}) }); console.log(`${status} ${current}: ${text}`, detail ?? ""); };
  const check = (text, cond, detail) => { say(cond ? "PASS" : "FAIL", text, cond ? undefined : detail); return !!cond; };
  const note = (text) => say("INFO", text);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const got = await fn(); if (got || Date.now() >= end) return got; await sleep(1000); } };
  const post = (path, body) => api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

  // two markets with prices, the usual names first
  const want = ["BTC", "ETH", "SOL"];
  const mids = markets.filter((m) => prices[m.id] && prices[m.id].bid && prices[m.id].ask)
    .sort((a, b) => (want.includes(a.symbol) ? want.indexOf(a.symbol) : 9) - (want.includes(b.symbol) ? want.indexOf(b.symbol) : 9)).slice(0, 2).map((m) => m.id);
  if (!mids.length) throw new Error("No market has prices yet: wait a few seconds and run again.");
  const A = mids[0], mA = byId[A];
  const px = (id) => prices[id];
  const round = (m, p) => +p.toFixed(m.price_decimals);
  const size = (id, times = 1) => { const m = byId[id], step = 10 ** -m.size_decimals; return +(Math.ceil(Math.max(m.min_base, m.min_quote / px(id).mark) * 1.25 * times / step) * step).toFixed(m.size_decimals); };
  // the account as Lighter has it now: Live reads it again every 2 seconds
  const fresh = async () => { await sleep(2500); return Live.account(); };
  const position = async (id) => ((await fresh()).positions.find((p) => p.market_id === id) || {}).size || 0;
  const orders = (id) => api(`/open_orders?market_ids=${id}&fresh=true`);
  const setting = async (id) => ((await fresh()).settings || {})[id] || {};
  const flatten = async () => {
    try {
      if ((await Promise.all(mids.map(orders))).flat().length) { await post("/cancel_all"); await until(async () => !(await Promise.all(mids.map(orders))).flat().length, 15000); }
      for (const p of (await fresh()).positions) await post(`/close?market_id=${p.market_id}&fraction=1`).catch((e) => console.warn("cleanup", e.message));
      if (!(await until(async () => !(await fresh()).positions.length, 20000))) console.warn("could not close everything: check the testnet account");
    } catch (e) { console.warn("cleanup", e.message); }
  };

  // the server's engine for this account, Auto on
  const arm = async () => {
    if (!Live.auto().armed) await post("/armed?armed=true");
    return until(async () => Live.auto().armed, 10000);
  };
  const working = () => Object.keys(Live.auto().working || {});

  const tests = {
    async trailing() {
      if (!check("Auto turns on", await arm(), Live.auto())) return;
      const q = size(A);
      await post("/order", { market_id: A, side: "buy", kind: "market", size: q, unit: "base", slippage_bps: 100, trail: { mode: "pct", value: 2, activate_pct: 0 } });
      if (!check("the position opens", Math.abs((await until(() => position(A), 20000)) - q) < 1e-9, await position(A))) return;
      check("the server has the trailing for this market", await until(async () => (Live.auto().stops || {})[A], 15000), Live.auto().stops);
      const stop = await until(async () => (await orders(A)).find((x) => x.trigger_price && x.reduce_only && x.is_ask), 45000);
      if (check("the engine puts the stop on Lighter with the second key", stop, await orders(A))) {
        const dist = (px(A).mark - stop.trigger_price) / px(A).mark * 100;
        check("about 2% under the price", dist > 1.2 && dist < 2.8, dist);
      }
      await api(`/trail/${A}`, { method: "DELETE" });
      check("trailing removed from the server", await until(async () => !(Live.auto().stops || {})[A], 15000), Live.auto().stops);
      note(`after removing the trailing, its stop order ${(await orders(A)).some((x) => x.trigger_price) ? "stays on Lighter" : "is cancelled too"}`);
    },
    async scaled_exits() {
      if (!check("Auto is on", await arm(), Live.auto())) return;
      const q = size(A, 2.5), p1 = round(mA, px(A).mark * 1.05), p2 = round(mA, px(A).mark * 1.1);
      await post("/order", { market_id: A, side: "buy", kind: "market", size: q, unit: "base", slippage_bps: 100, tp_levels: [{ price: p1, pct: 50 }, { price: p2, pct: 50 }], be_after_tp1: true });
      if (!check("the position opens", Math.abs((await until(() => position(A), 20000)) - q) < 1e-9, await position(A))) return;
      const tps = await until(async () => { const got = (await orders(A)).filter((x) => x.trigger_price && x.reduce_only); return got.length === 2 ? got : null; }, 45000);
      if (!check("the engine places the two take-profits", tps, await orders(A))) return;
      const trig = tps.map((x) => x.trigger_price).sort((a, b) => a - b);
      check("at the two prices asked", Math.abs(trig[0] - p1) < 1e-9 && Math.abs(trig[1] - p2) < 1e-9, trig);
      const total = tps.reduce((s, x) => s + x.remaining, 0);
      check("together they close the whole position, each its share", Math.abs(total - q) < 10 ** -mA.size_decimals * 1.5 && tps.every((x) => x.remaining < q), tps.map((x) => x.remaining));
      check("the server lists the plan", (Live.auto().exits || {})[A], Live.auto().exits);
    },
    async chase() {
      if (!check("Auto is on", await arm(), Live.auto())) return;
      const q = size(A);
      await post("/order", { market_id: A, side: "buy", kind: "chase", size: q, unit: "base" });
      const o = await until(async () => working().length && (await orders(A)).find((x) => working().includes(String(x.client_order_index))), 30000);
      if (!o) {
        if (await position(A)) return check("the chase filled at once", true);
        return check("the chase puts an order on the book", false, [Live.auto().working, await orders(A)]);
      }
      const bid = px(A).bid;
      check("a buy rests near the best bid", !o.is_ask && Math.abs(o.price - bid) / bid < 0.003, [o.price, bid]);
      await post(`/cancel_order?market_id=${A}&order_index=${o.order_index}`);
      check("cancelling the order by hand ends the chase", await until(async () => !working().length, 60000), Live.auto().working);
      await sleep(4000);
      check("and nothing else is sent", !(await orders(A)).length, await orders(A));
    },
    async iceberg() {
      if (!check("Auto is on", await arm(), Live.auto())) return;
      const total = size(A, 4), price = round(mA, px(A).bid * 0.97);
      await post("/order", { market_id: A, side: "buy", kind: "iceberg", size: total, unit: "base", price, ice_slice: 50, post_only: true });
      const mine = await until(async () => { const got = await orders(A); return working().length && got.length ? got : null; }, 30000);
      if (!check("the first slice rests on the book", mine, [Live.auto().working, await orders(A)])) return;
      check("one slice only, smaller than the whole, at its price", mine.length === 1 && mine[0].remaining < total && Math.abs(mine[0].price - price) < 1e-9, mine);
      await post(`/cancel_order?market_id=${A}&order_index=${mine[0].order_index}`);
      check("cancelling the slice by hand ends the iceberg", await until(async () => !working().length, 60000), Live.auto().working);
      await sleep(4000);
      check("and no further slice is sent", !(await orders(A)).length, await orders(A));
    },
    async account() {
      const a = await fresh();
      check("account read, with Lighter's cross margin figures", a && a.cross_value !== null && a.initial !== null && a.maintenance !== null, a);
      check("nothing open: available is close to the value", Math.abs(a.available - a.total_value) <= Math.max(1, a.total_value * 0.02), [a.available, a.total_value]);
      check("the account's own fee rates are read", await until(async () => Live.account().fees, 10000), Live.account().fees);
    },
    async leverage() {
      for (const lev of [3.3, 10.5]) {
        if (mA.max_leverage && lev > mA.max_leverage) continue;
        await post(`/leverage?market_id=${A}&leverage=${lev}&cross=true`);
        check(`${lev}x is stored as ${lev}x`, await until(async () => (await setting(A)).leverage === lev, 15000), await setting(A));
      }
      if (mA.max_leverage > 12) {
        const ask = +(mA.max_leverage - 0.1).toFixed(1);
        await post(`/leverage?market_id=${A}&leverage=${ask}&cross=true`);
        await sleep(4000);
        note(`asked ${ask}x (maximum ${mA.max_leverage}x): Lighter stores ${(await setting(A)).leverage}x`);
      }
      await post(`/leverage?market_id=${A}&leverage=${Math.min(10, mA.max_leverage || 10)}&cross=true`);
    },
    async margin_mode() {
      const lev = Math.min(10, mA.max_leverage || 10);
      await post(`/leverage?market_id=${A}&leverage=${lev}&cross=false`);
      check("isolated with nothing open", await until(async () => (await setting(A)).cross === false, 15000), await setting(A));
      await post(`/leverage?market_id=${A}&leverage=${lev}&cross=true`);
      check("back to cross", await until(async () => (await setting(A)).cross === true, 15000), await setting(A));
      await post("/order", { market_id: A, side: "buy", kind: "limit", size: size(A), unit: "base", price: round(mA, px(A).bid * 0.97), post_only: true });
      await until(async () => (await orders(A)).length, 15000);
      let refused = null;
      try { await post(`/leverage?market_id=${A}&leverage=${lev}&cross=false`); } catch (e) { refused = e.message; }
      check("with an order resting, switching to isolated is refused", refused, "accepted");
      if (refused) note(`the words shown: ${refused}`);
    },
    async limit() {
      const q = size(A), price = round(mA, px(A).bid * 0.96);
      await post("/order", { market_id: A, side: "buy", kind: "limit", size: q, unit: "base", price, post_only: true });
      const o = await until(async () => (await orders(A)).find((x) => Math.abs(x.price - price) < 1e-9), 15000);
      if (!check("post-only limit rests on the book", o, await orders(A))) return;
      check("size and side as sent", Math.abs(o.remaining - q) < 1e-9 && !o.is_ask, o);
      const next = round(mA, px(A).bid * 0.97);
      await post("/move_order", { market_id: A, order_index: o.order_index, price: next });
      check("moved to the new price, same order", await until(async () => (await orders(A)).some((x) => x.order_index === o.order_index && Math.abs(x.price - next) < 1e-9), 15000), await orders(A));
      await post(`/cancel_order?market_id=${A}&order_index=${o.order_index}`);
      check("cancelled", await until(async () => !(await orders(A)).length, 15000), await orders(A));
    },
    async entry() {
      const q = size(A), sl = round(mA, px(A).mark * 0.9), tp = round(mA, px(A).mark * 1.1);
      await post("/order", { market_id: A, side: "buy", kind: "market", size: q, unit: "base", sl_price: sl, tp_price: tp, slippage_bps: 100 });
      const pos = await until(() => position(A), 20000);
      if (!check("the position opens", Math.abs(pos - q) < 1e-9, pos)) return;
      const prot = await until(async () => { const got = (await orders(A)).filter((x) => x.trigger_price); return got.length === 2 ? got : null; }, 20000);
      if (check("SL and TP are on the book, reduce-only", prot && prot.every((x) => x.reduce_only && x.is_ask), await orders(A))) {
        const trig = prot.map((x) => x.trigger_price).sort((a, b) => a - b);
        check("at the prices asked", Math.abs(trig[0] - sl) < 1e-9 && Math.abs(trig[1] - tp) < 1e-9, trig);
        const stop = prot.find((x) => Math.abs(x.trigger_price - sl) < 1e-9), next = round(mA, px(A).mark * 0.92);
        await post("/position_sltp", { market_id: A, kind: "sl", price: next, order_index: stop.order_index });
        check("the stop moves, same order", await until(async () => (await orders(A)).some((x) => x.order_index === stop.order_index && Math.abs(x.trigger_price - next) < 1e-9), 15000), await orders(A));
      }
      await post(`/close?market_id=${A}&fraction=0.5`);
      const half = await until(async () => { const p = await position(A); return p > 0 && p < q ? p : 0; }, 20000);
      check("half closed", half > 0, await position(A));
      await post(`/close?market_id=${A}&fraction=1`);
      check("closed", await until(async () => !(await position(A)), 20000), await position(A));
      if (await until(async () => !(await orders(A)).length, 20000)) check("Lighter removes the SL and TP of a closed position", true);
      else note(`SL/TP still listed 20s after the close: ${JSON.stringify((await orders(A)).map((x) => [x.type, x.status]))}`);
    },
    async limit_exits() {
      const q = size(A), sl = round(mA, px(A).mark * 0.9), tp = round(mA, px(A).mark * 1.1);
      const slLim = round(mA, sl * 0.995), tpLim = round(mA, tp * 0.995);
      try { await post("/order", { market_id: A, side: "buy", kind: "market", size: q, unit: "base", sl_price: sl, tp_price: tp, sl_limit_price: slLim, tp_limit_price: tpLim, slippage_bps: 100 }); }
      catch (e) { return check("Lighter accepts stop-limit SL and TP attached to the entry", false, e.message); }
      const pos = await until(() => position(A), 20000);
      if (!check("the position opens", Math.abs(pos - q) < 1e-9, pos)) return;
      const prot = await until(async () => { const got = (await orders(A)).filter((x) => x.trigger_price); return got.length === 2 ? got : null; }, 20000);
      if (!check("SL and TP are on the book, reduce-only", prot && prot.every((x) => x.reduce_only && x.is_ask), await orders(A))) return;
      note(`listed as types ${JSON.stringify(prot.map((x) => x.type).sort())}`);
      const oSl = prot.find((x) => Math.abs(x.trigger_price - sl) < 1e-9), oTp = prot.find((x) => Math.abs(x.trigger_price - tp) < 1e-9);
      check("the SL keeps its trigger and its limit price", oSl && Math.abs(oSl.price - slLim) < 1e-9, oSl);
      check("the TP keeps its trigger and its limit price", oTp && Math.abs(oTp.price - tpLim) < 1e-9, oTp);
      check("both are limit types, not market", prot.every((x) => /limit/i.test(x.type)), prot.map((x) => x.type));
      await post(`/close?market_id=${A}&fraction=1`);
      if (await until(async () => !(await position(A)) && !(await orders(A)).length, 20000)) check("closing the position takes the stop-limits away too", true);
      else note(`stop-limits still listed 20s after the close: ${JSON.stringify((await orders(A)).map((x) => [x.type, x.status]))}`);
    },
    async conditional() {
      const q = size(A), up = round(mA, px(A).mark * 1.05), down = round(mA, px(A).mark * 0.95);
      await post("/order", { market_id: A, side: "buy", kind: "conditional", cond_exec: "market", trigger_price: up, size: q, unit: "base" });
      const o = await until(async () => (await orders(A)).find((x) => Math.abs(x.trigger_price - up) < 1e-9), 15000);
      check("stop-market buy above the price waits, not reduce-only", o && !o.reduce_only && !o.is_ask, await orders(A));
      await sleep(1000);
      await post("/order", { market_id: A, side: "buy", kind: "conditional", cond_exec: "limit", trigger_price: down, price: down, size: q, unit: "base" });
      const o2 = await until(async () => (await orders(A)).find((x) => Math.abs(x.trigger_price - down) < 1e-9), 15000);
      check("limit buy that waits for a lower price", o2 && Math.abs(o2.price - down) < 1e-9, await orders(A));
      check("neither opened anything", !(await position(A)));
    },
    async twap() {
      const q = size(A, 6);
      await post("/order", { market_id: A, side: "buy", kind: "twap", twap_minutes: 10, size: q, unit: "base", slippage_bps: 100 });
      const o = await until(async () => (await orders(A)).find((x) => /twap/i.test(x.type)), 20000);
      if (check("the TWAP is accepted and listed", o, await orders(A))) {
        note(`listed as type '${o.type}', status '${o.status}', remaining ${o.remaining} of ${q}`);
        await post(`/cancel_order?market_id=${A}&order_index=${o.order_index}`);
        check("cancelled while running", await until(async () => !(await orders(A)).length, 20000), await orders(A));
      }
      note(`filled before the cancel: ${await position(A)}`);
    },
    async scale() {
      const q = size(A, 4), from = round(mA, px(A).bid * 0.95), to = round(mA, px(A).bid * 0.97);
      await post("/order", { market_id: A, side: "buy", kind: "scale", size: q, unit: "base", scale_from: from, scale_to: to, scale_count: 3, scale_dist: "even", post_only: true });
      const got = await until(async () => { const list = await orders(A); return list.length === 3 ? list : null; }, 20000);
      if (!check("three limits rest on the book", got, await orders(A))) return;
      const ps = got.map((x) => x.price).sort((a, b) => a - b);
      check("from the first price to the last", Math.abs(ps[0] - from) < 1e-9 && Math.abs(ps[2] - to) < 1e-9, ps);
      check("together they are the whole size", Math.abs(got.reduce((s, x) => s + x.remaining, 0) - q) < 10 ** -mA.size_decimals * 1.5, got.map((x) => x.remaining));
    },
    async basket() {
      if (mids.length < 2) return say("SKIP", "needs two markets with prices");
      const B = mids[1], usd = (id) => +(size(id) * px(id).mark * 1.05).toFixed(2);
      const r = await post("/basket", { legs: [{ market_id: A, side: "buy", size_usd: usd(A) }, { market_id: B, side: "sell", size_usd: usd(B) }], slippage_bps: 100 });
      check("a buy and a sell on two markets both fill, and the answer says so", r.legs.length === 2 && r.legs.every((x) => x.filled > 0), r);
      const a = await position(A), b = await position(B);
      check("the positions are there", a > 0 && b < 0, [a, b]);
    },
    async reverse() {
      const q = size(A);
      await post("/order", { market_id: A, side: "buy", kind: "market", size: q, unit: "base", slippage_bps: 100 });
      if (!check("a long opens", Math.abs((await until(() => position(A), 20000)) - q) < 1e-9, await position(A))) return;
      await post(`/reverse?market_id=${A}`);
      check("reversed to a short of the same size", await until(async () => Math.abs((await position(A)) + q) < 1e-9, 20000), await position(A));
    },
    async rfq() {
      let r;
      try { r = await post("/rfq", { market_id: A, side: "buy", size: size(A), unit: "base" }); } catch (e) { return note(`the testnet refuses the request: ${e.message}`); }
      check("the request is accepted", r.id !== undefined && r.id !== null, r);
      const got = await api(`/rfq/${r.id}`);
      check("read back: same market and side", got.market_id === A && got.side === "buy", got);
      note(`status '${got.status}', ${got.responses.length} answers`);
      try { const closed = await post(`/rfq/${r.id}/status?status=closed`); check("closed by hand", closed.status === "closed" || closed.status !== got.status, closed); }
      catch (e) { note(`closing by hand is refused: ${e.message}`); }
    },
    async history() {
      const trades = await api("/trades");
      check("trades read, with realized PnL", Array.isArray(trades) && trades.every((x) => "pnl" in x), trades[0]);
      note(`${trades.length} fills listed`);
      const rows = await api("/funding_history");
      check("funding history read", Array.isArray(rows), rows);
      const row = rows.find((x) => x.size && x.rate && x.change && byId[x.market_id] && px(x.market_id));
      if (!row) return note("no funding payment on this account yet");
      const implied = Math.abs(row.change) / (row.size * px(row.market_id).mark) * 100, ratio = implied / Math.abs(row.rate);
      note(`funding rate ${row.rate} against ${implied.toFixed(6)}% worked out from the payment at today's price (ratio ${ratio.toFixed(2)})`);
      check("the rate is a % per hour, as the table shows it", ratio > 0.2 && ratio < 5, ratio);
    },
  };

  const trades = names.some((n) => !READS.has(n));
  if (trades) await flatten();
  try {
    for (const name of names) {
      current = name;
      if (AUTO.includes(name) && !Live.auto().on) { say("SKIP", "automations are off: hand a second testnet key to the server to test it"); continue; }
      try { await tests[name](); } catch (e) { say("FAIL", `stopped by an error: ${e.message}`); }
      if (trades) await flatten();
    }
  } finally { if (trades) await flatten(); }
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = `${count("PASS")} passed, ${count("FAIL")} failed, ${count("INFO")} notes` + (count("SKIP") ? `, ${count("SKIP")} skipped` : "");
  console.log(summary);
  return { summary, results: results.filter((r) => r.status !== "PASS"), passed: results.filter((r) => r.status === "PASS").map((r) => `${r.scenario}: ${r.text}`) };
}
