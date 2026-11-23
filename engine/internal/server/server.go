// Package server is the engine's local HTTP interface for the Python server (backend/engine_go.py), on
// 127.0.0.1 only and behind a token the Python server makes up at each start. The Python server forwards the
// site's calls (rules, managed stops, scaled exits, chase, the kill switch) and mirrors every engine's state with
// a long poll on /v1/state.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/engine"
	"github.com/telcoray/lighterdeck/engine/internal/feed"
	"github.com/telcoray/lighterdeck/engine/internal/i18n"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
	"github.com/telcoray/lighterdeck/engine/internal/risk"
)

type slot struct {
	eng    *engine.Engine
	trader *lighter.Trader
	cancel context.CancelFunc
}

// Host runs the engines: the deck's own ("deck") and one per visitor (their account number).
type Host struct {
	Client  *lighter.Client
	Prices  *feed.Prices
	Book    *feed.Book
	DataDir string
	Token   string

	ctx     context.Context
	mu      sync.Mutex
	engines map[string]*slot

	vmu     sync.Mutex
	version int64
	bump    chan struct{} // closed and replaced at every change
}

func NewHost(ctx context.Context, c *lighter.Client, prices *feed.Prices, book *feed.Book, dataDir, token string) *Host {
	return &Host{Client: c, Prices: prices, Book: book, DataDir: dataDir, Token: token, ctx: ctx,
		engines: map[string]*slot{}, bump: make(chan struct{})}
}

func (h *Host) changed() {
	h.vmu.Lock()
	h.version++
	close(h.bump)
	h.bump = make(chan struct{})
	h.vmu.Unlock()
}

func (h *Host) current() (int64, chan struct{}) {
	h.vmu.Lock()
	defer h.vmu.Unlock()
	return h.version, h.bump
}

// start runs an engine for an account: the deck's (caps from the env file apply) or a visitor's.
func (h *Host) start(key string, trader *lighter.Trader, dir string) (*slot, error) {
	g := risk.NewGuard(trader, h.Prices, filepath.Join(dir, "limits.json"))
	name := ""
	if key != "deck" {
		name = "#" + key + " "
	}
	eng, err := engine.New(trader, h.Prices, h.Book, g, dir, name)
	if err != nil {
		return nil, err
	}
	eng.OnChange(h.changed)
	ctx, cancel := context.WithCancel(h.ctx)
	s := &slot{eng: eng, trader: trader, cancel: cancel}
	h.mu.Lock()
	if old := h.engines[key]; old != nil {
		old.cancel()
	}
	h.engines[key] = s
	h.mu.Unlock()
	go eng.Run(ctx)
	h.changed()
	return s, nil
}

// StartDeck runs the deck's own engine, keyless until the Python server sends the key.
func (h *Host) StartDeck() error {
	_, err := h.start("deck", lighter.NewTrader(h.Client, true), h.DataDir)
	return err
}

func (h *Host) slot(key string) *slot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.engines[key]
}

// ---------- HTTP ----------

func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", h.health)
	mux.HandleFunc("GET /v1/state", h.state)
	mux.HandleFunc("POST /v1/deck/key", h.deckKey)
	mux.HandleFunc("POST /v1/users/{account}/start", h.userStart)
	mux.HandleFunc("POST /v1/users/{account}/stop", h.userStop)
	mux.HandleFunc("POST /v1/e/{key}/{op}", h.op)
	mux.HandleFunc("PATCH /v1/e/{key}/rules/{id}", h.patchRule)
	mux.HandleFunc("DELETE /v1/e/{key}/rules/{id}", h.deleteRule)
	return h.auth(mux)
}

func (h *Host) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Engine-Token")), []byte(h.Token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		i18n.Set(r.Header.Get("X-Lang"))
		next.ServeHTTP(w, r)
	})
}

