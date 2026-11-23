package engine

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/feed"
)

// The chase and iceberg checks of tests/offline/test_work.py, on the Go engine.

var ctx = context.Background()

func (r *rig) setBidAsk(bid, ask float64) {
	r.prices.Set(1, feed.Stats{Mark: (bid + ask) / 2, Bid: bid, Ask: ask}, time.Unix(0, int64(*r.clock*1e9)))
}

// step is one pass of the worked orders, as if the check interval had gone by.
func (r *rig) step() {
	r.later(WorkingCheck)
	s, _ := r.prices.Stats(1)
	r.prices.Set(1, s, time.Unix(0, int64(*r.clock*1e9)))
	r.eng.Work(ctx)
}

func fields(kv ...any) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = raw(kv[i+1])
	}
	return out
}

func (r *rig) start(t *testing.T, kind string, side int, qty float64, kv ...any) string {
	t.Helper()
	rule, err := r.eng.StartWorking(kind, 1, side, qty, fields(kv...))
	if err != nil {
		t.Fatal(err)
	}
	return rule.ID
}

func (r *rig) alive(id string) bool { return r.eng.Rule(id) != nil }

func TestChaseRefusedWithAutoOff(t *testing.T) {
	r := newRig(t, false)
	r.eng.SetArmedQuiet(false)
	_, err := r.eng.StartWorking("chase", 1, 1, 1, nil)
	var ve *ValueError
	check(t, "Auto off refused", err != nil && asValue(err, &ve))
}

func asValue(err error, ve **ValueError) bool {
	v, ok := err.(*ValueError)
	*ve = v
	return ok
}

func TestChaseFollowsTheBid(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "chase", 1, 1.0)
	r.step()
	check(t, "post-only at the best bid", len(r.api.sent) == 1 && r.api.sent[0] == sentOrder{1, 100, true, false, 1}, r.api.sent)
	check(t, "the site sees it", r.eng.WorkingOrders()["1"].Kind == "chase", r.eng.WorkingOrders())
	r.setBidAsk(101, 101.5)
	r.step()
	check(t, "moves with the bid, no second order", len(r.api.moves) == 1 && r.api.moves[0] == 101 && len(r.api.sent) == 1, r.api.moves)
	r.step()
	check(t, "no move while already there", len(r.api.moves) == 1, r.api.moves)
	r.api.book[1].Remaining = 0.6
	r.setBidAsk(102, 102.5)
	r.step()
	check(t, "partial fill keeps going", r.api.moves[len(r.api.moves)-1] == 102 && r.alive(id), r.api.moves)
	r.api.end(1, "filled", 1.0)
	r.step()
	check(t, "filled ends it", !r.alive(id) && len(r.api.sent) == 1)
}

func TestChaseCap(t *testing.T) {
	r := newRig(t, false)
	r.start(t, "chase", 1, 1.0, "cap", 100.5)
	r.step()
	r.setBidAsk(103, 103.5)
	r.step()
	check(t, "stops at the cap", len(r.api.moves) == 1 && r.api.moves[0] == 100.5, r.api.moves)

	s := newRig(t, false)
	s.start(t, "chase", -1, 1.0, "cap", 99.0)
	s.step()
	check(t, "sell: at the ask, sell side", s.api.sent[0].Size == -1 && s.api.sent[0].Price == 100.5, s.api.sent)
	s.setBidAsk(97.5, 98)
	s.step()
	check(t, "sell: stops at the cap", len(s.api.moves) == 1 && s.api.moves[0] == 99, s.api.moves)
}

func TestChaseBouncedPostOnlyGoesAgain(t *testing.T) {
	r := newRig(t, false)
	r.start(t, "chase", 1, 1.0)
	r.step()
	r.api.end(1, "canceled-post-only", 0.25)
	r.step()
	r.step()
	check(t, "bounced post-only goes again for the rest", len(r.api.sent) == 2 && r.api.sent[1].Size == 0.75, r.api.sent)
}

func TestChaseCancelledByHand(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "chase", 1, 1.0)
	r.step()
	r.api.end(1, "canceled", 0)
	r.step()
	r.step()
	check(t, "cancelled by hand ends it", !r.alive(id) && len(r.api.sent) == 1, r.api.sent)
}

func TestChaseTimeUp(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "chase", 1, 1.0, "until", *r.clock-1, "then_market", true)
	r.step()
	r.api.book[1].Remaining = 1.0
	r.step()
	r.step()
	check(t, "time up sends the rest at market", len(r.api.cancels) == 1 && r.api.cancels[0] == 101 &&
		len(r.api.market_) == 1 && r.api.market_[0] == marketOrder{1, 100.5} && !r.alive(id), r.api.cancels, r.api.market_)

	s := newRig(t, false)
	id = s.start(t, "chase", 1, 1.0, "until", *s.clock-1)
	s.step()
	s.step()
	s.step()
	check(t, "time up cancels", len(s.api.cancels) == 1 && len(s.api.market_) == 0 && !s.alive(id), s.api.cancels)
}

