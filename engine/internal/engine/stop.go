package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"github.com/telcoray/lighterdeck/engine/internal/lighter"
)

// ---------- managed stop ----------

func (e *Engine) atrOf(ctx context.Context, mid int) (float64, error) {
	if hit, ok := e.atr[mid]; ok && e.now()-hit.at < AtrTTL && hit.value != 0 {
		return hit.value, nil
	}
	var bars []lighter.Candle
	if err := e.io(func() (err error) { bars, err = e.api.Candles(ctx, mid, AtrTF, AtrLen+2); return }); err != nil {
		return 0, err
	}
	if len(bars) > AtrLen+1 {
		bars = bars[len(bars)-(AtrLen+1):]
	}
	if len(bars) < 2 {
		return 0, errors.New("no candles for ATR")
	}
	sum := 0.0
	for i := 1; i < len(bars); i++ {
		a, b := bars[i-1], bars[i]
		sum += math.Max(b.High, a.Close) - math.Min(b.Low, a.Close)
	}
	v := sum / float64(len(bars)-1)
	e.atr[mid] = atrHit{e.now(), v}
	return v, nil
}

// trailDistance: the price distance the trailing stop keeps from the best price: a PnL % (on margin), a price
// %, a fixed amount or N x ATR. 0 when the rule has no trailing.
func (e *Engine) trailDistance(ctx context.Context, r *Rule, best, leverage float64) (float64, error) {
	switch {
	case r.TrailPnl != 0:
		return best * r.TrailPnl / 100 / leverage, nil
	case r.TrailPct != 0:
		return best * r.TrailPct / 100, nil
	case r.TrailPrice != 0:
		return r.TrailPrice, nil
	case r.TrailAtr != 0:
		atr, err := e.atrOf(ctx, r.MarketID)
		return r.TrailAtr * atr, err
	}
	return 0, nil
}

func (e *Engine) managedStop(ctx context.Context, r *Rule) (bool, error) {
	st, mid := &r.State, r.MarketID
	pos := e.position(mid)
	mark, ok := e.price(mid)
	if pos == nil || !ok || mark == 0 {
		if st.Size != nil && *st.Size != 0 {
			e.note(e.describe(r)+": position closed", "info", r)
			r.State = State{}
			if r.AutoRemove {
				e.remove(r.ID)
			}
			return true, nil
		}
		return false, nil
	}
	side := sign(pos.Size)
	entry := pos.Entry
	if st.Side != side || st.Entry == nil || *st.Entry != entry {
		// new position (or flipped): restart tracking, keep the old order to be re-used/modified
		st.Side, st.Entry, st.Best, st.Stop = side, f64(entry), f64(mark), nil
	}
	best := *st.Best
	if side > 0 {
		best = math.Max(best, mark)
	} else {
		best = math.Min(best, mark)
	}
	st.Best = f64(best)
	leverage := lev(pos)
	// activation and breakeven are PnL % on margin, as the positions table shows it: price move x leverage
	bestProfit := (best - entry) / entry * 100 * float64(side) * leverage
	s := float64(side)

	var candidates []float64
	if r.InitialStopPct != 0 {
		candidates = append(candidates, entry*(1-s*r.InitialStopPct/100))
	}
	if r.BeNow || (r.BreakevenAtPct != 0 && bestProfit >= r.BreakevenAtPct) {
		offset := 0.05
		if r.BreakevenOffsetPct != nil {
			offset = *r.BreakevenOffsetPct
		}
		candidates = append(candidates, entry*(1+s*offset/100))
	}
	if bestProfit >= r.TrailActivatePct {
		dist, err := e.trailDistance(ctx, r, best, leverage)
		if err != nil {
			return false, err
		}
		if dist != 0 {
			candidates = append(candidates, best-s*dist)
		}
	}
	if len(candidates) == 0 {
		return false, nil
	}
	desired := candidates[0]
	for _, c := range candidates[1:] {
		if side > 0 {
			desired = math.Max(desired, c)
		} else {
			desired = math.Min(desired, c)
		}
	}
	if st.Stop != nil { // never loosen
		if side > 0 {
			desired = math.Max(desired, *st.Stop)
		} else {
			desired = math.Min(desired, *st.Stop)
		}
	}
	desired = e.roundPrice(mid, desired)
	sym := e.symbol(mid)
	posSize := pos.Size

	sizeChanged := st.Size == nil || *st.Size != posSize
	moved := st.Stop == nil || math.Abs(desired-*st.Stop) / *st.Stop * 100 >= MinStopStepPct
	dueCheck := e.now()-st.Checked > VerifyEvery
	if !(sizeChanged || moved || dueCheck) {
		return false, nil
	}

	if moved && !sizeChanged && !dueCheck && st.Oi != 0 && st.Stop != nil {
		// the order is known and was checked lately: move it straight away, at most once a second
		if e.now()-st.Sent < FastModifyEvery {
			return false, nil
		}
		oi := st.Oi
		if err := e.io(func() error { return e.api.ModifyStop(ctx, mid, oi, posSize, desired) }); err != nil {
			st.Oi = 0 // gone or changed on Lighter: the next pass looks it up
			return false, err
		}
		st.Sent = e.now()
		e.note(fmt.Sprintf("%s stop -> %s (best %s)", sym, Repr(desired), Repr(*st.Best)), "info", r)
		st.Stop = f64(desired)
		return true, nil
	}

	var order *lighter.Order
	if st.Coi != 0 {
		var orders []lighter.Order
		if err := e.io(func() (err error) { orders, err = e.api.ActiveOrders(ctx, mid); return }); err != nil {
			return false, err
		}
		for i := range orders {
			if orders[i].ClientOrderIndex == st.Coi {
				order = &orders[i]
				break
			}
		}
	}
	st.Checked = e.now()

	if order != nil && !sizeChanged {
		st.Oi = order.OrderIndex
		if moved {
			oi := order.OrderIndex
			if err := e.io(func() error { return e.api.ModifyStop(ctx, mid, oi, posSize, desired) }); err != nil {
				return false, err
			}
			st.Sent = e.now()
			e.note(fmt.Sprintf("%s stop -> %s (best %s)", sym, Repr(desired), Repr(*st.Best)), "info", r)
		}
	} else {
		if order != nil {
			oi := order.OrderIndex
			if err := e.io(func() error { return e.api.CancelOrder(ctx, mid, oi) }); err != nil {
				return false, err
			}
		}
		var coi int64
		if err := e.io(func() (err error) { coi, err = e.api.StopOrder(ctx, mid, posSize, desired, "sl"); return }); err != nil {
			return false, err
		}
		st.Coi, st.Oi, st.Sent = coi, 0, e.now() // its order index comes from the next look-up
		e.note(fmt.Sprintf("%s stop placed @ %s for %s", sym, Repr(desired), Repr(posSize)), "info", r)
	}
	st.Stop = f64(desired)
	st.Size = f64(posSize)
	return true, nil
}

