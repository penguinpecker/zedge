package guest

import (
	"bytes"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
)

// FuzzEntryPoints throws arbitrary bytes at all five entry points. A panic
// fails the run (a panic in the guest is a wasm trap). Every result must be
// well formed and have the one public shape its entry point allows; an error
// carries no effect; a private rejection, a retry or a sync hands back the
// input state with one more tick requested and the sender's outcome collected,
// and a staged command adds only its item; the ledger is conserved (a deposit
// adds exactly its amount, a request pays out exactly its withdrawal, a tick
// moves nothing in or out); no deposit or withdrawal leaves fewer evidence IDs
// than the exits still owed; every request accepted is RequestBytes long and
// every clock record ends with its payload's Keccak-256.
//
//	go test -run '^$' -fuzz FuzzEntryPoints -fuzztime 60s
func FuzzEntryPoints(f *testing.F) {
	calls := map[string]uint8{"deploy": 0, "deposit": 1, "process": 2, "trusted": 3}
	for _, s := range run(f, script()) {
		if s.Call == "restart" || strings.HasPrefix(s.Name, "account ") {
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
		// one tick, a deposit gives one receipt, a tick publishes its clock,
		// then archive records, then at most one request to carry on.
		receipts, appEvents, withdrawals := 0, 0, 0 // deploy: nothing
		switch call % 5 {
		case 1:
			receipts = 1
		case 2:
			receipts, appEvents, withdrawals = 1, 1, 1
		case 3:
			appEvents = len(r.AppEvents)
			if appEvents == 0 || r.AppEvents[0].EventSubType != ClockSubType {
				t.Fatalf("a tick without its clock record: %s", out)
			}
			for i, e := range r.AppEvents[1:] {
				if e.EventSubType != ArchiveSubType && (e.EventSubType != TickSubType || i != appEvents-2) {
					t.Fatalf("a tick published %x: %s", e.EventSubType, out)
				}
			}
		}
		if len(r.Events) != receipts || len(r.AppEvents) != appEvents || len(r.Withdrawals) > withdrawals || call%5 == 2 && r.AppEvents[0].EventSubType != TickSubType {
			t.Fatalf("wrong public shape for entry point %d: %s", call%5, out)
		}
		// Every request accepted has the one length; every clock record names its payload.
		if call%5 == 2 && len(payload) != RequestBytes || call%5 == 3 && !bytes.Equal(r.AppEvents[0].Data[160:], keccak(payload)) {
			t.Fatalf("a request of %d bytes, or a clock record without its payload's hash: %s", len(payload), out)
		}
		prev, _ := DecodeState(state)
		for _, e := range r.Events {
			var receipt receiptEnvelope
			if !canonical(e.Data, &receipt) || receipt.Kind != "receipt" || receipt.Account != e.UserID || e.EventSubType != ReceiptSubType || len(e.Data)%ReceiptBytes != 0 {
				t.Fatalf("malformed receipt: %s", e.Data)
			}
			if s := receipt.Body.Status; prev != nil && (s == "rejected" || s == "retry" || s == "requested" || s == "staged") {
				again := *next
				again.TickSeq--
				again.Outcomes = prev.Outcomes
				if s == "staged" {
					again.Staged = prev.Staged
				}
				if !bytes.Equal(marshal(&again), state) || r.Withdrawals != nil {
					t.Fatalf("a %s request had an effect: %s", s, out)
				}
			}
		}
		if prev != nil {
			paid := uint64(0)
			for _, w := range r.Withdrawals {
				amount, _ := new(big.Int).SetString(w.Amount[2:], 16)
				paid += amount.Uint64()
			}
			deposited := uint64(0)
			if call%5 == 1 {
				deposited = new(big.Int).SetBytes(value).Uint64()
			}
			a, b := prev.Engine, next.Engine
			if b.Deposited != a.Deposited+deposited || b.PaidOut != a.PaidOut+paid || b.Custody != a.Custody+deposited-paid {
				t.Fatalf("ledger not conserved: deposited %d -> %d, paid out %d -> %d, custody %d -> %d", a.Deposited, b.Deposited, a.PaidOut, b.PaidOut, a.Custody, b.Custody)
			}
		}
		if (call%5 == 1 || r.Withdrawals != nil) && !exitReserved(next.Engine) {
			t.Fatalf("the exit reserve was spent: %s", out)
		}
	})
}