// health: the markets loaded, how many have a price and how old the latest prices are.
func (h *Host) health(w http.ResponseWriter, r *http.Request) {
	priced := 0
	for id := range h.Client.Markets() {
		if _, ok := h.Prices.Mark(id); ok {
			priced++
		}
	}
	age := -1.0
	if at := h.Prices.UpdatedAt(); !at.IsZero() {
		age = time.Since(at).Seconds()
	}
	reply(w, map[string]any{"ok": true, "markets": len(h.Client.Markets()), "priced": priced, "prices_age_s": age,
		"book_markets": len(h.Book.Subs())})
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	var ve *engine.ValueError
	if errors.As(err, &ve) {
		code = http.StatusBadRequest
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return &engine.ValueError{Msg: "bad request: " + err.Error()}
	}
	return nil
}

func (h *Host) snapshots() map[string]engine.Snapshot {
	h.mu.Lock()
	keys := make(map[string]*slot, len(h.engines))
	for k, s := range h.engines {
		keys[k] = s
	}
	h.mu.Unlock()
	out := map[string]engine.Snapshot{}
	for k, s := range keys {
		out[k] = s.eng.Snapshot()
	}
	return out
}

// state answers at once when something changed since `since`, otherwise when something does (or after
// `wait` seconds, 25 at most).
func (h *Host) state(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	wait, _ := strconv.ParseFloat(r.URL.Query().Get("wait"), 64)
	if wait <= 0 || wait > 25 {
		wait = 25
	}
	v, ch := h.current()
	if v <= since {
		select {
		case <-ch:
		case <-time.After(time.Duration(wait * float64(time.Second))):
		case <-r.Context().Done():
			return
		}
		// changes come in bursts (a pass notes, saves, notes): let the burst finish
		select {
		case <-time.After(5 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		v, _ = h.current()
	}
	reply(w, map[string]any{"version": v, "engines": h.snapshots()})
}

type keyReq struct {
	AccountIndex int64  `json:"account_index"`
	APIKeyIndex  int    `json:"api_key_index"`
	PrivateKey   string `json:"private_key"`
}

func (h *Host) deckKey(w http.ResponseWriter, r *http.Request) {
	var k keyReq
	if err := decode(r, &k); err != nil {
		fail(w, err)
		return
	}
	s := h.slot("deck")
	if s == nil {
		fail(w, errors.New("deck engine not running"))
		return
	}
	if err := s.trader.SetKey(k.AccountIndex, k.APIKeyIndex, k.PrivateKey); err != nil {
		fail(w, &engine.ValueError{Msg: err.Error()})
		return
	}
	if k.PrivateKey == "" {
		s.eng.SetAccount(nil)
	}
	s.eng.Refresh()
	h.changed()
	reply(w, map[string]bool{"ok": true})
}

func (h *Host) userStart(w http.ResponseWriter, r *http.Request) {
	account, err := strconv.ParseInt(r.PathValue("account"), 10, 64)
	if err != nil || account <= 0 {
		fail(w, &engine.ValueError{Msg: "bad account"})
		return
	}
	var req struct {
		keyReq
		Dir string `json:"dir"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	if req.Dir == "" {
		req.Dir = filepath.Join(h.DataDir, "users", fmt.Sprint(account))
	}
	t := lighter.NewTrader(h.Client, false)
	if err := t.SetKey(account, req.APIKeyIndex, req.PrivateKey); err != nil {
		fail(w, &engine.ValueError{Msg: err.Error()})
		return
	}
	if _, err := h.start(fmt.Sprint(account), t, req.Dir); err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]bool{"ok": true})
}

func (h *Host) userStop(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("account")
	h.mu.Lock()
	s := h.engines[key]
	if key != "deck" {
		delete(h.engines, key)
	}
	h.mu.Unlock()
	if s != nil && key != "deck" {
		s.cancel()
		_ = s.trader.SetKey(0, 0, "")
	}
	h.changed()
	reply(w, map[string]bool{"ok": true})
}

func (h *Host) engineOf(w http.ResponseWriter, r *http.Request) *engine.Engine {
	s := h.slot(r.PathValue("key"))
	if s == nil {
		fail(w, &engine.ValueError{Msg: "no engine for " + r.PathValue("key")})
		return nil
	}
	return s.eng
}

// done answers with the result and the engine's state, so the Python mirror is current at once.
func done(w http.ResponseWriter, eng *engine.Engine, result any) {
	reply(w, map[string]any{"result": result, "state": eng.Snapshot()})
}

func (h *Host) op(w http.ResponseWriter, r *http.Request) {
	eng := h.engineOf(w, r)
	if eng == nil {
		return
	}
	switch r.PathValue("op") {
	case "armed":
		var req struct {
			Armed bool `json:"armed"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		eng.SetArmed(req.Armed)
		done(w, eng, nil)
	case "note":
		var req struct {
			Msg   string `json:"msg"`
			Level string `json:"level"`
			Rule  string `json:"rule"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		eng.Note(req.Msg, req.Level, req.Rule)
		done(w, eng, nil)
	case "rules":
		var fields map[string]json.RawMessage
		if err := decode(r, &fields); err != nil {
			fail(w, err)
			return
		}
		rule, err := eng.AddRule(fields)
		if err != nil {
			fail(w, err)
			return
		}
		done(w, eng, eng.RuleJSON(rule))
	case "stop":
		var req struct {
			MarketID int                        `json:"market_id"`
			Fields   map[string]json.RawMessage `json:"fields"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		rule, err := eng.SetMarketStop(req.MarketID, req.Fields)
		if err != nil {
			fail(w, err)
			return
		}
		done(w, eng, eng.RuleJSON(rule))
	case "exits":
		var req struct {
			MarketID   int            `json:"market_id"`
			Levels     []engine.Level `json:"levels"`
			BeAfterTP1 bool           `json:"be_after_tp1"`
			Before     float64        `json:"before"`
			Size       float64        `json:"size"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		rule, err := eng.SetExitPlan(req.MarketID, req.Levels, req.BeAfterTP1, req.Before, req.Size)
		if err != nil {
			fail(w, err)
			return
		}
		done(w, eng, eng.RuleJSON(rule))
	case "place_exits":
		var req struct {
			Rule    string  `json:"rule"`
			PosSize float64 `json:"pos_size"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		if err := eng.PlaceExits(r.Context(), req.Rule, req.PosSize); err != nil {
			fail(w, err)
			return
		}
		done(w, eng, nil)
	case "working":
		var req struct {
			Kind     string                     `json:"kind"`
			MarketID int                        `json:"market_id"`
			Side     int                        `json:"side"`
			Qty      float64                    `json:"qty"`
			Fields   map[string]json.RawMessage `json:"fields"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		if req.Kind != "chase" && req.Kind != "iceberg" {
			fail(w, &engine.ValueError{Msg: "unknown kind"})
			return
		}
		rule, err := eng.StartWorking(req.Kind, req.MarketID, req.Side, req.Qty, req.Fields)
		if err != nil {
			fail(w, err)
			return
		}
		done(w, eng, eng.RuleJSON(rule))
	case "account":
		var req struct {
			Account *lighter.Account `json:"account"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		eng.SetAccount(req.Account)
		done(w, eng, nil)
	case "describe":
		var rule engine.Rule
		if err := decode(r, &rule); err != nil {
			fail(w, err)
			return
		}
		done(w, eng, eng.Describe(&rule))
	default:
		http.NotFound(w, r)
	}
}

func (h *Host) patchRule(w http.ResponseWriter, r *http.Request) {
	eng := h.engineOf(w, r)
	if eng == nil {
		return
	}
	var changes map[string]json.RawMessage
	if err := decode(r, &changes); err != nil {
		fail(w, err)
		return
	}
	rule, err := eng.UpdateRule(r.PathValue("id"), changes)
	if err != nil {
		fail(w, err)
		return
	}
	done(w, eng, eng.RuleJSON(rule))
}

func (h *Host) deleteRule(w http.ResponseWriter, r *http.Request) {
	eng := h.engineOf(w, r)
	if eng == nil {
		return
	}
	eng.DeleteRule(r.PathValue("id"))
	done(w, eng, nil)
}
