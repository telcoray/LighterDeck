// Package engine runs the automations: managed stops (initial, breakeven, trailing), scaled take-profits, chase
// and iceberg orders worked on the book, and event trades. A port of backend/engine.py that always runs the way
// ENGINE_FAST does there: it wakes on every change of the best bid or ask of the markets its rules act on.
//
// Every rule lives in rules.json, in the Python engine's format. The engine only sends orders while armed;
// disarming is the kill switch for every automation (manual orders from the site still work).
//
// One engine per account: the deck's own, and one per visitor of the public site who left automations on.
// Each runs its passes one at a time, holding its lock except while it waits for Lighter, the way the Python
// engine's asyncio loop gives way at each await: the site can change rules in between.
package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/feed"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
	"github.com/telcoray/lighterdeck/engine/internal/risk"
)

const (
	TickSeconds     = 3.0  // the account and every rule
	WorkingCheck    = 3.0  // seconds between looks at a worked order
	MissingLimit    = 10   // looks without finding it, then it stops rather than send more
	MinStopStepPct  = 0.05 // no modify for smaller moves
	VerifyEvery     = 60.0 // re-check that each stop order still exists
	AtrTF           = "15m"
	AtrLen          = 14
	AtrTTL          = 300.0
	FastIdle        = 250 * time.Millisecond // waits this long for a price before looking at the clock-driven rules
	FastMaxSpread   = 0.003                  // the book's mid stands in for the mark only under a 0.3% spread
	FastModifyEvery = 1.0                    // a stop or a chased order moves at most once a second
	maxLogs         = 300
)

var workingKinds = map[string]bool{"chase": true, "iceberg": true}

// stopFields can be set on a managed stop from the ticket or the positions table.
var stopFields = []string{"initial_stop_pct", "breakeven_at_pct", "trail_pnl", "trail_pct", "trail_price", "trail_atr",
	"trail_activate_pct", "be_now"}

// Lighter is the account the engine trades for (lighter.Trader; a fake in tests).
type Lighter interface {
	Market(id int) *lighter.Market
	HasSigner() bool
	AccountIndex() (int64, bool)
	NewCOI() int64
	Account(ctx context.Context) (*lighter.Account, error)
	ActiveOrders(ctx context.Context, marketID int) ([]lighter.Order, error)
	OrderOutcome(ctx context.Context, marketID int, coi int64) (*lighter.Outcome, error)
	Candles(ctx context.Context, marketID int, tf string, count int) ([]lighter.Candle, error)
	StopOrder(ctx context.Context, marketID int, posSize, trigger float64, kind string) (int64, error)
	ModifyStop(ctx context.Context, marketID int, orderIndex int64, posSize, trigger float64) error
	LimitOrder(ctx context.Context, marketID int, size, price float64, reduceOnly, postOnly bool, coi int64) (int64, error)
	ModifyOrder(ctx context.Context, marketID int, orderIndex int64, size, price float64) error
	CancelOrder(ctx context.Context, marketID int, orderIndex int64) error
	MarketOrder(ctx context.Context, marketID int, size, ref float64, reduceOnly bool) (int64, error)
	Entry(ctx context.Context, marketID int, size float64, kind string, price float64, sl, tp *float64, slippagePct float64) (int64, error)
}

// Prices are every market's latest stats (feed.Prices).
type Prices interface {
	Mark(id int) (float64, bool)
	Stats(id int) (feed.Stats, bool)
	UpdatedAt() time.Time
}

// Book is the order book watch (feed.Book).
type Book interface {
	Quote(id int) (bid, ask float64, ok bool)
	Want(owner any, ids map[int]bool)
	Listen(fn func(int)) int
	Unlisten(id int)
}

// Risk reviews the orders the engine opens itself (risk.Guard).
type Risk interface {
	Quote(marketID, side int) (float64, error)
	Review(ctx context.Context, acc *lighter.Account, marketID, side int, size, price float64, stop, target *float64) error
	Limits() risk.Limits
}

// Log is one line of the engine's log, as the site shows it.
type Log struct {
	Seq   int64   `json:"seq"`
	TS    float64 `json:"ts"`
	Level string  `json:"level"`
	Msg   string  `json:"msg"`
}

type atrHit struct {
	at, value float64
}

