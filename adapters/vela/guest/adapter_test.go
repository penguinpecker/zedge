package guest

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

func state(t testing.TB, b []byte) *State {
	t.Helper()
	s, err := DecodeState(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func result(t testing.TB, out []byte) Result {
	t.Helper()
	var r Result
	if err := json.Unmarshal(out, &r); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	return r
}

func TestTimeFreePaths(t *testing.T) {
	steps := run(t, script())
	for _, s := range steps {
		if strings.HasSuffix(s.Name, "fails") != (s.Error != "") {
			t.Fatalf("%s: error %q", s.Name, s.Error)
		}
		if s.Error != "" && !bytes.Equal(s.before, s.after) {
			t.Fatalf("%s: a failed step changed the state", s.Name)
		}
		if s.Withdrawals != nil {
			t.Fatalf("%s: a Vela withdrawal", s.Name)
		}
	}
	for name, want := range map[string]string{
		"deposit through the endpoint fails":                         ErrToken,
		"command before the first tick fails":                        ErrClock,
		"alice's command from bob fails":                             ErrMismatch,
		"truncated envelope fails":                                   ErrEnvelope,
		"deeply nested payload fails":                                ErrEnvelope,
		"command with a nested trailer fails":                        ErrCommand,
		"oversized payload fails":                                    ErrEnvelope,
		"replayed tick fails":                                        ErrTick,
		"tick nobody asked for fails":                                ErrTick,
		"malformed tick fails":                                       ErrTrusted,
		"payload over the allocation cap fails":                      ErrEnvelope,
		"tick stamped in milliseconds fails":                         ErrTrusted,
		"events: a result signed by someone else fails":              ErrMismatch,
		"events: a result whose outcome is not the one signed fails": ErrMismatch,
	} {
		if got := find(t, steps, name).Error; got != want {
			t.Errorf("%s: error %q, want %q", name, got, want)
		}
	}

	sync := find(t, steps, "sync asks for tick 1")
	if len(sync.AppEvents) != 1 || sync.AppEvents[0].EventSubType != TickSubType || !bytes.Equal(sync.AppEvents[0].Data, words(1, 1, 0, 0, 0)) || len(sync.Events) != 1 {
		t.Fatalf("sync: %+v", sync)
	}
	if r := body(t, sync.Events[0]); r.Account != keeper || r.RequestID != keeper+":sync" || r.Body.Type != "sync" || r.Body.Status != "requested" || r.Body.Tick != 1 || r.Body.At != (receiptAt{}) || !sameButTick(t, sync.before, sync.after) {
		t.Fatalf("sync receipt: %+v", r)
	}
	// The first tick sets the clock, then credits the first Base deposit,
	// registering its depositor, and creates the next two rounds.
	tick := find(t, steps, "tick 1 sets the clock and credits alice's first Base deposit, registering her")
	if s := state(t, tick.after); s.Clock != t0 || s.Block != block0 || s.LastTick != 1 || s.Engine.Time != t0 || s.Engine.Sequence != 5 || s.DepositsSeen != 1 || s.Deposits != 1 ||
		len(s.Engine.Rounds) != 2 || s.rounds()[0].Spec.Start != s1 {
		t.Fatalf("tick 1: %+v", s)
	}
	credit := append(append(words(1), addressWord(alice)...), words(200_000_000, creditCredited, 0)...)
	if tick.Events != nil || len(tick.AppEvents) != 2 || !bytes.Equal(tick.AppEvents[0].Data, clockRecord(tick.Payload, 1, block0, t0, 0, 0, 1)) ||
		tick.AppEvents[1].EventSubType != CreditSubType || !bytes.Equal(tick.AppEvents[1].Data, credit) {
		t.Fatalf("tick 1 effects: %+v", tick.AppEvents)
	}
	if a := state(t, tick.after).Engine.Accounts[0]; a.ID != alice || a.Cash != 200_000_000 || a.Nonce != 1 {
		t.Fatalf("alice after her deposit: %+v", a)
	}

	retry := find(t, steps, "explicit register after a deposit is a retry")
	if r := body(t, retry.Events[0]); !sameButTick(t, retry.before, retry.after) || r.RequestID != alice+":1" || r.Body.Type != "command" || r.Body.Status != "retry" || r.Body.Receipt.CommandID != alice+":1" || r.Body.Tick != 2 {
		t.Fatalf("register retry: %+v", r)
	}
	if r := body(t, find(t, steps, "bob registers").Events[0]); r.Account != bob || r.RequestID != bob+":1" || r.Body.Status != "applied" {
		t.Fatalf("bob register: %+v", r)
	}

	// A withdrawal is a public payout record, which the vault on Base pays.
	withdraw := find(t, steps, "alice withdraws")
	payout := append(append(append(words(testApp, 1, payoutWithdrawal), addressWord(alice)...), addressWord(outside)...), words(50_000_000)...)
	if len(withdraw.Events) != 1 || len(withdraw.AppEvents) != 2 || withdraw.AppEvents[1].EventSubType != PayoutSubType || !bytes.Equal(withdraw.AppEvents[1].Data, payout) {
		t.Fatalf("withdrawal effects: %+v", withdraw.AppEvents)
	}
	if r := body(t, withdraw.Events[0]); r.RequestID != alice+":2" || r.Body.Status != "applied" || r.Body.Withdrawal != 1 || r.Body.Receipt.Amount != 50_000_000 || r.Body.Receipt.WithdrawalID != alice+":2" || r.Body.At != (receiptAt{1, block0, t0}) || r.Body.Tick != 4 {
		t.Fatalf("withdrawal receipt: %+v", r)
	}
	if s := state(t, withdraw.after); s.Withdrawals != 1 || s.Payouts != 1 || s.Engine.Custody != 150_000_000 || s.Engine.PaidOut != 50_000_000 || s.Engine.Time != t0 {
		t.Fatalf("ledger after withdrawal: %+v", s.Engine)
	}

	again := find(t, steps, "exact retry of the withdrawal has no effect")
	if r := body(t, again.Events[0]); !sameButTick(t, again.before, again.after) || len(again.AppEvents) != 1 || len(again.Events) != 1 || r.Body.Status != "retry" || r.Body.Withdrawal != 0 {
		t.Fatalf("withdrawal retry emitted an effect: %+v", again)
	}

	for name, reason := range map[string]string{
		"overdraft is rejected in private":                     "insufficient available cash",
		"withdrawal to the vault is rejected in private":       "withdrawal destination not allowed",
		"authority command from a user is rejected in private": "wrong authorization class",
	} {
		s := find(t, steps, name)
		if !sameButTick(t, s.before, s.after) || len(s.AppEvents) != 1 || len(s.Events) != 1 {
			t.Fatalf("%s: a rejection had an effect", name)
		}
		if r := body(t, s.Events[0]); r.Account != s.Sender || r.Body.Type != "command" || r.Body.Status != "rejected" || r.Body.Reason != reason || r.Body.Receipt != nil {
			t.Fatalf("%s: %+v", name, r)
		}
	}

	// A book command is staged, not applied: the ledger is untouched and the
	// tick that passes it applies it, here to a round the engine never held.
	staged := find(t, steps, "order for an unknown round is staged")
	if s := state(t, staged.after); len(s.Staged) != 1 || s.Staged[0].Tick != 8 || !bytes.Equal(marshal(s.Engine), marshal(state(t, staged.before).Engine)) {
		t.Fatalf("staging: %+v", s.Staged)
	}
	if r := body(t, staged.Events[0]); r.Body.Type != "command" || r.Body.Status != "staged" || r.Body.Tick != 8 || r.Body.Receipt != nil {
		t.Fatalf("staged receipt: %+v", r.Body)
	}
	// A tick stamped behind the clock applies at the clock: it may not move
	// it back, and it may not be lost either.
	if s := state(t, find(t, steps, "tick 9 behind the clock applies at the clock, skipping seven").after); s.Clock != t0 || s.Block != block1 || s.LastTick != 9 || s.TickSeq != 10 || s.Engine.Time != t0 ||
		len(s.Staged) != 0 || len(s.Outcomes) != 1 || s.Outcomes[0] != (Outcome{alice, alice + ":3", 8, "rejected", "unknown round"}) {
		t.Fatalf("tick 9: %+v %+v", s.Staged, s.Outcomes)
	}
	if s := state(t, find(t, steps, "tick 10 checkpoints the engine and credits bob's deposit").after); s.Clock != t1 || s.LastTick != 10 || s.DepositsSeen != 2 || account(s.Engine, bob).Cash != 75_000_000 {
		t.Fatalf("tick 10: %+v", s)
	}
	if e := find(t, steps, "bob withdraws everything").AppEvents; len(e) != 2 || !bytes.Equal(e[1].Data, append(append(append(words(testApp, 2, payoutWithdrawal), addressWord(bob)...), addressWord(bob)...), words(75_000_000)...)) {
		t.Fatalf("bob's payout: %+v", e)
	}
	// The block number is recorded as reported; only the timestamp is ordered.
	if s := state(t, find(t, steps, "tick with an earlier block number is accepted").after); s.Clock != t1+1 || s.Block != block0 || s.LastTick != 11 {
		t.Fatalf("last tick: clock=%d block=%d tick=%d", s.Clock, s.Block, s.LastTick)
	}

	// The 33rd account's deposit is refunded in full through a payout.
	fill := find(t, steps, "tick 15 credits accounts 27 to 32 and refunds the deposit past the account limit")
	past := fmt.Sprintf("0x%040x", MaxSliceAccounts+1)
	refund := fill.AppEvents[len(fill.AppEvents)-2:]
	if refund[0].EventSubType != CreditSubType || !bytes.Equal(refund[0].Data, append(append(words(MaxSliceAccounts+1), addressWord(past)...), words(1, creditRefunded, 3)...)) ||
		refund[1].EventSubType != PayoutSubType || !bytes.Equal(refund[1].Data, append(append(append(words(testApp, 3, payoutRefund), addressWord(past)...), addressWord(past)...), words(1)...)) {
		t.Fatalf("refund: %+v", refund)
	}
	extra := uint64(MaxSliceAccounts - 2)
	end := state(t, fill.after)
	if e := end.Engine; len(e.Accounts) != MaxSliceAccounts || e.Deposited != 275_000_000+extra || e.Custody != 150_000_000+extra || e.PaidOut != 125_000_000 ||
		e.Claimable != 0 || len(e.Withdrawals) != 0 || uint64(len(e.ExternalEvidence)) != 2+extra+4 || end.Deposits != 2+extra || end.DepositsSeen != 3+extra || end.Withdrawals != 2 || end.Payouts != 3 {
		t.Fatalf("final ledger: deposited=%d custody=%d paidOut=%d accounts=%d", e.Deposited, e.Custody, e.PaidOut, len(e.Accounts))
	}
}

// A request's public shape must not say what it was. Every accepted command
// or sync, whether it applied, was staged, was refused or was a retry, gives
// one receipt of one size to its sender and asks for one tick, and a
// withdrawal adds its payout record; a report or an event result gives one
// receipt and asks for nothing; a tick gives no receipt, publishes the clock
// it applied first, then only public records, and asks for a tick only to
// carry on.
func TestEveryReplyHasOneShape(t *testing.T) {
	asked, archived := uint64(0), 0
	for _, s := range run(t, script()) {
		if s.Error != "" || s.Call == "restart" {
			continue
		}
		if s.Call == "deploy" {
			asked = 0
			continue
		}
		before, after := state(t, s.before), state(t, s.after)
		switch {
		case s.Call == "process" && (strings.Contains(string(s.Payload), `"type":"report"`) || strings.Contains(string(s.Payload), `"type":"resolve"`)):
			if len(s.Events) != 1 || s.Events[0].UserID != s.Sender || after.TickSeq != before.TickSeq {
				t.Fatalf("%s: %d receipts", s.Name, len(s.Events))
			}
			if r := body(t, s.Events[0]); r.Body.Type != "report" && r.Body.Type != "resolve" || r.Body.Tick != 0 {
				t.Fatalf("%s: receipt %s", s.Name, s.Events[0].Data)
			}
			for _, e := range s.AppEvents {
				if e.EventSubType == ArchiveSubType {
					archived++
				} else if e.EventSubType != SettleSubType && e.EventSubType != ConfirmSubType {
					t.Fatalf("%s: app event %x", s.Name, e.EventSubType)
				}
			}
		case s.Call == "process":
			asked++
			paid := len(s.AppEvents) == 2 && s.AppEvents[1].EventSubType == PayoutSubType
			if len(s.Events) != 1 || s.Events[0].UserID != s.Sender || len(s.AppEvents) != 1 && !paid || !asks(t, after, s.AppEvents[0]) || after.TickSeq != asked {
				t.Fatalf("%s: %d receipts, %d app events", s.Name, len(s.Events), len(s.AppEvents))
			}
			if r := body(t, s.Events[0]); r.Body.Tick != asked || paid != (r.Body.Withdrawal != 0) {
				t.Fatalf("%s: receipt %s", s.Name, s.Events[0].Data)
			}
		case s.Call == "trusted":
			if s.Events != nil || len(s.AppEvents) == 0 || s.AppEvents[0].EventSubType != ClockSubType || len(s.AppEvents[0].Data) != 224 ||
				!bytes.Equal(s.AppEvents[0].Data[:96], words(after.LastTick, after.Block, after.Clock)) || !bytes.Equal(s.AppEvents[0].Data[192:], keccak(s.Payload)) || after.TickSeq != before.TickSeq {
				t.Fatalf("%s: %d receipts, %d app events", s.Name, len(s.Events), len(s.AppEvents))
			}
			for _, e := range s.AppEvents[1:] {
				var record engine.RoundArchive
				switch e.EventSubType {
				case ArchiveSubType:
					if !canonical(e.Data, &record) {
						t.Fatalf("%s: archive record %s", s.Name, e.Data)
					}
					archived++
				case SettleSubType, CreditSubType, PayoutSubType, ConfirmSubType:
				default:
					t.Fatalf("%s: app event %x", s.Name, e.EventSubType)
				}
			}
		default:
			t.Fatalf("%s: a %s call succeeded", s.Name, s.Call)
		}
	}
	if archived != 3 {
		t.Fatalf("%d rounds archived, want 3", archived)
	}
}

// asks reports whether e is the request for st's latest tick: the tick
// number, the next deposit index, the counts of scheduled, open and
// unconfirmed rounds, then their registry IDs.
func asks(t testing.TB, st *State, e AppEvent) bool {
	t.Helper()
	var scheduled, open, confirm []byte
	for _, m := range st.rounds() {
		if m.Spec.Asset == engine.EventAsset {
			continue
		}
		if m.Status == "scheduled" {
			scheduled = append(scheduled, raw(m.Spec.RegistryRoundID)...)
		} else if m.Status == "open" {
			open = append(open, raw(m.Spec.RegistryRoundID)...)
		}
	}
	for _, u := range st.Unconfirmed {
		if !bytes.Contains(open, raw(u.Round)) {
			confirm = append(confirm, raw(u.Round)...)
		}
	}
	want := append(append(append(words(st.TickSeq, st.DepositsSeen+1, uint64(len(scheduled)/32), uint64(len(open)/32), uint64(len(confirm)/32)), scheduled...), open...), confirm...)
	return e.EventSubType == TickSubType && bytes.Equal(e.Data, want)
}

// The largest receipt this build can produce still fits one size class, so
// length never separates one outcome from another. Every kind of receipt body,
// with either kind of collected outcome, a view at every cap, the longest
// origin and application ID and every number at its cap. A receipt's engine
// receipt holds fills (an order) or released orders (cancel_all), not both.
func TestReceiptsAreOneSize(t *testing.T) {
	s := state(t, find(t, run(t, script()), "exact retry of the withdrawal has no effect").after)
	s.Origin = "https://" + strings.Repeat("a", 253)
	s.Engine.Rounds = []engine.Round{} // their IDs commit to the application ID, which changes here
	s.Engine.Config.Domain.ApplicationID = "18446744073709551615"
	s.LastTick, s.Block, s.Clock = engine.MaxAtoms, engine.MaxAtoms, MaxClock
	top, round := uint64(engine.MaxAtoms), strings.Repeat("ab", 32)
	id := engine.CommandID(alice, top)
	fill := engine.PrivateFill{OrderID: id, Role: "maker", Side: engine.Sell, RoundID: round, Outcome: engine.Down, Price: 99, Quantity: top, Fee: top}
	full := engine.PrivateReceipt{Sequence: top, CommandID: id, Status: "self_trade_cancelled", RoundID: round, OrderID: id, Amount: top, Fills: slices.Repeat([]engine.PrivateFill{fill}, MaxFills)}
	released := engine.PrivateReceipt{Sequence: top, CommandID: id, Status: "cancelled", RoundID: round, ReleasedOrders: slices.Repeat([]string{id}, MaxAccountOrders)}
	withdrawn := engine.PrivateReceipt{Sequence: top, CommandID: id, Status: "accepted", WithdrawalID: id, Amount: top}
	order := engine.Order{ID: id, Account: alice, RoundID: round, Outcome: engine.Down, Side: engine.Sell, Price: 99, Original: top, Remaining: top, Filled: top,
		FilledNotional: top, FeePaid: top, MaxFee: top, ReservedCash: top, Sequence: top, Expiry: top}
	view := engine.AccountSnapshot{Account: alice, Sequence: top, Nonce: top, Cash: top, ReservedCash: top, Withdrawals: []engine.Withdrawal{},
		Orders: slices.Repeat([]engine.Order{order}, MaxAccountOrders), Holdings: slices.Repeat([]engine.Holding{{RoundID: round, Up: top, Down: top, ReservedUp: top, ReservedDown: top}}, MaxSliceRounds)}
	reason := strings.Repeat("r", 128) // the longest reason is 73 bytes
	bodies := map[string]receiptBody{
		"applied":  {Type: "command", Status: "applied", Receipt: &full},
		"retry":    {Type: "command", Status: "retry", Receipt: &full},
		"released": {Type: "command", Status: "applied", Receipt: &released},
		"withdraw": {Type: "command", Status: "applied", Receipt: &withdrawn, Withdrawal: top},
		"rejected": {Type: "command", Status: "rejected", Reason: reason},
		"staged":   {Type: "command", Status: "staged"},
		"report":   {Type: "report", Status: "rejected", Reason: reason},
		"resolve":  {Type: "resolve", Status: "rejected", Reason: reason},
		"sync":     {Type: "sync", Status: "requested"},
	}
	longest := 0
	for name, b := range bodies {
		for _, o := range []outcomeReceipt{{Outcome{alice, id, top, "applied", ""}, &full}, {Outcome{alice, id, top, "rejected", reason}, nil}} {
			s.taken = &o
			data := s.receipt(alice, alice+":report:"+fmt.Sprint(uint64(MaxClock)), b).Data
			var e receiptEnvelope
			if len(data) != ReceiptBytes || !canonical(data, &e) || strings.Trim(e.Body.Pad, "0") != "" || e.Body.Outcome == nil || e.Body.View == nil {
				t.Errorf("%s with an %s outcome: %d bytes, want %d", name, o.Status, len(data), ReceiptBytes)
			}
			e.Body.View, e.Body.Pad, e.Body.At, e.Body.Tick = &view, "", receiptAt{top, top, MaxClock}, top
			longest = max(longest, len(marshal(e)))
		}
	}
	t.Logf("largest receipt before padding: %d of %d bytes", longest, ReceiptBytes)
	if longest > ReceiptBytes {
		t.Fatalf("a receipt can reach %d bytes; the size class is %d", longest, ReceiptBytes)
	}
	// A receipt that could not fit moves up a whole class; nothing is cut.
	if n := len(s.receipt(alice, id, receiptBody{Type: "command", Status: "rejected", Reason: strings.Repeat("r", ReceiptBytes)}).Data); n != 2*ReceiptBytes {
		t.Errorf("oversized receipt is %d bytes, want %d", n, 2*ReceiptBytes)
	}
}

// Every request has one length on chain, whatever it is, and every request
// that could be accepted fits it: each kind of command at its widest, with
// the longest origin, application ID, epoch and nonce (README section 4).
func TestRequestsAreOneSize(t *testing.T) {
	h := newHarness(t, alice, bob)
	n := h.next(alice)
	place := func(o engine.Outcome, side engine.Side) []byte {
		c := order(side, 60, 1_000_000, engine.GTC)
		c.Outcome = o
		return commandPayload(alice, n, c)
	}
	for name, p := range map[string][]byte{
		"sync":            syncPayload(alice),
		"mint":            commandPayload(alice, n, engine.Command{Op: engine.Mint, RoundID: id1, Quantity: 1_000_000}),
		"merge":           commandPayload(alice, n, engine.Command{Op: engine.Merge, RoundID: id1, Quantity: 1_000_000}),
		"redeem":          commandPayload(alice, n, engine.Command{Op: engine.Redeem, RoundID: id1}),
		"withdraw":        commandPayload(alice, n, engine.Command{Op: engine.RequestWithdrawal, Amount: 1_000_000, Destination: outside}),
		"cancel_all":      commandPayload(alice, n, engine.Command{Op: engine.CancelAll}),
		"cancel_order":    commandPayload(alice, n, engine.Command{Op: engine.CancelOrder, OrderID: engine.CommandID(alice, 3)}),
		"place up buy":    place(engine.Up, engine.Buy),
		"place up sell":   place(engine.Up, engine.Sell),
		"place down buy":  place(engine.Down, engine.Buy),
		"place down sell": place(engine.Down, engine.Sell),
		"report":          reportPayload(alice, chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report, uint32(b1)),
	} {
		if r := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, p, h.st)); len(p) != RequestBytes || r.Error != "" {
			t.Errorf("%s: %d bytes, error %q", name, len(p), r.Error)
		}
	}
	// The resolver's result, on a deployment with the event.
	ev := newHarnessWith(t, eventParams(), alice)
	resolve := resolvePayload(alice, 2, signResult(resolverKey, deployed(), eventID(testEvent()), 2))
	if r := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, resolve, ev.st)); len(resolve) != RequestBytes || r.Error != "" {
		t.Errorf("resolve: %d bytes, error %q", len(resolve), r.Error)
	}
	d := testDomain()
	d.ChainID, d.ApplicationID, d.Origin = 2651420, "18446744073709551615", "https://"+strings.Repeat("a", 253)
	top, round := uint64(engine.MaxAtoms), strings.Repeat("ab", 32)
	id := engine.CommandID(alice, top)
	longest := 0
	for _, c := range []engine.Command{{Op: engine.Register}, {Op: engine.Mint, RoundID: round, Quantity: top}, {Op: engine.Merge, RoundID: round, Quantity: top},
		{Op: engine.Redeem, RoundID: round}, {Op: engine.RequestWithdrawal, Amount: top, Destination: outside}, {Op: engine.CancelWithdrawal, WithdrawalID: id},
		{Op: engine.CancelOrder, OrderID: id}, {Op: engine.CancelAll, RoundID: round},
		{Op: engine.PlaceOrder, RoundID: round, Outcome: engine.Down, Side: engine.Sell, Price: 99, Quantity: top, TIF: engine.GTC, Expiry: MaxClock, MaxFee: top}} {
		c.Domain, c.ID, c.Nonce, c.Account = engine.Domain{ChainID: d.ChainID, Endpoint: endpoint, ApplicationID: d.ApplicationID, RulesVersion: engine.Version}, id, top, alice
		if c.Op == engine.PlaceOrder {
			// As long as staging takes, which is longer than any order the engine accepts.
			c.RoundID += strings.Repeat("a", MaxStagedBytes-len(marshal(c)))
		}
		longest = max(longest, len(marshal(requestEnvelope{1, d, alice, "9999999999", id, "command", requestBody{Type: "command", Command: string(marshal(c))}})))
	}
	longest = max(longest, len(marshal(requestEnvelope{1, d, alice, "9999999999", alice + ":resolve", "command", requestBody{Type: "resolve", Outcome: 2, Signature: "0x" + strings.Repeat("f", 130)}})))
	// A report fits only with the deployment's own domain, which deploy checks
	// (TestDeployRejected): here, with f = 5 and the longest request ID.
	full := make([]byte, 224+32+blobBytes+2*(32+32*6))
	at := alice + ":report:" + fmt.Sprint(uint64(MaxClock))
	if n := len(marshal(requestEnvelope{1, testDomain(), alice, epoch, at, "command", requestBody{Type: "report", Report: base64.StdEncoding.EncodeToString(full)}})); n > RequestBytes {
		t.Fatalf("a report request is %d bytes", n)
	} else {
		t.Logf("longest report request before padding: %d of %d bytes", n, RequestBytes)
	}
	t.Logf("longest request before padding: %d of %d bytes", longest, RequestBytes)
	if longest > RequestBytes {
		t.Fatalf("a request can reach %d bytes; the size class is %d", longest, RequestBytes)
	}
}

