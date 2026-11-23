package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"github.com/telcoray/lighterdeck/engine/internal/lighter"
	"github.com/telcoray/lighterdeck/engine/internal/risk"
)

// ---------- event trade ----------

func orDefault(p *float64, d float64) float64 {
	if p != nil {
		return *p
	}
	return d
}

func (e *Engine) eventTrade(ctx context.Context, r *Rule) (bool, error) {
	if r.Status != "waiting" && r.Status != "window" {
		return false, nil
	}
	now, ts, mid := e.now(), r.EventTS, r.MarketID
	mark, _ := e.price(mid)

	if r.Mode == "long" || r.Mode == "short" {
		if now < ts+r.DelayS {
			return false, nil
		}
		if now > ts+r.DelayS+120 {
			r.Status = "expired"
			e.note(e.describe(r)+": missed entry window", "warning", r)
			return true, nil
		}
		side := 1
		if r.Mode == "short" {
			side = -1
		}
		return e.enter(ctx, r, side, mark)
	}

	// breakout: range of the last N minutes before the event, then wait for a break
	if now < ts {
		return false, nil
	}
	st := &r.State
	if st.High == nil {
		minutes := int(orDefault(r.RangeMinutes, 15))
		var bars []lighter.Candle
		if err := e.io(func() (err error) { bars, err = e.api.Candles(ctx, mid, "1m", minutes+5); return }); err != nil {
			return false, err
		}
		hi, lo, n := math.Inf(-1), math.Inf(1), 0
		for _, c := range bars {
			if ts-float64(minutes*60) <= float64(c.Time) && float64(c.Time) < ts {
				hi, lo, n = math.Max(hi, c.High), math.Min(lo, c.Low), n+1
			}
		}
		if n == 0 {
			return false, errors.New("no candles for pre-event range")
		}
		st.High, st.Low = f64(hi), f64(lo)
		r.Status = "window"
		e.note(fmt.Sprintf("%s pre-event range %s - %s", e.symbol(mid), Repr(lo), Repr(hi)), "info", r)
		return true, nil
	}
	if now > ts+orDefault(r.WindowMinutes, 30)*60 {
		r.Status = "expired"
		e.note(e.describe(r)+": no breakout, expired", "info", r)
		return true, nil
	}
	buf := orDefault(r.BufferPct, 0.05) / 100
	if mark > *st.High*(1+buf) {
		return e.enter(ctx, r, 1, mark)
	}
	if mark != 0 && mark < *st.Low*(1-buf) {
		return e.enter(ctx, r, -1, mark)
	}
	return false, nil
}

func (e *Engine) enter(ctx context.Context, r *Rule, side int, mark float64) (bool, error) {
	mid := r.MarketID
	m := e.api.Market(mid)
	if e.position(mid) != nil {
		r.Status = "skipped"
		e.note(e.describe(r)+": position already open, skipped", "warning", r)
		return true, nil
	}
	s := float64(side)
	ref, err := e.risk.Quote(mid, side)
	var size float64
	var sl, tp *float64
	if err == nil && ref <= 0 {
		return false, errors.New("no price to size the order")
	}
	if err == nil {
		size = m.RoundSize(r.SizeUSD / ref)
		if r.StopPct != 0 {
			sl = f64(m.RoundPrice(ref * (1 - s*r.StopPct/100)))
		}
		if r.TpPct != 0 {
			tp = f64(m.RoundPrice(ref * (1 + s*r.TpPct/100)))
		}
		acc := e.account
		err = e.io(func() error { return e.risk.Review(ctx, acc, mid, side, size, ref, sl, tp) })
	}
	if err != nil {
		var b *risk.Blocked
		if errors.As(err, &b) { // refused by the risk guard, never retried
			r.Status = "blocked"
			e.note(fmt.Sprintf("%s: blocked by risk check: %v", e.describe(r), err), "error", r)
			return true, nil
		}
		return false, err
	}
	r.Status = "done" // set before sending: never fire twice
	e.save()
	slip := e.risk.Limits().SlippageBpsCap / 10000
	worst := m.RoundPrice(ref * (1 + s*slip))
	if err := e.io(func() error {
		_, err := e.api.Entry(ctx, mid, size*s, "market", worst, sl, tp, slip*100)
		return err
	}); err != nil {
		return true, err
	}
	dir := "LONG"
	if side < 0 {
		dir = "SHORT"
	}
	msg := fmt.Sprintf("%s %s %s @ ~%s (%s)", m.Symbol, dir, Repr(size), Repr(ref), r.EventTitle)
	if sl != nil {
		msg += " SL " + Repr(*sl)
	}
	if tp != nil {
		msg += " TP " + Repr(*tp)
	}
	e.note(msg, "warning", r)

	// the native SL protects the position; trailing / breakeven tighten it from here
	if r.TrailPct != 0 || r.BreakevenAtPct != 0 {
		add := map[string]json.RawMessage{"type": raw("managed_stop"), "market_id": raw(mid), "auto_remove": raw(true),
			"trail_activate_pct": raw(r.TrailActivatePct)}
		if r.TrailPct != 0 {
			add["trail_pct"] = raw(r.TrailPct)
		}
		if r.BreakevenAtPct != 0 {
			add["breakeven_at_pct"] = raw(r.BreakevenAtPct)
		}
		if _, err := e.addRule(add); err != nil {
			return true, err
		}
	}
	return true, nil
}
