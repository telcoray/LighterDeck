package lighter

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	lgclient "github.com/elliottech/lighter-go/client"
	lgtypes "github.com/elliottech/lighter-go/types"
	"github.com/elliottech/lighter-go/types/txtypes"
)

// Lighter's order constants (the Python SDK's SignerClient).
const (
	OrderLimit           = 0
	OrderMarket          = 1
	OrderStopLoss        = 2
	OrderStopLossLimit   = 3
	OrderTakeProfit      = 4
	OrderTakeProfitLimit = 5

	TifIOC      = 0
	TifGTT      = 1
	TifPostOnly = 2

	GroupOTO   = 1
	GroupOTOCO = 3

	expiry28Days = -1 // the signer's 28-day default
	expiryIOC    = 0
)

// ErrNoKey: the trader has no key to sign with.
var ErrNoKey = errors.New("trading disabled: no API key configured")

// Trader is one Lighter account and API key: the deck's own (key set from the Python server, env caps apply),
// or a visitor's dedicated automation key (no caps). It reads the account and signs and sends its orders.
type Trader struct {
	c    *Client
	caps bool // the deck's MAX_NOTIONAL_USD / MAX_ORDERS_PER_DAY

	mu       sync.RWMutex
	account  int64
	keyIndex uint8
	tx       *lgclient.TxClient

	sendMu sync.Mutex // one transaction at a time on this key: nonce fetched, signed, sent

	authMu   sync.Mutex
	token    string
	tokenExp time.Time

	feesMu sync.Mutex
	fees   *Fees
	feesAt time.Time

	coiMu   sync.Mutex
	lastCOI int64

	dayMu sync.Mutex
	day   string
	dayN  int
}

func NewTrader(c *Client, caps bool) *Trader { return &Trader{c: c, caps: caps} }

func (t *Trader) Client() *Client { return t.c }

// SetKey arms the trader with a key (privateKey "" clears it). The key was checked with Lighter by the caller.
func (t *Trader) SetKey(account int64, keyIndex int, privateKey string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.authMu.Lock()
	t.token = ""
	t.authMu.Unlock()
	t.feesMu.Lock()
	t.fees, t.feesAt = nil, time.Time{}
	t.feesMu.Unlock()
	if privateKey == "" {
		t.tx, t.account, t.keyIndex = nil, 0, 0
		return nil
	}
	if keyIndex < 0 || keyIndex > 254 {
		return fmt.Errorf("bad api key index %d", keyIndex)
	}
	tx, err := lgclient.NewTxClient(nil, privateKey, account, uint8(keyIndex), t.c.chainID)
	if err != nil {
		return err
	}
	t.tx, t.account, t.keyIndex = tx, account, uint8(keyIndex)
	return nil
}

func (t *Trader) HasSigner() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.tx != nil
}

func (t *Trader) AccountIndex() (int64, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.account, t.tx != nil
}

func (t *Trader) KeyIndex() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return int(t.keyIndex)
}

func (t *Trader) Market(id int) *Market { return t.c.Market(id) }

// NewCOI is a client order index: the time in ms, kept increasing so two orders never share one.
func (t *Trader) NewCOI() int64 {
	t.coiMu.Lock()
	defer t.coiMu.Unlock()
	c := time.Now().UnixMilli() % (1 << 47)
	if c <= t.lastCOI {
		c = t.lastCOI + 1
	}
	t.lastCOI = c
	return c
}

// ---------- auth ----------

func (t *Trader) authToken() (string, error) {
	t.mu.RLock()
	tx := t.tx
	t.mu.RUnlock()
	if tx == nil {
		return "", ErrNoKey
	}
	t.authMu.Lock()
	defer t.authMu.Unlock()
	if t.token != "" && time.Now().Before(t.tokenExp.Add(-time.Minute)) {
		return t.token, nil
	}
	exp := time.Now().Add(10 * time.Minute)
	tok, err := tx.GetAuthToken(exp)
	if err != nil {
		return "", fmt.Errorf("auth token: %w", err)
	}
	t.token, t.tokenExp = tok, exp
	return tok, nil
}

