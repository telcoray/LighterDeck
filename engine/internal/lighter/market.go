package lighter

import (
	"math"
	"strconv"
)

// Market is one perp as the deck sees it, built from Lighter's orderBookDetails (backend/lighter_api.py Market).
//
// Values on the wire are "real" units; everything above this package works in "display" units: display size =
// real size x multiplier, display price = real price / multiplier. Today every perp has multiplier 1.
type Market struct {
	ID                int     `json:"id"`
	Symbol            string  `json:"symbol"`
	Multiplier        float64 `json:"multiplier"`
	RealSizeDecimals  int     `json:"-"`
	RealPriceDecimals int     `json:"-"`
	SizeDecimals      int     `json:"size_decimals"`
	PriceDecimals     int     `json:"price_decimals"`
	MinBase           float64 `json:"min_base"`
	MinQuote          float64 `json:"min_quote"`
	DefaultLeverage   float64 `json:"default_leverage"` // 0 when unknown
}

type marketDetails struct {
	MarketID                     int    `json:"market_id"`
	Symbol                       string `json:"symbol"`
	MarketType                   string `json:"market_type"`
	Status                       string `json:"status"`
	Multiplier                   flex   `json:"multiplier"`
	SizeDecimals                 int    `json:"size_decimals"`
	PriceDecimals                int    `json:"price_decimals"`
	MinBaseAmount                flex   `json:"min_base_amount"`
	MinQuoteAmount               flex   `json:"min_quote_amount"`
	DefaultInitialMarginFraction flex   `json:"default_initial_margin_fraction"`
}

func newMarket(d marketDetails) *Market {
	m := &Market{ID: d.MarketID, Symbol: d.Symbol, Multiplier: float64(d.Multiplier),
		RealSizeDecimals: d.SizeDecimals, RealPriceDecimals: d.PriceDecimals}
	if m.Multiplier == 0 {
		m.Multiplier = 1
	}
	// display precision gains a digit when the multiplier shifts values (lighter-ts getDisplayDecimals)
	m.SizeDecimals = d.SizeDecimals
	if m.Multiplier < 1 {
		m.SizeDecimals++
	}
	m.PriceDecimals = d.PriceDecimals
	if m.Multiplier > 1 {
		m.PriceDecimals++
	}
	m.MinBase = m.DispSize(float64(d.MinBaseAmount))
	m.MinQuote = float64(d.MinQuoteAmount)
	if imf := float64(d.DefaultInitialMarginFraction); imf > 0 { // basis points
		m.DefaultLeverage = Round(10000/imf, 1)
	}
	return m
}

func (m *Market) DispPrice(real float64) float64 { return real / m.Multiplier }
func (m *Market) DispSize(real float64) float64  { return real * m.Multiplier }

// SizeInt is a display size as the signer's unsigned integer base amount.
func (m *Market) SizeInt(size float64) int64 {
	return int64(math.RoundToEven(math.Abs(size) / m.Multiplier * math.Pow10(m.RealSizeDecimals)))
}

// PriceInt is a display price as the signer's integer price.
func (m *Market) PriceInt(price float64) uint32 {
	return uint32(math.RoundToEven(price * m.Multiplier * math.Pow10(m.RealPriceDecimals)))
}

func (m *Market) RoundPrice(price float64) float64 { return Round(price, m.PriceDecimals) }
func (m *Market) RoundSize(size float64) float64   { return Round(size, m.SizeDecimals) }

// Round rounds like Python's round(x, n): to the nearest decimal of the double's exact value, halves to even.
func Round(x float64, n int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	v, _ := strconv.ParseFloat(strconv.FormatFloat(x, 'f', n, 64), 64)
	return v
}

// flex reads a JSON number or a numeric string (Lighter sends both), empty or null as 0.
type flex float64

func (f *flex) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == "null" || s == `""` {
		*f = 0
		return nil
	}
	if len(s) >= 2 && s[0] == '"' {
		s = s[1 : len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*f = flex(v)
	return nil
}
