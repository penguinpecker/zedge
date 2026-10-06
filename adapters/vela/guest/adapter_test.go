package guest

import (
	"bytes"
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
	}
	for name, want := range map[string]string{
		"deposit before the first tick fails":   ErrClock,
		"command before the first tick fails":   ErrClock,
		"deposit of another token fails":        ErrToken,
		"deposit of ETH fails":                  ErrToken,
		"alice's command from bob fails":        ErrMismatch,
		"truncated envelope fails":              ErrEnvelope,
		"deeply nested payload fails":           ErrEnvelope,
		"command with a nested trailer fails":   ErrCommand,
		"oversized payload fails":               ErrEnvelope,
		"replayed tick fails":                   ErrTick,
		"tick nobody asked for fails":           ErrTick,
		"malformed tick fails":                  ErrTrusted,
		"tick behind the clock fails":           ErrTime,
		"deposit past the account limit fails":  ErrDeposit,
		"payload over the allocation cap fails": ErrEnvelope,
		"tick stamped in milliseconds fails":    ErrTrusted,
	} {
		if got := find(t, steps, name).Error; got != want {
			t.Errorf("%s: error %q, want %q", name, got, want)
		}
	}

	sync := find(t, steps, "sync asks for tick 1")
	if len(sync.AppEvents) != 1 || sync.AppEvents[0].EventSubType != TickSubType || !bytes.Equal(sync.AppEvents[0].Data, words(1, 0, 0)) || len(sync.Events) != 1 || sync.Withdrawals != nil {
		t.Fatalf("sync: %+v", sync)
	}
	if r := body(t, sync.Events[0]); r.Account != keeper || r.RequestID != keeper+":sync" || r.Body.Type != "sync" || r.Body.Status != "requested" || r.Body.Tick != 1 || r.Body.At != (receiptAt{}) || !sameButTick(t, sync.before, sync.after) {
		t.Fatalf("sync receipt: %+v", r)
	}
	tick := find(t, steps, "tick 1 sets the clock")
	if s := state(t, tick.after); s.Clock != t0 || s.Block != block0 || s.LastTick != 1 || s.Engine.Time != t0 || s.Engine.Sequence != 1 {
		t.Fatalf("tick 1: %+v", s)
	}
	// The tick publishes what it applied, and never asks for another tick.
	if tick.Events != nil || tick.Withdrawals != nil || len(tick.AppEvents) != 1 || tick.AppEvents[0].EventSubType != ClockSubType || !bytes.Equal(tick.AppEvents[0].Data, clockRecord(tick.Payload, 1, block0, t0, 0, 0)) {
		t.Fatalf("tick 1 effects: %+v", tick)
	}

	deposit := find(t, steps, "first deposit registers and credits alice")
	if len(deposit.Events) != 1 || deposit.Withdrawals != nil || deposit.AppEvents != nil {
		t.Fatalf("deposit effects: %+v", deposit)
	}
	if r := body(t, deposit.Events[0]); r.Account != alice || r.RequestID != alice+":notice:1" || r.Body.Type != "deposit" || r.Body.Status != "credited" || !r.Body.Registered || r.Body.Deposit != 1 || r.Body.Receipt.Amount != 200_000_000 ||
		r.Body.At != (receiptAt{1, block0, t0}) || r.Body.Tick != 0 {
		t.Fatalf("deposit receipt: %+v", r)
	}
	if a := state(t, deposit.after).Engine.Accounts[0]; a.ID != alice || a.Cash != 200_000_000 || a.Nonce != 1 {
		t.Fatalf("alice after deposit: %+v", a)
	}

	retry := find(t, steps, "explicit register after a deposit is a retry")
	if r := body(t, retry.Events[0]); !sameButTick(t, retry.before, retry.after) || r.RequestID != alice+":1" || r.Body.Type != "command" || r.Body.Status != "retry" || r.Body.Receipt.CommandID != alice+":1" || r.Body.Tick != 2 {
		t.Fatalf("register retry: %+v", r)
	}
	if r := body(t, find(t, steps, "bob registers").Events[0]); r.Account != bob || r.RequestID != bob+":1" || r.Body.Status != "applied" {
		t.Fatalf("bob register: %+v", r)
	}

	withdraw := find(t, steps, "alice withdraws")
	if len(withdraw.Withdrawals) != 1 || withdraw.Withdrawals[0] != (Withdrawal{collateral, outside, "0x2faf080"}) || len(withdraw.Events) != 1 {
		t.Fatalf("withdrawal effects: %+v", withdraw)
	}
	if r := body(t, withdraw.Events[0]); r.RequestID != alice+":2" || r.Body.Status != "applied" || r.Body.Withdrawal != 1 || r.Body.Receipt.Amount != 50_000_000 || r.Body.Receipt.WithdrawalID != alice+":2" || r.Body.At != (receiptAt{1, block0, t0}) || r.Body.Tick != 4 {
		t.Fatalf("withdrawal receipt: %+v", r)
	}
	if s := state(t, withdraw.after); s.Withdrawals != 1 || s.Engine.Custody != 150_000_000 || s.Engine.PaidOut != 50_000_000 || s.Engine.Time != t0 {
		t.Fatalf("ledger after withdrawal: %+v", s.Engine)
	}

	again := find(t, steps, "exact retry of the withdrawal has no effect")
	if r := body(t, again.Events[0]); !sameButTick(t, again.before, again.after) || again.Withdrawals != nil || len(again.Events) != 1 || r.Body.Status != "retry" || r.Body.Withdrawal != 0 {
		t.Fatalf("withdrawal retry emitted an effect: %+v", again)
	}

	for name, reason := range map[string]string{
		"overdraft is rejected in private":                     "insufficient available cash",
		"withdrawal to the endpoint is rejected in private":    "withdrawal destination not allowed",
		"authority command from a user is rejected in private": "wrong authorization class",
	} {
		s := find(t, steps, name)
		if !sameButTick(t, s.before, s.after) || s.Withdrawals != nil || len(s.Events) != 1 {
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
	if s := state(t, find(t, steps, "tick 10 checkpoints the engine and skips eight").after); s.Clock != t1 || s.Block != block1 || s.LastTick != 10 || s.TickSeq != 10 || s.Engine.Time != t1 ||
		len(s.Staged) != 0 || len(s.Outcomes) != 1 || s.Outcomes[0] != (Outcome{alice, alice + ":3", 8, "rejected", "unknown round"}) {
		t.Fatalf("tick 10: %+v %+v", s.Staged, s.Outcomes)
	}
	if r := body(t, find(t, steps, "bob deposits").Events[0]); r.RequestID != bob+":notice:1" || r.Body.Registered || r.Body.Deposit != 2 {
		t.Fatalf("bob deposit receipt: %+v", r)
	}
	if w := find(t, steps, "bob withdraws everything").Withdrawals; len(w) != 1 || w[0] != (Withdrawal{collateral, bob, "0x47868c0"}) {
		t.Fatalf("bob withdrawal: %+v", w)
	}

	extra := uint64(MaxSliceAccounts - 2)
	end := state(t, find(t, steps, "tick with an earlier block number is accepted").after)
	if e := end.Engine; len(e.Accounts) != MaxSliceAccounts || e.Deposited != 275_000_000+extra || e.Custody != 150_000_000+extra || e.PaidOut != 125_000_000 ||
		e.Claimable != 0 || len(e.Withdrawals) != 0 || uint64(len(e.ExternalEvidence)) != 2+extra+4 || end.Deposits != 2+extra || end.Withdrawals != 2 {
		t.Fatalf("final ledger: deposited=%d custody=%d paidOut=%d accounts=%d", e.Deposited, e.Custody, e.PaidOut, len(e.Accounts))
	}
	// The block number is recorded as reported; only the timestamp is ordered.
	if end.Clock != t1+1 || end.Block != block0 || end.LastTick != 11 {
		t.Fatalf("last tick: clock=%d block=%d tick=%d", end.Clock, end.Block, end.LastTick)
	}
}

// A request's public shape must not say what it was. Every accepted
// process_request, whether it applied, was staged, was refused, was a retry or
// was a sync, gives one receipt of one size to its sender and asks for one
// tick; a deposit gives one receipt; a tick gives none, publishes the clock it
// applied, then any archive records, and asks for a tick only to carry on.
func TestEveryReplyHasOneShape(t *testing.T) {
	asked, archived := uint64(0), 0
	for _, s := range run(t, script()) {
		if s.Error != "" || s.Call == "deploy" || s.Call == "restart" {
			continue
		}
		before, after := state(t, s.before), state(t, s.after)
		switch s.Call {
		case "process":
			asked++
			if len(s.Events) != 1 || s.Events[0].UserID != s.Sender || len(s.AppEvents) != 1 || !asks(t, after, s.AppEvents[0]) || after.TickSeq != asked || len(s.Withdrawals) > 1 {
				t.Fatalf("%s: %d receipts, %d app events, %d withdrawals", s.Name, len(s.Events), len(s.AppEvents), len(s.Withdrawals))
			}
			if r := body(t, s.Events[0]); r.Body.Tick != asked || (len(s.Withdrawals) == 1) != (r.Body.Withdrawal != 0) {
				t.Fatalf("%s: receipt %s", s.Name, s.Events[0].Data)
			}
		case "deposit":
			if len(s.Events) != 1 || s.Events[0].UserID != s.Sender || s.AppEvents != nil || s.Withdrawals != nil || body(t, s.Events[0]).Body.Type != "deposit" {
				t.Fatalf("%s: %d receipts, %d app events", s.Name, len(s.Events), len(s.AppEvents))
			}
		case "trusted":
			if s.Events != nil || s.Withdrawals != nil || len(s.AppEvents) == 0 || s.AppEvents[0].EventSubType != ClockSubType || len(s.AppEvents[0].Data) != 192 ||
				!bytes.Equal(s.AppEvents[0].Data[:96], words(after.LastTick, after.Block, after.Clock)) || !bytes.Equal(s.AppEvents[0].Data[160:], keccak(s.Payload)) || after.TickSeq != before.TickSeq {
				t.Fatalf("%s: %d receipts, %d app events", s.Name, len(s.Events), len(s.AppEvents))
			}
			for _, e := range s.AppEvents[1:] {
				var record engine.RoundArchive
				if e.EventSubType != ArchiveSubType || !canonical(e.Data, &record) {
					t.Fatalf("%s: app event %x", s.Name, e.EventSubType)
				}
				archived++
			}
		}
	}
	if asked != 24 || archived != 1 {
		t.Fatalf("%d requests asked for a tick, want 24; %d rounds archived, want 1", asked, archived)
	}
}

// asks reports whether e is the request for st's latest tick: the tick
// number, the counts of scheduled and open rounds, then their registry IDs.
func asks(t testing.TB, st *State, e AppEvent) bool {
	t.Helper()
	var scheduled, open []byte
	for _, m := range st.rounds() {
		if m.Status == "scheduled" {
			scheduled = append(scheduled, raw(m.Spec.RegistryRoundID)...)
		} else if m.Status == "open" {
			open = append(open, raw(m.Spec.RegistryRoundID)...)
		}
	}
	want := append(append(words(st.TickSeq, uint64(len(scheduled)/32), uint64(len(open)/32)), scheduled...), open...)
	return e.EventSubType == TickSubType && bytes.Equal(e.Data, want)
}

// The largest receipt this build can produce still fits one size class, so
// length never separates one outcome from another. Every kind of receipt body,
// with either kind of collected outcome, a view at every cap, the longest
// origin and application ID and every number at its cap. A receipt's engine
// receipt holds fills (an order) or released orders (cancel_all), not both.
func TestReceiptsAreOneSize(t *testing.T) {
	s := state(t, run(t, script()[:12])[11].after)
	s.Origin = "https://" + strings.Repeat("a", 253)
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
		"deposit":  {Type: "deposit", Status: "credited", Receipt: &withdrawn, Deposit: top, Registered: true},
		"sync":     {Type: "sync", Status: "requested"},
	}
	longest := 0
	for name, b := range bodies {
		for _, o := range []outcomeReceipt{{Outcome{alice, id, top, "applied", ""}, &full}, {Outcome{alice, id, top, "rejected", reason}, nil}} {
			s.taken = &o
			data := s.receipt(alice, alice+":notice:"+fmt.Sprint(top), b).Data
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
	} {
		if r := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, p, h.st)); len(p) != RequestBytes || r.Error != "" {
			t.Errorf("%s: %d bytes, error %q", name, len(p), r.Error)
		}
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
		s.Engine.ExternalEvidence = append(s.Engine.ExternalEvidence, sha(fmt.Sprint("spent:", s.Withdrawals, ":a")), sha(fmt.Sprint("spent:", s.Withdrawals, ":b")))
	}
	sort.Strings(s.Engine.ExternalEvidence)
}