// ---------- the account ----------

// Position is an open position as the deck's tables show it (display units).
type Position struct {
	MarketID int      `json:"market_id"`
	Symbol   string   `json:"symbol"`
	Size     float64  `json:"size"`
	Entry    float64  `json:"entry"`
	Value    float64  `json:"value"`
	Upnl     float64  `json:"upnl"`
	Rpnl     float64  `json:"rpnl"`
	Liq      float64  `json:"liq"`
	Margin   float64  `json:"margin"`
	Leverage *float64 `json:"leverage"`
	Cross    bool     `json:"cross"`
}

type Setting struct {
	Leverage float64 `json:"leverage"`
	Cross    bool    `json:"cross"`
}

type Fees struct {
	Taker float64 `json:"taker"`
	Maker float64 `json:"maker"`
	Tier  any     `json:"tier"`
}

// Account is backend/lighter_api.py account(): the same keys, so the Python server can use it as it is.
type Account struct {
	Index       int64           `json:"index"`
	Collateral  float64         `json:"collateral"`
	Available   float64         `json:"available"`
	TotalValue  float64         `json:"total_value"`
	CrossValue  *float64        `json:"cross_value"`
	Initial     *float64        `json:"initial"`
	Maintenance *float64        `json:"maintenance"`
	Positions   []Position      `json:"positions"`
	Settings    map[int]Setting `json:"settings"`
	Fees        *Fees           `json:"fees"`
}

// Position of a market, nil when flat.
func (a *Account) Position(marketID int) *Position {
	if a == nil {
		return nil
	}
	for i := range a.Positions {
		if a.Positions[i].MarketID == marketID {
			return &a.Positions[i]
		}
	}
	return nil
}

type optFlex struct {
	set bool
	v   float64
}

func (o *optFlex) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var f flex
	if err := f.UnmarshalJSON(b); err != nil {
		return err
	}
	o.set, o.v = true, float64(f)
	return nil
}

func (o optFlex) ptr() *float64 {
	if !o.set {
		return nil
	}
	v := o.v
	return &v
}

// Account reads the account; nil without a key.
func (t *Trader) Account(ctx context.Context) (*Account, error) {
	account, ok := t.AccountIndex()
	if !ok {
		return nil, nil
	}
	var data struct {
		Accounts []struct {
			Collateral  flex    `json:"collateral"`
			Available   flex    `json:"available_balance"`
			Total       flex    `json:"total_asset_value"`
			CrossValue  optFlex `json:"cross_asset_value"`
			Initial     optFlex `json:"cross_initial_margin_requirement"`
			Maintenance optFlex `json:"cross_maintenance_margin_requirement"`
			Positions   []struct {
				MarketID   int    `json:"market_id"`
				Symbol     string `json:"symbol"`
				Position   flex   `json:"position"`
				Sign       int    `json:"sign"`
				IMF        flex   `json:"initial_margin_fraction"`
				MarginMode int    `json:"margin_mode"`
				Entry      flex   `json:"avg_entry_price"`
				Value      flex   `json:"position_value"`
				Upnl       flex   `json:"unrealized_pnl"`
				Rpnl       flex   `json:"realized_pnl"`
				Liq        flex   `json:"liquidation_price"`
				Margin     flex   `json:"allocated_margin"`
			} `json:"positions"`
		} `json:"accounts"`
	}
	if err := t.c.get(ctx, "/api/v1/account", url.Values{"by": {"index"}, "value": {fmt.Sprint(account)}}, "", &data); err != nil {
		return nil, err
	}
	if len(data.Accounts) == 0 {
		return nil, fmt.Errorf("account %d not found", account)
	}
	acc := data.Accounts[0]
	out := &Account{Index: account, Collateral: float64(acc.Collateral), Available: float64(acc.Available),
		TotalValue: float64(acc.Total), CrossValue: acc.CrossValue.ptr(), Initial: acc.Initial.ptr(),
		Maintenance: acc.Maintenance.ptr(), Positions: []Position{}, Settings: map[int]Setting{}}
	for _, p := range acc.Positions {
		size := float64(p.Position)
		if p.Sign < 0 {
			size = -size
		}
		imf := float64(p.IMF) // percent
		var lev *float64
		if imf != 0 {
			l := Round(100/imf, 1)
			lev = &l
			out.Settings[p.MarketID] = Setting{Leverage: l, Cross: p.MarginMode == 0}
		}
		if size == 0 {
			continue
		}
		m := t.c.Market(p.MarketID)
		dp := func(v float64) float64 { return v }
		if m != nil {
			dp = m.DispPrice
			size = m.DispSize(size)
		}
		out.Positions = append(out.Positions, Position{MarketID: p.MarketID, Symbol: p.Symbol, Size: size,
			Entry: dp(float64(p.Entry)), Value: float64(p.Value), Upnl: float64(p.Upnl), Rpnl: float64(p.Rpnl),
			Liq: dp(float64(p.Liq)), Margin: float64(p.Margin), Leverage: lev, Cross: p.MarginMode == 0})
	}
	out.Fees = t.feeRates(ctx)
	return out, nil
}

