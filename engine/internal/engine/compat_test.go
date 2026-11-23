package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// rules.json written by the Python engine (testdata/python_rules.json, made with backend/engine.py) is read as
// it is, and written back in the same format: either engine can take over the other's file.
func TestReadsAndWritesThePythonFormat(t *testing.T) {
	b, err := os.ReadFile("testdata/python_rules.json")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "rules.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	eng, err := New(newFake(), nil, nil, fakeRisk{}, dir, "")
	if err != nil {
		t.Fatal(err)
	}
	rules := eng.list()
	if len(rules) != 4 {
		t.Fatalf("four rules: %d", len(rules))
	}
	s, x, c, ev := rules[0], rules[1], rules[2], rules[3]
	st := s.State
	if s.Type != "managed_stop" || s.TrailPct != 1.5 || s.InitialStopPct != 2 || !s.AutoRemove || !s.Enabled ||
		st.Side != 1 || *st.Entry != 100 || *st.Best != 102.5 || *st.Stop != 101 || *st.Size != 0.5 || st.Coi != 12345 || st.Oi != 67890 || st.Sent != 2.5 {
		t.Errorf("managed stop: %+v %+v", s.ruleFields, st)
	}
	if x.Type != "exit_plan" || len(x.Levels) != 2 || x.Levels[1].Price != 120 || !x.BeAfterTP1 || x.Size != 0.5 {
		t.Errorf("exit plan: %+v", x.ruleFields)
	}
	if c.Type != "chase" || c.Cap != 0 || c.Until != 0 || c.State.Coi != 555 || c.State.OrderIndex != nil || c.State.Remaining != 1 {
		t.Errorf("chase (nulls as unset): %+v %+v", c.ruleFields, c.State)
	}
	if ev.Status != "waiting" || ev.EventTitle != "USD CPI" || ev.EventTS != 1800000000 || *ev.RangeMinutes != 15 || ev.StopPct != 0 || string(ev.Extra["custom_field"]) != `"kept"` {
		t.Errorf("event trade: %+v %v", ev.ruleFields, ev.Extra)
	}
	if d := eng.describe(s); d != "BTC managed stop: SL 2%, trail 1.5% from PnL +0%" {
		t.Errorf("describe as Python: %q", d)
	}
	if d := eng.describe(c); d != "BTC chase buy 1" {
		t.Errorf("describe chase: %q", d)
	}
	eng.mu.Lock()
	eng.save()
	eng.mu.Unlock()
	out, _ := os.ReadFile(filepath.Join(dir, "rules.json"))
	var back []map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if back[3]["custom_field"] != "kept" || back[0]["state"].(map[string]any)["oi"].(float64) != 67890 || back[2]["state"].(map[string]any)["order_index"] != nil {
		t.Errorf("written back: %s", out)
	}
	if !strings.Contains(string(out), `"event_title": "USD CPI"`) {
		t.Errorf("indented like Python's: %s", out)
	}
	_ = os.WriteFile(filepath.Join(os.TempDir(), "ld_go_rules.json"), out, 0o644) // for the Python side of the check
}