type Engine struct {
	api    Lighter
	prices Prices
	book   Book
	risk   Risk
	name   string // in the server log: whose engine it is
	dir    string // rules.json and state.json

	mu      sync.Mutex
	rules   map[string]*Rule
	order   []string // rule ids in the order they were added
	armed   bool
	account *lighter.Account
	logs    []Log
	logSeq  int64
	atr     map[int]atrHit

	dmu     sync.Mutex // the markets woken by the book, and those this engine watches
	dirty   map[int]bool
	refresh bool // read the account at the next pass (a key just arrived)
	watch   map[int]bool
	wake    chan struct{}
	changed func() // called after anything the site shows has changed

	now    func() float64
	random func() float64 // in [0, 1)
}

func New(api Lighter, prices Prices, book Book, rk Risk, dir, name string) (*Engine, error) {
	e := &Engine{api: api, prices: prices, book: book, risk: rk, name: name, dir: dir, rules: map[string]*Rule{},
		atr: map[int]atrHit{}, dirty: map[int]bool{}, watch: map[int]bool{}, wake: make(chan struct{}, 1),
		changed: func() {}, now: func() float64 { return float64(time.Now().UnixNano()) / 1e9 }, random: randFloat}
	if err := e.load(); err != nil {
		return nil, err
	}
	return e, nil
}

// OnChange sets the function told about every change the site shows.
func (e *Engine) OnChange(fn func()) {
	e.mu.Lock()
	e.changed = fn
	e.mu.Unlock()
}

// SetClock replaces the clock (tests).
func (e *Engine) SetClock(now func() float64) { e.now = now }

// ---------- persistence ----------

func (e *Engine) rulesFile() string { return filepath.Join(e.dir, "rules.json") }
func (e *Engine) stateFile() string { return filepath.Join(e.dir, "state.json") }

func (e *Engine) load() error {
	if b, err := os.ReadFile(e.rulesFile()); err == nil {
		var list []*Rule
		if err := json.Unmarshal(b, &list); err != nil {
			return fmt.Errorf("%s: %w", e.rulesFile(), err)
		}
		for _, r := range list {
			if _, dup := e.rules[r.ID]; !dup {
				e.order = append(e.order, r.ID)
			}
			e.rules[r.ID] = r
		}
	}
	if b, err := os.ReadFile(e.stateFile()); err == nil {
		var st struct {
			Armed bool `json:"armed"`
		}
		_ = json.Unmarshal(b, &st)
		e.armed = st.Armed
	}
	return nil
}

// save writes the rules and the kill switch (lock held).
func (e *Engine) save() {
	list := e.list()
	if list == nil {
		list = []*Rule{}
	}
	b, _ := json.MarshalIndent(list, "", " ")
	if err := writeAtomic(e.rulesFile(), b); err != nil {
		slog.Error(e.name+"rules not saved", "err", err)
	}
	s, _ := json.Marshal(map[string]bool{"armed": e.armed})
	if err := writeAtomic(e.stateFile(), s); err != nil {
		slog.Error(e.name+"state not saved", "err", err)
	}
	e.changed()
}

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// list is the rules in the order they were added (lock held).
func (e *Engine) list() []*Rule {
	out := make([]*Rule, 0, len(e.order))
	for _, id := range e.order {
		if r, ok := e.rules[id]; ok {
			out = append(out, r)
		}
	}
	return out
}

func (e *Engine) has(id string) bool {
	_, ok := e.rules[id]
	return ok
}

func (e *Engine) remove(id string) {
	if _, ok := e.rules[id]; !ok {
		return
	}
	delete(e.rules, id)
	for i, x := range e.order {
		if x == id {
			e.order = append(e.order[:i], e.order[i+1:]...)
			break
		}
	}
}

func (e *Engine) insert(r *Rule) {
	if _, ok := e.rules[r.ID]; !ok {
		e.order = append(e.order, r.ID)
	}
	e.rules[r.ID] = r
}

// note writes a line to the log (and the rule's note) (lock held).
func (e *Engine) note(msg, level string, r *Rule) {
	if r != nil {
		r.Note = msg
	}
	e.logSeq++
	e.logs = append(e.logs, Log{Seq: e.logSeq, TS: e.now(), Level: level, Msg: msg})
	if len(e.logs) > maxLogs {
		e.logs = e.logs[len(e.logs)-maxLogs:]
	}
	switch level {
	case "error", "warning":
		slog.Warn(e.name + msg)
	default:
		slog.Info(e.name + msg)
	}
	e.changed()
}