// feeRates are the account's own taker and maker fees (its plan), asked every 10 minutes; nil until known.
func (t *Trader) feeRates(ctx context.Context) *Fees {
	t.feesMu.Lock()
	fees, at := t.fees, t.feesAt
	if time.Since(at) < 10*time.Minute {
		t.feesMu.Unlock()
		return fees
	}
	t.feesAt = time.Now()
	t.feesMu.Unlock()
	account, _ := t.AccountIndex()
	tok, err := t.authToken()
	if err != nil {
		return fees
	}
	var data struct {
		Taker    float64 `json:"current_taker_fee_tick"`
		Maker    float64 `json:"current_maker_fee_tick"`
		TierName string  `json:"user_tier_name"`
		Tier     any     `json:"user_tier"`
	}
	if err := t.c.get(ctx, "/api/v1/accountLimits", url.Values{"account_index": {fmt.Sprint(account)}}, tok, &data); err != nil {
		slog.Info("account fees not read", "err", err)
		return fees
	}
	f := &Fees{Taker: data.Taker / 1e6, Maker: data.Maker / 1e6, Tier: data.Tier}
	if data.TierName != "" {
		f.Tier = data.TierName
	}
	t.feesMu.Lock()
	t.fees = f
	t.feesMu.Unlock()
	return f
}

// Order is an order on the book.
type Order struct {
	OrderIndex       int64   `json:"order_index"`
	ClientOrderIndex int64   `json:"client_order_index"`
	MarketID         int     `json:"market_id"`
	IsAsk            bool    `json:"is_ask"`
	Type             string  `json:"type"`
	Price            float64 `json:"price"`
	TriggerPrice     float64 `json:"trigger_price"`
	Remaining        float64 `json:"remaining"`
	ReduceOnly       bool    `json:"reduce_only"`
	Status           string  `json:"status"`
}

type rawOrder struct {
	OrderIndex       int64  `json:"order_index"`
	ClientOrderIndex int64  `json:"client_order_index"`
	MarketIndex      int    `json:"market_index"`
	IsAsk            bool   `json:"is_ask"`
	Type             string `json:"type"`
	Price            flex   `json:"price"`
	TriggerPrice     flex   `json:"trigger_price"`
	Remaining        flex   `json:"remaining_base_amount"`
	Filled           flex   `json:"filled_base_amount"`
	ReduceOnly       bool   `json:"reduce_only"`
	Status           string `json:"status"`
}