// spend stands in for earlier withdrawals: it raises the withdrawal count and
// fills the engine's evidence set until only free IDs are left.
func spend(s *State, free int) {
	for int(s.Deposits+2*s.Withdrawals) < maxEvidence-free {
		s.Withdrawals++
		s.Payouts++
		s.Engine.ExternalEvidence = append(s.Engine.ExternalEvidence, sha(fmt.Sprint("spent:", s.Withdrawals, ":a")), sha(fmt.Sprint("spent:", s.Withdrawals, ":b")))
	}
	sort.Strings(s.Engine.ExternalEvidence)
}

// One account recycling a single atom must not be able to use up the engine's
// evidence IDs and strand everybody else. Deposits and partial withdrawals stop
// while two IDs remain for every account that holds a balance, and a withdrawal
// of a whole balance is always taken.
func TestExitReserve(t *testing.T) {
	s := state(t, find(t, run(t, script()), "bob withdraws everything").after) // alice holds 150 tokens, bob nothing
	spend(s, 8)
	h := &harness{t: t, st: marshal(s), block: 5000}
	free := func() int { return maxEvidence - len(h.s().Engine.ExternalEvidence) }
	cash := func(who string) uint64 { return account(h.s().Engine, who).Cash }
	withdraw := func(who string, amount uint64) (paid bool, reason string) {
		before := h.st
		b := h.cmd(who, engine.Command{Op: engine.RequestWithdrawal, Amount: amount, Destination: who})
		if paid = b.Status == "applied"; !paid && !sameButTick(t, before, h.st) {
			t.Fatalf("a refused withdrawal by %s changed the ledger", who)
		}
		if !exitReserved(h.s().Engine) {
			t.Fatalf("withdrawal by %s left fewer evidence IDs than the funded accounts need", who)
		}
		return paid, b.Reason
	}
	const reserve = "exit reserve reached: only a withdrawal of the whole balance is accepted"

	if !h.credited(bob, 500_000_000) || free() != 7 { // the victim: two accounts now hold a balance
		t.Fatalf("victim's deposit: %d IDs free", free())
	}
	if paid, reason := withdraw(alice, 1); !paid || free() != 5 {
		t.Fatalf("a partial withdrawal above the reserve must be taken: %q, %d IDs free", reason, free())
	}
	if !h.credited(alice, 1) || free() != 4 {
		t.Fatalf("a deposit above the reserve must be taken: %d IDs free", free())
	}
	// Four IDs left and two funded accounts: nothing but a full exit now.
	if paid, reason := withdraw(alice, 1); paid || reason != reserve || free() != 4 {
		t.Fatalf("the attacker's partial withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if paid, reason := withdraw(bob, 1); paid || reason != reserve || free() != 4 {
		t.Fatalf("the victim's partial withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	// A deposit the reserve cannot take is refunded on Base in full.
	for name, who := range map[string]string{"a funded account": alice, "a new account": keeper} {
		if h.credited(who, 1) || free() != 4 {
			t.Fatalf("deposit by %s: %d IDs free", name, free())
		}
	}
	if paid, reason := withdraw(bob, cash(bob)); !paid || cash(bob) != 0 || free() != 2 {
		t.Fatalf("the victim's full withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if paid, reason := withdraw(alice, cash(alice)); !paid || cash(alice) != 0 || free() != 0 {
		t.Fatalf("the attacker's full withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if e := h.s().Engine; e.Custody != 0 || len(e.ExternalEvidence) != maxEvidence {
		t.Fatalf("custody %d left with %d evidence IDs used", e.Custody, len(e.ExternalEvidence))
	}
}

// The adapter must add nothing to the ledger: the same commands and times
// applied straight to the engine give the same engine state hash. The evidence
// strings are spelled out here on purpose.
func TestEngineReplay(t *testing.T) {
	steps := run(t, script())
	e, err := engine.New(deployed())
	if err != nil {
		t.Fatal(err)
	}
	apply := func(at uint64, who string, nonce uint64, system bool, c engine.Command) {
		t.Helper()
		c.Domain, c.Nonce, c.ID = e.Config.Domain, nonce, engine.CommandID(who, nonce)
		if e, _, err = engine.Apply(e, c, engine.AuthenticatedContext{Domain: e.Config.Domain, Principal: who, Timestamp: at, System: system}); err != nil {
			t.Fatal(err)
		}
	}
	system := func(at uint64, c engine.Command) { t.Helper(); apply(at, trigger, e.AuthorityNonce+1, true, c) }
	create := func(start uint64) {
		spec := mustSpec(start)
		system(t0, engine.Command{Op: engine.CreateRound, Round: &spec})
	}
	system(t0, engine.Command{Op: engine.Checkpoint})
	apply(t0, alice, 1, false, engine.Command{Op: engine.Register, Account: alice})
	system(t0, engine.Command{Op: engine.Deposit, Account: alice, Amount: 200_000_000, Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:BASE_DEPOSIT:8453:%s:%d:1", testCustody.Vault, testApp))})
	create(s1)
	create(s1 + 900)
	apply(t0, bob, 1, false, engine.Command{Op: engine.Register, Account: bob})
	apply(t0, alice, 2, false, engine.Command{Op: engine.RequestWithdrawal, Account: alice, Amount: 50_000_000, Destination: outside})
	system(t0, engine.Command{Op: engine.ExportWithdrawal, WithdrawalID: alice + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:WITHDRAWAL:31337:%s:%d:1", endpoint, testApp))})
	system(t0, engine.Command{Op: engine.ConfirmClaim, WithdrawalID: alice + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:CLAIM:31337:%s:%d:1", endpoint, testApp))})
	system(t0, engine.Command{Op: engine.Checkpoint}) // tick 9, stamped behind the clock
	system(t1, engine.Command{Op: engine.Checkpoint})
	system(t1, engine.Command{Op: engine.Deposit, Account: bob, Amount: 75_000_000, Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:BASE_DEPOSIT:8453:%s:%d:2", testCustody.Vault, testApp))})
	apply(t1, bob, 2, false, engine.Command{Op: engine.RequestWithdrawal, Account: bob, Amount: 75_000_000, Destination: bob})
	system(t1, engine.Command{Op: engine.ExportWithdrawal, WithdrawalID: bob + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:WITHDRAWAL:31337:%s:%d:2", endpoint, testApp))})
	system(t1, engine.Command{Op: engine.ConfirmClaim, WithdrawalID: bob + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:CLAIM:31337:%s:%d:2", endpoint, testApp))})
	want, err := engine.StateHash(e)
	if err != nil {
		t.Fatal(err)
	}
	if got := find(t, steps, "bob withdraws everything").EngineHash; got != want {
		t.Fatalf("adapter engine hash %s, direct replay %s", got, want)
	}
}

// Principal and time come from the host and the last tick, whatever a payload says.
func TestContextComesFromTheHost(t *testing.T) {
	before := find(t, run(t, script()), "bob registers").after // clock at t0
	for name, c := range map[string]struct {
		sender  string
		payload []byte
		want    string
	}{
		"envelope for alice from bob":         {bob, commandPayload(alice, 2, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: outside}), ErrMismatch},
		"command for bob in alice's envelope": {alice, envelope(alice, bob+":2", requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: deployed().Domain, ID: bob + ":2", Nonce: 2, Op: engine.RequestWithdrawal, Account: bob, Amount: 1, Destination: outside}))}), ErrMismatch},
		"request ID is not the command ID":    {alice, envelope(alice, alice+":9", requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: deployed().Domain, ID: alice + ":2", Nonce: 2, Op: engine.Register, Account: alice}))}), ErrContext},
		"command ID is not sender:nonce":      {alice, envelope(alice, "order-1", requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: deployed().Domain, ID: "order-1", Nonce: 2, Op: engine.Register, Account: alice}))}), ErrContext},
		"command for another deployment":      {alice, envelope(alice, alice+":2", requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: engine.Domain{ChainID: 31337, Endpoint: endpoint, ApplicationID: "8", RulesVersion: engine.Version}, ID: alice + ":2", Nonce: 2, Op: engine.Register, Account: alice}))}), ErrContext},
	} {
		if got := result(t, ProcessRequest(testApp, raw(c.sender), requestTypeProcess, c.payload, before)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
	// A user command lands at the last trusted clock; a client cannot name a time.
	out := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, commandPayload(alice, 2, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: outside}), before))
	if s := state(t, out.State); out.Error != "" || s.Engine.Time != t0 || s.Clock != t0 {
		t.Fatalf("user command moved the clock: %+v", out)
	}
	// The trigger address can never trade, even when the host names it as sender.
	out = result(t, ProcessRequest(testApp, raw(trigger), requestTypeProcess, commandPayload(trigger, 1, engine.Command{Op: engine.Register}), before))
	if r := body(t, out.Events[0]); out.Error != "" || !sameButTick(t, before, out.State) || r.Body.Status != "rejected" || r.Body.Reason != "authority cannot trade" {
		t.Fatalf("authority registered as a trader: %+v", r)
	}
	// Nor can it be credited a Base deposit: that is refunded.
	h := &harness{t: t, st: before, block: 5000}
	if h.credited(trigger, 1) || account(h.s().Engine, trigger) != nil || h.s().Payouts != 1 {
		t.Fatal("a deposit by the trigger was credited")
	}
}

