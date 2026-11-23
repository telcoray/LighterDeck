// Package lighter talks to Lighter: public REST, authenticated reads and signed orders (the Go side of
// backend/lighter_api.py). Orders are signed here with Lighter's official Go signer (elliottech/lighter-go),
// the same code the Python SDK loads as a DLL and the browser as WebAssembly.
package lighter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Config holds what the client needs from the environment.
type Config struct {
	URL            string  // https://mainnet.zklighter.elliot.ai
	MaxSlippagePct float64 // worst-price margin for stop orders (MAX_SLIPPAGE_PCT, default 0.5)
	MaxNotional    float64 // MAX_NOTIONAL_USD on the deck's own key; 0 = no cap
	MaxOrdersDay   int     // MAX_ORDERS_PER_DAY on the deck's own key; 0 = no cap
}

// Client is the shared, keyless side: markets, public data, the HTTP connection.
type Client struct {
	Cfg     Config
	http    *http.Client
	chainID uint32

	mu      sync.RWMutex
	markets map[int]*Market

	candleMu sync.Mutex
	candles  map[string]candleHit
}

type candleHit struct {
	at   time.Time
	bars []Candle
}

func NewClient(cfg Config) *Client {
	if cfg.MaxSlippagePct == 0 {
		cfg.MaxSlippagePct = 0.5
	}
	cfg.URL = strings.TrimRight(cfg.URL, "/")
	return &Client{Cfg: cfg, http: &http.Client{Timeout: 15 * time.Second}, chainID: ChainID(cfg.URL),
		markets: map[int]*Market{}, candles: map[string]candleHit{}}
}

// ChainID of a Lighter URL, as the Python SDK picks it.
func ChainID(u string) uint32 {
	switch {
	case strings.Contains(u, "testnet.zklighter"), strings.Contains(u, "api.rh-testnet.lighter"):
		return 300
	case strings.Contains(u, "api.rh.lighter"):
		return 466324
	}
	return 304
}

// WSURL is the stream endpoint of the same network.
func (c *Client) WSURL() string {
	u := strings.Replace(c.Cfg.URL, "https://", "wss://", 1)
	return strings.Replace(u, "http://", "ws://", 1) + "/stream" // http: a local fake Lighter in tests
}

// ---------- REST ----------

type apiError struct {
	path string
	msg  string
}

func (e *apiError) Error() string { return e.path + ": " + e.msg }

func (c *Client) get(ctx context.Context, path string, params url.Values, auth string, out any) error {
	u := c.Cfg.URL + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	if auth != "" {
		req.Header.Set("authorization", auth)
	}
	return c.do(req, path, out)
}

func (c *Client) postForm(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Cfg.URL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return c.do(req, path, out)
}

func (c *Client) do(req *http.Request, path string, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var head struct {
		Code    *int   `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &head)
	if resp.StatusCode != http.StatusOK || (head.Code != nil && *head.Code != 200) {
		msg := head.Message
		if msg == "" {
			msg = strings.TrimSpace(string(body))
			if len(msg) > 300 {
				msg = msg[:300]
			}
		}
		code := resp.StatusCode
		if head.Code != nil {
			code = *head.Code
		}
		return &apiError{path, fmt.Sprintf("%d %s", code, msg)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}

// LoadMarkets reads the active perps.
func (c *Client) LoadMarkets(ctx context.Context) error {
	var data struct {
		Details []marketDetails `json:"order_book_details"`
	}
	if err := c.get(ctx, "/api/v1/orderBookDetails", nil, "", &data); err != nil {
		return err
	}
	ms := map[int]*Market{}
	for _, d := range data.Details {
		if d.MarketType == "perp" && d.Status == "active" {
			ms[d.MarketID] = newMarket(d)
		}
	}
	c.mu.Lock()
	c.markets = ms
	c.mu.Unlock()
	return nil
}

// SetMarkets replaces the markets (tests).
func (c *Client) SetMarkets(ms map[int]*Market) {
	c.mu.Lock()
	c.markets = ms
	c.mu.Unlock()
}

func (c *Client) Market(id int) *Market {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.markets[id]
}

func (c *Client) Markets() map[int]*Market {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[int]*Market, len(c.markets))
	for k, v := range c.markets {
		out[k] = v
	}
	return out
}

// Multipliers per market, for the price feed and the book.
func (c *Client) Multipliers() map[int]float64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[int]float64, len(c.markets))
	for k, v := range c.markets {
		out[k] = v.Multiplier
	}
	return out
}

// Candle is one OHLCV bar in display units; Time in unix seconds.
type Candle struct {
	Time   int64   `json:"time"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume float64 `json:"volume"`
}

var nativeSeconds = map[string]int64{"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400}

// Candles returns up to count (at most 500) of the latest bars of a timeframe Lighter serves, kept 5 seconds.
func (c *Client) Candles(ctx context.Context, marketID int, tf string, count int) ([]Candle, error) {
	secs, ok := nativeSeconds[tf]
	if !ok {
		return nil, fmt.Errorf("timeframe %s not served", tf)
	}
	if count > 500 {
		count = 500
	}
	key := fmt.Sprintf("%d/%s/%d", marketID, tf, count)
	c.candleMu.Lock()
	hit, ok := c.candles[key]
	c.candleMu.Unlock()
	if ok && time.Since(hit.at) < 5*time.Second {
		return hit.bars, nil
	}
	end := time.Now().Unix()
	var data struct {
		C []struct {
			T int64 `json:"t"`
			O flex  `json:"o"`
			H flex  `json:"h"`
			L flex  `json:"l"`
			C flex  `json:"c"`
			V flex  `json:"v"`
		} `json:"c"`
	}
	err := c.get(ctx, "/api/v1/candles", url.Values{
		"market_id": {fmt.Sprint(marketID)}, "resolution": {tf},
		"start_timestamp": {fmt.Sprint(end - secs*int64(count))}, "end_timestamp": {fmt.Sprint(end)},
		"count_back": {fmt.Sprint(count)}, "merge_mark_price": {"true"},
	}, "", &data)
	if err != nil {
		return nil, err
	}
	m := c.Market(marketID)
	dp, ds := func(v float64) float64 { return v }, func(v float64) float64 { return v }
	if m != nil {
		dp, ds = m.DispPrice, m.DispSize
	}
	bars := make([]Candle, 0, len(data.C))
	for _, b := range data.C {
		bars = append(bars, Candle{Time: b.T / 1000, Open: dp(float64(b.O)), High: dp(float64(b.H)), Low: dp(float64(b.L)),
			Close: dp(float64(b.C)), Volume: ds(float64(b.V))})
	}
	if len(bars) > count {
		bars = bars[len(bars)-count:]
	}
	c.candleMu.Lock()
	c.candles[key] = candleHit{time.Now(), bars}
	c.candleMu.Unlock()
	return bars, nil
}

// NextNonce asks Lighter for the key's next nonce.
func (c *Client) NextNonce(ctx context.Context, account int64, keyIndex uint8) (int64, error) {
	var data struct {
		Nonce int64 `json:"nonce"`
	}
	err := c.get(ctx, "/api/v1/nextNonce", url.Values{"account_index": {fmt.Sprint(account)}, "api_key_index": {fmt.Sprint(keyIndex)}}, "", &data)
	return data.Nonce, err
}