// ActiveOrders of a market.
func (t *Trader) ActiveOrders(ctx context.Context, marketID int) ([]Order, error) {
	account, ok := t.AccountIndex()
	if !ok {
		return nil, nil
	}
	tok, err := t.authToken()
	if err != nil {
		return nil, err
	}
	var data struct {
		Orders []rawOrder `json:"orders"`
	}
	if err := t.c.get(ctx, "/api/v1/accountActiveOrders", url.Values{"account_index": {fmt.Sprint(account)}, "market_id": {fmt.Sprint(marketID)}}, tok, &data); err != nil {
		return nil, err
	}
	m := t.c.Market(marketID)
	out := make([]Order, 0, len(data.Orders))
	for _, o := range data.Orders {
		p, tp, rem := float64(o.Price), float64(o.TriggerPrice), float64(o.Remaining)
		if m != nil {
			p, tp, rem = m.DispPrice(p), m.DispPrice(tp), m.DispSize(rem)
		}
		out = append(out, Order{OrderIndex: o.OrderIndex, ClientOrderIndex: o.ClientOrderIndex, MarketID: o.MarketIndex,
			IsAsk: o.IsAsk, Type: o.Type, Price: p, TriggerPrice: tp, Remaining: rem, ReduceOnly: o.ReduceOnly, Status: o.Status})
	}
	return out, nil
}

// Outcome is how an order that left the book ended.
type Outcome struct {
	Status string  `json:"status"`
	Filled float64 `json:"filled"`
}

// OrderOutcome of an order by its client order index; nil while Lighter doesn't list it.
func (t *Trader) OrderOutcome(ctx context.Context, marketID int, coi int64) (*Outcome, error) {
	account, ok := t.AccountIndex()
	if !ok {
		return nil, ErrNoKey
	}
	tok, err := t.authToken()
	if err != nil {
		return nil, err
	}
	var data struct {
		Orders []rawOrder `json:"orders"`
	}
	if err := t.c.get(ctx, "/api/v1/accountInactiveOrders", url.Values{"account_index": {fmt.Sprint(account)}, "market_id": {fmt.Sprint(marketID)}, "limit": {"50"}}, tok, &data); err != nil {
		return nil, err
	}
	m := t.c.Market(marketID)
	for _, o := range data.Orders {
		if o.ClientOrderIndex == coi {
			f := float64(o.Filled)
			if m != nil {
				f = m.DispSize(f)
			}
			return &Outcome{Status: o.Status, Filled: f}, nil
		}
	}
	return nil, nil
}

// DailyPnL since 00:00 UTC from Lighter's hourly account PnL series; nil when the midnight point is missing.
func (t *Trader) DailyPnL(ctx context.Context) (*float64, error) {
	account, ok := t.AccountIndex()
	if !ok {
		v := 0.0
		return &v, nil
	}
	tok, err := t.authToken()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	midnight := now / 86400 * 86400
	var data struct {
		PnL []struct {
			Timestamp int64 `json:"timestamp"`
			TradePnL  flex  `json:"trade_pnl"`
		} `json:"pnl"`
	}
	err = t.c.get(ctx, "/api/v1/pnl", url.Values{"by": {"index"}, "value": {fmt.Sprint(account)}, "resolution": {"1h"},
		"start_timestamp": {fmt.Sprint(midnight)}, "end_timestamp": {fmt.Sprint(now)}, "count_back": {"0"}}, tok, &data)
	if err != nil {
		return nil, err
	}
	for _, p := range data.PnL {
		if p.Timestamp == midnight {
			v := float64(data.PnL[len(data.PnL)-1].TradePnL) - float64(p.TradePnL)
			return &v, nil
		}
	}
	return nil, nil
}

// ---------- signed actions ----------

func (t *Trader) checkLimits(notional float64) error {
	if !t.HasSigner() {
		return ErrNoKey
	}
	if !t.caps {
		return nil
	}
	cfg := t.c.Cfg
	if cfg.MaxNotional > 0 && notional > cfg.MaxNotional {
		return fmt.Errorf("order $%.0f exceeds MAX_NOTIONAL_USD $%.0f", notional, cfg.MaxNotional)
	}
	t.dayMu.Lock()
	defer t.dayMu.Unlock()
	today := time.Now().Format("2006-01-02")
	if t.day != today {
		t.day, t.dayN = today, 0
	}
	if cfg.MaxOrdersDay > 0 && t.dayN >= cfg.MaxOrdersDay {
		return fmt.Errorf("MAX_ORDERS_PER_DAY (%d) reached", cfg.MaxOrdersDay)
	}
	t.dayN++
	return nil
}

