package lighter

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	lgclient "github.com/elliottech/lighter-go/client"
)

// A fake Lighter on localhost: nothing leaves the test. It answers the reads with fixed data and keeps every
// signed transaction sent to it.
type fakeServer struct {
	mu       sync.Mutex
	txs      []map[string]any
	types    []string
	nonce    int64
	badNonce int // sendTx calls refused for their nonce
	auth     []string
}

func (f *fakeServer) handler() http.Handler {
	mux := http.NewServeMux()
	write := func(w http.ResponseWriter, v string) { _, _ = w.Write([]byte(v)) }
	mux.HandleFunc("/api/v1/orderBookDetails", func(w http.ResponseWriter, r *http.Request) {
		write(w, `{"code":200,"order_book_details":[
			{"market_id":1,"symbol":"BTC","market_type":"perp","status":"active","size_decimals":5,"price_decimals":1,
			 "min_base_amount":"0.00020","min_quote_amount":"10.000000","default_initial_margin_fraction":500},
			{"market_id":7,"symbol":"OLD","market_type":"perp","status":"inactive","size_decimals":2,"price_decimals":2,
			 "min_base_amount":"1","min_quote_amount":"10"},
			{"market_id":2048,"symbol":"ETH/USDC","market_type":"spot","status":"active","size_decimals":4,"price_decimals":2,
			 "min_base_amount":"0.01","min_quote_amount":"10"}]}`)
	})
	mux.HandleFunc("/api/v1/nextNonce", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.nonce++
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "nonce": f.nonce})
	})
	mux.HandleFunc("/api/v1/sendTx", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.badNonce > 0 {
			f.badNonce--
			w.WriteHeader(http.StatusBadRequest)
			write(w, `{"code":21104,"message":"invalid nonce"}`)
			return
		}
		var tx map[string]any
		_ = json.Unmarshal([]byte(r.Form.Get("tx_info")), &tx)
		f.txs = append(f.txs, tx)
		f.types = append(f.types, r.Form.Get("tx_type"))
		write(w, `{"code":200,"tx_hash":"0xabc"}`)
	})
	mux.HandleFunc("/api/v1/account", func(w http.ResponseWriter, r *http.Request) {
		write(w, `{"code":200,"accounts":[{"collateral":"1000.5","available_balance":"800","total_asset_value":"1020.25",
			"cross_asset_value":"1020.25","cross_initial_margin_requirement":"50","cross_maintenance_margin_requirement":null,
			"positions":[
			 {"market_id":1,"symbol":"BTC","position":"0.01000","sign":-1,"initial_margin_fraction":"20.00","margin_mode":0,
			  "avg_entry_price":"100000.0","position_value":"1000","unrealized_pnl":"-5","realized_pnl":"1","liquidation_price":"150000","allocated_margin":"0"},
			 {"market_id":2,"symbol":"ETH","position":"0","sign":1,"initial_margin_fraction":"10.00","margin_mode":1,
			  "avg_entry_price":"0","position_value":"0","unrealized_pnl":"0","realized_pnl":"0","liquidation_price":"0","allocated_margin":"0"}]}]}`)
	})
	mux.HandleFunc("/api/v1/accountLimits", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.auth = append(f.auth, r.Header.Get("authorization"))
		f.mu.Unlock()
		write(w, `{"code":200,"current_taker_fee_tick":280,"current_maker_fee_tick":40,"user_tier_name":"premium"}`)
	})
	mux.HandleFunc("/api/v1/accountActiveOrders", func(w http.ResponseWriter, r *http.Request) {
		write(w, `{"code":200,"orders":[{"order_index":281474976710656,"client_order_index":42,"market_index":1,"is_ask":true,
			"type":"stop-loss","price":"99000.0","trigger_price":"99500.0","remaining_base_amount":"0.01000","reduce_only":true,"status":"open"}]}`)
	})
	mux.HandleFunc("/api/v1/accountInactiveOrders", func(w http.ResponseWriter, r *http.Request) {
		write(w, `{"code":200,"orders":[{"order_index":5,"client_order_index":43,"market_index":1,"is_ask":false,"type":"limit",
			"price":"100.0","filled_base_amount":"0.00500","remaining_base_amount":"0","reduce_only":false,"status":"canceled-post-only"}]}`)
	})
	return mux
}

func setup(t *testing.T) (*fakeServer, *Trader) {
	t.Helper()
	f := &fakeServer{}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	c := NewClient(Config{URL: srv.URL, MaxSlippagePct: 0.5})
	if err := c.LoadMarkets(context.Background()); err != nil {
		t.Fatal(err)
	}
	key, _, err := lgclient.GenerateAPIKey() // a throwaway key: nothing here reaches Lighter
	if err != nil {
		t.Fatal(err)
	}
	tr := NewTrader(c, true)
	if err := tr.SetKey(123456, 3, key); err != nil {
		t.Fatal(err)
	}
	return f, tr
}

func num(v any) float64 { x, _ := v.(float64); return x }