func TestEnvelopeRejected(t *testing.T) {
	before := find(t, run(t, script()), "tick 1 sets the clock and credits alice's first Base deposit, registering her").after
	good := requestEnvelope{1, testDomain(), bob, epoch, bob + ":1", "command", requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: deployed().Domain, ID: bob + ":1", Nonce: 1, Op: engine.Register, Account: bob}))}}
	edit := func(f func(*requestEnvelope)) []byte { e := good; f(&e); return padded(e) }
	text := string(padded(good))
	if r := result(t, ProcessRequest(testApp, raw(bob), requestTypeProcess, []byte(text), before)); r.Error != "" || len(text) != RequestBytes || body(t, r.Events[0]).Body.Status != "applied" {
		t.Fatalf("the unedited envelope must be accepted: %+v", r)
	}
	// fit takes zeros out of the pad, or adds some, so that an edited envelope
	// is still RequestBytes long and only the edit can be what is refused.
	fit := func(s string) []byte {
		j := strings.LastIndex(s, `"pad":"`) + len(`"pad":"`)
		j += strings.IndexByte(s[j:], '"') // the pad's closing quote
		if d := RequestBytes - len(s); d < 0 {
			return []byte(s[:j+d] + s[j:])
		}
		return []byte(s[:j] + strings.Repeat("0", RequestBytes-len(s)) + s[j:])
	}
	// What session.ts encrypts for guest.ts's body without ../crypto/pad.ts:
	// canonical in every respect but its length.
	bare := marshal(bareEnvelope{1, good.Domain, bob, epoch, bob + ":1", "command", bareBody{Type: "command", Command: good.Body.Command}})
	for name, c := range map[string]struct {
		payload []byte
		want    string
	}{
		"other chain":           {edit(func(e *requestEnvelope) { e.Domain.ChainID = 84532 }), ErrContext},
		"other endpoint":        {edit(func(e *requestEnvelope) { e.Domain.Endpoint = outside }), ErrContext},
		"other application":     {edit(func(e *requestEnvelope) { e.Domain.ApplicationID = "8" }), ErrContext},
		"other wasm":            {edit(func(e *requestEnvelope) { e.Domain.ApplicationFingerprint = strings.Repeat("cd", 32) }), ErrContext},
		"other rules":           {edit(func(e *requestEnvelope) { e.Domain.RulesHash = strings.Repeat("cd", 32) }), ErrContext},
		"other origin":          {edit(func(e *requestEnvelope) { e.Domain.Origin = "https://zedge.example" }), ErrContext},
		"other epoch":           {edit(func(e *requestEnvelope) { e.Epoch = "2" }), ErrContext},
		"a receipt":             {edit(func(e *requestEnvelope) { e.Kind = "receipt" }), ErrContext},
		"version 2":             {edit(func(e *requestEnvelope) { e.Version = 2 }), ErrContext},
		"other account":         {edit(func(e *requestEnvelope) { e.Account = alice }), ErrMismatch},
		"unknown body type":     {edit(func(e *requestEnvelope) { e.Body.Type = "view" }), ErrEnvelope},
		"sync with a command":   {edit(func(e *requestEnvelope) { e.Body.Type, e.RequestID = "sync", bob+":sync" }), ErrEnvelope},
		"sync under another ID": {edit(func(e *requestEnvelope) { e.Body, e.RequestID = requestBody{Type: "sync"}, bob+":1" }), ErrEnvelope},
		"sync with a report":    {edit(func(e *requestEnvelope) { e.Body, e.RequestID = requestBody{Type: "sync", Report: "AAAA"}, bob+":sync" }), ErrEnvelope},
		"command with a report": {edit(func(e *requestEnvelope) { e.Body.Report = "AAAA" }), ErrEnvelope},
		"report with a command": {edit(func(e *requestEnvelope) { e.Body.Type, e.Body.Report, e.RequestID = "report", "AAAA", bob+":report:0" }), ErrEnvelope},
		"report not in base64": {edit(func(e *requestEnvelope) {
			e.Body, e.RequestID = requestBody{Type: "report", Report: "AA*A"}, bob+":report:0"
		}), ErrEnvelope},
		"report in unpadded base64": {edit(func(e *requestEnvelope) {
			e.Body, e.RequestID = requestBody{Type: "report", Report: "AA"}, bob+":report:0"
		}), ErrEnvelope},
		"report in URL base64": {edit(func(e *requestEnvelope) {
			e.Body, e.RequestID = requestBody{Type: "report", Report: "-_-_"}, bob+":report:0"
		}), ErrEnvelope},
		"report under a command ID":   {edit(func(e *requestEnvelope) { e.Body = requestBody{Type: "report", Report: "AAAA"} }), ErrEnvelope},
		"empty command":               {edit(func(e *requestEnvelope) { e.Body.Command = "" }), ErrCommand},
		"command with a space":        {edit(func(e *requestEnvelope) { e.Body.Command += " " }), ErrCommand},
		"command keys reordered":      {edit(func(e *requestEnvelope) { e.Body.Command = `{"id":"x",` + e.Body.Command[1:] }), ErrCommand},
		"command over the size":       {commandPayload(bob, 1, engine.Command{Op: engine.Register, RoundID: strings.Repeat("a", RequestBytes)}), ErrEnvelope},
		"empty":                       {nil, ErrEnvelope},
		"not padded":                  {bare, ErrEnvelope},
		"padded with something else":  {fit(strings.Replace(text, `"pad":"0`, `"pad":"1`, 1)), ErrEnvelope},
		"padded with escaped zeros":   {fit(strings.Replace(text, `"pad":"0`, `"pad":"\u0030`, 1)), ErrEnvelope},
		"one byte short":              {[]byte(strings.Replace(text, `"pad":"0`, `"pad":"`, 1)), ErrEnvelope},
		"one byte long":               {[]byte(strings.Replace(text, `"pad":"`, `"pad":"0`, 1)), ErrEnvelope},
		"trailing byte":               {fit(text + " "), ErrEnvelope},
		"leading space":               {fit(" " + text), ErrEnvelope},
		"unknown field":               {fit(strings.Replace(text, `"kind"`, `"extra":1,"kind"`, 1)), ErrEnvelope},
		"duplicate field":             {fit(strings.Replace(text, `"kind"`, `"epoch":"1","kind"`, 1)), ErrEnvelope},
		"keys reordered":              {fit(strings.Replace(text, `{"version":1,`, `{`, 1)[:len(text)-13] + `,"version":1}`), ErrEnvelope},
		"pad outside the body":        {fit(strings.Replace(text, `"body":{`, `"pad":"","body":{`, 1)), ErrEnvelope},
		"body as a string":            {fit(strings.Replace(text, `"body":{`, `"body":"x","b":{`, 1)), ErrEnvelope},
		"number as a string":          {fit(strings.Replace(text, `"version":1`, `"version":"1"`, 1)), ErrEnvelope},
		"not JSON":                    {[]byte{0xff, 0x00, 0x7b}, ErrEnvelope},
		"not JSON, of the right size": {bytes.Repeat([]byte{'{'}, RequestBytes), ErrEnvelope},
	} {
		if c.payload != nil && len(c.payload) != RequestBytes && c.want != ErrEnvelope {
			t.Fatalf("%s: %d bytes would be refused for its length", name, len(c.payload))
		}
		if got := result(t, ProcessRequest(testApp, raw(bob), requestTypeProcess, c.payload, before)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
	for _, kind := range []int32{0, 2, 3, 4, -1} { // deploy, deanonymize, associate key, trusted
		if got := result(t, ProcessRequest(testApp, raw(bob), kind, []byte(text), before)).Error; got != ErrRequestType {
			t.Errorf("request type %d: error %q", kind, got)
		}
	}
	for name, sender := range map[string][]byte{"short": raw(bob)[:19], "long": append(raw(bob), 0), "zero": make([]byte, 20), "none": nil} {
		if got := result(t, ProcessRequest(testApp, sender, requestTypeProcess, []byte(text), before)).Error; got != ErrSender {
			t.Errorf("%s sender: error %q", name, got)
		}
	}
	if got := result(t, ProcessRequest(testApp+1, raw(bob), requestTypeProcess, []byte(text), before)).Error; got != ErrApplication {
		t.Errorf("another application's ID: error %q", got)
	}
}

// Custody is the Base vault (README section 6): the endpoint's own deposit
// path is refused whatever it carries, and the inbox's records are credited
// exactly once each, in index order, or refunded in full.
func TestBaseDeposits(t *testing.T) {
	before := find(t, run(t, script()), "tick with an earlier block number is accepted").after // indexes 1 and 2 seen
	for name, st := range map[string][]byte{"a valid state": before, "no state": nil} {
		if got := result(t, Deposit(testApp, raw(bob), raw(collateral), []byte{1}, st)).Error; got != ErrToken {
			t.Errorf("Vela deposit with %s: %q", name, got)
		}
	}
	s := state(t, before)
	h := &harness{t: t, st: before, block: 5000}
	tick := func(deposits ...dep) Result {
		h.sync(keeper)
		h.block++
		r := h.ok(result(t, TrustedRequest(testApp, tick3(h.s().TickSeq, h.block, h.s().Clock, nil, deposits), h.st)))
		h.st = r.State
		return r
	}
	credits := func(r Result) (out []uint64) {
		for _, e := range r.AppEvents {
			if e.EventSubType == CreditSubType {
				out = append(out, new(big.Int).SetBytes(e.Data[:32]).Uint64(), new(big.Int).SetBytes(e.Data[96:128]).Uint64())
			}
		}
		return out
	}
	// A gap waits, a repeat is skipped, the rest go in index order.
	if r := tick(dep{4, bob, 1}); credits(r) != nil || h.s().DepositsSeen != 2 {
		t.Fatalf("a gap was not waited at: %v", credits(r))
	}
	if r := tick(dep{2, bob, 1}, dep{3, bob, 7}, dep{3, bob, 7}, dep{4, carol, 9}, dep{6, bob, 1}); !slices.Equal(credits(r), []uint64{3, 1, 4, 1}) || h.s().DepositsSeen != 4 ||
		account(h.s().Engine, bob).Cash != 7 || account(h.s().Engine, carol).Cash != 9 || h.s().Engine.Deposited != state(t, before).Engine.Deposited+16 {
		t.Fatalf("credits %v: seen %d, bob %d, deposited %d", credits(r), h.s().DepositsSeen, account(h.s().Engine, bob).Cash, h.s().Engine.Deposited)
	}
	// What the engine cannot take is refunded: past the atom cap (but within
	// the inbox's uint96), past the lifetime cap.
	if r := tick(dep{5, bob, engine.MaxAtoms + 1}, dep{6, bob, engine.MaxAtoms - h.s().Engine.Deposited + 1}); !slices.Equal(credits(r), []uint64{5, 2, 6, 2}) || h.s().Payouts != s.Payouts+2 {
		t.Fatalf("refunds %v", credits(r))
	}
	// A record the inbox could not have written stops processing there.
	for name, edit := range map[string]func([]byte){
		"an account with high bytes": func(p []byte) { p[len(p)-64] = 1 },
		"a zero account":             func(p []byte) { copy(p[len(p)-64:len(p)-32], make([]byte, 32)) },
		"a zero amount":              func(p []byte) { copy(p[len(p)-32:], make([]byte, 32)) },
		"an amount past uint96":      func(p []byte) { p[len(p)-13] = 1 },
		"an index past the cap":      func(p []byte) { p[len(p)-96+23] = 1 },
	} {
		h.sync(keeper)
		h.block++
		p := tick3(h.s().TickSeq, h.block, h.s().Clock, nil, []dep{{7, bob, 1}})
		edit(p)
		r := h.ok(result(t, TrustedRequest(testApp, p, h.st)))
		if h.st = r.State; credits(r) != nil || h.s().DepositsSeen != 6 {
			t.Fatalf("%s: credited %v", name, credits(r))
		}
	}
	// No more than MaxDeposits records in one payload.
	h.sync(keeper)
	if got := result(t, TrustedRequest(testApp, tick3(h.s().TickSeq, h.block+1, h.s().Clock, nil, deps(7, 0x100, MaxDeposits+1, 1)), h.st)).Error; got != ErrTrusted {
		t.Fatalf("nine deposit records: %q", got)
	}
}

func TestTickRejected(t *testing.T) {
	before := find(t, run(t, script()), "sync asks for tick 10").after // clock at t0 / block0, ticks 2 to 10 requested
	if s := state(t, before); s.Clock != t0 || s.TickSeq != 10 || s.LastTick != 1 {
		t.Fatalf("unexpected starting point: %+v", s)
	}
	dirty := func(i int) []byte { p := tickPayload(2, block1, t1); p[i] = 1; return p }
	_ = binary.BigEndian
	word := func(i int, v uint64) []byte {
		p := tickPayload(2, block1, t1)
		binary.BigEndian.PutUint64(p[32*i+24:], v)
		return p
	}
	if r := result(t, TrustedRequest(testApp, tickPayload(2, block0, t0), before)); r.Error != "" || r.Events != nil || r.Withdrawals != nil {
		t.Fatalf("a tick in the same block and second must be accepted: %+v", r)
	}
	if r := result(t, TrustedRequest(testApp, tickPayload(2, block0, t0-1), before)); r.Error != "" || state(t, r.State).Clock != t0 {
		t.Fatalf("a tick behind the clock must apply at the clock: %+v", r.Error)
	}
	// The block number is not an ordering rule, and the timestamp cap itself is a time.
	if r := result(t, TrustedRequest(testApp, tickPayload(2, block0-1, MaxClock), before)); r.Error != "" || state(t, r.State).Block != block0-1 || state(t, r.State).Clock != MaxClock {
		t.Fatalf("a tick at the cap with an earlier block number must be accepted: %+v", r.Error)
	}
	for name, c := range map[string]struct {
		payload []byte
		want    string
	}{
		"empty":                  {nil, ErrTrusted},
		"one byte short":         {tickPayload(2, block1, t1)[:255], ErrTrusted},
		"one byte long":          {append(tickPayload(2, block1, t1), 0), ErrTrusted},
		"one word long":          {append(tickPayload(2, block1, t1), make([]byte, 32)...), ErrTrusted},
		"version 1":              {tickPayload(2, block1, t1)[:192], ErrTrusted},
		"version 2":              {word(0, 2), ErrTrusted},
		"version 4":              {word(0, 4), ErrTrusted},
		"a record not sent":      {word(6, 1), ErrTrusted},
		"a deposit not sent":     {word(7, 1), ErrTrusted},
		"17 records":             {word(6, MaxRecords+1), ErrTrusted},
		"other chain":            {word(1, 1), ErrTrusted},
		"other endpoint":         {dirty(95), ErrTrusted},
		"dirty address padding":  {dirty(64), ErrTrusted},
		"timestamp over 64 bits": {dirty(4*32 + 23), ErrTrusted},
		"tick over 64 bits":      {dirty(5 * 32), ErrTrusted},
		"tick 0":                 {word(5, 0), ErrTick},
		"tick already applied":   {word(5, 1), ErrTick},
		"tick not requested":     {word(5, 11), ErrTick},
		"timestamp 0":            {word(4, 0), ErrTrusted},
		"timestamp past the cap": {word(4, MaxClock+1), ErrTrusted},
		"timestamp of 10^15":     {word(4, engine.MaxAtoms), ErrTrusted},
		"block past the cap":     {word(3, engine.MaxAtoms+1), ErrTrusted},
	} {
		if got := result(t, TrustedRequest(testApp, c.payload, before)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
}

func TestDeployRejected(t *testing.T) {
	edit := func(f func(*DeployParams)) []byte { p := testParams(); f(&p); return marshal(p) }
	good := marshal(testParams())
	if r := result(t, Deploy(testApp, good, testSalt)); r.Error != "" || state(t, r.State).Engine.Config.Domain.ApplicationID != fmt.Sprint(testApp) || r.Events != nil ||
		state(t, r.State).Salt != strings.Repeat("5a", 32) {
		t.Fatalf("deploy: %+v", r.Error)
	}
	if r := result(t, Deploy(testApp, edit(func(p *DeployParams) { p.Markets = []Market{{"ETH", 300}} }), testSalt)); r.Error != "" || state(t, r.State).Markets[0] != (Market{"ETH", 300}) {
		t.Fatalf("deploy of another market: %+v", r.Error)
	}
	if got := result(t, Deploy(0, good, testSalt)).Error; got != ErrApplication {
		t.Errorf("application 0: error %q", got)
	}
	// No deployment starts without 32 bytes from the host's random source.
	for name, salt := range map[string][]byte{"no salt": nil, "short salt": testSalt[:31], "long salt": append(testSalt[:32:32], 1), "salt of zeros": make([]byte, 32)} {
		if got := result(t, Deploy(testApp, good, salt)).Error; got != ErrInternal {
			t.Errorf("%s: error %q", name, got)
		}
	}
	for name, c := range map[string]struct {
		params []byte
		want   string
	}{
		"empty":                  {nil, ErrParams},
		"application ID given":   {edit(func(p *DeployParams) { p.Engine.Domain.ApplicationID = fmt.Sprint(testApp) }), ErrParams},
		"trailing byte":          {append(append([]byte{}, good...), '\n'), ErrParams},
		"unknown field":          {[]byte(strings.Replace(string(good), `"origin"`, `"admin":"x","origin"`, 1)), ErrParams},
		"canonical but too long": {edit(func(p *DeployParams) { p.Origin = "https://" + strings.Repeat("a", MaxParamsBytes) }), ErrParams},
		"Ethereum mainnet":       {edit(func(p *DeployParams) { p.Engine.Domain.ChainID = 1 }), ErrConfig},
		"Base mainnet":           {edit(func(p *DeployParams) { p.Engine.Domain.ChainID = 8453 }), ErrConfig},
		"registry elsewhere": {edit(func(p *DeployParams) {
			p.Engine.Oracle.ChainID = 84532 // consistent in itself, but not the endpoint's chain
			p.Engine.Oracle.RulesHash, _ = engine.RegistryRulesHash(p.Engine)
		}), ErrConfig},
		"wrong rules hash":       {edit(func(p *DeployParams) { p.Engine.FeeBps, p.Engine.Oracle.CutoffBuffer = 100, 6 }), ErrConfig},
		"fee above the cap":      {edit(func(p *DeployParams) { p.Engine.FeeBps = 1001 }), ErrConfig},
		"short fingerprint":      {edit(func(p *DeployParams) { p.ApplicationFingerprint = "ab" }), ErrConfig},
		"uppercase fingerprint":  {edit(func(p *DeployParams) { p.ApplicationFingerprint = strings.Repeat("AB", 32) }), ErrConfig},
		"origin without scheme":  {edit(func(p *DeployParams) { p.Origin = "localhost:5173" }), ErrConfig},
		"origin with a path":     {edit(func(p *DeployParams) { p.Origin = "https://zedge.example/app" }), ErrConfig},
		"origin with a quote":    {edit(func(p *DeployParams) { p.Origin = `https://zedge.example"` }), ErrConfig},
		"epoch 0":                {edit(func(p *DeployParams) { p.Epoch = "0" }), ErrConfig},
		"epoch with a sign":      {edit(func(p *DeployParams) { p.Epoch = "+1" }), ErrConfig},
		"epoch of eleven digits": {edit(func(p *DeployParams) { p.Epoch = "12345678901" }), ErrConfig},
		"markets missing":        {[]byte(strings.Replace(string(good), `,"markets":[{"asset":"BTC","duration":900}]`, "", 1)), ErrParams},
		"markets null":           {edit(func(p *DeployParams) { p.Markets = nil }), ErrConfig},
		"no market":              {edit(func(p *DeployParams) { p.Markets = []Market{} }), ErrConfig},
		"two markets":            {edit(func(p *DeployParams) { p.Markets = []Market{{"BTC", 900}, {"ETH", 900}} }), ErrConfig},
		"unknown asset":          {edit(func(p *DeployParams) { p.Markets = []Market{{"SOL", 900}} }), ErrConfig},
		"unknown duration":       {edit(func(p *DeployParams) { p.Markets = []Market{{"BTC", 60}} }), ErrConfig},
		"stake limits missing":   {[]byte(strings.Replace(string(good), `,"stakeLimits":`+string(marshal(testLimits)), "", 1)), ErrParams},
		"no stake limits":        {edit(func(p *DeployParams) { p.StakeLimits = StakeLimits{} }), ErrConfig},
		"account limit 0":        {edit(func(p *DeployParams) { p.StakeLimits.Account = 0 }), ErrConfig},
		"boundary limit 0":       {edit(func(p *DeployParams) { p.StakeLimits.Boundary = 0 }), ErrConfig},
		"house limit 0":          {edit(func(p *DeployParams) { p.StakeLimits.HouseTotal = 0 }), ErrConfig},
		"limit past the cap":     {edit(func(p *DeployParams) { p.StakeLimits.Boundary = engine.MaxAtoms + 1 }), ErrConfig},
		"no house":               {edit(func(p *DeployParams) { p.StakeLimits.House = "" }), ErrConfig},
		"uppercase house":        {edit(func(p *DeployParams) { p.StakeLimits.House = strings.ToUpper(house) }), ErrConfig},
		"house of zeros":         {edit(func(p *DeployParams) { p.StakeLimits.House = "0x" + strings.Repeat("0", 40) }), ErrConfig},
		"account above boundary": {edit(func(p *DeployParams) { p.StakeLimits.Account = p.StakeLimits.Boundary + 1 }), ErrConfig},
		"house is the trigger":   {edit(func(p *DeployParams) { p.StakeLimits.House = trigger }), ErrConfig}, // the authority can never trade
		"house is the endpoint":  {edit(func(p *DeployParams) { p.StakeLimits.House = endpoint }), ErrConfig},
		"house is the token":     {edit(func(p *DeployParams) { p.StakeLimits.House = collateral }), ErrConfig},
		"no Chainlink config":    {edit(func(p *DeployParams) { p.Chainlink.Configs = nil }), ErrConfig},
		"another feed":           {edit(func(p *DeployParams) { p.Chainlink.FeedID = engine.ETHStreamsFeed }), ErrConfig},
		"five digests": {edit(func(p *DeployParams) {
			for i := 0; i < MaxDigests; i++ {
				d := p.Chainlink.Configs[0]
				d.Digest = fmt.Sprintf("0x%064x", i+1)
				p.Chainlink.Configs = append(p.Chainlink.Configs, d)
			}
		}), ErrConfig},
		"a digest twice":   {edit(func(p *DeployParams) { p.Chainlink.Configs = append(p.Chainlink.Configs, p.Chainlink.Configs[0]) }), ErrConfig},
		"a zero digest":    {edit(func(p *DeployParams) { p.Chainlink.Configs[0].Digest = "0x" + strings.Repeat("0", 64) }), ErrConfig},
		"uppercase digest": {edit(func(p *DeployParams) { p.Chainlink.Configs[0].Digest = strings.ToUpper(p.Chainlink.Configs[0].Digest) }), ErrConfig},
		"f of 0":           {edit(func(p *DeployParams) { p.Chainlink.Configs[0].F = 0 }), ErrConfig},
		"fewer than 3f+1":  {edit(func(p *DeployParams) { p.Chainlink.Configs[0].Signers = p.Chainlink.Configs[0].Signers[:15] }), ErrConfig},
		"a signer twice":   {edit(func(p *DeployParams) { p.Chainlink.Configs[0].Signers[1] = p.Chainlink.Configs[0].Signers[0] }), ErrConfig},
		"a zero signer":    {edit(func(p *DeployParams) { p.Chainlink.Configs[0].Signers[1] = "0x" + strings.Repeat("0", 40) }), ErrConfig},
		"an uppercase signer": {edit(func(p *DeployParams) {
			p.Chainlink.Configs[0].Signers[1] = strings.ToUpper(p.Chainlink.Configs[0].Signers[1])
		}), ErrConfig},
		"custody on another chain": {edit(func(p *DeployParams) { p.Custody.ChainID = 84532 }), ErrConfig},
		"no vault":                 {edit(func(p *DeployParams) { p.Custody.Vault = "" }), ErrConfig},
		"vault is the inbox":       {edit(func(p *DeployParams) { p.Custody.Vault = p.Custody.Inbox }), ErrConfig},
		"vault is the endpoint":    {edit(func(p *DeployParams) { p.Custody.Vault = endpoint }), ErrConfig},
		"inbox is the trigger":     {edit(func(p *DeployParams) { p.Custody.Inbox = trigger }), ErrConfig},
		"custody missing":          {[]byte(strings.Replace(string(good), `,"custody":`+string(marshal(testCustody)), "", 1)), ErrParams},
		// A report request this deployment could not be sent: its origin is
		// so long that a report with f+1 = 6 signatures no longer fits.
		"reports that cannot fit": {edit(func(p *DeployParams) { p.Origin = "https://" + strings.Repeat("a", 200) }), ErrConfig},
		// The event and its resolver (README section 13).
		"an event without a resolver": {edit(func(p *DeployParams) { p.Event = testEvent() }), ErrConfig},
		"a resolver without an event": {edit(func(p *DeployParams) { p.Resolver = resolver }), ErrConfig},
		"the house as resolver":       {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), house }), ErrConfig},
		"the trigger as resolver":     {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), trigger }), ErrConfig},
		"the endpoint as resolver":    {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), endpoint }), ErrConfig},
		"the vault as resolver":       {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), testCustody.Vault }), ErrConfig},
		"an uppercase resolver":       {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), strings.ToUpper(resolver) }), ErrConfig},
		"a resolver of zeros":         {edit(func(p *DeployParams) { p.Event, p.Resolver = testEvent(), "0x"+strings.Repeat("0", 40) }), ErrConfig},
		"an event cut off after its end": {edit(func(p *DeployParams) {
			p.Event, p.Resolver = testEvent(), resolver
			p.Event.Cutoff = p.Event.End + 1
		}), ErrConfig},
		"an event question that is no hash": {edit(func(p *DeployParams) {
			p.Event, p.Resolver = testEvent(), resolver
			p.Event.Question = "0x" + strings.Repeat("0", 64)
		}), ErrConfig},
		"an event of null":         {[]byte(strings.Replace(string(good), `,"custody":`, `,"event":null,"custody":`, 1)), ErrParams},
		"deposits from 0 spelled":  {[]byte(strings.TrimSuffix(string(good), "}") + `,"depositsFrom":0}`), ErrParams},
		"deposits from past 10^15": {edit(func(p *DeployParams) { p.DepositsFrom = engine.MaxAtoms + 1 }), ErrConfig},
	} {
		if got := result(t, Deploy(testApp, c.params, testSalt)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
}

// A stored state is accepted only in its one canonical, self-consistent form.
func TestStateRejected(t *testing.T) {
	good := find(t, run(t, script()), "exact retry of the withdrawal has no effect").after // after alice's withdrawal
	edit := func(f func(*State)) []byte {
		s := state(t, good)
		f(s)
		return marshal(s)
	}
	text := string(good)
	for name, b := range map[string][]byte{
		"empty":                    nil,
		"null":                     []byte("null"),
		"leading space":            []byte(" " + text),
		"unknown field":            []byte(`{"owner":"x",` + text[1:]),
		"version 1":                edit(func(s *State) { s.Version = 1 }), // the time-free build, which had no markets or outcomes
		"no market":                edit(func(s *State) { s.Markets = []Market{} }),
		"two markets":              edit(func(s *State) { s.Markets = append(s.Markets, Market{"ETH", 300}) }),
		"market of another length": edit(func(s *State) { s.Markets[0].Duration = 600 }),
		"staged without a command": edit(func(s *State) { s.Staged = []Staged{{Tick: 1}} }),
		"staged withdrawal":        edit(func(s *State) { s.Staged = []Staged{{1, staged(alice, 3, engine.RequestWithdrawal)}} }),
		"staged past nonce":        edit(func(s *State) { s.Staged = []Staged{{1, staged(alice, 2, engine.CancelAll)}} }),
		"staged for nobody":        edit(func(s *State) { s.Staged = []Staged{{1, staged(keeper, 1, engine.CancelAll)}} }),
		"staged tick not asked":    edit(func(s *State) { s.Staged = []Staged{{s.TickSeq + 1, staged(alice, 3, engine.CancelAll)}} }),
		"staged twice": edit(func(s *State) {
			s.Staged = []Staged{{1, staged(alice, 3, engine.CancelAll)}, {2, staged(alice, 3, engine.CancelAll)}}
		}),
		"staged out of tick order": edit(func(s *State) {
			s.Staged = []Staged{{2, staged(alice, 3, engine.CancelAll)}, {1, staged(bob, 2, engine.CancelAll)}}
		}),
		"staged command too large": edit(func(s *State) {
			c := staged(alice, 3, engine.CancelAll)
			c.RoundID = strings.Repeat("ab", 300)
			s.Staged = []Staged{{1, c}}
		}),
		"staged null":   edit(func(s *State) { s.Staged = nil }),
		"outcomes null": edit(func(s *State) { s.Outcomes = nil }),
		"outcome unsorted": edit(func(s *State) {
			s.Outcomes = []Outcome{{alice, alice + ":3", 1, "applied", ""}, {bob, bob + ":2", 1, "applied", ""}}
		}),
		"outcome tick not applied": edit(func(s *State) { s.Outcomes = []Outcome{{alice, alice + ":3", s.LastTick + 1, "applied", ""}} }),
		"outcome of another":       edit(func(s *State) { s.Outcomes = []Outcome{{alice, bob + ":3", 1, "applied", ""}} }),
		"applied with a reason":    edit(func(s *State) { s.Outcomes = []Outcome{{alice, alice + ":3", 1, "applied", "x"}} }),
		"rejected without reason":  edit(func(s *State) { s.Outcomes = []Outcome{{alice, alice + ":3", 1, "rejected", ""}} }),
		"deposit seen twice":       edit(func(s *State) { s.DepositsSeen-- }),
		"payout from nowhere":      edit(func(s *State) { s.Payouts++ }),
		"refund without a deposit": edit(func(s *State) { s.DepositsSeen++ }),
		"unconfirmed null":         edit(func(s *State) { s.Unconfirmed = nil }),
		"unconfirmed twice": edit(func(s *State) {
			u := Unconfirmed{"0x" + strings.Repeat("ab", 32), "0x" + strings.Repeat("cd", 32), "", 0}
			s.Unconfirmed = []Unconfirmed{u, u}
		}),
		"unconfirmed outcome without closing": edit(func(s *State) {
			s.Unconfirmed = []Unconfirmed{{"0x" + strings.Repeat("ab", 32), "0x" + strings.Repeat("cd", 32), "", 1}}
		}),
		"unconfirmed void": edit(func(s *State) {
			s.Unconfirmed = []Unconfirmed{{"0x" + strings.Repeat("ab", 32), "0x" + strings.Repeat("cd", 32), "0x" + strings.Repeat("ef", 32), 3}}
		}),
		"nine unconfirmed": edit(func(s *State) {
			for i := 0; i <= MaxUnconfirmed; i++ {
				s.Unconfirmed = append(s.Unconfirmed, Unconfirmed{fmt.Sprintf("0x%064x", i+1), "0x" + strings.Repeat("cd", 32), "", 0})
			}
		}),
		"no Chainlink config":      edit(func(s *State) { s.Chainlink = Chainlink{} }),
		"no custody":               edit(func(s *State) { s.Custody = Custody{} }),
		"version 3":                edit(func(s *State) { s.Version = 3 }), // the build that held custody in the endpoint
		"no engine":                edit(func(s *State) { s.Engine = nil }),
		"clock without a tick":     edit(func(s *State) { s.LastTick = 0 }),
		"tick never requested":     edit(func(s *State) { s.LastTick = s.TickSeq + 1 }),
		"engine ahead of clock":    edit(func(s *State) { s.Clock = s.Engine.Time - 1 }),
		"deposit count":            edit(func(s *State) { s.Deposits++ }),
		"withdrawal count":         edit(func(s *State) { s.Withdrawals-- }),
		"cash from nowhere":        edit(func(s *State) { s.Engine.Accounts[0].Cash++ }),
		"claim left open":          edit(func(s *State) { s.Engine.Claimable, s.Engine.PaidOut = 1, s.Engine.PaidOut-1 }),
		"unsupported chain":        edit(func(s *State) { s.Engine.Config.Domain.ChainID = 1 }),
		"no stake limits":          edit(func(s *State) { s.StakeLimits = StakeLimits{} }),
		"uppercase house":          edit(func(s *State) { s.StakeLimits.House = strings.ToUpper(house) }),
		"house is the trigger":     edit(func(s *State) { s.StakeLimits.House = trigger }),
		"version 2":                edit(func(s *State) { s.Version = 2 }), // the build before stake limits
		"application ID not a u64": edit(func(s *State) { s.Engine.Config.Domain.ApplicationID = "zedge" }),
		"other fingerprint shape":  edit(func(s *State) { s.ApplicationFingerprint = "0x" + fingerprint[2:] }),
		"no salt":                  edit(func(s *State) { s.Salt = "" }),
		"salt of zeros":            edit(func(s *State) { s.Salt = strings.Repeat("0", 64) }),
		"uppercase salt":           edit(func(s *State) { s.Salt = strings.Repeat("5A", 32) }),
		"clock past the cap":       edit(func(s *State) { s.Clock = MaxClock + 1 }),
		"registry elsewhere": edit(func(s *State) {
			s.Engine.Config.Oracle.ChainID = 84532
			s.Engine.Config.Oracle.RulesHash, _ = engine.RegistryRulesHash(s.Engine.Config)
		}),
		"deposits from past those seen":   edit(func(s *State) { s.DepositsFrom = s.DepositsSeen + 1 }),
		"credits from below depositsFrom": edit(func(s *State) { s.DepositsFrom = s.DepositsSeen }),
		// The same two with payouts made to balance in wrapped arithmetic: a
		// negative count of refunds hidden by an extra withdrawal.
		"deposits from past those seen, balanced": edit(func(s *State) {
			spend(s, maxEvidence-int(s.Deposits+2*s.Withdrawals)-2)
			s.DepositsFrom = s.DepositsSeen + 1
			s.Payouts = s.Withdrawals + s.DepositsSeen - s.DepositsFrom - s.Deposits
		}),
		"credits from below depositsFrom, balanced": edit(func(s *State) {
			s.DepositsFrom = s.DepositsSeen
			s.Payouts = s.Withdrawals + s.DepositsSeen - s.DepositsFrom - s.Deposits
		}),
		"a resolver without an event": edit(func(s *State) { s.Resolver = resolver }),
		// Valid in every other respect: only its size is refused.
		"one byte over the bound": inflate(t, good, MaxStateBytes+1),
	} {
		if _, err := DecodeState(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
		if got := result(t, TrustedRequest(testApp, tickPayload(2, block1, t1), b)).Error; got != ErrState {
			t.Errorf("%s: error %q", name, got)
		}
	}
	if _, err := DecodeState(inflate(t, good, MaxStateBytes)); err != nil {
		t.Errorf("a state of exactly the bound must be accepted: %v", err)
	}
	if _, err := DecodeState(edit(func(s *State) {
		s.Staged = []Staged{{1, staged(bob, 2, engine.CancelAll)}, {2, staged(alice, 3, engine.CancelAll)}}
		s.Outcomes = []Outcome{{bob, bob + ":2", 1, "applied", ""}, {alice, alice + ":3", 1, "rejected", "x"}}
	})); err != nil {
		t.Errorf("staged commands and outcomes in order must be accepted: %v", err)
	}
}

// staged is a canonical book command (or, for the refusal cases, not one).
func staged(who string, nonce uint64, op engine.Operation) engine.Command {
	c, _ := command(who, nonce, engine.Command{Op: op})
	return c
}