// send signs one transaction with a fresh nonce from Lighter and sends it. The Python server signs the deck's
// manual orders with the same key, so the two can ask for a nonce at the same moment: a refused nonce is asked
// again once.
func (t *Trader) send(ctx context.Context, what string, sign func(tx *lgclient.TxClient, ops *lgtypes.TransactOpts) (txtypes.TxInfo, error)) error {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.RLock()
	tx, account, keyIndex := t.tx, t.account, t.keyIndex
	t.mu.RUnlock()
	if tx == nil {
		return ErrNoKey
	}
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		var nonce int64
		nonce, err = t.c.NextNonce(ctx, account, keyIndex)
		if err != nil {
			return fmt.Errorf("%s: %w", what, err)
		}
		var info txtypes.TxInfo
		info, err = sign(tx, &lgtypes.TransactOpts{Nonce: &nonce})
		if err != nil {
			return fmt.Errorf("%s: %w", what, err)
		}
		var body string
		body, err = info.GetTxInfo()
		if err != nil {
			return fmt.Errorf("%s: %w", what, err)
		}
		var resp struct {
			TxHash string `json:"tx_hash"`
		}
		err = t.c.postForm(ctx, "/api/v1/sendTx", url.Values{"tx_type": {fmt.Sprint(info.GetTxType())}, "tx_info": {body}}, &resp)
		if err == nil {
			slog.Info(what+" ok", "tx", resp.TxHash)
			return nil
		}
		if !strings.Contains(strings.ToLower(err.Error()), "nonce") {
			break
		}
	}
	return fmt.Errorf("%s: %w", what, err)
}

func side(size float64) string {
	if size < 0 {
		return "sell"
	}
	return "buy"
}

func b2u(b bool) uint8 {
	if b {
		return 1
	}
	return 0
}

func (t *Trader) market(id int) (*Market, error) {
	m := t.c.Market(id)
	if m == nil {
		return nil, fmt.Errorf("unknown market %d", id)
	}
	return m, nil
}

func expiry(e int64) int64 {
	if e == expiry28Days {
		return time.Now().Add(28 * 24 * time.Hour).UnixMilli()
	}
	return e
}

func (t *Trader) createOrder(ctx context.Context, what string, o *lgtypes.CreateOrderTxReq) error {
	o.OrderExpiry = expiry(o.OrderExpiry)
	return t.send(ctx, what, func(tx *lgclient.TxClient, ops *lgtypes.TransactOpts) (txtypes.TxInfo, error) {
		return tx.GetCreateOrderTransaction(o, ops)
	})
}

// MarketOrder: size > 0 buys, < 0 sells; the worst price is ref +/- the default slippage.
func (t *Trader) MarketOrder(ctx context.Context, marketID int, size, ref float64, reduceOnly bool) (int64, error) {
	m, err := t.market(marketID)
	if err != nil {
		return 0, err
	}
	slip := t.c.Cfg.MaxSlippagePct / 100
	isAsk := size < 0
	worst := ref * (1 + slip)
	if isAsk {
		worst = ref * (1 - slip)
	}
	worst = m.RoundPrice(worst)
	if !reduceOnly {
		if err := t.checkLimits(math.Abs(size) * ref); err != nil {
			return 0, err
		}
	}
	coi := t.NewCOI()
	return coi, t.createOrder(ctx, fmt.Sprintf("market %s %g %s", side(size), math.Abs(size), m.Symbol), &lgtypes.CreateOrderTxReq{
		MarketIndex: int64(marketID), ClientOrderIndex: coi, BaseAmount: m.SizeInt(size), Price: m.PriceInt(worst),
		IsAsk: b2u(isAsk), Type: OrderMarket, TimeInForce: TifIOC, ReduceOnly: b2u(reduceOnly), OrderExpiry: expiryIOC})
}