// io runs a call to Lighter without the lock, so the site can change rules meanwhile (lock held on entry
// and on return).
func (e *Engine) io(fn func() error) error {
	e.mu.Unlock()
	defer e.mu.Lock()
	return fn()
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randFloat() float64 {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	var u uint64
	for _, x := range b {
		u = u<<8 | uint64(x)
	}
	return float64(u>>11) / float64(1<<53)
}

// ---------- prices ----------

// price the rules follow: the order book's mid while fresh and tight, the mark otherwise.
func (e *Engine) price(mid int) (float64, bool) {
	if e.book != nil {
		if bid, ask, ok := e.book.Quote(mid); ok && 0 < bid && bid < ask && (ask-bid)/ask < FastMaxSpread {
			return (bid + ask) / 2, true
		}
	}
	return e.prices.Mark(mid)
}

// best bid (side > 0) or ask: the order book's when fresh, the price feed's otherwise.
func (e *Engine) best(mid, side int) float64 {
	if e.book != nil {
		if bid, ask, ok := e.book.Quote(mid); ok {
			if side > 0 {
				return bid
			}
			return ask
		}
	}
	s, _ := e.prices.Stats(mid)
	if side > 0 {
		return s.Bid
	}
	return s.Ask
}

func (e *Engine) bookFresh(mid int) bool {
	if e.book == nil {
		return false
	}
	_, _, ok := e.book.Quote(mid)
	return ok
}

func (e *Engine) position(mid int) *lighter.Position {
	return e.account.Position(mid)
}

func (e *Engine) symbol(mid int) string {
	if m := e.api.Market(mid); m != nil {
		return m.Symbol
	}
	return fmt.Sprint(mid)
}

func (e *Engine) roundPrice(mid int, p float64) float64 {
	if m := e.api.Market(mid); m != nil {
		return m.RoundPrice(p)
	}
	return p
}

func sign(x float64) int {
	if x > 0 {
		return 1
	}
	return -1
}

func lev(p *lighter.Position) float64 {
	if p.Leverage != nil && *p.Leverage != 0 {
		return *p.Leverage
	}
	return 1
}

// ---------- the loop ----------

// Run is the engine's loop until ctx ends. The rules that follow the price (managed stops, breakouts, chase) run
// on every change of their market's best bid or ask; the rest keeps its clock: the account and every rule each
// TickSeconds, worked orders' checks each second. One pass at a time, so a new price waits for the orders of the
// last one.
func (e *Engine) Run(ctx context.Context) {
	lid := -1
	if e.book != nil {
		lid = e.book.Listen(e.onQuote)
		defer func() {
			e.book.Unlisten(lid)
			e.book.Want(e, nil)
		}()
	}
	var lastTick, lastWork float64
	idle := time.NewTimer(0)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-idle.C:
		}
		e.Pass(ctx, &lastTick, &lastWork)
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(FastIdle)
	}
}

// Pass is one turn of the loop: the tick when it's due, otherwise the rules of the markets that moved; then the
// worked orders when a second has gone by or their market moved.
func (e *Engine) Pass(ctx context.Context, lastTick, lastWork *float64) {
	e.dmu.Lock()
	dirty, refresh := e.dirty, e.refresh
	e.dirty, e.refresh = map[int]bool{}, false
	e.dmu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	if refresh || now-*lastTick >= TickSeconds {
		*lastTick = now
		e.tick(ctx)
	} else if e.armed && e.api.HasSigner() && e.account != nil {
		e.react(ctx, dirty, now)
	}
	worked := e.workedMarkets()
	hit := false
	for id := range dirty {
		hit = hit || worked[id]
	}
	if now-*lastWork >= 1 || hit {
		*lastWork = now
		e.work(ctx)
	}
	w := e.watched()
	e.dmu.Lock()
	e.watch = w
	e.dmu.Unlock()
	if e.book != nil {
		e.book.Want(e, w)
	}
}

