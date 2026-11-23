package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"github.com/telcoray/lighterdeck/engine/internal/i18n"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
)

// ---------- orders worked on the book: chase and iceberg ----------
// One limit order at a time. When it leaves the book Lighter says how it ended, and only that decides what comes
// next: never another order on a guess, so the total can't be sent twice. Cancelling the order by hand ends the
// rule. With Auto off they wait, and the order on the book stays where it is.

// StartWorking adds a chase or an iceberg; fields are the rest of the rule (cap, until, price, slice_pct...).
func (e *Engine) StartWorking(kind string, mid, side int, qty float64, fields map[string]json.RawMessage) (*Rule, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.armed {
		return nil, &ValueError{i18n.L("Chase e Iceberg lavorano con Auto: attivalo prima di inviarli", "Chase and Iceberg work through Auto: turn it on first")}
	}
	add := map[string]json.RawMessage{}
	for k, v := range fields {
		add[k] = v
	}
	add["type"], add["market_id"], add["side"], add["qty"] = raw(kind), raw(mid), raw(side), raw(qty)
	r, err := e.addRule(add)
	if err != nil {
		return nil, err
	}
	r.State.Filled = 0
	e.save()
	return r.clone(), nil
}

// Working is, for the site, the order on the book of each worked rule by its client order index.
type Working struct {
	Kind   string  `json:"kind"`
	Qty    float64 `json:"qty"`
	Filled float64 `json:"filled"`
	Rule   string  `json:"rule"`
}

func (e *Engine) work(ctx context.Context) {
	if !e.armed || !e.api.HasSigner() {
		return
	}
	changed := false
	for _, r := range e.list() {
		if !workingKinds[r.Type] || !r.Enabled {
			continue
		}
		var ch bool
		var err error
		if r.Type == "chase" {
			ch, err = e.chase(ctx, r)
		} else {
			ch, err = e.iceberg(ctx, r)
		}
		if err == nil {
			if r.State.Errors != 0 {
				r.State.Errors = 0
				ch = true
			}
			changed = changed || ch
			continue
		}
		r.State.Errors++
		changed = true
		if r.State.Errors == 1 {
			e.note(fmt.Sprintf("%s: %v", e.describe(r), err), "error", r)
		}
		if r.State.Errors >= 5 {
			e.endWorking(r, fmt.Sprintf("stopped after repeated errors: %v", err), "error")
		}
	}
	if changed {
		e.save()
	}
}

func (e *Engine) endWorking(r *Rule, why, level string) {
	e.note(e.describe(r)+": "+why, level, nil)
	e.remove(r.ID)
}

func (e *Engine) left(r *Rule) float64 {
	m := e.api.Market(r.MarketID)
	if m == nil {
		return r.Qty - r.State.Filled
	}
	return m.RoundSize(r.Qty - r.State.Filled)
}

func (e *Engine) sendWorking(ctx context.Context, r *Rule, qty, price float64, postOnly bool) error {
	st, coi := &r.State, e.api.NewCOI()
	// kept before sending: if the answer is lost, the order is looked for instead of sent again
	st.Coi, st.OrderIndex, st.Price, st.Remaining, st.Checked, st.Missing = coi, nil, price, qty, e.now(), 0
	e.save()
	mid, size, reduce := r.MarketID, float64(r.Side)*qty, r.ReduceOnly
	return e.io(func() error {
		_, err := e.api.LimitOrder(ctx, mid, size, price, reduce, postOnly, coi)
		return err
	})
}

// readWorking: the order on the book, or how it ended; neither while Lighter hasn't listed it.
func (e *Engine) readWorking(ctx context.Context, r *Rule) (*lighter.Order, *lighter.Outcome, error) {
	st, mid := &r.State, r.MarketID
	st.Checked = e.now()
	coi := st.Coi
	var orders []lighter.Order
	if err := e.io(func() (err error) { orders, err = e.api.ActiveOrders(ctx, mid); return }); err != nil {
		return nil, nil, err
	}
	for i := range orders {
		if o := orders[i]; o.ClientOrderIndex == coi {
			st.OrderIndex, st.Remaining, st.Price, st.Missing = i64(o.OrderIndex), o.Remaining, o.Price, 0
			return &o, nil, nil
		}
	}
	var out *lighter.Outcome
	if err := e.io(func() (err error) { out, err = e.api.OrderOutcome(ctx, mid, coi); return }); err != nil {
		return nil, nil, err
	}
	if out != nil {
		filled := st.Filled + out.Filled
		if m := e.api.Market(mid); m != nil {
			filled = m.RoundSize(filled)
		}
		st.Filled, st.Coi, st.OrderIndex, st.Missing = filled, 0, nil, 0
		return nil, out, nil
	}
	st.Missing++
	if st.Missing >= MissingLimit {
		e.endWorking(r, "its order isn't on Lighter's lists, stopped: check the open orders", "error")
	}
	return nil, nil, nil
}