// LimitOrder: good till time (28 days) or post-only; coi 0 picks one.
func (t *Trader) LimitOrder(ctx context.Context, marketID int, size, price float64, reduceOnly, postOnly bool, coi int64) (int64, error) {
	m, err := t.market(marketID)
	if err != nil {
		return 0, err
	}
	if !reduceOnly {
		if err := t.checkLimits(math.Abs(size) * price); err != nil {
			return 0, err
		}
	}
	tif := uint8(TifGTT)
	if postOnly {
		tif = TifPostOnly
	}
	if coi == 0 {
		coi = t.NewCOI()
	}
	return coi, t.createOrder(ctx, fmt.Sprintf("limit %s %g %s @ %g", side(size), math.Abs(size), m.Symbol, price), &lgtypes.CreateOrderTxReq{
		MarketIndex: int64(marketID), ClientOrderIndex: coi, BaseAmount: m.SizeInt(size), Price: m.PriceInt(m.RoundPrice(price)),
		IsAsk: b2u(size < 0), Type: OrderLimit, TimeInForce: tif, ReduceOnly: b2u(reduceOnly), OrderExpiry: expiry28Days})
}

// Entry is an opening order with Lighter's own SL/TP attached (OTO / OTOCO): size > 0 buys; for a market order
// price is the worst fill, for a limit the limit price. The SL/TP close the whole position (base amount 0).
func (t *Trader) Entry(ctx context.Context, marketID int, size float64, kind string, price float64, sl, tp *float64, slippagePct float64) (int64, error) {
	m, err := t.market(marketID)
	if err != nil {
		return 0, err
	}
	if err := t.checkLimits(math.Abs(size) * price); err != nil {
		return 0, err
	}
	isAsk := size < 0
	tif, typ, exp := uint8(TifGTT), uint8(OrderLimit), int64(expiry28Days)
	if kind == "market" {
		tif, typ, exp = TifIOC, OrderMarket, expiryIOC
	}
	coi := t.NewCOI()
	orders := []*lgtypes.CreateOrderTxReq{{MarketIndex: int64(marketID), ClientOrderIndex: coi, BaseAmount: m.SizeInt(size),
		Price: m.PriceInt(m.RoundPrice(price)), IsAsk: b2u(isAsk), Type: typ, TimeInForce: tif, OrderExpiry: exp}}
	slip := slippagePct / 100
	label := fmt.Sprintf("%s %s %g %s @ %g", kind, side(size), math.Abs(size), m.Symbol, price)
	for _, p := range []struct {
		trigger *float64
		typ     uint8
		name    string
	}{{tp, OrderTakeProfit, "tp"}, {sl, OrderStopLoss, "sl"}} {
		if p.trigger == nil || *p.trigger == 0 {
			continue
		}
		worst := *p.trigger * (1 - slip) // closing side: a long exits by selling
		if isAsk {
			worst = *p.trigger * (1 + slip)
		}
		orders = append(orders, &lgtypes.CreateOrderTxReq{MarketIndex: int64(marketID), ClientOrderIndex: coi + int64(len(orders)),
			BaseAmount: 0, Price: m.PriceInt(m.RoundPrice(worst)), IsAsk: b2u(!isAsk), Type: p.typ, TimeInForce: TifIOC,
			ReduceOnly: 1, TriggerPrice: m.PriceInt(m.RoundPrice(*p.trigger)), OrderExpiry: expiry28Days})
		label += fmt.Sprintf(" %s %g", p.name, *p.trigger)
	}
	if len(orders) == 1 {
		return coi, t.createOrder(ctx, label, orders[0])
	}
	group := uint8(GroupOTO)
	if len(orders) == 3 {
		group = GroupOTOCO
	}
	for _, o := range orders {
		o.OrderExpiry = expiry(o.OrderExpiry)
	}
	return coi, t.send(ctx, label, func(tx *lgclient.TxClient, ops *lgtypes.TransactOpts) (txtypes.TxInfo, error) {
		return tx.GetCreateGroupedOrdersTransaction(&lgtypes.CreateGroupedOrdersTxReq{GroupingType: group, Orders: orders}, ops)
	})
}