func (e *Engine) onQuote(mid int) {
	e.dmu.Lock()
	if !e.watch[mid] {
		e.dmu.Unlock()
		return
	}
	e.dirty[mid] = true
	e.dmu.Unlock()
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// Refresh reads the account at the next pass, right away (the key just arrived or changed).
func (e *Engine) Refresh() {
	e.dmu.Lock()
	e.refresh = true
	e.dmu.Unlock()
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// Wake marks a market as moved and wakes the loop (tests).
func (e *Engine) Wake(mid int) { e.onQuote(mid) }

func (e *Engine) workedMarkets() map[int]bool {
	out := map[int]bool{}
	for _, r := range e.rules {
		if r.Type == "chase" && r.Enabled {
			out[r.MarketID] = true
		}
	}
	return out
}

// watched: the markets whose order book this engine follows, those of the rules that act on the price.
func (e *Engine) watched() map[int]bool {
	out := map[int]bool{}
	if !e.armed || !e.api.HasSigner() {
		return out
	}
	now := e.now()
	for _, r := range e.rules {
		if !r.Enabled {
			continue
		}
		switch r.Type {
		case "managed_stop", "chase":
			out[r.MarketID] = true
		case "event_trade":
			if r.Status == "window" || (r.Status == "waiting" && now >= r.EventTS-120) {
				out[r.MarketID] = true
			}
		}
	}
	return out
}

// Watched is watched() under the lock (tests).
func (e *Engine) Watched() map[int]bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.watched()
}

func (e *Engine) tick(ctx context.Context) {
	if _, ok := e.api.AccountIndex(); ok {
		var acc *lighter.Account
		err := e.io(func() (err error) { acc, err = e.api.Account(ctx); return })
		if err != nil {
			e.note("account fetch failed: "+err.Error(), "error", nil)
			return
		}
		e.account = acc
		e.changed()
	} else if e.account != nil {
		e.account = nil
		e.changed()
	}
	// without the account the engine can't tell a closed position from one it hasn't read yet: no rule acts
	if !e.armed || !e.api.HasSigner() || e.account == nil {
		return
	}
	changed := false
	for _, r := range e.list() {
		if !r.Enabled || workingKinds[r.Type] {
			continue
		}
		var ch bool
		var err error
		switch r.Type {
		case "managed_stop":
			ch, err = e.managedStop(ctx, r)
		case "exit_plan":
			ch, err = e.exitPlan(ctx, r)
		default:
			ch, err = e.eventTrade(ctx, r)
		}
		if err != nil {
			e.note(fmt.Sprintf("rule %s: %v", r.ID, err), "error", r)
			ch = true
		}
		changed = changed || ch
	}
	if changed {
		e.save()
	}
}

// react: between two ticks, the rules of the markets whose price just moved, and event trades at their time.
func (e *Engine) react(ctx context.Context, dirty map[int]bool, now float64) {
	changed := false
	for _, r := range e.list() {
		if !r.Enabled {
			continue
		}
		var ch bool
		var err error
		switch {
		case r.Type == "managed_stop" && dirty[r.MarketID]:
			ch, err = e.managedStop(ctx, r)
		case r.Type == "event_trade" && (r.Status == "waiting" || r.Status == "window") && now >= r.EventTS:
			ch, err = e.eventTrade(ctx, r)
		}
		if err != nil {
			e.note(fmt.Sprintf("rule %s: %v", r.ID, err), "error", r)
			ch = true
		}
		changed = changed || ch
	}
	if changed {
		e.save()
	}
}

// React is react() under the lock, as Pass calls it (tests).
func (e *Engine) React(ctx context.Context, dirty ...int) {
	d := map[int]bool{}
	for _, id := range dirty {
		d[id] = true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.account == nil {
		return
	}
	e.react(ctx, d, e.now())
}

// Tick is tick() under the lock (tests).
func (e *Engine) Tick(ctx context.Context) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.tick(ctx)
}

// Work is work() under the lock (tests).
func (e *Engine) Work(ctx context.Context) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.work(ctx)
}

// ---------- the site's calls ----------

// ValueError is a request the engine refuses (the Python engine's ValueError: a 400 for the site).
type ValueError struct{ Msg string }

func (v *ValueError) Error() string { return v.Msg }

func (e *Engine) Armed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.armed
}

func (e *Engine) SetArmed(armed bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.armed = armed
	e.save()
	if armed {
		e.note("automations ARMED", "warning", nil)
	} else {
		e.note("automations DISARMED (kill switch)", "warning", nil)
	}
}

// SetArmedQuiet sets the kill switch without a log line (tests).
func (e *Engine) SetArmedQuiet(armed bool) {
	e.mu.Lock()
	e.armed = armed
	e.mu.Unlock()
}

// SetAccount replaces the account as the site last read it (nil when the key is removed).
func (e *Engine) SetAccount(acc *lighter.Account) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.account = acc
	e.changed()
}

// Note writes a line to the log; ruleID, when given, also becomes that rule's note.
func (e *Engine) Note(msg, level, ruleID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if level == "" {
		level = "info"
	}
	e.note(msg, level, e.rules[ruleID])
}