func TestMarketsAndRounding(t *testing.T) {
	_, tr := setup(t)
	ms := tr.c.Markets()
	if len(ms) != 1 || ms[1].Symbol != "BTC" {
		t.Fatalf("only active perps: %v", ms)
	}
	m := ms[1]
	if m.MinBase != 0.0002 || m.MinQuote != 10 || m.DefaultLeverage != 20 || m.SizeDecimals != 5 || m.PriceDecimals != 1 {
		t.Fatalf("market fields: %+v", m)
	}
	if m.SizeInt(-0.0123) != 1230 || m.PriceInt(98765.4) != 987654 {
		t.Fatalf("to integers: %d %d", m.SizeInt(-0.0123), m.PriceInt(98765.4))
	}
	for _, c := range []struct{ x, want float64 }{{2.675, 2.67}, {0.125, 0.12}, {0.375, 0.38}, {100.05, 100.0}, {-1.25, -1.2}} {
		if got := Round(c.x, 2-boolInt(c.x == 100.05 || c.x == -1.25)); got != c.want {
			t.Errorf("Round(%v) = %v, want %v (Python's round)", c.x, got, c.want)
		}
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestAccount(t *testing.T) {
	f, tr := setup(t)
	acc, err := tr.Account(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if acc.Index != 123456 || acc.Collateral != 1000.5 || acc.Available != 800 || acc.TotalValue != 1020.25 ||
		acc.CrossValue == nil || *acc.CrossValue != 1020.25 || acc.Maintenance != nil || *acc.Initial != 50 {
		t.Fatalf("account fields: %+v", acc)
	}
	if len(acc.Positions) != 1 {
		t.Fatalf("flat markets left out: %+v", acc.Positions)
	}
	p := acc.Positions[0]
	if p.Size != -0.01 || p.Entry != 100000 || *p.Leverage != 5 || !p.Cross || p.Upnl != -5 || p.Liq != 150000 {
		t.Fatalf("position: %+v", p)
	}
	if s := acc.Settings[2]; s.Leverage != 10 || s.Cross {
		t.Fatalf("a market's leverage without a position: %+v", acc.Settings)
	}
	if acc.Fees == nil || math.Abs(acc.Fees.Taker-0.00028) > 1e-12 || acc.Fees.Tier != "premium" {
		t.Fatalf("fees: %+v", acc.Fees)
	}
	if len(f.auth) != 1 || !strings.HasPrefix(f.auth[0], "") || f.auth[0] == "" {
		t.Fatalf("an auth token for the private reads: %v", f.auth)
	}
	// the JSON keys are the Python server's
	b, _ := json.Marshal(acc)
	for _, k := range []string{`"total_value"`, `"cross_value"`, `"initial"`, `"maintenance":null`, `"positions"`, `"settings":{"1":`, `"fees":{"taker"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("account JSON lacks %s: %s", k, b)
		}
	}
}

func TestOrders(t *testing.T) {
	_, tr := setup(t)
	os, err := tr.ActiveOrders(context.Background(), 1)
	if err != nil || len(os) != 1 {
		t.Fatal(os, err)
	}
	o := os[0]
	if o.OrderIndex != 281474976710656 || o.ClientOrderIndex != 42 || !o.IsAsk || o.TriggerPrice != 99500 || o.Remaining != 0.01 || !o.ReduceOnly {
		t.Fatalf("active order: %+v", o)
	}
	out, err := tr.OrderOutcome(context.Background(), 1, 43)
	if err != nil || out == nil || out.Status != "canceled-post-only" || out.Filled != 0.005 {
		t.Fatalf("outcome: %+v %v", out, err)
	}
	if out, _ := tr.OrderOutcome(context.Background(), 1, 44); out != nil {
		t.Fatal("not listed yet: nil")
	}
}

// The signed transactions carry the fields the Python server's lighter_api.py would send for the same call.
func TestSignedOrders(t *testing.T) {
	f, tr := setup(t)
	ctx := context.Background()
	if _, err := tr.StopOrder(ctx, 1, 0.01, 99500, "sl"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.LimitOrder(ctx, 1, -0.02, 101000.04, false, true, 777); err != nil {
		t.Fatal(err)
	}
	if err := tr.ModifyStop(ctx, 1, 281474976710656, 0.01, 99600); err != nil {
		t.Fatal(err)
	}
	if err := tr.ModifyOrder(ctx, 1, 281474976710657, 0.02, 100900); err != nil {
		t.Fatal(err)
	}
	if err := tr.CancelOrder(ctx, 1, 281474976710657); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.MarketOrder(ctx, 1, 0.01, 100000, false); err != nil {
		t.Fatal(err)
	}
	sl, tp := 99000.0, 102000.0
	if _, err := tr.Entry(ctx, 1, 0.01, "market", 100500, &sl, &tp, 0.5); err != nil {
		t.Fatal(err)
	}
	if len(f.txs) != 7 {
		t.Fatalf("seven transactions: %d", len(f.txs))
	}
	want := []map[string]float64{
		// stop: closing a long sells, at trigger x (1 - 0.5%), IOC, reduce-only
		{"MarketIndex": 1, "BaseAmount": 1000, "Price": 990025, "IsAsk": 1, "Type": OrderStopLoss, "TimeInForce": TifIOC, "ReduceOnly": 1, "TriggerPrice": 995000},
		// post-only sell at the rounded price, with the caller's client order index
		{"MarketIndex": 1, "ClientOrderIndex": 777, "BaseAmount": 2000, "Price": 1010000, "IsAsk": 1, "Type": OrderLimit, "TimeInForce": TifPostOnly, "ReduceOnly": 0},
		{"MarketIndex": 1, "Index": 281474976710656, "BaseAmount": 1000, "Price": 991020, "TriggerPrice": 996000},
		{"MarketIndex": 1, "Index": 281474976710657, "BaseAmount": 2000, "Price": 1009000, "TriggerPrice": 0},
		{"MarketIndex": 1, "Index": 281474976710657},
		// market buy: worst price ref x (1 + 0.5%), IOC, no expiry
		{"MarketIndex": 1, "BaseAmount": 1000, "Price": 1005000, "IsAsk": 0, "Type": OrderMarket, "TimeInForce": TifIOC, "OrderExpiry": 0},
	}
	for i, w := range want {
		for k, v := range w {
			if got := num(f.txs[i][k]); got != v {
				t.Errorf("tx %d %s = %v, want %v (%v)", i, k, got, v, f.txs[i])
			}
		}
		if num(f.txs[i]["AccountIndex"]) != 123456 || num(f.txs[i]["ApiKeyIndex"]) != 3 || f.txs[i]["Sig"] == nil {
			t.Errorf("tx %d signed for the account and key: %v", i, f.txs[i])
		}
	}
	// the nonce is Lighter's next one each time
	for i, tx := range f.txs {
		if num(tx["Nonce"]) != float64(i+1) {
			t.Errorf("tx %d nonce %v", i, tx["Nonce"])
		}
	}
	// the entry with its SL and TP goes as one OTOCO group: the opening order and two reduce-only triggers
	g := f.txs[6]
	if num(g["GroupingType"]) != GroupOTOCO {
		t.Fatalf("OTOCO: %v", g)
	}
	orders, _ := g["Orders"].([]any)
	if len(orders) != 3 {
		t.Fatalf("three orders: %v", g)
	}
	tpo, slo := orders[1].(map[string]any), orders[2].(map[string]any)
	if num(tpo["Type"]) != OrderTakeProfit || num(tpo["TriggerPrice"]) != 1020000 || num(tpo["Price"]) != 1014900 || num(tpo["IsAsk"]) != 1 || num(tpo["ReduceOnly"]) != 1 || num(tpo["BaseAmount"]) != 0 {
		t.Errorf("take-profit: %v", tpo)
	}
	if num(slo["Type"]) != OrderStopLoss || num(slo["TriggerPrice"]) != 990000 || num(slo["Price"]) != 985050 {
		t.Errorf("stop-loss: %v", slo)
	}
}

func TestRefusedNonceAskedAgainOnce(t *testing.T) {
	f, tr := setup(t)
	f.badNonce = 1
	if _, err := tr.StopOrder(context.Background(), 1, 0.01, 99500, "sl"); err != nil {
		t.Fatalf("a refused nonce is asked again: %v", err)
	}
	if len(f.txs) != 1 || num(f.txs[0]["Nonce"]) != 2 {
		t.Fatalf("sent once with the new nonce: %v", f.txs)
	}
	f.badNonce = 2
	if _, err := tr.StopOrder(context.Background(), 1, 0.01, 99500, "sl"); err == nil || !strings.Contains(err.Error(), "nonce") {
		t.Fatalf("only once: %v", err)
	}
}

func TestCaps(t *testing.T) {
	_, tr := setup(t)
	tr.c.Cfg.MaxNotional = 500
	if _, err := tr.MarketOrder(context.Background(), 1, 0.01, 100000, false); err == nil || !strings.Contains(err.Error(), "MAX_NOTIONAL_USD") {
		t.Fatalf("the deck's notional cap: %v", err)
	}
	if _, err := tr.MarketOrder(context.Background(), 1, -0.01, 100000, true); err != nil {
		t.Fatalf("reduce-only isn't capped: %v", err)
	}
	visitor := NewTrader(tr.c, false)
	key, _, _ := lgclient.GenerateAPIKey()
	_ = visitor.SetKey(5, 4, key)
	if _, err := visitor.MarketOrder(context.Background(), 1, 0.01, 100000, false); err != nil {
		t.Fatalf("a visitor's key has no deck caps: %v", err)
	}
	_ = tr.SetKey(0, 0, "")
	if _, err := tr.StopOrder(context.Background(), 1, 0.01, 99500, "sl"); err == nil {
		t.Fatal("no key, no orders")
	}
}

func TestNewCOIIncreases(t *testing.T) {
	tr := NewTrader(NewClient(Config{URL: "https://x"}), false)
	last := int64(0)
	for i := 0; i < 1000; i++ {
		c := tr.NewCOI()
		if c <= last {
			t.Fatalf("client order index went back: %d after %d", c, last)
		}
		last = c
	}
}