func (e *Engine) chase(ctx context.Context, r *Rule) (bool, error) {
	st, mid, side := &r.State, r.MarketID, r.Side
	now := e.now()
	best := e.best(mid, side)
	if best == 0 || (!e.bookFresh(mid) && now-float64(e.prices.UpdatedAt().UnixNano())/1e9 > 15) {
		return false, nil
	}
	target := best
	if r.Cap != 0 {
		if side > 0 {
			target = math.Min(best, r.Cap)
		} else {
			target = math.Max(best, r.Cap)
		}
	}
	target = e.roundPrice(mid, target)
	if st.Coi == 0 {
		left := e.left(r)
		if left <= 0 {
			e.endWorking(r, "filled", "warning")
			return true, nil
		}
		if err := e.sendWorking(ctx, r, left, target, true); err != nil {
			return true, err
		}
		e.note(fmt.Sprintf("%s: at %s", e.describe(r), G(target)), "info", r)
		return true, nil
	}
	expired := r.Until != 0 && now >= r.Until
	if st.OrderIndex == nil || expired || now-st.Checked >= WorkingCheck {
		act, out, err := e.readWorking(ctx, r)
		if err != nil {
			return true, err
		}
		if out != nil {
			left := e.left(r)
			switch {
			case left <= 0 || out.Status == "filled":
				e.endWorking(r, "filled", "warning")
			case st.Expiring:
				if r.ThenMarket && left > 0 {
					s, _ := e.prices.Stats(mid)
					ref := s.Bid
					if side > 0 {
						ref = s.Ask
					}
					if ref == 0 {
						ref = best
					}
					size, reduce := float64(side)*left, r.ReduceOnly
					if err := e.io(func() error { _, err := e.api.MarketOrder(ctx, mid, size, ref, reduce); return err }); err != nil {
						return true, err
					}
					e.endWorking(r, fmt.Sprintf("time up: %s sent at market", G(left)), "warning")
				} else {
					e.endWorking(r, fmt.Sprintf("time up: %s not filled", G(left)), "warning")
				}
			case out.Status != "canceled-post-only": // the price moved under it: it goes again, otherwise it's over
				e.endWorking(r, fmt.Sprintf("order %s, %s not filled", out.Status, G(left)), "warning")
			}
			return true, nil
		}
		if act == nil {
			return !e.has(r.ID), nil
		}
	}
	if expired && !st.Expiring {
		st.Expiring, st.Checked = true, 0
		oi := *st.OrderIndex
		return true, e.io(func() error { return e.api.CancelOrder(ctx, mid, oi) })
	}
	if !st.Expiring && target != st.Price && now-st.Moved >= FastModifyEvery {
		st.Moved = now
		oi, rem := *st.OrderIndex, st.Remaining
		if err := e.io(func() error { return e.api.ModifyOrder(ctx, mid, oi, rem, target) }); err != nil {
			return true, err
		}
		st.Price = target
		return true, nil
	}
	return false, nil
}

func (e *Engine) iceberg(ctx context.Context, r *Rule) (bool, error) {
	st, mid := &r.State, r.MarketID
	m := e.api.Market(mid)
	now := e.now()
	if st.Coi == 0 {
		left := e.left(r)
		if left <= 0 {
			e.endWorking(r, "filled", "warning")
			return true, nil
		}
		if now < st.Retry {
			return false, nil
		}
		least := math.Max(m.MinBase, m.MinQuote/r.Price)
		// each slice a little different, so the book doesn't show the same size over and over
		qty := m.RoundSize(r.Qty * r.SlicePct / 100 * (0.8 + 0.4*e.random()))
		qty = math.Max(qty, m.RoundSize(least+math.Pow10(-m.SizeDecimals)))
		if left-qty < least {
			qty = left
		}
		if err := e.sendWorking(ctx, r, qty, r.Price, r.PostOnly); err != nil {
			return true, err
		}
		st.Slices++
		e.note(fmt.Sprintf("%s: slice %d, %s", e.describe(r), st.Slices, G(qty)), "info", r)
		return true, nil
	}
	if now-st.Checked < WorkingCheck {
		return false, nil
	}
	act, out, err := e.readWorking(ctx, r)
	if err != nil {
		return true, err
	}
	if out == nil {
		return act == nil && !e.has(r.ID), nil
	}
	switch {
	case out.Status == "canceled-post-only":
		st.Retry = now + 5 // it would have crossed: it tries again when the price has moved
	case out.Status != "filled":
		e.endWorking(r, fmt.Sprintf("order %s, %s not sent", out.Status, G(e.left(r))), "warning")
	case e.left(r) <= 0:
		e.endWorking(r, "filled", "warning")
	}
	return true, nil
}

// WorkingOrders: the order on the book of each worked rule, by its client order index.
func (e *Engine) WorkingOrders() map[string]Working {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := map[string]Working{}
	for _, r := range e.rules {
		if workingKinds[r.Type] && r.State.Coi != 0 {
			out[fmt.Sprint(r.State.Coi)] = Working{Kind: r.Type, Qty: r.Qty, Filled: r.State.Filled, Rule: r.ID}
		}
	}
	return out
}