// AddRule adds a rule from the site's fields; an event trade comes with event_title and event_ts already filled
// in by the Python server (it has the calendar).
func (e *Engine) AddRule(fields map[string]json.RawMessage) (*Rule, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, err := e.addRule(fields)
	if err != nil {
		return nil, err
	}
	return r.clone(), nil
}

func (e *Engine) addRule(fields map[string]json.RawMessage) (*Rule, error) {
	b, _ := json.Marshal(fields)
	var r Rule
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, &ValueError{err.Error()}
	}
	r.ID = newID()
	if _, ok := fields["enabled"]; !ok {
		r.Enabled = true
	}
	r.Created = e.now()
	r.State = State{}
	switch {
	case r.Type == "event_trade":
		if r.EventTitle == "" || r.EventTS == 0 {
			return nil, &ValueError{"unknown event"}
		}
		r.Status = "waiting"
	case r.Type == "managed_stop", r.Type == "exit_plan", workingKinds[r.Type]:
	default:
		return nil, &ValueError{"unknown rule type"}
	}
	if e.api.Market(r.MarketID) == nil {
		return nil, &ValueError{"unknown market"}
	}
	e.insert(&r)
	e.save()
	e.note(fmt.Sprintf("rule %s added: %s", r.ID, e.describe(&r)), "info", nil)
	return &r, nil
}

func (e *Engine) UpdateRule(id string, changes map[string]json.RawMessage) (*Rule, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, ok := e.rules[id]
	if !ok {
		return nil, &ValueError{"unknown rule"}
	}
	if err := r.patch(changes); err != nil {
		return nil, &ValueError{err.Error()}
	}
	e.save()
	return r.clone(), nil
}

func (e *Engine) DeleteRule(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remove(id)
	e.save()
}

// marketStop: the managed stop of a market (one per market).
func (e *Engine) marketStop(mid int) *Rule {
	for _, r := range e.list() {
		if r.Type == "managed_stop" && r.MarketID == mid {
			return r
		}
	}
	return nil
}

// SetMarketStop replaces the market's managed stops with these settings (nil removes them). The tracking state
// and the stop order already on Lighter carry over, so the order is modified, not doubled.
func (e *Engine) SetMarketStop(mid int, fields map[string]json.RawMessage) (*Rule, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var old []*Rule
	for _, r := range e.list() {
		if r.Type == "managed_stop" && r.MarketID == mid {
			old = append(old, r)
		}
	}
	var state *State
	beNow := false
	for _, r := range old {
		if state == nil && r.State.Coi != 0 {
			s := r.State
			state = &s
		}
		beNow = beNow || r.BeNow
	}
	for _, r := range old {
		e.remove(r.ID)
	}
	if fields == nil {
		e.save()
		if len(old) > 0 {
			e.note(e.symbol(mid)+" managed stop removed (the stop already placed stays on Lighter)", "info", nil)
		}
		return nil, nil
	}
	add := map[string]json.RawMessage{"type": raw("managed_stop"), "market_id": raw(mid), "auto_remove": raw(true)}
	for _, k := range stopFields {
		if v, ok := fields[k]; ok && truthyJSON(v) {
			add[k] = v
		}
	}
	if beNow { // a breakeven already reached by TP1 stays when the trailing changes
		add["be_now"] = raw(true)
	}
	r, err := e.addRule(add)
	if err != nil {
		return nil, err
	}
	if state != nil {
		state.Stop = nil // new settings: recompute the level, keep modifying the same order
		r.State = *state
		e.save()
	}
	return r.clone(), nil
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func truthyJSON(v json.RawMessage) bool {
	var x any
	if json.Unmarshal(v, &x) != nil {
		return false
	}
	switch t := x.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	}
	return true
}

// ---------- what the site reads ----------

// Snapshot is the engine as the Python server mirrors it.
type Snapshot struct {
	Armed    bool              `json:"armed"`
	Account  *lighter.Account  `json:"account"`
	Rules    []json.RawMessage `json:"rules"`
	Logs     []Log             `json:"logs"`
	LogSeq   int64             `json:"log_seq"`
	HasKey   bool              `json:"has_key"`
	KeyIndex int               `json:"api_key_index"`
}