// ---------- scaled exits: TP1, TP2... each a reduce-only order for part of the position ----------

// SetExitPlan sets the market's plan (one per market). levels: price and qty each; before: the signed position
// when the order was sent; size: the order's signed size. The TP orders go out once the order has filled.
func (e *Engine) SetExitPlan(mid int, levels []Level, beAfterTP1 bool, before, size float64) (*Rule, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range e.list() {
		if r.Type == "exit_plan" && r.MarketID == mid {
			e.remove(r.ID)
		}
	}
	if len(levels) == 0 {
		e.save()
		return nil, nil
	}
	ls := make([]Level, len(levels))
	for i, l := range levels {
		ls[i] = Level{Price: l.Price, Qty: l.Qty}
	}
	r, err := e.addRule(map[string]json.RawMessage{"type": raw("exit_plan"), "market_id": raw(mid), "levels": raw(ls),
		"be_after_tp1": raw(beAfterTP1), "before": raw(before), "size": raw(size)})
	if err != nil {
		return nil, err
	}
	return r.clone(), nil
}

// PlaceExits sends the take-profit order of every level not placed yet; posSize is the signed position.
func (e *Engine) PlaceExits(ctx context.Context, id string, posSize float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, ok := e.rules[id]
	if !ok {
		return &ValueError{"unknown rule"}
	}
	err := e.placeExits(ctx, r, posSize)
	e.save()
	return err
}

func (e *Engine) placeExits(ctx context.Context, r *Rule, posSize float64) error {
	mid, s := r.MarketID, float64(sign(posSize))
	sym := e.symbol(mid)
	for i := range r.Levels {
		if r.Levels[i].Coi != 0 {
			continue
		}
		l := r.Levels[i]
		var coi int64
		if err := e.io(func() (err error) { coi, err = e.api.StopOrder(ctx, mid, s*l.Qty, l.Price, "tp"); return }); err != nil {
			return err
		}
		if i < len(r.Levels) {
			r.Levels[i].Coi = coi
		}
		e.note(fmt.Sprintf("%s TP%d placed @ %s for %s", sym, i+1, G(l.Price), G(l.Qty)), "info", r)
	}
	if !r.State.Placed {
		a := math.Abs(posSize)
		r.State.Placed, r.State.Side, r.State.Start, r.State.Size, r.State.Checked = true, sign(posSize), a, f64(a), e.now()
	}
	return nil
}

