package engine

import (
	"context"
	"testing"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/lighter"
)

// The engine checks of tests/offline/test_fast.py (the book's own are in package feed).

func (r *rig) quote(bid, ask float64) { r.book.SetQuote(1, bid, ask, time.Now()) }

func (r *rig) withPosition(size float64) {
	l := 1.0
	acc := &lighter.Account{Positions: []lighter.Position{{MarketID: 1, Size: size, Entry: 100, Leverage: &l}}}
	r.api.acct = acc
	r.eng.SetAccount(acc)
}

func (r *rig) addStop(t *testing.T, kv ...any) string {
	t.Helper()
	f := fields(append([]any{"type", "managed_stop", "market_id", 1}, kv...)...)
	rule, err := r.eng.AddRule(f)
	if err != nil {
		t.Fatal(err)
	}
	return rule.ID
}

func (r *rig) setSent(id string, v float64) { r.eng.Edit(id, func(x *Rule) { x.State.Sent = v }) }

func TestPriceFollowsTheBook(t *testing.T) {
	r := newRig(t, true)
	r.quote(100.4, 100.6)
	p, _ := r.eng.price(1)
	check(t, "the book's mid while tight", p == 100.5, p)
	r.quote(99, 101)
	p, _ = r.eng.price(1)
	check(t, "the mark when the spread is wide", p == 100, p)
	r.book.DropQuote(1)
	p, _ = r.eng.price(1)
	check(t, "the mark without a book", p == 100, p)
}

func TestManagedStopFromTheBook(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(1)
	id := r.addStop(t, "trail_pct", 1.0)
	check(t, "watched: a managed stop's market", len(r.eng.Watched()) == 1 && r.eng.Watched()[1], r.eng.Watched())
	r.quote(100.9, 101.1)
	r.eng.React(ctx, 1)
	check(t, "placed at best - 1%", len(r.api.placed) == 1 && r.api.placed[0] == [2]float64{1, 100}, r.api.placed)
	r.setSent(id, 0)
	r.quote(101.9, 102.1)
	r.eng.React(ctx, 1)
	st := r.eng.Rule(id).State
	check(t, "first move looks the order up and learns its index", len(r.api.stopMod) == 1 && r.api.stopMod[0] == stopMove{501, 101} && st.Oi == 501 && r.api.lookups == 1, r.api.stopMod, st, r.api.lookups)
	r.setSent(id, 0)
	r.quote(102.4, 102.6)
	r.eng.React(ctx, 1)
	check(t, "next moves go straight, no look-up", r.api.stopMod[len(r.api.stopMod)-1] == stopMove{501, 101.5} && r.api.lookups == 1, r.api.stopMod, r.api.lookups)
	r.quote(102.9, 103.1)
	r.eng.React(ctx, 1)
	check(t, "not twice within a second", len(r.api.stopMod) == 2, r.api.stopMod)
	r.later(1.1)
	r.eng.React(ctx, 1)
	check(t, "moves again after a second, to the best so far", r.api.stopMod[len(r.api.stopMod)-1] == stopMove{501, 102}, r.api.stopMod)
	r.setSent(id, 0)
	r.api.failMod = true
	r.quote(104.9, 105.1)
	r.eng.React(ctx, 1)
	check(t, "a failed modify forgets the order index", r.eng.Rule(id).State.Oi == 0, r.eng.Rule(id).State)
	r.api.failMod = false
	r.eng.React(ctx, 1)
	check(t, "then looks it up and moves it", r.api.stopMod[len(r.api.stopMod)-1] == stopMove{501, 104}, r.api.stopMod)
	r.quote(100, 100.2)
	r.setSent(id, 0)
	r.eng.React(ctx, 1)
	check(t, "never loosened when the price falls back", r.api.stopMod[len(r.api.stopMod)-1] == stopMove{501, 104}, r.api.stopMod)
	n := len(r.api.stopMod)
	r.quote(109.9, 110.1)
	r.eng.React(ctx, 2)
	check(t, "another market's price doesn't touch it", len(r.api.stopMod) == n)
}

func TestManagedStopPositionClosedRemovesIt(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(1)
	id := r.addStop(t, "trail_pct", 1.0, "auto_remove", true)
	r.quote(100.9, 101.1)
	r.eng.React(ctx, 1)
	r.withPosition(0)
	r.eng.SetAccount(&lighter.Account{Positions: []lighter.Position{}})
	r.eng.React(ctx, 1)
	check(t, "position closed: the rule goes", r.eng.Rule(id) == nil)
}

