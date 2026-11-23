package engine

import (
	"encoding/json"
	"reflect"
	"strings"
)

// Level is one take-profit of a scaled exit.
type Level struct {
	Price  float64 `json:"price"`
	Qty    float64 `json:"qty"`
	Coi    int64   `json:"coi,omitempty"`
	Done   bool    `json:"done,omitempty"`
	Filled bool    `json:"filled,omitempty"`
}

// State is what a rule keeps between passes. One struct for every rule type, as the Python engine's dict: a
// managed stop uses side/entry/best/stop/size/coi/oi/checked/sent; a scaled exit placed/side/start/size/checked/
// be_done; a worked order coi/order_index/price/remaining/filled/...; a breakout high/low.
type State struct {
	Side    int      `json:"side,omitempty"`
	Entry   *float64 `json:"entry,omitempty"`
	Best    *float64 `json:"best,omitempty"`
	Stop    *float64 `json:"stop,omitempty"`
	Size    *float64 `json:"size,omitempty"`
	Coi     int64    `json:"coi,omitempty"`
	Oi      int64    `json:"oi,omitempty"`
	Checked float64  `json:"checked,omitempty"`
	Sent    float64  `json:"sent,omitempty"`

	Placed bool    `json:"placed,omitempty"`
	Start  float64 `json:"start,omitempty"`
	BeDone bool    `json:"be_done,omitempty"`

	Filled     float64 `json:"filled,omitempty"`
	OrderIndex *int64  `json:"order_index,omitempty"`
	Price      float64 `json:"price,omitempty"`
	Remaining  float64 `json:"remaining,omitempty"`
	Missing    int     `json:"missing,omitempty"`
	Moved      float64 `json:"moved,omitempty"`
	Expiring   bool    `json:"expiring,omitempty"`
	Errors     int     `json:"errors,omitempty"`
	Slices     int     `json:"slices,omitempty"`
	Retry      float64 `json:"retry,omitempty"`

	High *float64 `json:"high,omitempty"`
	Low  *float64 `json:"low,omitempty"`
}

// ruleFields are the fields of every rule type. Rules are kept in rules.json in the Python engine's format, so
// either engine reads the other's file; fields neither knows are kept as they are (Rule.Extra).
type ruleFields struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	MarketID int     `json:"market_id"`
	Enabled  bool    `json:"enabled"`
	Created  float64 `json:"created"`
	State    State   `json:"state"`
	Note     string  `json:"note,omitempty"`

	// managed stop
	AutoRemove         bool     `json:"auto_remove,omitempty"`
	InitialStopPct     float64  `json:"initial_stop_pct,omitempty"`
	BreakevenAtPct     float64  `json:"breakeven_at_pct,omitempty"`
	BreakevenOffsetPct *float64 `json:"breakeven_offset_pct,omitempty"`
	TrailPnl           float64  `json:"trail_pnl,omitempty"`
	TrailPct           float64  `json:"trail_pct,omitempty"`
	TrailPrice         float64  `json:"trail_price,omitempty"`
	TrailAtr           float64  `json:"trail_atr,omitempty"`
	TrailActivatePct   float64  `json:"trail_activate_pct,omitempty"`
	BeNow              bool     `json:"be_now,omitempty"`

	// scaled exits
	Levels     []Level `json:"levels,omitempty"`
	BeAfterTP1 bool    `json:"be_after_tp1,omitempty"`
	Before     float64 `json:"before,omitempty"`
	Size       float64 `json:"size,omitempty"`

	// chase and iceberg
	Side       int     `json:"side,omitempty"`
	Qty        float64 `json:"qty,omitempty"`
	Cap        float64 `json:"cap,omitempty"`
	Until      float64 `json:"until,omitempty"`
	ThenMarket bool    `json:"then_market,omitempty"`
	ReduceOnly bool    `json:"reduce_only,omitempty"`
	Price      float64 `json:"price,omitempty"`
	SlicePct   float64 `json:"slice_pct,omitempty"`
	PostOnly   bool    `json:"post_only,omitempty"`

	// event trade
	EventID       json.RawMessage `json:"event_id,omitempty"`
	EventTitle    string          `json:"event_title,omitempty"`
	EventTS       float64         `json:"event_ts,omitempty"`
	Status        string          `json:"status,omitempty"`
	Mode          string          `json:"mode,omitempty"`
	DelayS        float64         `json:"delay_s,omitempty"`
	RangeMinutes  *float64        `json:"range_minutes,omitempty"`
	WindowMinutes *float64        `json:"window_minutes,omitempty"`
	BufferPct     *float64        `json:"buffer_pct,omitempty"`
	SizeUSD       float64         `json:"size_usd,omitempty"`
	StopPct       float64         `json:"stop_pct,omitempty"`
	TpPct         float64         `json:"tp_pct,omitempty"`
}

// Rule is one automation.
type Rule struct {
	ruleFields
	Extra map[string]json.RawMessage `json:"-"`
}

var knownKeys = func() map[string]bool {
	out := map[string]bool{}
	t := reflect.TypeOf(ruleFields{})
	for i := 0; i < t.NumField(); i++ {
		name := strings.Split(t.Field(i).Tag.Get("json"), ",")[0]
		out[name] = true
	}
	return out
}()

func (r *Rule) UnmarshalJSON(b []byte) error {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	// null in a known field means "not set" (Python writes None)
	clean := map[string]json.RawMessage{}
	r.Extra = nil
	for k, v := range all {
		if knownKeys[k] {
			if string(v) != "null" {
				clean[k] = v
			}
			continue
		}
		if r.Extra == nil {
			r.Extra = map[string]json.RawMessage{}
		}
		r.Extra[k] = v
	}
	cb, _ := json.Marshal(clean)
	var f ruleFields
	if err := json.Unmarshal(cb, &f); err != nil {
		return err
	}
	r.ruleFields = f
	return nil
}

func (r Rule) MarshalJSON() ([]byte, error) {
	b, err := json.Marshal(r.ruleFields)
	if err != nil || len(r.Extra) == 0 {
		return b, err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, err
	}
	for k, v := range r.Extra {
		if _, ok := all[k]; !ok {
			all[k] = v
		}
	}
	return json.Marshal(all)
}

// clone is a deep copy (for the snapshots the Python server reads).
func (r *Rule) clone() *Rule {
	b, _ := json.Marshal(r)
	var c Rule
	_ = json.Unmarshal(b, &c)
	return &c
}

// patch applies changes to any field but id, type, state and created (the Python engine's update_rule).
func (r *Rule) patch(changes map[string]json.RawMessage) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	for k, v := range changes {
		switch k {
		case "id", "type", "state", "created":
			continue
		}
		all[k] = v
	}
	b, _ = json.Marshal(all)
	var nr Rule
	if err := json.Unmarshal(b, &nr); err != nil {
		return err
	}
	nr.ID, nr.Type, nr.State, nr.Created = r.ID, r.Type, r.State, r.Created
	*r = nr
	return nil
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }
