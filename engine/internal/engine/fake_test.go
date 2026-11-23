package engine

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/feed"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
	"github.com/telcoray/lighterdeck/engine/internal/risk"
)

// fakeLighter is a Lighter that keeps everything in memory: nothing leaves the test.
type fakeLighter struct {
	mu      sync.Mutex
	market  *lighter.Market
	acct    *lighter.Account
	n       int64
	book    map[int64]*lighter.Order // resting orders by client order index
	done    map[int64]*lighter.Outcome
	sent    []sentOrder
	moves   []float64
	cancels []int64
	market_ []marketOrder
	placed  [][2]float64 // stop orders: size, trigger
	stopMod []stopMove
	entries [][2]float64
	lookups int
	fail    int  // limit orders that fail before reaching Lighter
	failMod bool // stop modifies fail
	signer  bool
	candles []lighter.Candle
}

type sentOrder struct {
	Size, Price  float64
	Post, Reduce bool
	Coi          int64
}

type marketOrder struct{ Size, Ref float64 }

type stopMove struct {
	Oi      int64
	Trigger float64
}

func newFake() *fakeLighter {
	return &fakeLighter{
		market: &lighter.Market{ID: 1, Symbol: "BTC", Multiplier: 1, RealSizeDecimals: 4, RealPriceDecimals: 1,
			SizeDecimals: 4, PriceDecimals: 1, MinBase: 0.0002, MinQuote: 10, DefaultLeverage: 10},
		book: map[int64]*lighter.Order{}, done: map[int64]*lighter.Outcome{}, signer: true,
	}
}

func (f *fakeLighter) Market(id int) *lighter.Market {
	if id == 1 {
		return f.market
	}
	return nil
}
func (f *fakeLighter) HasSigner() bool             { return f.signer }
func (f *fakeLighter) AccountIndex() (int64, bool) { return 1, f.signer }
func (f *fakeLighter) NewCOI() int64               { f.mu.Lock(); defer f.mu.Unlock(); f.n++; return f.n }
func (f *fakeLighter) Account(context.Context) (*lighter.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.acct, nil
}

func (f *fakeLighter) ActiveOrders(context.Context, int) ([]lighter.Order, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookups++
	var out []lighter.Order
	for _, o := range f.book {
		out = append(out, *o)
	}
	return out, nil
}

func (f *fakeLighter) OrderOutcome(_ context.Context, _ int, coi int64) (*lighter.Outcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.done[coi], nil
}

func (f *fakeLighter) Candles(context.Context, int, string, int) ([]lighter.Candle, error) {
	if f.candles != nil {
		return f.candles, nil
	}
	now := time.Now().Unix()
	var out []lighter.Candle
	for i := 0; i < 10; i++ {
		out = append(out, lighter.Candle{Time: now - 600 + 60*int64(i), High: 101, Low: 99, Close: 100})
	}
	return out, nil
}

func (f *fakeLighter) StopOrder(_ context.Context, _ int, size, trigger float64, _ string) (int64, error) {
	coi := f.NewCOI()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.placed = append(f.placed, [2]float64{size, trigger})
	f.book = map[int64]*lighter.Order{coi: {OrderIndex: 500 + coi, ClientOrderIndex: coi, Remaining: abs(size), Price: trigger}}
	return coi, nil
}

func (f *fakeLighter) ModifyStop(_ context.Context, _ int, oi int64, _, trigger float64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failMod {
		return errors.New("order not found")
	}
	f.stopMod = append(f.stopMod, stopMove{oi, trigger})
	return nil
}

func (f *fakeLighter) LimitOrder(_ context.Context, _ int, size, price float64, reduce, post bool, coi int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail > 0 {
		f.fail--
		return 0, errors.New("no answer")
	}
	f.sent = append(f.sent, sentOrder{size, price, post, reduce, coi})
	f.book[coi] = &lighter.Order{OrderIndex: coi + 100, ClientOrderIndex: coi, Remaining: abs(size), Price: price}
	return coi, nil
}

func (f *fakeLighter) ModifyOrder(_ context.Context, _ int, oi int64, _, price float64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.moves = append(f.moves, price)
	for _, o := range f.book {
		if o.OrderIndex == oi {
			o.Price = price
		}
	}
	return nil
}

func (f *fakeLighter) CancelOrder(_ context.Context, _ int, oi int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels = append(f.cancels, oi)
	for c, o := range f.book {
		if o.OrderIndex == oi {
			f.done[c] = &lighter.Outcome{Status: "canceled"}
			delete(f.book, c)
		}
	}
	return nil
}

func (f *fakeLighter) MarketOrder(_ context.Context, _ int, size, ref float64, _ bool) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.market_ = append(f.market_, marketOrder{size, ref})
	return 0, nil
}

func (f *fakeLighter) Entry(_ context.Context, _ int, size float64, _ string, worst float64, _, _ *float64, _ float64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, [2]float64{size, worst})
	return 0, nil
}

// end takes an order off the book with how it ended.
func (f *fakeLighter) end(coi int64, status string, filled float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.book, coi)
	f.done[coi] = &lighter.Outcome{Status: status, Filled: filled}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// fakeRisk lets every order through at 100.
type fakeRisk struct{}

func (fakeRisk) Quote(int, int) (float64, error) { return 100, nil }
func (fakeRisk) Review(context.Context, *lighter.Account, int, int, float64, float64, *float64, *float64) error {
	return nil
}
func (fakeRisk) Limits() risk.Limits { return risk.Limits{SlippageBpsCap: 50} }

type rig struct {
	eng    *Engine
	api    *fakeLighter
	prices *feed.Prices
	book   *feed.Book
	clock  *float64
	dir    string
}

func newRig(t *testing.T, withBook bool) *rig {
	t.Helper()
	api := newFake()
	prices := feed.NewPrices(nil)
	prices.Set(1, feed.Stats{Mark: 100, Bid: 100, Ask: 100.5}, time.Now())
	var book *feed.Book
	var b Book
	if withBook {
		book = feed.NewBook(nil)
		book.Subscribe(1)
		b = book
	}
	dir := t.TempDir()
	eng, err := New(api, prices, b, fakeRisk{}, dir, "")
	if err != nil {
		t.Fatal(err)
	}
	clock := float64(time.Now().UnixNano()) / 1e9
	eng.SetClock(func() float64 { return clock })
	eng.SetArmedQuiet(true)
	return &rig{eng: eng, api: api, prices: prices, book: book, clock: &clock, dir: dir}
}

// later moves the engine's clock on.
func (r *rig) later(s float64) { *r.clock += s }

func check(t *testing.T, name string, ok bool, got ...any) {
	t.Helper()
	if !ok {
		t.Errorf("FAIL %s %v", name, got)
	}
}
