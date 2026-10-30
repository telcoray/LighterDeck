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