// One account recycling a single atom must not be able to use up the engine's
// evidence IDs and strand everybody else. Deposits and partial withdrawals stop
// while two IDs remain for every account that holds a balance, and a withdrawal
// of a whole balance is always taken.
func TestExitReserve(t *testing.T) {
	s := state(t, run(t, script()[:30])[29].after) // alice holds 150 tokens, bob nothing
	spend(s, 8)
	st := marshal(s)
	free := func() int { return maxEvidence - len(state(t, st).Engine.ExternalEvidence) }
	cash := func(who string) uint64 {
		for _, a := range state(t, st).Engine.Accounts {
			if a.ID == who {
				return a.Cash
			}
		}
		return 0
	}
	nonce := map[string]uint64{alice: 2, bob: 2}
	deposit := func(who string, amount uint64) string {
		r := result(t, Deposit(testApp, raw(who), raw(collateral), new(big.Int).SetUint64(amount).Bytes(), st))
		if r.Error == "" {
			st = r.State
		}
		return r.Error
	}
	withdraw := func(who string, amount uint64) (paid bool, reason string) {
		r := result(t, ProcessRequest(testApp, raw(who), requestTypeProcess, commandPayload(who, nonce[who]+1, engine.Command{Op: engine.RequestWithdrawal, Amount: amount, Destination: who}), st))
		if r.Error != "" {
			t.Fatalf("withdrawal by %s failed in public: %s", who, r.Error)
		}
		if paid = len(r.Withdrawals) == 1; paid {
			nonce[who]++
		} else if !sameButTick(t, st, r.State) {
			t.Fatalf("a refused withdrawal by %s changed the ledger", who)
		}
		st = r.State
		if !exitReserved(state(t, st).Engine) {
			t.Fatalf("withdrawal by %s left fewer evidence IDs than the funded accounts need", who)
		}
		return paid, body(t, r.Events[0]).Body.Reason
	}
	const reserve = "exit reserve reached: only a withdrawal of the whole balance is accepted"

	if e := deposit(bob, 500_000_000); e != "" || free() != 7 { // the victim: two accounts now hold a balance
		t.Fatalf("victim's deposit: %q, %d IDs free", e, free())
	}
	if paid, reason := withdraw(alice, 1); !paid || free() != 5 {
		t.Fatalf("a partial withdrawal above the reserve must be taken: %q, %d IDs free", reason, free())
	}
	if e := deposit(alice, 1); e != "" || free() != 4 {
		t.Fatalf("a deposit above the reserve must be taken: %q, %d IDs free", e, free())
	}
	// Four IDs left and two funded accounts: nothing but a full exit now.
	if paid, reason := withdraw(alice, 1); paid || reason != reserve || free() != 4 {
		t.Fatalf("the attacker's partial withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if paid, reason := withdraw(bob, 1); paid || reason != reserve || free() != 4 {
		t.Fatalf("the victim's partial withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	for name, who := range map[string]string{"a funded account": alice, "a new account": keeper} {
		if e := deposit(who, 1); e != ErrDeposit || free() != 4 {
			t.Fatalf("deposit by %s: %q, %d IDs free", name, e, free())
		}
	}
	if paid, reason := withdraw(bob, cash(bob)); !paid || cash(bob) != 0 || free() != 2 {
		t.Fatalf("the victim's full withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if paid, reason := withdraw(alice, cash(alice)); !paid || cash(alice) != 0 || free() != 0 {
		t.Fatalf("the attacker's full withdrawal: paid=%v reason=%q, %d IDs free", paid, reason, free())
	}
	if e := state(t, st).Engine; e.Custody != 0 || len(e.ExternalEvidence) != maxEvidence {
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
	system(t0, engine.Command{Op: engine.Checkpoint})
	apply(t0, alice, 1, false, engine.Command{Op: engine.Register, Account: alice})
	system(t0, engine.Command{Op: engine.Deposit, Account: alice, Amount: 200_000_000, Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:DEPOSIT:31337:%s:%d:1", endpoint, testApp))})
	apply(t0, bob, 1, false, engine.Command{Op: engine.Register, Account: bob})
	apply(t0, alice, 2, false, engine.Command{Op: engine.RequestWithdrawal, Account: alice, Amount: 50_000_000, Destination: outside})
	system(t0, engine.Command{Op: engine.ExportWithdrawal, WithdrawalID: alice + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:WITHDRAWAL:31337:%s:%d:1", endpoint, testApp))})
	system(t0, engine.Command{Op: engine.ConfirmClaim, WithdrawalID: alice + ":2", Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:CLAIM:31337:%s:%d:1", endpoint, testApp))})
	system(t1, engine.Command{Op: engine.Checkpoint})
	system(t1, engine.Command{Op: engine.Deposit, Account: bob, Amount: 75_000_000, Evidence: sha(fmt.Sprintf("ZEDGE_VELA_V1:DEPOSIT:31337:%s:%d:2", endpoint, testApp))})
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
	steps := run(t, script()[:10])
	before := steps[9].after // bob registered, clock at t0
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
	if got := result(t, Deposit(testApp, raw(trigger), raw(collateral), []byte{1}, before)).Error; got != ErrDeposit {
		t.Fatalf("deposit by the trigger: %q", got)
	}
}

func TestEnvelopeRejected(t *testing.T) {
	steps := run(t, script()[:6])
	before := steps[5].after
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
	bare := marshal(bareEnvelope{1, good.Domain, bob, epoch, bob + ":1", "command", bareBody{"command", good.Body.Command}})
	for name, c := range map[string]struct {
		payload []byte
		want    string
	}{
		"other chain":                 {edit(func(e *requestEnvelope) { e.Domain.ChainID = 84532 }), ErrContext},
		"other endpoint":              {edit(func(e *requestEnvelope) { e.Domain.Endpoint = outside }), ErrContext},
		"other application":           {edit(func(e *requestEnvelope) { e.Domain.ApplicationID = "8" }), ErrContext},
		"other wasm":                  {edit(func(e *requestEnvelope) { e.Domain.ApplicationFingerprint = strings.Repeat("cd", 32) }), ErrContext},
		"other rules":                 {edit(func(e *requestEnvelope) { e.Domain.RulesHash = strings.Repeat("cd", 32) }), ErrContext},
		"other origin":                {edit(func(e *requestEnvelope) { e.Domain.Origin = "https://zedge.example" }), ErrContext},
		"other epoch":                 {edit(func(e *requestEnvelope) { e.Epoch = "2" }), ErrContext},
		"a receipt":                   {edit(func(e *requestEnvelope) { e.Kind = "receipt" }), ErrContext},
		"version 2":                   {edit(func(e *requestEnvelope) { e.Version = 2 }), ErrContext},
		"other account":               {edit(func(e *requestEnvelope) { e.Account = alice }), ErrMismatch},
		"unknown body type":           {edit(func(e *requestEnvelope) { e.Body.Type = "view" }), ErrEnvelope},
		"sync with a command":         {edit(func(e *requestEnvelope) { e.Body.Type, e.RequestID = "sync", bob+":sync" }), ErrEnvelope},
		"sync under another ID":       {edit(func(e *requestEnvelope) { e.Body, e.RequestID = requestBody{Type: "sync"}, bob+":1" }), ErrEnvelope},
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

func TestDepositRejected(t *testing.T) {
	steps := run(t, script()[:6])
	before := steps[5].after
	wide := make([]byte, 32)
	binary.BigEndian.PutUint64(wide[24:], 5)
	if r := result(t, Deposit(testApp, raw(bob), raw(collateral), wide, before)); r.Error != "" || state(t, r.State).Engine.Deposited != 200_000_005 {
		t.Fatalf("a 32-byte amount must be accepted: %+v", r.Error)
	}
	if r := result(t, Deposit(testApp, raw(bob), raw(collateral), new(big.Int).SetUint64(engine.MaxAtoms-200_000_000).Bytes(), before)); r.Error != "" {
		t.Fatalf("a deposit up to the lifetime cap must be accepted: %s", r.Error)
	}
	for name, c := range map[string]struct {
		sender, token, value []byte
		want                 string
	}{
		"zero amount":        {raw(bob), raw(collateral), nil, ErrAmount},
		"zero bytes":         {raw(bob), raw(collateral), make([]byte, 32), ErrAmount},
		"above the atom cap": {raw(bob), raw(collateral), new(big.Int).SetUint64(engine.MaxAtoms + 1).Bytes(), ErrAmount},
		"nine bytes":         {raw(bob), raw(collateral), append([]byte{1}, make([]byte, 8)...), ErrAmount},
		"past the lifetime":  {raw(bob), raw(collateral), new(big.Int).SetUint64(engine.MaxAtoms).Bytes(), ErrDeposit},
		"short token":        {raw(bob), raw(collateral)[:19], []byte{1}, ErrToken},
		"no token":           {raw(bob), nil, []byte{1}, ErrToken},
		"short sender":       {raw(bob)[:5], raw(collateral), []byte{1}, ErrSender},
		"zero sender":        {make([]byte, 20), raw(collateral), []byte{1}, ErrSender},
		"state of another":   {raw(bob), raw(collateral), []byte{1}, ErrApplication},
		"no state":           {raw(bob), raw(collateral), []byte{1}, ErrState},
		"truncated state":    {raw(bob), raw(collateral), []byte{1}, ErrState},
		"state with a space": {raw(bob), raw(collateral), []byte{1}, ErrState},
	} {
		app, st := testApp, before
		switch name {
		case "state of another":
			app++
		case "no state":
			st = nil
		case "truncated state":
			st = before[:len(before)-1]
		case "state with a space":
			st = append(append([]byte{}, before...), ' ')
		}
		if got := result(t, Deposit(app, c.sender, c.token, c.value, st)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
}

func TestTickRejected(t *testing.T) {
	steps := run(t, script()[:25]) // clock at t0 / block0, ticks 2 to 10 requested
	before := steps[24].after
	if s := state(t, before); s.Clock != t0 || s.TickSeq != 10 || s.LastTick != 1 {
		t.Fatalf("unexpected starting point: %+v", s)
	}
	dirty := func(i int) []byte { p := tickPayload(2, block1, t1); p[i] = 1; return p }
	word := func(i int, v uint64) []byte {
		p := tickPayload(2, block1, t1)
		binary.BigEndian.PutUint64(p[32*i+24:], v)
		return p
	}
	if r := result(t, TrustedRequest(testApp, tickPayload(2, block0, t0), before)); r.Error != "" || r.Events != nil || r.Withdrawals != nil {
		t.Fatalf("a tick in the same block and second must be accepted: %+v", r)
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
		"one byte short":         {tickPayload(2, block1, t1)[:191], ErrTrusted},
		"one byte long":          {append(tickPayload(2, block1, t1), 0), ErrTrusted},
		"version 2":              {word(0, 2), ErrTrusted},
		"other chain":            {word(1, 1), ErrTrusted},
		"other endpoint":         {dirty(95), ErrTrusted},
		"dirty address padding":  {dirty(64), ErrTrusted},
		"timestamp over 64 bits": {dirty(4*32 + 23), ErrTrusted},
		"tick over 64 bits":      {dirty(5 * 32), ErrTrusted},
		"tick 0":                 {word(5, 0), ErrTick},
		"tick already applied":   {word(5, 1), ErrTick},
		"tick not requested":     {word(5, 11), ErrTick},
		"timestamp 0":            {word(4, 0), ErrTrusted},
		"timestamp behind":       {word(4, t0-1), ErrTime},
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
		"Horizen mainnet":        {edit(func(p *DeployParams) { p.Engine.Domain.ChainID = 26514 }), ErrConfig},
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
	} {
		if got := result(t, Deploy(testApp, c.params, testSalt)).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}
}

// A stored state is accepted only in its one canonical, self-consistent form.
func TestStateRejected(t *testing.T) {
	steps := run(t, script()[:12])
	good := steps[11].after // after alice's withdrawal
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
		"notices null":             edit(func(s *State) { s.Notices = nil }),
		"notices unsorted":         edit(func(s *State) { s.Notices = []Notice{{alice, 1}, {bob, 1}} }),
		"notice count 0":           edit(func(s *State) { s.Notices[0].Count = 0 }),
		"no engine":                edit(func(s *State) { s.Engine = nil }),
		"clock without a tick":     edit(func(s *State) { s.LastTick = 0 }),
		"tick never requested":     edit(func(s *State) { s.LastTick = s.TickSeq + 1 }),
		"engine ahead of clock":    edit(func(s *State) { s.Clock = s.Engine.Time - 1 }),
		"deposit count":            edit(func(s *State) { s.Deposits++ }),
		"withdrawal count":         edit(func(s *State) { s.Withdrawals-- }),
		"cash from nowhere":        edit(func(s *State) { s.Engine.Accounts[0].Cash++ }),
		"claim left open":          edit(func(s *State) { s.Engine.Claimable, s.Engine.PaidOut = 1, s.Engine.PaidOut-1 }),
		"production chain":         edit(func(s *State) { s.Engine.Config.Domain.ChainID = 26514 }),
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