func TestChaseStalePricesSendNothing(t *testing.T) {
	r := newRig(t, false)
	r.prices.Set(1, feed.Stats{Mark: 100, Bid: 100, Ask: 100.5}, time.Now().Add(-60*time.Second))
	r.start(t, "chase", 1, 1.0)
	r.later(WorkingCheck)
	r.eng.Work(ctx)
	check(t, "stale prices send nothing", len(r.api.sent) == 0, r.api.sent)
}

func TestChaseLostAnswerNeverSendsTwice(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "chase", 1, 1.0)
	r.api.fail = 1
	r.step()
	for i := 0; i < MissingLimit+2; i++ {
		r.step()
	}
	check(t, "lost answer never sends again, and stops", len(r.api.sent) == 0 && !r.alive(id), r.api.sent)
}

func TestChaseAutoOffFreezes(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "chase", 1, 1.0)
	r.step()
	r.eng.SetArmedQuiet(false)
	r.setBidAsk(110, 110.5)
	r.step()
	check(t, "Auto off freezes it", len(r.api.moves) == 0 && r.alive(id), r.api.moves)
}

func TestIcebergAddsUp(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "iceberg", -1, 1.0, "price", 105.0, "slice_pct", 10, "post_only", true)
	seenTwo := false
	for i := 0; i < 60; i++ {
		r.step()
		if !r.alive(id) {
			break
		}
		if len(r.api.book) > 1 {
			seenTwo = true
		}
		for coi, o := range r.api.book {
			r.api.end(coi, "filled", o.Remaining)
		}
	}
	total := 0.0
	sizes := map[float64]bool{}
	for _, s := range r.api.sent {
		total -= s.Size
		sizes[-s.Size] = true
		// a slice is up to 12% of the total; a last piece under the exchange minimum (10 USD / 105) joins it
		check(t, "at its price, as sells, post-only", s.Price == 105 && s.Size < 0 && s.Post && -s.Size <= 0.12+10/105.0+1e-4, s)
	}
	check(t, "adds up exactly", math.Abs(total-1) < 1e-9 && !r.alive(id), total, r.api.sent)
	check(t, "one at a time", !seenTwo)
	check(t, "slices about 10% and not all the same", len(r.api.sent) >= 8 && len(r.api.sent) <= 13 && len(sizes) > 1, r.api.sent)
}

func TestIcebergCancelledByHand(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "iceberg", 1, 1.0, "price", 95.0, "slice_pct", 25)
	r.step()
	r.api.end(1, "filled", r.api.sent[0].Size)
	r.step()
	r.step()
	n := len(r.api.sent)
	r.api.end(2, "canceled", 0)
	r.step()
	r.step()
	check(t, "cancelled by hand ends it", !r.alive(id) && len(r.api.sent) == n && n == 2, r.api.sent)
}

func TestIcebergBouncedWaitsThenRetries(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "iceberg", 1, 1.0, "price", 101.0, "slice_pct", 25, "post_only", true)
	r.step()
	r.api.end(1, "canceled-post-only", 0)
	r.step() // reads the bounce: retry in 5 s
	r.eng.Work(ctx)
	waited := len(r.api.sent) == 1 && r.alive(id)
	r.eng.Edit(id, func(x *Rule) { x.State.Retry = 0 })
	r.step()
	check(t, "bounced post-only waits, then retries", waited && len(r.api.sent) == 2, r.api.sent)
}

func TestIcebergNeverUnderMinimum(t *testing.T) {
	r := newRig(t, false)
	id := r.start(t, "iceberg", 1, 0.5, "price", 100.0, "slice_pct", 20)
	for i := 0; i < 40; i++ {
		r.step()
		if !r.alive(id) {
			break
		}
		for coi, o := range r.api.book {
			r.api.end(coi, "filled", o.Remaining)
		}
	}
	total := 0.0
	for _, s := range r.api.sent {
		total += s.Size
		check(t, "no slice under the exchange minimum", abs(s.Size)*100 >= 10, s)
	}
	check(t, "adds up", math.Abs(total-0.5) < 1e-9, total)
}

func TestRestartCarriesOn(t *testing.T) {
	r := newRig(t, false)
	r.start(t, "chase", 1, 1.0)
	r.step()
	again, err := New(r.api, r.prices, nil, fakeRisk{}, r.dir, "")
	if err != nil {
		t.Fatal(err)
	}
	again.SetClock(func() float64 { return *r.clock })
	again.SetArmedQuiet(true)
	r.setBidAsk(104, 104.5)
	r.later(WorkingCheck)
	again.Work(ctx)
	check(t, "restart: same order, moved", len(r.api.sent) == 1 && len(r.api.moves) == 1 && r.api.moves[0] == 104, r.api.sent, r.api.moves)
}
