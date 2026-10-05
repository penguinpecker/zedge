package guest

import (
	"bytes"
	"encoding/json"
	"math/big"
	"testing"
)

// FuzzEntryPoints throws arbitrary bytes at all five entry points. A panic
// fails the run (a panic in the guest is a wasm trap). Every result must be
// well formed and have the one public shape its entry point allows; an error
// carries no effect; a private rejection, a retry or a sync hands back the
// input state with one more tick requested and nothing else changed; no
// deposit or withdrawal leaves fewer evidence IDs than the exits still owed.
//
//	go test -run '^$' -fuzz FuzzEntryPoints -fuzztime 60s
func FuzzEntryPoints(f *testing.F) {
	calls := map[string]uint8{"deploy": 0, "deposit": 1, "process": 2, "trusted": 3}
	for _, s := range run(f, script()[:30]) {
		if s.Call == "restart" {
			continue
		}
		var sender, token []byte
		if s.Sender != "" {
			sender = raw(s.Sender)
		}
		if s.Token != "" {
			token = raw(s.Token)
		}
		value := new(big.Int).SetUint64(s.Amount).Bytes()
		if s.Call == "deploy" {
			value = testSalt // the deploy call takes its salt from here
		}
		f.Add(calls[s.Call], testApp, int32(requestTypeProcess), sender, token, value, s.Payload, s.before)
	}
	f.Add(uint8(4), testApp, int32(0), []byte(nil), []byte(nil), []byte(nil), []byte(nil), []byte(nil))

	f.Fuzz(func(t *testing.T, call uint8, appID uint64, requestType int32, sender, token, value, payload, state []byte) {
		before := append([]byte(nil), state...)
		var out []byte
		switch call % 5 {
		case 0:
			out = Deploy(appID, payload, value)
		case 1:
			out = Deposit(appID, sender, token, value, state)
		case 2:
			out = ProcessRequest(appID, sender, requestType, payload, state)
		case 3:
			out = TrustedRequest(appID, payload, state)
		case 4:
			out = LoadModule(appID)
		}
		if !bytes.Equal(state, before) {
			t.Fatal("an entry point wrote to its input")
		}
		var r Result
		if err := json.Unmarshal(out, &r); err != nil || r.Fuel != fuel {
			t.Fatalf("malformed result: %s", out)
		}
		if r.Error != "" {
			if r.State != nil || r.Events != nil || r.AppEvents != nil || r.Withdrawals != nil {
				t.Fatalf("an error result carried effects: %s", out)
			}
			return
		}
		if call%5 == 4 {
			return
		}
		next, err := DecodeState(r.State)
		if err != nil {
			t.Fatalf("returned state does not decode: %v", err)
		}
		// One shape per entry point: a request gives one receipt and asks for
		// one tick, a deposit gives one receipt, a tick publishes its clock.
		receipts, appEvents, withdrawals, kind := 0, 0, 0, TickSubType // deploy: nothing
		switch call % 5 {
		case 1:
			receipts = 1
		case 2:
			receipts, appEvents, withdrawals = 1, 1, 1
		case 3:
			appEvents, kind = 1, ClockSubType
		}
		if len(r.Events) != receipts || len(r.AppEvents) != appEvents || len(r.Withdrawals) > withdrawals || appEvents == 1 && r.AppEvents[0].EventSubType != kind {
			t.Fatalf("wrong public shape for entry point %d: %s", call%5, out)
		}
		for _, e := range r.Events {
			var receipt receiptEnvelope
			if !canonical(e.Data, &receipt) || receipt.Kind != "receipt" || receipt.Account != e.UserID || e.EventSubType != ReceiptSubType || len(e.Data)%ReceiptBytes != 0 {
				t.Fatalf("malformed receipt: %s", e.Data)
			}
			if s := receipt.Body.Status; s == "rejected" || s == "retry" || s == "requested" {
				next.TickSeq--
				if again, _ := json.Marshal(next); !bytes.Equal(again, state) || r.Withdrawals != nil {
					t.Fatalf("a %s request had an effect: %s", s, out)
				}
			}
		}
		if (call%5 == 1 || r.Withdrawals != nil) && !exitReserved(next.Engine) {
			t.Fatalf("the exit reserve was spent: %s", out)
		}
	})
}
