"use strict";
// Trading math for the order ticket, ported from Lighter's own frontend core:
// elliottech/lighter-ts (MIT License, Copyright (c) 2026 Elliot Technologies, Inc.), src/formulas/
// common.ts (liquidation price), orderMargin.ts (order margin), sltp.ts (SL/TP PnL)
// and sltpTriggerValidation.ts (SL vs liquidation warning). Plain numbers in display units.

const Formulas = {
  // initial margin an order locks: notional x initial margin fraction (= notional / leverage)
  orderMargin(notional, leverage) {
    return leverage ? notional / leverage : null;
  },

  fee(notional, rate) {
    return notional * (rate || 0);
  },

  // cross maintenance margin requirement: sum of |size| x mark x maintenance fraction
  maintenanceReq(positions, markOf, mmfOf) {
    return positions.reduce((acc, p) => acc + Math.abs(p.size) * (markOf(p.market_id) || p.entry) * mmfOf(p.market_id), 0);
  },

  // lighter-ts computePositionLiquidationPrice:
  // liq = mark + (TAV - MMR) / (|size| x (mmf - sign)), clamped to the mark when already beyond it
  liquidationPrice(size, mark, mmf, totalAccountValue, maintenanceReq) {
    if (!size || !mark) return null;
    const sign = size > 0 ? 1 : -1;
    const liq = mark + (totalAccountValue - maintenanceReq) / (Math.abs(size) * (mmf - sign));
    if (!isFinite(liq) || liq < 0) return null;
    if ((sign === 1 && liq >= mark) || (sign === -1 && liq <= mark)) return mark;
    return liq;
  },

  // an isolated position: its own margin absorbs the loss until only the maintenance part is left
  // (margin + (liq - entry) x size = mmf x |size| x liq)
  isolatedLiquidation(size, entry, margin, mmf) {
    if (!size || !entry) return null;
    const liq = (entry * size - margin) / (size - mmf * Math.abs(size));
    return isFinite(liq) && liq > 0 ? liq : null;
  },

  // estimated liquidation price of this market's position after the order fills (cross margin)
  liquidationAfterOrder({ account, market, side, qty, entry, mark, markOf, mmfOf, feeUsd }) {
    if (!account || !qty || !mark) return null;
    const positions = account.positions.filter((p) => p.cross !== false);
    const current = positions.find((p) => p.market_id === market.id);
    const newSize = (current ? current.size : 0) + side * qty;
    if (Math.abs(newSize) < 1e-12) return null;
    // filling away from the mark is an immediate unrealized loss (or gain), fees are paid now
    const tav = account.total_value - (feeUsd || 0) - (entry - mark) * side * qty;
    const others = positions.filter((p) => p.market_id !== market.id);
    const mmr = this.maintenanceReq(others, markOf, mmfOf) + Math.abs(newSize) * mark * market.mmf;
    return this.liquidationPrice(newSize, mark, market.mmf, tav, mmr);
  },

  // lighter-ts getSLTPInfo (trigger-price mode): PnL in USD and in % of margin at the trigger
  sltpOutcome({ isSL, side, entry, trigger, qty, leverage }) {
    if (!trigger || !entry || !qty) return null;
    const sideSign = (side < 0 ? -1 : 1) * (isSL ? 1 : -1);
    const usd = sideSign * (entry - trigger) * qty; // positive = size of the loss for SL / gain for TP
    const pct = (1 - trigger / entry) * 100 * sideSign * (leverage || 1);
    return { usd, pct };
  },

  // lighter-ts getSLTriggerPriceLiqWarningKey: a stop beyond the liquidation price never fires in time
  slBeyondLiquidation(side, trigger, liq) {
    if (!trigger || !liq) return false;
    return side > 0 ? trigger < liq : trigger > liq;
  },
};

