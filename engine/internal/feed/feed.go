// Package feed follows Lighter's websocket: every market's prices (market_stats/all, about once a second) and
// the order book of the markets the engines watch (order_book/{id}, an update every few milliseconds on a busy
// market). The Go side of backend/feed.py.
package feed

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Stats are a market's latest figures, prices in display units.
type Stats struct {
	Mark, Last, Bid, Ask, Index, High, Low float64
	Funding, Change, Volume, OI            float64
}

// Prices holds every market's stats from market_stats/all.
type Prices struct {
	Multipliers func() map[int]float64

	mu      sync.RWMutex
	stats   map[int]Stats
	updated time.Time
}

func NewPrices(mult func() map[int]float64) *Prices {
	return &Prices{Multipliers: mult, stats: map[int]Stats{}}
}

func (p *Prices) Mark(id int) (float64, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	s, ok := p.stats[id]
	return s.Mark, ok && s.Mark != 0
}

func (p *Prices) Stats(id int) (Stats, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	s, ok := p.stats[id]
	return s, ok
}

func (p *Prices) UpdatedAt() time.Time {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.updated
}

// Set replaces a market's stats (tests).
func (p *Prices) Set(id int, s Stats, at time.Time) {
	p.mu.Lock()
	p.stats[id] = s
	p.updated = at
	p.mu.Unlock()
}

// Run keeps the market_stats/all subscription open, reconnecting on any drop.
func (p *Prices) Run(ctx context.Context, wsURL string) {
	for ctx.Err() == nil {
		err := stream(ctx, wsURL, func(send func(any) error) error {
			return send(map[string]string{"type": "subscribe", "channel": "market_stats/all"})
		}, func(send func(any) error, raw []byte) {
			var msg struct {
				MarketStats map[string]json.RawMessage `json:"market_stats"`
			}
			if json.Unmarshal(raw, &msg) == nil && msg.MarketStats != nil {
				p.merge(msg.MarketStats)
			}
		})
		if ctx.Err() != nil {
			return
		}
		slog.Warn("price feed dropped; reconnecting", "err", err)
		sleep(ctx, 3*time.Second)
	}
}

type rawStats struct {
	MarketID *int `json:"market_id"`
	Mark     *num `json:"mark_price"`
	Last     *num `json:"last_trade_price"`
	Bid      *num `json:"best_bid_price"`
	Ask      *num `json:"best_ask_price"`
	Funding  *num `json:"current_funding_rate"`
	Change   *num `json:"daily_price_change"`
	Index    *num `json:"index_price"`
	Volume   *num `json:"daily_quote_token_volume"`
	High     *num `json:"daily_price_high"`
	Low      *num `json:"daily_price_low"`
	OI       *num `json:"open_interest_usd"`
}

func (p *Prices) merge(payload map[string]json.RawMessage) {
	mult := map[int]float64{}
	if p.Multipliers != nil {
		mult = p.Multipliers()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for key, raw := range payload {
		var s rawStats
		if json.Unmarshal(raw, &s) != nil {
			// the single-market channel sends one object instead of a map: the payload itself is the stats
			continue
		}
		id := 0
		if s.MarketID != nil {
			id = *s.MarketID
		} else if v, err := strconv.Atoi(key); err == nil {
			id = v
		} else {
			continue
		}
		m := mult[id]
		if m == 0 {
			m = 1
		}
		cur := p.stats[id]
		price := func(dst *float64, v *num) {
			if v != nil && v.ok {
				*dst = v.v / m
			}
		}
		plain := func(dst *float64, v *num) {
			if v != nil && v.ok {
				*dst = v.v
			}
		}
		price(&cur.Mark, s.Mark)
		price(&cur.Last, s.Last)
		price(&cur.Bid, s.Bid)
		price(&cur.Ask, s.Ask)
		price(&cur.Index, s.Index)
		price(&cur.High, s.High)
		price(&cur.Low, s.Low)
		plain(&cur.Funding, s.Funding)
		plain(&cur.Change, s.Change)
		plain(&cur.Volume, s.Volume)
		plain(&cur.OI, s.OI)
		p.stats[id] = cur
	}
	p.updated = time.Now()
}

// num is a JSON number or numeric string; an empty string is no value.
type num struct {
	v  float64
	ok bool
}

func (n *num) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == "null" || s == `""` {
		return nil
	}
	if len(s) >= 2 && s[0] == '"' {
		s = s[1 : len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil // a value Lighter didn't fill in: kept as before
	}
	n.v, n.ok = v, true
	return nil
}

// ---------- the websocket ----------

// stream dials, runs start, then hands every message to on until the connection drops. Lighter's own
// {"type":"ping"} is answered here.
func stream(ctx context.Context, url string, start func(send func(any) error) error, on func(send func(any) error, raw []byte)) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, _, err := websocket.Dial(dctx, url, nil)
	cancel()
	if err != nil {
		return err
	}
	conn.SetReadLimit(64 << 20)
	defer conn.CloseNow()
	var wmu sync.Mutex
	send := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		wmu.Lock()
		defer wmu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}
	// keepalive: a websocket ping every 10 seconds; a connection that stops answering is dropped
	pctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pctx.Done():
				return
			case <-t.C:
				c, cancel := context.WithTimeout(pctx, 10*time.Second)
				if err := conn.Ping(c); err != nil && pctx.Err() == nil {
					conn.CloseNow()
				}
				cancel()
			}
		}
	}()
	if err := start(send); err != nil {
		return err
	}
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) == nil && head.Type == "ping" {
			_ = send(map[string]string{"type": "pong"})
			continue
		}
		on(send, raw)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
