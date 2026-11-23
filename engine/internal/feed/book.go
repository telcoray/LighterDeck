package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Stale: a quote older than this counts as none.
const Stale = 2 * time.Second

type side struct {
	levels map[float64]float64
	best   float64
	has    bool
}

type book struct {
	bids, asks side
	nonce      int64
	hasNonce   bool
}

type quote struct {
	bid, ask float64
	at       time.Time
}

// Book keeps the best bid and ask of the markets the engines are watching, from Lighter's order_book/{id}
// channel. Engines say which markets they need (Want); the watch subscribes to those and drops the others. A
// listener hears a market only when its best bid or ask changes. A gap in the book's nonces resubscribes for a
// fresh snapshot.
type Book struct {
	Multipliers func() map[int]float64

	mu        sync.Mutex
	books     map[int]*book
	quotes    map[int]quote
	wants     map[any]map[int]bool
	subs      map[int]bool
	listeners map[int]func(int) // by listener id
	nextL     int
	kick      chan struct{}
	now       func() time.Time
}

func NewBook(mult func() map[int]float64) *Book {
	return &Book{Multipliers: mult, books: map[int]*book{}, quotes: map[int]quote{}, wants: map[any]map[int]bool{},
		subs: map[int]bool{}, listeners: map[int]func(int){}, kick: make(chan struct{}, 1), now: time.Now}
}

// Listen adds a listener, called with a market id (from the websocket's goroutine: it must not block).
// It returns the id to Unlisten with.
func (b *Book) Listen(fn func(int)) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextL++
	b.listeners[b.nextL] = fn
	return b.nextL
}

func (b *Book) Unlisten(id int) {
	b.mu.Lock()
	delete(b.listeners, id)
	b.mu.Unlock()
}

// Want says which markets an owner needs (none drops the owner).
func (b *Book) Want(owner any, ids map[int]bool) {
	b.mu.Lock()
	cur := b.wants[owner]
	same := len(cur) == len(ids)
	for id := range ids {
		same = same && cur[id]
	}
	if same {
		b.mu.Unlock()
		return
	}
	if len(ids) > 0 {
		cp := make(map[int]bool, len(ids))
		for id := range ids {
			cp[id] = true
		}
		b.wants[owner] = cp
	} else {
		delete(b.wants, owner)
	}
	b.mu.Unlock()
	select {
	case b.kick <- struct{}{}:
	default:
	}
}

// Wanted is every market some owner needs.
func (b *Book) Wanted() map[int]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.wantedLocked()
}

func (b *Book) wantedLocked() map[int]bool {
	out := map[int]bool{}
	for _, ids := range b.wants {
		for id := range ids {
			out[id] = true
		}
	}
	return out
}

// Quote is the best bid and ask while fresh.
func (b *Book) Quote(id int) (bid, ask float64, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	q, ok := b.quotes[id]
	if !ok || b.now().Sub(q.at) >= Stale {
		return 0, 0, false
	}
	return q.bid, q.ask, true
}

// SetQuote puts a quote in directly (tests).
func (b *Book) SetQuote(id int, bid, ask float64, at time.Time) {
	b.mu.Lock()
	b.quotes[id] = quote{bid, ask, at}
	b.mu.Unlock()
}

// DropQuote removes a quote (tests).
func (b *Book) DropQuote(id int) {
	b.mu.Lock()
	delete(b.quotes, id)
	b.mu.Unlock()
}

// Subscribe marks markets as subscribed without a connection (tests).
func (b *Book) Subscribe(ids ...int) {
	b.mu.Lock()
	for _, id := range ids {
		b.subs[id] = true
	}
	b.mu.Unlock()
}

// Subs are the markets subscribed now.
func (b *Book) Subs() map[int]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[int]bool{}
	for id := range b.subs {
		out[id] = true
	}
	return out
}

// Best is the best bid and ask kept for a market, and whether both sides have one (tests).
func (b *Book) Best(id int) (bid, ask float64, bids, asks map[float64]float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bk := b.books[id]
	if bk == nil {
		return 0, 0, nil, nil
	}
	return bk.bids.best, bk.asks.best, bk.bids.levels, bk.asks.levels
}

// ---------- the connection ----------

// Run keeps the subscriptions open, reconnecting on any drop.
func (b *Book) Run(ctx context.Context, wsURL string) {
	for ctx.Err() == nil {
		err := stream(ctx, wsURL, func(send func(any) error) error {
			b.mu.Lock()
			b.subs, b.books, b.quotes = map[int]bool{}, map[int]*book{}, map[int]quote{}
			b.mu.Unlock()
			slog.Info("book watch connected")
			go func() {
				for {
					if err := b.Sync(send); err != nil {
						return
					}
					select {
					case <-ctx.Done():
						return
					case <-b.kick:
					}
				}
			}()
			return nil
		}, func(send func(any) error, raw []byte) {
			b.On(send, raw)
		})
		if ctx.Err() != nil {
			return
		}
		slog.Warn("book watch dropped; reconnecting", "err", err)
		b.mu.Lock()
		b.quotes = map[int]quote{}
		b.mu.Unlock()
		sleep(ctx, 3*time.Second)
	}
}