func (e *Engine) Snapshot() Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := Snapshot{Armed: e.armed, Account: e.account, Logs: append([]Log{}, e.logs...), LogSeq: e.logSeq,
		HasKey: e.api.HasSigner(), Rules: []json.RawMessage{}}
	if t, ok := e.api.(interface{ KeyIndex() int }); ok {
		s.KeyIndex = t.KeyIndex()
	}
	if s.Account != nil {
		b, _ := json.Marshal(s.Account)
		var cp lighter.Account
		_ = json.Unmarshal(b, &cp)
		s.Account = &cp
	}
	for _, r := range e.list() {
		s.Rules = append(s.Rules, withDescription(r, e.describe(r)))
	}
	return s
}

func withDescription(r *Rule, d string) json.RawMessage {
	b, _ := json.Marshal(r)
	var all map[string]json.RawMessage
	_ = json.Unmarshal(b, &all)
	all["description"] = raw(d)
	out, _ := json.Marshal(all)
	return out
}

// RuleJSON is a rule with its description, as the site reads it.
func (e *Engine) RuleJSON(r *Rule) json.RawMessage {
	if r == nil {
		return json.RawMessage("null")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return withDescription(r, e.describe(r))
}

// Rule is a copy of a rule (tests).
func (e *Engine) Rule(id string) *Rule {
	e.mu.Lock()
	defer e.mu.Unlock()
	if r, ok := e.rules[id]; ok {
		return r.clone()
	}
	return nil
}

// Edit changes a rule in place under the lock (tests).
func (e *Engine) Edit(id string, fn func(r *Rule)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if r, ok := e.rules[id]; ok {
		fn(r)
	}
}

// Describe a rule in a line.
func (e *Engine) Describe(r *Rule) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.describe(r)
}

func (e *Engine) describe(r *Rule) string {
	sym := e.symbol(r.MarketID)
	switch {
	case workingKinds[r.Type]:
		side := "buy"
		if r.Side < 0 {
			side = "sell"
		}
		done := ""
		if r.State.Filled != 0 {
			done = fmt.Sprintf(" (%s filled)", G(r.State.Filled))
		}
		if r.Type == "iceberg" {
			return fmt.Sprintf("%s iceberg %s %s @ %s, %s%% at a time%s", sym, side, G(r.Qty), G(r.Price), G(r.SlicePct), done)
		}
		s := fmt.Sprintf("%s chase %s %s", sym, side, G(r.Qty))
		if r.Cap != 0 {
			s += " up to " + G(r.Cap)
		}
		return s + done
	case r.Type == "managed_stop":
		var parts []string
		if r.InitialStopPct != 0 {
			parts = append(parts, "SL "+Num(r.InitialStopPct)+"%")
		}
		if r.BreakevenAtPct != 0 {
			parts = append(parts, "BE at PnL +"+Num(r.BreakevenAtPct)+"%")
		}
		if r.BeNow {
			parts = append(parts, "BE after TP1")
		}
		trail := ""
		switch {
		case r.TrailPnl != 0:
			trail = G(r.TrailPnl) + "% PnL"
		case r.TrailPct != 0:
			trail = Num(r.TrailPct) + "%"
		case r.TrailPrice != 0:
			trail = "$" + G(r.TrailPrice)
		case r.TrailAtr != 0:
			trail = G(r.TrailAtr) + "x ATR"
		}
		if trail != "" {
			parts = append(parts, fmt.Sprintf("trail %s from PnL +%s%%", trail, Num(r.TrailActivatePct)))
		}
		if len(parts) == 0 {
			parts = []string{"(empty)"}
		}
		return sym + " managed stop: " + join(parts)
	case r.Type == "exit_plan":
		var parts []string
		for i, l := range r.Levels {
			parts = append(parts, fmt.Sprintf("TP%d %s @ %s", i+1, G(l.Qty), G(l.Price)))
		}
		s := sym + " scaled exits: " + join(parts)
		if r.BeAfterTP1 {
			s += ", BE after TP1"
		}
		return s
	}
	return fmt.Sprintf("%s %s on %s $%s", sym, r.Mode, r.EventTitle, Num(r.SizeUSD))
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}

// G is Python's format(x, "g").
func G(x float64) string { return risk.G(x) }

// Num is a number as Python's str() writes a float read from JSON: no needless digits.
func Num(x float64) string {
	if x == math.Trunc(x) && math.Abs(x) < 1e15 {
		return fmt.Sprintf("%d", int64(x))
	}
	return fmt.Sprint(x)
}

// Repr is Python's str() of a float: 101.0, 0.5.
func Repr(x float64) string {
	if x == math.Trunc(x) && math.Abs(x) < 1e16 {
		return fmt.Sprintf("%.1f", x)
	}
	return fmt.Sprint(x)
}
