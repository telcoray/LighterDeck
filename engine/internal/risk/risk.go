// Package risk is the pre-trade guard for the orders the engine opens on its own (event trades), the Go side
// of backend/risk.py: the same rules, in the same order, read from the same limits.json the site edits.
package risk

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/feed"
	"github.com/telcoray/lighterdeck/engine/internal/i18n"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
)

const (
	feedMaxAge  = 10 * time.Second // without a price update, quotes count as stale
	dailyPnLTTL = 30 * time.Second
)

// Blocked is an order the guard refuses; the message is shown as is.
type Blocked struct{ Msg string }

func (b *Blocked) Error() string { return b.Msg }

func blocked(it, en string) error { return &Blocked{i18n.L(it, en)} }

// Limits as in limits.json.
type Limits struct {
	PerOrderPct      float64         `json:"per_order_pct"`
	PerMarketPct     float64         `json:"per_market_pct"`
	TotalExposurePct float64         `json:"total_exposure_pct"`
	LeverageCap      float64         `json:"leverage_cap"`
	DailyLossPct     float64         `json:"daily_loss_pct"`
	OpenMarkets      float64         `json:"open_markets"`
	SlippageBpsCap   float64         `json:"slippage_bps_cap"`
	On               map[string]bool `json:"on"`
}

func defaults() Limits {
	return Limits{PerOrderPct: 5, PerMarketPct: 15, TotalExposurePct: 50, LeverageCap: 5, DailyLossPct: 3, OpenMarkets: 3,
		SlippageBpsCap: 50, On: map[string]bool{}}
}

// Source is what the guard reads: the account's daily PnL and the markets.
type Source interface {
	DailyPnL(ctx context.Context) (*float64, error)
	Market(id int) *lighter.Market
}

// Quotes are the prices an order would fill at.
type Quotes interface {
	Stats(id int) (feed.Stats, bool)
	UpdatedAt() time.Time
}

type Guard struct {
	src    Source
	prices Quotes
	file   string

	mu    sync.Mutex
	pnl   *float64
	pnlAt time.Time
	now   func() time.Time
}

func NewGuard(src Source, prices Quotes, limitsFile string) *Guard {
	return &Guard{src: src, prices: prices, file: limitsFile, now: time.Now}
}

// Limits are read from the file each time: the site changes them.
func (g *Guard) Limits() Limits {
	l := defaults()
	if g.file == "" {
		return l
	}
	b, err := os.ReadFile(g.file)
	if err != nil {
		return l
	}
	var saved map[string]json.RawMessage
	if json.Unmarshal(b, &saved) != nil {
		return l
	}
	// limits.json written by earlier versions
	old := map[string]string{"max_leverage": "leverage_cap", "max_positions": "open_markets", "max_slippage_bps": "slippage_bps_cap"}
	for k, v := range old {
		if raw, ok := saved[k]; ok {
			if _, has := saved[v]; !has {
				saved[v] = raw
			}
		}
	}
	num := func(key string, dst *float64) {
		if raw, ok := saved[key]; ok {
			var f float64
			if json.Unmarshal(raw, &f) == nil {
				*dst = f
			}
		}
	}
	num("per_order_pct", &l.PerOrderPct)
	num("per_market_pct", &l.PerMarketPct)
	num("total_exposure_pct", &l.TotalExposurePct)
	num("leverage_cap", &l.LeverageCap)
	num("daily_loss_pct", &l.DailyLossPct)
	num("open_markets", &l.OpenMarkets)
	num("slippage_bps_cap", &l.SlippageBpsCap)
	if raw, ok := saved["on"]; ok {
		var on map[string]any
		if json.Unmarshal(raw, &on) == nil {
			for k, v := range on {
				l.On[k] = truthy(v)
			}
		}
	}
	return l
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return v != nil
}

func (g *Guard) dailyPnL(ctx context.Context) *float64 {
	g.mu.Lock()
	if g.now().Sub(g.pnlAt) < dailyPnLTTL {
		v := g.pnl
		g.mu.Unlock()
		return v
	}
	g.mu.Unlock()
	v, err := g.src.DailyPnL(ctx)
	if err != nil {
		v = nil
	}
	g.mu.Lock()
	g.pnl, g.pnlAt = v, g.now()
	g.mu.Unlock()
	return v
}

// Quote is the price an order would fill at: the best ask to buy, the best bid to sell. Stale data is refused.
func (g *Guard) Quote(marketID, side int) (float64, error) {
	s, ok := g.prices.Stats(marketID)
	if !ok || g.now().Sub(g.prices.UpdatedAt()) > feedMaxAge {
		return 0, blocked("Prezzi non aggiornati: attendi che il feed riparta", "Prices are stale: wait for the feed to recover")
	}
	p := s.Bid
	if side > 0 {
		p = s.Ask
	}
	if p == 0 {
		p = s.Mark
	}
	return p, nil
}

// Proposal is an order that opens or adds exposure, with the account as it is now.
type Proposal struct {
	Account  *lighter.Account
	Market   *lighter.Market
	Side     int
	Size     float64
	Price    float64
	Stop     *float64
	Target   *float64
	Mark     *float64
	DailyPnL *float64
	notional float64
}