// Sync subscribes to the wanted markets and drops the others.
func (b *Book) Sync(send func(any) error) error {
	b.mu.Lock()
	wanted := b.wantedLocked()
	var add, drop []int
	for id := range wanted {
		if !b.subs[id] {
			add = append(add, id)
			b.subs[id] = true
		}
	}
	for id := range b.subs {
		if !wanted[id] {
			drop = append(drop, id)
			delete(b.subs, id)
			delete(b.books, id)
			delete(b.quotes, id)
		}
	}
	b.mu.Unlock()
	for _, id := range add {
		if err := send(map[string]string{"type": "subscribe", "channel": fmt.Sprintf("order_book/%d", id)}); err != nil {
			return err
		}
	}
	for _, id := range drop {
		if err := send(map[string]string{"type": "unsubscribe", "channel": fmt.Sprintf("order_book/%d", id)}); err != nil {
			return err
		}
	}
	return nil
}

type rawLevel struct {
	Price num `json:"price"`
	Size  num `json:"size"`
}

type bookMsg struct {
	Type      string `json:"type"`
	Channel   string `json:"channel"`
	OrderBook *struct {
		Bids       []rawLevel `json:"bids"`
		Asks       []rawLevel `json:"asks"`
		Nonce      *int64     `json:"nonce"`
		BeginNonce *int64     `json:"begin_nonce"`
	} `json:"order_book"`
}

// On handles one message from the websocket.
func (b *Book) On(send func(any) error, raw []byte) {
	var msg bookMsg
	if json.Unmarshal(raw, &msg) != nil || !strings.HasSuffix(msg.Type, "order_book") || msg.OrderBook == nil {
		return
	}
	ch := msg.Channel
	if i := strings.LastIndexAny(ch, ":/"); i >= 0 {
		ch = ch[i+1:]
	}
	mid, err := strconv.Atoi(ch)
	if err != nil {
		return
	}
	ob := msg.OrderBook
	b.mu.Lock()
	if !b.subs[mid] {
		b.mu.Unlock()
		return
	}
	bk := b.books[mid]
	if bk == nil {
		bk = &book{bids: side{levels: map[float64]float64{}}, asks: side{levels: map[float64]float64{}}}
		b.books[mid] = bk
	}
	if msg.Type == "subscribed/order_book" {
		bk.bids, bk.asks = side{levels: map[float64]float64{}}, side{levels: map[float64]float64{}}
	} else if bk.hasNonce && ob.BeginNonce != nil && *ob.BeginNonce != bk.nonce {
		// an update went missing: start over from a fresh snapshot
		delete(b.books, mid)
		delete(b.quotes, mid)
		b.mu.Unlock()
		ch := fmt.Sprintf("order_book/%d", mid)
		_ = send(map[string]string{"type": "unsubscribe", "channel": ch})
		_ = send(map[string]string{"type": "subscribe", "channel": ch})
		return
	}
	mult := 1.0
	if b.Multipliers != nil {
		if m := b.Multipliers()[mid]; m != 0 {
			mult = m
		}
	}
	// the best of each side is kept as levels come and go; only when the best one leaves is the side scanned
	// again (a busy book has thousands of levels and an update every few milliseconds)
	apply(&bk.bids, ob.Bids, mult, func(a, c float64) bool { return a > c })
	apply(&bk.asks, ob.Asks, mult, func(a, c float64) bool { return a < c })
	if ob.Nonce != nil {
		bk.nonce, bk.hasNonce = *ob.Nonce, true
	} else {
		bk.hasNonce = false
	}
	if !bk.bids.has || !bk.asks.has {
		b.mu.Unlock()
		return
	}
	old, had := b.quotes[mid]
	b.quotes[mid] = quote{bk.bids.best, bk.asks.best, b.now()}
	var fns []func(int)
	if !had || old.bid != bk.bids.best || old.ask != bk.asks.best {
		for _, fn := range b.listeners {
			fns = append(fns, fn)
		}
	}
	b.mu.Unlock()
	for _, fn := range fns {
		fn(mid)
	}
}

func apply(s *side, levels []rawLevel, mult float64, better func(a, c float64) bool) {
	lost := false
	for _, l := range levels {
		if !l.Price.ok {
			continue
		}
		price, size := l.Price.v/mult, l.Size.v*mult
		if size > 0 {
			s.levels[price] = size
			if !lost && (!s.has || better(price, s.best)) {
				s.best, s.has = price, true
			}
		} else {
			delete(s.levels, price)
			lost = lost || (s.has && price == s.best)
		}
	}
	if lost { // the best level left: whatever came in the same message, scan the side again
		s.has = false
		for p := range s.levels {
			if !s.has || better(p, s.best) {
				s.best, s.has = p, true
			}
		}
	}
}