func (e *Engine) breakevenNow(mid int) {
	if r := e.marketStop(mid); r != nil {
		r.BeNow = true
		r.State.Checked = 0
	} else {
		_, _ = e.addRule(map[string]json.RawMessage{"type": raw("managed_stop"), "market_id": raw(mid), "auto_remove": raw(true), "be_now": raw(true)})
	}
	e.note(e.symbol(mid)+" TP1 filled: stop to breakeven", "warning", nil)
}

func (e *Engine) exitPlan(ctx context.Context, r *Rule) (bool, error) {
	st, mid := &r.State, r.MarketID
	pos := e.position(mid)
	now := e.now()
	if !st.Placed {
		// waiting for the entry to fill (a limit): the position has to grow by the whole order
		held := 0.0
		if pos != nil {
			held = pos.Size
		}
		if r.Size != 0 && (held-r.Before)*float64(sign(r.Size)) >= math.Abs(r.Size)*0.999 {
			if err := e.placeExits(ctx, r, held); err != nil {
				return true, err
			}
			return true, nil
		}
		if now-st.Checked < VerifyEvery {
			return false, nil
		}
		st.Checked = now
		sideAsk := r.Size < 0
		var orders []lighter.Order
		if err := e.io(func() (err error) { orders, err = e.api.ActiveOrders(ctx, mid); return }); err != nil {
			return false, err
		}
		for _, o := range orders {
			if !o.ReduceOnly && o.IsAsk == sideAsk {
				return false, nil
			}
		}
		e.note(e.describe(r)+": the entry order is gone, plan removed", "info", r)
		e.remove(r.ID)
		return true, nil
	}

	if pos == nil || sign(pos.Size) != st.Side {
		// position closed or flipped: the take-profits left over go with it
		for _, l := range r.Levels {
			if l.Coi == 0 || l.Done {
				continue
			}
			coi := l.Coi
			err := e.io(func() error {
				orders, err := e.api.ActiveOrders(ctx, mid)
				if err != nil {
					return err
				}
				for _, o := range orders {
					if o.ClientOrderIndex == coi {
						return e.api.CancelOrder(ctx, mid, o.OrderIndex)
					}
				}
				return nil
			})
			if err != nil {
				e.note(fmt.Sprintf("exit plan: TP not cancelled: %v", err), "info", nil)
			}
		}
		e.note(e.describe(r)+": position closed", "info", r)
		e.remove(r.ID)
		return true, nil
	}

	for _, l := range r.Levels {
		if l.Coi == 0 { // a take-profit that failed to go out at entry
			if err := e.placeExits(ctx, r, pos.Size); err != nil {
				return true, err
			}
			return true, nil
		}
	}
	size := math.Abs(pos.Size)
	if st.Size != nil && size == *st.Size && now-st.Checked < VerifyEvery {
		return false, nil
	}
	st.Size, st.Checked = f64(size), now
	var orders []lighter.Order
	if err := e.io(func() (err error) { orders, err = e.api.ActiveOrders(ctx, mid); return }); err != nil {
		return true, err
	}
	active := map[int64]bool{}
	for _, o := range orders {
		active[o.ClientOrderIndex] = true
	}
	changed := false
	for i := range r.Levels {
		l := &r.Levels[i]
		if l.Done || active[l.Coi] {
			continue
		}
		l.Done = true // gone: filled if the position shrank, cancelled by hand otherwise
		l.Filled = size < st.Start-1e-12
		changed = true
	}
	if r.BeAfterTP1 && len(r.Levels) > 0 && r.Levels[0].Filled && !st.BeDone {
		st.BeDone = true
		e.breakevenNow(mid)
		changed = true
	}
	return changed, nil
}

// MarketStops: the managed stop per market for the site, settings plus the level on Lighter.
func (e *Engine) MarketStop(mid int) *Rule {
	e.mu.Lock()
	defer e.mu.Unlock()
	if r := e.marketStop(mid); r != nil {
		return r.clone()
	}
	return nil
}