func TestBreakevenAndInitialStop(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(-2) // a short at 100
	id := r.addStop(t, "initial_stop_pct", 2.0, "breakeven_at_pct", 1.0)
	r.quote(99.9, 100.1)
	r.eng.React(ctx, 1)
	check(t, "a short's initial stop above the entry", len(r.api.placed) == 1 && r.api.placed[0] == [2]float64{-2, 102}, r.api.placed)
	r.setSent(id, 0)
	r.quote(98.8, 99.0) // +1.1%: breakeven
	r.eng.React(ctx, 1)
	// 100 x (1 - 0.05%) = 99.95, which rounds to 100.0 at one decimal (as Python's round does)
	check(t, "breakeven for a short", r.api.stopMod[len(r.api.stopMod)-1].Trigger == 100, r.api.stopMod)
}

func TestTrailByATR(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(1)
	r.addStop(t, "trail_atr", 2.0)
	r.quote(100.9, 101.1)
	r.eng.React(ctx, 1)
	// the fake candles have a range of 2: the stop sits 2 x 2 under the best price
	check(t, "N x ATR from the best", len(r.api.placed) == 1 && r.api.placed[0][1] == 97, r.api.placed)
}

func TestEventBreakoutOnTheBook(t *testing.T) {
	r := newRig(t, true)
	r.api.acct = &lighter.Account{Positions: []lighter.Position{}}
	r.eng.SetAccount(r.api.acct)
	f := fields("type", "event_trade", "event_id", "x", "event_title", "USD CPI", "event_ts", *r.clock-1, "market_id", 1,
		"mode", "breakout", "size_usd", 100, "range_minutes", 15, "buffer_pct", 0.05)
	rule, err := r.eng.AddRule(f)
	if err != nil {
		t.Fatal(err)
	}
	id := rule.ID
	check(t, "watched: an event trade near its time", r.eng.Watched()[1], r.eng.Watched())
	r.api.candles = []lighter.Candle{}
	for i := 0; i < 10; i++ {
		r.api.candles = append(r.api.candles, lighter.Candle{Time: int64(*r.clock) - 600 + 60*int64(i), High: 101, Low: 99, Close: 100})
	}
	r.quote(100.4, 100.6)
	r.eng.React(ctx, 1)
	got := r.eng.Rule(id)
	check(t, "range read at the release", got.Status == "window" && *got.State.High == 101, got)
	r.eng.React(ctx, 1)
	check(t, "no entry inside the range", len(r.api.entries) == 0, r.api.entries)
	r.quote(101.2, 101.3)
	r.eng.React(ctx, 1)
	got = r.eng.Rule(id)
	check(t, "long on the breakout above the range", got.Status == "done" && len(r.api.entries) == 1 && r.api.entries[0][0] > 0, got.Status, r.api.entries)
}

func TestChaseAtTheBooksBid(t *testing.T) {
	r := newRig(t, true)
	r.quote(99.5, 99.7)
	r.start(t, "chase", 1, 0.5)
	r.eng.Work(ctx)
	check(t, "at the book's best bid", len(r.api.sent) == 1 && r.api.sent[0].Price == 99.5, r.api.sent)
}

func TestNothingWatchedWithAutoOff(t *testing.T) {
	r := newRig(t, true)
	r.addStop(t, "trail_pct", 1.0)
	r.eng.SetArmedQuiet(false)
	check(t, "nothing with Auto off", len(r.eng.Watched()) == 0)
}

