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
// input state with one more tick requested (none for a report) and the
// sender's outcome collected, and a staged command adds only its item; the
// ledger is conserved (the engine takes in exactly the deposits a tick
// credits and pays out exactly the withdrawal payouts it publishes); no
// credit or payout leaves fewer evidence IDs than the exits still owed; no
// result carries a Vela withdrawal; every request accepted is RequestBytes
// long and every clock record ends with its payload's Keccak-256.
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
		// One shape per entry point: a command or sync gives one receipt and
		// asks for one tick, and a withdrawal adds its payout record; a report
		// gives one receipt and only public round records; a tick publishes
		// its clock, then public records, then at most one request to carry on.
		prev, _ := DecodeState(state)
		if call%5 == 0 {
			prev = nil // deploy ignores the state it is handed
		}
		report := call%5 == 2 && prev != nil && next.TickSeq == prev.TickSeq
		switch call % 5 {
		case 0:
			if r.Events != nil || r.AppEvents != nil {
				t.Fatalf("deploy with effects: %s", out)
			}
		case 2:
			ok := len(r.Events) == 1
			for i, e := range r.AppEvents {
				switch {
				case report:
					ok = ok && (e.EventSubType == SettleSubType || e.EventSubType == ConfirmSubType || e.EventSubType == ArchiveSubType)
				case i == 0:
					ok = ok && e.EventSubType == TickSubType
				default:
					ok = ok && i == 1 && e.EventSubType == PayoutSubType
				}
			}
			if !ok || !report && len(r.AppEvents) == 0 || len(payload) != RequestBytes {
				t.Fatalf("wrong public shape for a request of %d bytes: %s", len(payload), out)
			}
		case 3:
			if len(r.Events) != 0 || len(r.AppEvents) == 0 || r.AppEvents[0].EventSubType != ClockSubType || !bytes.Equal(r.AppEvents[0].Data[192:], keccak(payload)) {
				t.Fatalf("a tick without its clock record: %s", out)
			}
			for i, e := range r.AppEvents[1:] {
				switch e.EventSubType {
				case ArchiveSubType, SettleSubType, CreditSubType, PayoutSubType, ConfirmSubType:
				case TickSubType:
					if i != len(r.AppEvents)-2 {
						t.Fatalf("a tick asked for another in the middle: %s", out)
					}
				default:
					t.Fatalf("a tick published %x: %s", e.EventSubType, out)
				}
			}
		}
		if r.Withdrawals != nil {
			t.Fatalf("a Vela withdrawal: %s", out)
		}
		for _, e := range r.Events {
			var receipt receiptEnvelope
			if !canonical(e.Data, &receipt) || receipt.Kind != "receipt" || receipt.Account != e.UserID || e.EventSubType != ReceiptSubType || len(e.Data)%ReceiptBytes != 0 {
				t.Fatalf("malformed receipt: %s", e.Data)
			}
			if s := receipt.Body.Status; prev != nil && (s == "rejected" || s == "retry" || s == "requested" || s == "staged") {
				again := *next
				if !report {
					again.TickSeq--
				}
				again.Outcomes = prev.Outcomes
				if s == "staged" {
					again.Staged = prev.Staged
				}
				if !bytes.Equal(marshal(&again), state) || len(r.AppEvents) > 1 {
					t.Fatalf("a %s request had an effect: %s", s, out)
				}
			}
		}
		if prev != nil {
			// The engine takes in exactly the deposits credited and pays out
			// exactly the withdrawal payouts; a refund never touches it.
			deposited, paid := uint64(0), uint64(0)
			for _, e := range r.AppEvents {
				amount := func(at int) uint64 { return new(big.Int).SetBytes(e.Data[at : at+32]).Uint64() }
				if e.EventSubType == CreditSubType && amount(96) == creditCredited {
					deposited += amount(64)
				}
				if e.EventSubType == PayoutSubType && amount(64) == payoutWithdrawal {
					paid += amount(160)
				}
			}
			a, b := prev.Engine, next.Engine
			if b.Deposited != a.Deposited+deposited || b.PaidOut != a.PaidOut+paid || b.Custody != a.Custody+deposited-paid {
				t.Fatalf("ledger not conserved: deposited %d -> %d, paid out %d -> %d, custody %d -> %d", a.Deposited, b.Deposited, a.PaidOut, b.PaidOut, a.Custody, b.Custody)
			}
			if (deposited != 0 || paid != 0) && !exitReserved(b) {
				t.Fatalf("the exit reserve was spent: %s", out)
			}
		}
	})
}
