package feed

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"
)

// The order book checks of tests/offline/test_fast.py.

type sent []map[string]string

func (s *sent) send(v any) error {
	b, _ := json.Marshal(v)
	var m map[string]string
	_ = json.Unmarshal(b, &m)
	*s = append(*s, m)
	return nil
}

type lv struct{ p, s float64 }

func levels(ls []lv) []map[string]string {
	out := []map[string]string{}
	for _, l := range ls {
		out = append(out, map[string]string{"price": fmt.Sprint(l.p), "size": fmt.Sprint(l.s)})
	}
	return out
}

func snap(mid int, bids, asks []lv, nonce int64) []byte {
	b, _ := json.Marshal(map[string]any{"type": "subscribed/order_book", "channel": fmt.Sprintf("order_book:%d", mid),
		"order_book": map[string]any{"bids": levels(bids), "asks": levels(asks), "nonce": nonce}})
	return b
}

func upd(mid int, bids, asks []lv, begin, nonce int64) []byte {
	b, _ := json.Marshal(map[string]any{"type": "update/order_book", "channel": fmt.Sprintf("order_book:%d", mid),
		"order_book": map[string]any{"bids": levels(bids), "asks": levels(asks), "begin_nonce": begin, "nonce": nonce}})
	return b
}

func TestBook(t *testing.T) {
	b, ws := NewBook(nil), &sent{}
	var heard []int
	b.Subscribe(1)
	b.Listen(func(id int) { heard = append(heard, id) })
	b.On(ws.send, snap(1, []lv{{99.9, 1}, {99.8, 2}}, []lv{{100.1, 1}, {100.2, 3}}, 10))
	bid, ask, ok := b.Quote(1)
	if !ok || bid != 99.9 || ask != 100.1 {
		t.Fatalf("best bid/ask from the snapshot: %v %v %v", bid, ask, ok)
	}
	if len(heard) != 1 {
		t.Fatalf("listener told: %v", heard)
	}
	b.On(ws.send, upd(1, nil, []lv{{100.2, 5}}, 10, 11))
	if len(heard) != 1 {
		t.Fatalf("no new best, nobody woken: %v", heard)
	}
	b.On(ws.send, upd(1, []lv{{99.9, 0}}, nil, 11, 12))
	bid, _, _ = b.Quote(1)
	if bid != 99.8 || len(heard) != 2 {
		t.Fatalf("a level removed moves the best bid: %v %v", bid, heard)
	}
	b.On(ws.send, upd(1, []lv{{99.95, 1}}, nil, 99, 100))
	if _, _, ok := b.Quote(1); ok || len(*ws) != 2 || (*ws)[0]["type"] != "unsubscribe" || (*ws)[1]["type"] != "subscribe" {
		t.Fatalf("a nonce gap resubscribes and drops the quote: %v", *ws)
	}
	b.On(ws.send, snap(2, []lv{{1, 1}}, []lv{{2, 1}}, 1))
	if _, _, ok := b.Quote(2); ok {
		t.Fatal("a market not subscribed is ignored")
	}
	b.On(ws.send, snap(1, []lv{{99.9, 1}}, []lv{{100.1, 1}}, 200))
	b.SetQuote(1, 99.9, 100.1, time.Now().Add(-5*time.Second))
	if _, _, ok := b.Quote(1); ok {
		t.Fatal("a stale quote counts as none")
	}

	b.Want("a", map[int]bool{1: true, 3: true})
	b.Want("b", map[int]bool{3: true, 4: true})
	if w := b.Wanted(); len(w) != 3 || !w[1] || !w[3] || !w[4] {
		t.Fatalf("wanted is the union: %v", w)
	}
	b.Want("a", nil)
	if w := b.Wanted(); len(w) != 2 || w[1] {
		t.Fatalf("an owner with nothing drops out: %v", w)
	}
	ws2 := &sent{}
	b.mu.Lock()
	b.subs = map[int]bool{1: true, 3: true}
	b.mu.Unlock()
	_ = b.Sync(ws2.send)
	got := map[string]bool{}
	for _, m := range *ws2 {
		got[m["type"]+" "+m["channel"]] = true
	}
	subs := b.Subs()
	if len(got) != 2 || !got["subscribe order_book/4"] || !got["unsubscribe order_book/1"] || len(subs) != 2 || !subs[3] || !subs[4] {
		t.Fatalf("sync subscribes and unsubscribes: %v %v", *ws2, subs)
	}
}

// The best kept level by level matches a full scan, also when the best leaves and a worse one comes in the same
// message.
func TestBookBestMatchesAFullScan(t *testing.T) {
	rnd := rand.New(rand.NewPCG(7, 7))
	b, ws := NewBook(nil), &sent{}
	b.Subscribe(5)
	var bids, asks []lv
	for i := 0; i < 20; i++ {
		bids = append(bids, lv{100 - float64(i)*0.1, 1})
		asks = append(asks, lv{100.1 + float64(i)*0.1, 1})
	}
	b.On(ws.send, snap(5, bids, asks, 0))
	wrong := 0
	for k := int64(0); k < 3000; k++ {
		isBid := rnd.IntN(2) == 0
		_, _, curB, curA := b.Best(5)
		cur := curA
		if isBid {
			cur = curB
		}
		var ls []lv
		if len(cur) > 0 && rnd.Float64() < 0.5 {
			keys := make([]float64, 0, len(cur))
			for p := range cur {
				keys = append(keys, p)
			}
			ls = append(ls, lv{keys[rnd.IntN(len(keys))], 0}) // a level leaves (often the best)
			if rnd.Float64() < 0.5 {
				best := keys[0]
				for _, p := range keys {
					if (isBid && p > best) || (!isBid && p < best) {
						best = p
					}
				}
				ls = append(ls, lv{best, 0})
			}
		}
		var p float64
		if isBid {
			p = 100 - rnd.Float64()*3
		} else {
			p = 100.1 + rnd.Float64()*3
		}
		ls = append(ls, lv{float64(int64(p*10+0.5)) / 10, float64(rnd.IntN(3))})
		if isBid {
			b.On(ws.send, upd(5, ls, nil, k, k+1))
		} else {
			b.On(ws.send, upd(5, nil, ls, k, k+1))
		}
		bb, ba, lb, la := b.Best(5)
		if len(lb) > 0 && len(la) > 0 {
			mx, mn := -1e18, 1e18
			for p := range lb {
				mx = max(mx, p)
			}
			for p := range la {
				mn = min(mn, p)
			}
			if bb != mx || ba != mn {
				wrong++
			}
		}
	}
	if wrong != 0 {
		t.Fatalf("best kept per level differs from a full scan %d times in 3000 updates", wrong)
	}
}
