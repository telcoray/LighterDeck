package feed

import (
	"encoding/json"
	"testing"
)

func TestPricesMerge(t *testing.T) {
	p := NewPrices(func() map[int]float64 { return map[int]float64{2: 1000} })
	var payload map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"1": {"market_id": 1, "mark_price": "100.5", "best_bid_price": "100.4", "best_ask_price": 100.6, "daily_price_change": -1.5},
		"2": {"market_id": 2, "mark_price": "2000", "open_interest_usd": "5"}}`), &payload)
	p.merge(payload)
	s, _ := p.Stats(1)
	if s.Mark != 100.5 || s.Bid != 100.4 || s.Ask != 100.6 || s.Change != -1.5 {
		t.Fatalf("market 1: %+v", s)
	}
	s, _ = p.Stats(2)
	if s.Mark != 2 || s.OI != 5 {
		t.Fatalf("a multiplier divides prices only: %+v", s)
	}
	_ = json.Unmarshal([]byte(`{"1": {"market_id": 1, "best_bid_price": ""}}`), &payload)
	p.merge(map[string]json.RawMessage{"1": payload["1"]})
	s, _ = p.Stats(1)
	if s.Bid != 100.4 || s.Mark != 100.5 {
		t.Fatalf("an empty value keeps the last one: %+v", s)
	}
	if p.UpdatedAt().IsZero() {
		t.Fatal("updated time set")
	}
}