// The Account page's figures from an account PnL series, as Lighter's /api/v1/pnl returns it (cumulative trade PnL,
// deposits and withdrawals; the last point live): the same as the server's /api/account_stats (main.py), for a key in
// the browser, and for paper from points made up of its own fills.
const AccountStats = {
  pnlOf: (p) => +p.trade_pnl + (+p.trade_spot_pnl || 0),
  flowsOf: (p) => +p.inflow - +p.outflow + (+p.spot_inflow || 0) - (+p.spot_outflow || 0),
  day: (ts) => new Date(ts * 1000).toISOString().slice(0, 10),

  // year: daily points of the last 365 days; hourly: hourly points of the last 7 days (needed when days <= 7)
  build(year, hourly, days, now = Date.now() / 1000) {
    const { pnlOf, flowsOf, day } = AccountStats;
    const start = now - days * 86400;
    const pts = days <= 7 ? (hourly || []).filter((p) => p.timestamp >= start - 3600) : year.filter((p) => p.timestamp >= start - 86400);
    if (!pts.length) return { series: [], flows: [], days: [], stats: null };
    const p0 = pnlOf(pts[0]), f0 = flowsOf(pts[0]);
    const series = pts.map((p) => ({ t: p.timestamp, equity: pnlOf(p) + flowsOf(p), pnl: pnlOf(p) - p0 }));
    const flows = [], daily = [];
    for (let i = 1; i < pts.length; i++) {
      const usd = flowsOf(pts[i]) - flowsOf(pts[i - 1]);
      if (Math.abs(usd) >= 1) flows.push({ t: pts[i].timestamp, at: pts[i - 1].timestamp, usd });
    }
    for (let i = 1; i < year.length; i++) daily.push({ day: day(year[i - 1].timestamp), pnl: pnlOf(year[i]) - pnlOf(year[i - 1]) });
    const from = day(start), inPeriod = daily.filter((d) => d.day >= from);
    let peak = -Infinity, drawdown = 0;
    for (const x of series) { peak = Math.max(peak, x.pnl); drawdown = Math.max(drawdown, peak - x.pnl); }
    const funded = series.filter((x) => x.equity >= 50).map((x) => x.equity);
    const base = funded.length ? funded.reduce((a, b) => a + b, 0) / funded.length : 0;
    const last = series[series.length - 1];
    const pick = (better) => inPeriod.reduce((m, d) => (m === null || better(d.pnl, m.pnl) ? d : m), null);
    return { series, flows, days: daily, stats: {
      pnl: last.pnl, return_pct: base > 0 ? last.pnl / base * 100 : null, max_drawdown: drawdown,
      net_flows: flowsOf(pts[pts.length - 1]) - f0, start_equity: series[0].equity,
      best_day: pick((a, b) => a > b), worst_day: pick((a, b) => a < b),
      green_days: inPeriod.filter((d) => d.pnl > 0.005).length, red_days: inPeriod.filter((d) => d.pnl < -0.005).length,
    } };
  },

  // per market over the period: realized PnL, funding, fills and volume (the server's /api/account_markets)
  markets(fills, fundings, sinceMs, complete = true) {
    const per = new Map();
    const row = (id, symbol) => {
      if (!per.has(id)) per.set(id, { market_id: id, symbol, realized: 0, fills: 0, volume: 0, funding: 0 });
      return per.get(id);
    };
    for (const f of fills) {
      if (f.ts < sinceMs) continue;
      const r = row(f.market_id, f.symbol);
      r.fills += 1;
      r.volume += +f.usd || 0;
      r.realized += +f.pnl || 0;
    }
    for (const f of fundings) if (f.ts >= sinceMs) row(f.market_id, f.symbol).funding += +f.change || 0;
    const markets = [...per.values()].sort((a, b) => Math.abs(b.realized + b.funding) - Math.abs(a.realized + a.funding));
    return { markets, volume: markets.reduce((s, r) => s + r.volume, 0), funding_complete: complete };
  },
};