func (p *Proposal) equity() float64 {
	if p.Account == nil {
		return 0
	}
	return p.Account.TotalValue
}

func (p *Proposal) cap(l Limits, key string, pct float64) float64 {
	base := p.equity()
	if key == "daily_loss_pct" && p.DailyPnL != nil {
		base -= *p.DailyPnL
	}
	return base * pct / 100
}

func (p *Proposal) positions() []lighter.Position {
	if p.Account == nil {
		return nil
	}
	return p.Account.Positions
}

func (p *Proposal) held() float64 {
	for _, x := range p.positions() {
		if x.MarketID == p.Market.ID {
			return x.Size
		}
	}
	return 0
}

// Review returns a Blocked error with the first broken rule, nil when the order may go.
func (g *Guard) Review(ctx context.Context, acc *lighter.Account, marketID, side int, size, price float64, stop, target *float64) error {
	m := g.src.Market(marketID)
	if m == nil {
		return blocked("Mercato non disponibile", "Market not available")
	}
	l := g.Limits()
	p := &Proposal{Account: acc, Market: m, Side: side, Size: size, Price: price, Stop: stop, Target: target}
	p.notional = size * price
	if acc != nil && l.On["daily_loss_pct"] {
		p.DailyPnL = g.dailyPnL(ctx)
	}
	for _, rule := range rules {
		if err := rule(p, l); err != nil {
			return err
		}
	}
	return nil
}

var rules = []func(*Proposal, Limits) error{
	ruleExchangeMinimum, ruleProtectionSide, ruleStopRequired, ruleAccountLoaded, ruleOrderSize, ruleNoFlip,
	ruleDailyLoss, ruleMarketExposure, ruleTotalExposure, ruleOpenMarkets, ruleLeverage, ruleMargin,
}

func ruleExchangeMinimum(p *Proposal, l Limits) error {
	m := p.Market
	if p.Size < m.MinBase || p.notional < m.MinQuote {
		return blocked(fmt.Sprintf("Ordine sotto il minimo dell'exchange (%s %s o %s USD)", G(m.MinBase), m.Symbol, G(m.MinQuote)),
			fmt.Sprintf("Order below the exchange minimum (%s %s or %s USD)", G(m.MinBase), m.Symbol, G(m.MinQuote)))
	}
	return nil
}

// sltpTriggerError: a long's SL below and its TP above the reference price (a short's the other way), checked
// against the entry and, for market orders, the mark too (lighter-ts formulas/sltpTriggerValidation.ts, MIT).
func sltpTriggerError(side int, entry float64, mark *float64, sl, tp *float64) error {
	type ref struct {
		it, en string
		v      float64
	}
	refs := []ref{{"prezzo d'entrata", "entry price", entry}}
	if mark != nil && *mark != 0 {
		refs = append(refs, ref{"mark price", "mark price", *mark})
	}
	for _, t := range []struct {
		v    *float64
		isSL bool
	}{{sl, true}, {tp, false}} {
		if t.v == nil || *t.v == 0 {
			continue
		}
		nameIt, nameEn := "Il take-profit", "The take-profit"
		if t.isSL {
			nameIt, nameEn = "Lo stop-loss", "The stop-loss"
		}
		if *t.v <= 0 {
			return blocked(nameIt+" deve essere maggiore di zero", nameEn+" must be above zero")
		}
		for _, r := range refs {
			below := t.isSL == (side > 0)
			if (below && *t.v >= r.v) || (!below && *t.v <= r.v) {
				wIt, wEn := "sopra", "above"
				if below {
					wIt, wEn = "sotto", "below"
				}
				return blocked(fmt.Sprintf("%s deve stare %s il %s (%s)", nameIt, wIt, r.it, G(r.v)),
					fmt.Sprintf("%s must be %s the %s (%s)", nameEn, wEn, r.en, G(r.v)))
			}
		}
	}
	return nil
}

func ruleProtectionSide(p *Proposal, l Limits) error {
	return sltpTriggerError(p.Side, p.Price, p.Mark, p.Stop, p.Target)
}

func ruleStopRequired(p *Proposal, l Limits) error {
	if l.On["stop_required"] && (p.Stop == nil || *p.Stop == 0) {
		return blocked("Imposta uno stop-loss: è obbligatorio nei tuoi limiti di rischio", "Set a stop-loss: your risk limits require one")
	}
	return nil
}

func ruleAccountLoaded(p *Proposal, l Limits) error {
	if p.Account == nil || p.equity() <= 0 {
		return blocked("Account non ancora caricato", "Account not loaded yet")
	}
	return nil
}

func ruleOrderSize(p *Proposal, l Limits) error {
	if !l.On["per_order_pct"] {
		return nil
	}
	c := p.cap(l, "per_order_pct", l.PerOrderPct)
	if p.notional > c {
		return blocked(fmt.Sprintf("Ordine da $%s: il tuo limite per ordine è %s%% del capitale ($%s)", comma0(p.notional), G(l.PerOrderPct), comma0(c)),
			fmt.Sprintf("$%s order: your per-order limit is %s%% of equity ($%s)", comma0(p.notional), G(l.PerOrderPct), comma0(c)))
	}
	return nil
}