// StopOrder is a reduce-only trigger order closing posSize (the signed position) at trigger; kind "sl" or "tp".
func (t *Trader) StopOrder(ctx context.Context, marketID int, posSize, trigger float64, kind string) (int64, error) {
	m, err := t.market(marketID)
	if err != nil {
		return 0, err
	}
	if !t.HasSigner() {
		return 0, ErrNoKey
	}
	slip := t.c.Cfg.MaxSlippagePct / 100
	isAsk := posSize > 0 // closing a long sells
	worst := trigger * (1 + slip)
	if isAsk {
		worst = trigger * (1 - slip)
	}
	typ := uint8(OrderStopLoss)
	if kind != "sl" {
		typ = OrderTakeProfit
	}
	coi := t.NewCOI()
	return coi, t.createOrder(ctx, fmt.Sprintf("%s %s @ %g", kind, m.Symbol, trigger), &lgtypes.CreateOrderTxReq{
		MarketIndex: int64(marketID), ClientOrderIndex: coi, BaseAmount: m.SizeInt(posSize), Price: m.PriceInt(m.RoundPrice(worst)),
		IsAsk: b2u(isAsk), Type: typ, TimeInForce: TifIOC, ReduceOnly: 1, TriggerPrice: m.PriceInt(m.RoundPrice(trigger)), OrderExpiry: expiry28Days})
}

func (t *Trader) modify(ctx context.Context, what string, req *lgtypes.ModifyOrderTxReq) error {
	return t.send(ctx, what, func(tx *lgclient.TxClient, ops *lgtypes.TransactOpts) (txtypes.TxInfo, error) {
		return tx.GetModifyOrderTransaction(req, ops)
	})
}

// ModifyStop moves a stop order's trigger (and its worst price with it).
func (t *Trader) ModifyStop(ctx context.Context, marketID int, orderIndex int64, posSize, trigger float64) error {
	m, err := t.market(marketID)
	if err != nil {
		return err
	}
	slip := t.c.Cfg.MaxSlippagePct / 100
	worst := trigger * (1 + slip)
	if posSize > 0 {
		worst = trigger * (1 - slip)
	}
	return t.modify(ctx, fmt.Sprintf("move stop %s -> %g", m.Symbol, trigger), &lgtypes.ModifyOrderTxReq{MarketIndex: int64(marketID),
		Index: orderIndex, BaseAmount: m.SizeInt(posSize), Price: m.PriceInt(m.RoundPrice(worst)), TriggerPrice: m.PriceInt(m.RoundPrice(trigger))})
}

// ModifyOrder moves a resting order to a new price.
func (t *Trader) ModifyOrder(ctx context.Context, marketID int, orderIndex int64, size, price float64) error {
	m, err := t.market(marketID)
	if err != nil {
		return err
	}
	return t.modify(ctx, fmt.Sprintf("move %s order %d -> %g", m.Symbol, orderIndex, price), &lgtypes.ModifyOrderTxReq{MarketIndex: int64(marketID),
		Index: orderIndex, BaseAmount: m.SizeInt(size), Price: m.PriceInt(m.RoundPrice(price))})
}

// CancelOrder by its order index.
func (t *Trader) CancelOrder(ctx context.Context, marketID int, orderIndex int64) error {
	return t.send(ctx, fmt.Sprintf("cancel %d/%d", marketID, orderIndex), func(tx *lgclient.TxClient, ops *lgtypes.TransactOpts) (txtypes.TxInfo, error) {
		return tx.GetCancelOrderTransaction(&lgtypes.CancelOrderTxReq{MarketIndex: int64(marketID), Index: orderIndex}, ops)
	})
}

// Candles of a market (shared, keyless data).
func (t *Trader) Candles(ctx context.Context, marketID int, tf string, count int) ([]Candle, error) {
	return t.c.Candles(ctx, marketID, tf, count)
}