func TestScaledExits(t *testing.T) {
	r := newRig(t, true)
	// nothing yet: the entry is a resting limit buy
	r.api.acct = &lighter.Account{Positions: []lighter.Position{}}
	r.eng.SetAccount(r.api.acct)
	r.api.book = map[int64]*lighter.Order{77: {OrderIndex: 7, ClientOrderIndex: 77}}
	rule, err := r.eng.SetExitPlan(1, []Level{{Price: 110, Qty: 0.5}, {Price: 120, Qty: 0.5}}, true, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	r.eng.Tick(ctx)
	check(t, "nothing before the entry fills", len(r.api.placed) == 0, r.api.placed)
	r.withPosition(1)
	r.eng.Tick(ctx)
	check(t, "both TPs once the entry filled", len(r.api.placed) == 2 && r.api.placed[0] == [2]float64{0.5, 110}, r.api.placed)
	got := r.eng.Rule(rule.ID)
	check(t, "placed", got.State.Placed && got.Levels[0].Coi != 0 && got.Levels[1].Coi != 0, got)
	// TP1 fills: its order leaves the book and the position shrinks
	r.api.book = map[int64]*lighter.Order{got.Levels[1].Coi: {OrderIndex: 900, ClientOrderIndex: got.Levels[1].Coi}}
	r.withPosition(0.5)
	r.eng.Tick(ctx)
	got = r.eng.Rule(rule.ID)
	check(t, "TP1 done and filled", got.Levels[0].Done && got.Levels[0].Filled && !got.Levels[1].Done, got.Levels)
	stop := r.eng.MarketStop(1)
	check(t, "stop to breakeven after TP1", stop != nil && stop.BeNow, stop)
	r.eng.SetAccount(&lighter.Account{Positions: []lighter.Position{}})
	r.api.acct = r.eng.account
	r.eng.Tick(ctx)
	check(t, "position closed: the plan goes", r.eng.Rule(rule.ID) == nil)
}

func TestSetMarketStopKeepsTheOrder(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(1)
	r.quote(100.9, 101.1)
	first, err := r.eng.SetMarketStop(1, fields("trail_pct", 1.0))
	if err != nil {
		t.Fatal(err)
	}
	r.eng.React(ctx, 1)
	coi := r.eng.Rule(first.ID).State.Coi
	second, _ := r.eng.SetMarketStop(1, fields("trail_pct", 2.0, "initial_stop_pct", 0))
	got := r.eng.Rule(second.ID)
	check(t, "one stop per market", r.eng.Rule(first.ID) == nil && got.TrailPct == 2 && got.InitialStopPct == 0, got)
	check(t, "the order carries over, the level is recomputed", got.State.Coi == coi && got.State.Stop == nil, got.State)
	gone, _ := r.eng.SetMarketStop(1, nil)
	check(t, "nil removes it", gone == nil && r.eng.MarketStop(1) == nil)
}

func TestLoopMovesTheStopWithinMilliseconds(t *testing.T) {
	r := newRig(t, true)
	r.eng.SetClock(func() float64 { return float64(time.Now().UnixNano()) / 1e9 })
	r.withPosition(1)
	id := r.addStop(t, "trail_pct", 1.0)
	r.quote(100.9, 101.1)
	c, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { r.eng.Run(c); close(done) }()
	time.Sleep(400 * time.Millisecond) // first pass: account, stop placed, market watched
	r.eng.React(ctx, 1)                // learns the order index
	r.setSent(id, 0)
	check(t, "it asked for the market's book", r.book.Wanted()[1], r.book.Wanted())
	t0 := time.Now()
	r.book.SetQuote(1, 101.9, 102.1, time.Now())
	r.eng.Wake(1)
	for {
		r.api.mu.Lock()
		n := len(r.api.stopMod)
		r.api.mu.Unlock()
		if n > 0 || time.Since(t0) > time.Second {
			break
		}
		time.Sleep(100 * time.Microsecond)
	}
	took := time.Since(t0)
	r.api.mu.Lock()
	mods := append([]stopMove{}, r.api.stopMod...)
	r.api.mu.Unlock()
	check(t, "stop moved soon after the price", len(mods) > 0 && mods[len(mods)-1] == stopMove{501, 101} && took < 50*time.Millisecond, mods, took)
	t.Logf("price to modify: %v", took)
	cancel()
	<-done
	check(t, "stopping lets go of the book", len(r.book.Wanted()) == 0, r.book.Wanted())
}

// Without the account read, a managed stop never takes "no position" for a closed one (it would remove itself).
func TestNoAccountNoAction(t *testing.T) {
	r := newRig(t, true)
	r.withPosition(1)
	id := r.addStop(t, "trail_pct", 1.0, "auto_remove", true)
	r.quote(100.9, 101.1)
	r.eng.React(ctx, 1)
	check(t, "placed", len(r.api.placed) == 1, r.api.placed)
	r.eng.SetAccount(nil) // a restart: the key not there yet, the account not read
	r.api.signer = false
	r.eng.Tick(ctx)
	r.api.signer = true
	r.eng.React(ctx, 1)
	r.eng.Tick(ctx) // the key is there now, but the account still isn't read: Tick reads it first
	check(t, "the stop stays", r.eng.Rule(id) != nil && len(r.api.placed) == 1, r.eng.Rule(id), r.api.placed)
}