func ruleNoFlip(p *Proposal, l Limits) error {
	if l.On["no_flip"] && p.held()*float64(p.Side) < 0 {
		return blocked("Hai una posizione opposta: chiudila (reduce-only) prima di girarti", "You hold the opposite position: close it (reduce-only) before reversing")
	}
	return nil
}

func ruleDailyLoss(p *Proposal, l Limits) error {
	if !l.On["daily_loss_pct"] {
		return nil
	}
	if p.DailyPnL == nil {
		return blocked("Non riesco a verificare il PnL di oggi: nuove posizioni bloccate per sicurezza", "Today's PnL can't be checked: new positions blocked to be safe")
	}
	c := p.cap(l, "daily_loss_pct", l.DailyLossPct)
	if *p.DailyPnL <= -c {
		return blocked(fmt.Sprintf("Raggiunta la perdita massima di oggi: %s USD, limite -%s%% (-$%s), posizioni aperte incluse", comma2(*p.DailyPnL), G(l.DailyLossPct), comma0(c)),
			fmt.Sprintf("Daily loss limit reached: %s USD, limit -%s%% (-$%s), open positions included", comma2(*p.DailyPnL), G(l.DailyLossPct), comma0(c)))
	}
	return nil
}

func ruleMarketExposure(p *Proposal, l Limits) error {
	if !l.On["per_market_pct"] {
		return nil
	}
	here := 0.0
	for _, x := range p.positions() {
		if x.MarketID == p.Market.ID {
			here = math.Abs(x.Value)
			break
		}
	}
	c := p.cap(l, "per_market_pct", l.PerMarketPct)
	if here+p.notional > c {
		return blocked(fmt.Sprintf("Su %s supereresti il limite di %s%% del capitale ($%s)", p.Market.Symbol, G(l.PerMarketPct), comma0(c)),
			fmt.Sprintf("This would exceed your %s%% of equity limit on %s ($%s)", G(l.PerMarketPct), p.Market.Symbol, comma0(c)))
	}
	return nil
}

func ruleTotalExposure(p *Proposal, l Limits) error {
	if !l.On["total_exposure_pct"] {
		return nil
	}
	total := p.notional
	for _, x := range p.positions() {
		total += math.Abs(x.Value)
	}
	c := p.cap(l, "total_exposure_pct", l.TotalExposurePct)
	if total > c {
		return blocked(fmt.Sprintf("L'esposizione totale supererebbe il %s%% del capitale ($%s)", G(l.TotalExposurePct), comma0(c)),
			fmt.Sprintf("Total exposure would exceed %s%% of equity ($%s)", G(l.TotalExposurePct), comma0(c)))
	}
	return nil
}

func ruleOpenMarkets(p *Proposal, l Limits) error {
	if !l.On["open_markets"] {
		return nil
	}
	ms := map[int]bool{p.Market.ID: true}
	for _, x := range p.positions() {
		ms[x.MarketID] = true
	}
	if float64(len(ms)) > l.OpenMarkets {
		return blocked(fmt.Sprintf("Avresti più di %s mercati aperti insieme", G(l.OpenMarkets)),
			fmt.Sprintf("You would have more than %s markets open at once", G(l.OpenMarkets)))
	}
	return nil
}

func leverage(p *Proposal) float64 {
	if p.Account != nil {
		if s, ok := p.Account.Settings[p.Market.ID]; ok && s.Leverage != 0 {
			return s.Leverage
		}
	}
	return p.Market.DefaultLeverage
}

func ruleLeverage(p *Proposal, l Limits) error {
	lev := leverage(p)
	if l.On["leverage_cap"] && lev != 0 && lev > l.LeverageCap {
		return blocked(fmt.Sprintf("La leva su %s è %sx, oltre il tuo limite di %sx: abbassala prima", p.Market.Symbol, G(lev), G(l.LeverageCap)),
			fmt.Sprintf("%s leverage is %sx, above your %sx limit: lower it first", p.Market.Symbol, G(lev), G(l.LeverageCap)))
	}
	return nil
}

func ruleMargin(p *Proposal, l Limits) error {
	lev := leverage(p)
	if lev != 0 && p.notional/lev > p.Account.Available {
		return blocked("Margine disponibile insufficiente", "Not enough available margin")
	}
	return nil
}

// ---------- Python-style number formatting for messages ----------

// G is Python's format(x, "g"): six significant digits, no trailing zeros.
func G(x float64) string {
	if x == math.Trunc(x) && math.Abs(x) < 1e6 {
		return fmt.Sprintf("%d", int64(x))
	}
	return fmt.Sprintf("%.6g", x)
}

func comma0(x float64) string { return commas(fmt.Sprintf("%.0f", x)) }
func comma2(x float64) string { return commas(fmt.Sprintf("%.2f", x)) }

func commas(s string) string {
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	var b strings.Builder
	for i, c := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String() + frac
	if neg {
		out = "-" + out
	}
	return out
}
