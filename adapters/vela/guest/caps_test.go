package guest

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

// The two gates of README section 9: a state with every cap reached fits the
// size bound (here), and the wasm soak passes on it (TestGuestSoak).

var cappedBase, heavyState, heavyTick []byte

// cappedState is a state with every adapter cap reached, built with the
// engine's own commands so that the guest accepts it: 32 accounts, each with
// shares in all 8 rounds (7 resolved but not swept, because every account has
// a command staged, and the 8th open) and 4 resting orders (128 in the book).
// Written in directly, because they are larger than anything reachable at the
// same time and no check refuses them: a staged place_order for every account,
// an outcome for every account (an account with a staged command has none), 4 fills and 4 released orders in
// every stored last receipt (a receipt holds one or the other), and 128
// released orders in the authority's. Evidence IDs are left to the caller.
func cappedState(t testing.TB) *State {
	t.Helper()
	if cappedBase == nil {
		cappedBase = marshal(buildCapped(t))
	}
	return state(t, cappedBase)
}

// capped is the state at every cap with two evidence IDs left per funded
// account and one withdrawal more, in three forms (every account with a
// place_order staged, every account with a cancel_all staged, nothing
// staged), and a tick that activates everything staged.
func capped(t testing.TB) (placing, cancelling, idle, tick []byte) {
	s := cappedState(t)
	spend(s, 2*MaxSliceAccounts+2)
	placing, tick = marshal(s), tickPayload(s.TickSeq, block1+3, s.Engine.Time+1)
	for i := range s.Staged {
		c := &s.Staged[i].Command
		*c, _ = command(c.Account, c.Nonce, engine.Command{Op: engine.CancelAll})
	}
	cancelling = marshal(s)
	s.Staged = []Staged{}
	return placing, cancelling, marshal(s), tick
}

// heaviest is the state just before the busiest tick the tests time, and that
// tick: seven rounds resolve on the full book, every account's cancel_all is
// due, sixteen activate and sixteen accounts are swept (README section 9).
func heaviest(t testing.TB) (state, tick []byte) {
	cappedState(t)
	return heavyState, heavyTick
}

// cappedReport is the state at every cap, nothing staged, with the test DON
// of reports_test.go pinned, and that DON's report for the open round's end:
// the heaviest report there is, which resolves the round and redeems all 32
// holders in one transition.
func cappedReport(t testing.TB) (st, payload []byte) {
	_, _, idle, _ := capped(t)
	s := state(t, idle)
	d := newTestDON(4)
	s.Chainlink = d.config(1)
	var end uint64
	for _, m := range s.Engine.Rounds {
		if m.Status == "open" {
			end = m.Spec.End
		}
	}
	full := d.sign(1, engine.BTCStreamsFeed, end, end, end+86400, new(big.Int).Mul(big.NewInt(98_000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)))
	return marshal(s), reportPayload(alice, "0x"+hex.EncodeToString(full), uint32(end))
}

// withEvent turns the oldest round of a state at every cap, resolved and held
// by every account, into the open event of a deployment that pins the event
// and its resolver: the event live in one of the eight slots, with every one
// of its times at ten digits. It returns the event's engine round ID.
func withEvent(t testing.TB, s *State) string {
	t.Helper()
	e := &EventTerms{Question: testEvent().Question, Start: t0, Cutoff: s1 + 100, End: s1 + 101, VoidableAfter: MaxClock}
	spec, err := e.spec(s.Engine.Config)
	if err != nil {
		t.Fatal(err)
	}
	id := engine.RoundID(s.Engine.Config, spec)
	for i := range s.Engine.Rounds {
		if m := &s.Engine.Rounds[i]; m.Spec.Start == s1 {
			old := m.ID
			*m = engine.Round{ID: id, Spec: spec, Status: "open", Locked: m.UpSupply, UpSupply: m.UpSupply, DownSupply: m.DownSupply}
			for j := range s.Engine.Accounts {
				h := s.Engine.Accounts[j].Holdings
				for k := range h {
					if h[k].RoundID == old {
						h[k].RoundID = id
					}
				}
				slices.SortFunc(h, func(a, b engine.Holding) int { return strings.Compare(a.RoundID, b.RoundID) })
			}
		}
	}
	slices.SortFunc(s.Engine.Rounds, func(a, b engine.Round) int { return strings.Compare(a.ID, b.ID) })
	s.Event, s.Resolver = e, resolver
	return id
}

// cappedResolve is the state at every cap, nothing staged, with the event
// live and held by all 32 accounts, and the resolver's Yes for it: the
// heaviest result there is, which redeems all 32 holders in one transition.
func cappedResolve(t testing.TB) (st, payload []byte) {
	_, _, idle, _ := capped(t)
	s := state(t, idle)
	id := withEvent(t, s)
	return marshal(s), resolvePayload(alice, 1, signResult(resolverKey, deployed(), id, 1))
}

func cappedAccounts() []string {
	accounts := []string{alice, bob}
	for i := len(accounts); i < MaxSliceAccounts; i++ {
		accounts = append(accounts, fmt.Sprintf("0x%040x", 0xc00+i))
	}
	return accounts
}

func buildCapped(t testing.TB) *State {
	tt, ok := t.(*testing.T)
	if !ok {
		t.Fatal("cappedState needs a *testing.T")
	}
	h := &harness{t: tt, st: result(t, Deploy(testApp, marshal(testParams()), testSalt)).State, block: 1000}
	h.sync(keeper)
	h.ok(h.tick(t0))
	accounts := cappedAccounts()
	for _, who := range accounts {
		if !h.credited(who, 1_000_000_000) {
			t.Fatalf("deposit by %s refunded", who)
		}
	}
	var rounds []rec
	for k := uint64(0); k < MaxSliceRounds; k++ {
		rounds = append(rounds, rec{start: s1 + 900*k})
	}
	h.sync(keeper)
	h.ok(h.tick(t0+100, rounds...))
	// do applies a user command straight to the engine at the clock, as the
	// adapter's direct path would; it is faster than a request per command.
	do := func(who string, c engine.Command) {
		s := h.s()
		c, _ = command(who, account(s.Engine, who).Nonce+1, c)
		next, _, err := engine.Apply(s.Engine, c, s.user(who))
		if err != nil {
			t.Fatalf("%s %s: %v", who, c.Op, err)
		}
		s.Engine = next
		h.st = marshal(s)
	}
	ids := make([]string, MaxSliceRounds)
	for k, r := range rounds {
		r.openedAt, r.opening = r.start+3, observed(r.start, r.start+3, p0)
		rounds[k] = r
		h.sync(keeper)
		h.ok(h.tick(r.start+5, r))
		ids[k] = engine.RoundID(deployed(), mustSpec(r.start))
		for _, who := range accounts {
			do(who, engine.Command{Op: engine.Mint, RoundID: ids[k], Quantity: 1_000_000})
		}
	}
	last := mustSpec(rounds[MaxSliceRounds-1].start)
	for _, who := range accounts {
		for i := uint64(0); i < MaxAccountOrders; i++ {
			do(who, engine.Command{Op: engine.PlaceOrder, RoundID: ids[MaxSliceRounds-1], Outcome: engine.Up, Side: engine.Sell, Price: 90 + i, Quantity: 1_000, TIF: engine.GTC, Expiry: last.Cutoff, MaxFee: 1_000})
		}
	}
	// Every account has staged after the tick that resolves the first seven
	// rounds was asked for, so that tick sweeps nobody.
	h.sync(keeper)
	k, s := h.s().TickSeq, h.s()
	for i, who := range accounts {
		c, _ := command(who, account(s.Engine, who).Nonce+1, engine.Command{Op: engine.PlaceOrder, RoundID: ids[MaxSliceRounds-1], Outcome: engine.Down, Side: engine.Buy,
			Price: 99, Quantity: 999_999_000_000, TIF: engine.GTC, Expiry: last.Cutoff, MaxFee: 9_899_991_000})
		s.Staged = append(s.Staged, Staged{k + 1 + uint64(i), c})
	}
	s.TickSeq += uint64(len(accounts))
	h.st = marshal(s)
	for i := range rounds[:MaxSliceRounds-1] {
		rounds[i].resolvedAt, rounds[i].outcome, rounds[i].closing = rounds[i].start+902, 1, observed(rounds[i].start+900, rounds[i].start+902, p0)
	}
	heavy := h.s()
	for i := range heavy.Staged {
		c := &heavy.Staged[i].Command
		*c, _ = command(c.Account, c.Nonce, engine.Command{Op: engine.CancelAll})
	}
	spend(heavy, 2*MaxSliceAccounts+2)
	heavyState, heavyTick = marshal(heavy), tick2(heavy.TickSeq, h.block+1, last.Start+100, rounds[:MaxSliceRounds-1]...)
	h.ok(h.tickN(k, last.Start+100, rounds[:MaxSliceRounds-1]...))
	s = h.s()
	reason := "exit reserve reached: only a withdrawal of the whole balance is accepted" // the longest reason
	for i := range s.Engine.Accounts {
		a := &s.Engine.Accounts[i]
		other := s.Engine.Accounts[(i+1)%len(s.Engine.Accounts)].ID
		fill := engine.Fill{MakerOrder: engine.CommandID(other, 999), TakerOrder: engine.CommandID(a.ID, 999), Buyer: a.ID, Seller: other, RoundID: ids[0], Outcome: engine.Down, Price: 99, Quantity: 999_999_000_000, BuyerFee: 9_899_991_000, SellerFee: 9_899_991_000}
		a.LastReceipt.Fills = slices.Repeat([]engine.Fill{fill}, MaxFills)
		a.LastReceipt.ReleasedOrders = slices.Repeat([]string{engine.CommandID(a.ID, 999)}, MaxAccountOrders)
		s.Outcomes = append(s.Outcomes, Outcome{a.ID, engine.CommandID(a.ID, 999), 1, "rejected", reason})
	}
	s.Engine.AuthorityReceipt.ReleasedOrders = slices.Repeat([]string{engine.CommandID(alice, 999)}, MaxSliceAccounts*MaxAccountOrders)
	// Every round settled from a report and not yet confirmed, and the most
	// DON configurations a deployment may pin, each with the most signers.
	for i := 0; i < MaxUnconfirmed; i++ {
		s.Unconfirmed = append(s.Unconfirmed, Unconfirmed{fmt.Sprintf("0x%064x", i+1), "0x" + sha("open"), "0x" + sha("close"), 2})
	}
	for len(s.Chainlink.Configs) < MaxDigests {
		s.Chainlink.Configs = append(s.Chainlink.Configs, DONConfig{Digest: fmt.Sprintf("0x%064x", len(s.Chainlink.Configs)), F: 5})
	}
	for i := range s.Chainlink.Configs {
		for j := len(s.Chainlink.Configs[i].Signers); j < MaxSigners; j++ {
			s.Chainlink.Configs[i].Signers = append(s.Chainlink.Configs[i].Signers, fmt.Sprintf("0x%040x", 0x5160+100*i+j))
		}
	}
	return s
}

// digits is the most digits the engine or the adapter lets a number under this
// key have (README section 3): an order price is at most 99, every time is at
// most MaxClock or a few weeks past it, the configuration is fixed at deploy,
// and the adapter's deposit and withdrawal counters stop at 4,096. Any other
// number is at most 10^15, the engine's cap on amounts, nonces and sequences.
var digits = map[string]int{"price": 2, "time": 10, "clock": 10, "start": 10, "end": 10, "cutoff": 10, "openingDeadline": 10, "voidableAfter": 10, "expiry": 10,
	"validFromTimestamp": 10, "observationsTimestamp": 10, "expiresAt": 10, "decimals": 2, "version": 1, "rulesVersion": 1, "feeBps": 4, "chainId": 7,
	"observationWindow": 2, "openingGrace": 3, "voidGrace": 7, "cutoffBuffer": 3, "deposits": 4, "withdrawals": 4, "f": 2}

// widest is the length of the state with every number at its widest, every
// all-digit string at the largest int192 price, every command or order ID with
// a 16-digit nonce, and every staged command MaxStagedBytes long with a
// 16-digit tick.
func widest(t testing.TB, s *State) int {
	t.Helper()
	rest := *s
	rest.Staged = []Staged{}
	b := marshal(&rest)
	n := len(marshal(s)) + len(s.Staged)*len(`{"tick":0000000000000000,"command":},`)
	for _, x := range s.Staged {
		n += MaxStagedBytes - len(marshal(x))
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	key := ""
	for {
		token, err := d.Token()
		if err == io.EOF {
			return n
		}
		if err != nil {
			t.Fatal(err)
		}
		switch v := token.(type) {
		case json.Number: // always an object member here: key is its name
			w, ok := digits[key]
			if !ok {
				w = 16
			}
			n += w - len(v)
		case string:
			if strings.Trim(v, "0123456789") == "" && v != "" {
				n += len(engine.MaxOraclePrice) - len(v)
			} else if len(v) > 43 && v[42] == ':' && isAddress(v[:42]) {
				n += 16 - (len(v) - 43)
			}
			key = v
		}
	}
}

func TestStateAtEveryCapFitsTheBound(t *testing.T) {
	s := cappedState(t)
	spend(s, 0)
	b, err := s.encode()
	if err != nil {
		t.Fatal(err)
	}
	e := s.Engine
	if len(e.Accounts) != MaxSliceAccounts || len(e.Rounds) != MaxSliceRounds || len(e.Orders) != MaxSliceAccounts*MaxAccountOrders ||
		len(s.Staged) != MaxSliceAccounts || len(s.Outcomes) != MaxSliceAccounts || len(s.Unconfirmed) != MaxUnconfirmed || len(e.ExternalEvidence) != maxEvidence ||
		len(s.Chainlink.Configs) != MaxDigests {
		t.Fatalf("not at every cap: %d accounts, %d rounds, %d orders, %d staged, %d outcomes, %d evidence IDs", len(e.Accounts), len(e.Rounds), len(e.Orders), len(s.Staged), len(s.Outcomes), len(e.ExternalEvidence))
	}
	for _, a := range e.Accounts {
		if len(a.Holdings) != MaxSliceRounds || activeOrders(e, a.ID) != MaxAccountOrders || len(a.LastReceipt.Fills) != MaxFills {
			t.Fatalf("%s is not at every cap", a.ID)
		}
	}
	top := widest(t, s)
	t.Logf("state at every cap: %d bytes; at most %d with every number at its widest; bound %d", len(b), top, MaxStateBytes)
	if top > MaxStateBytes {
		t.Fatalf("a state at every cap can reach %d bytes; the bound is %d", top, MaxStateBytes)
	}
	// The same with the event (README section 13): archived, so its terms,
	// its resolver and depositsFrom are kept beside eight price rounds; and
	// live in one of the eight slots, held by every account.
	archived := cappedState(t)
	spend(archived, 0)
	archived.Event, archived.Resolver = &EventTerms{Question: testEvent().Question, Start: t0, Cutoff: s1 + 100, End: s1 + 101, VoidableAfter: MaxClock}, resolver
	archived.DepositsFrom, archived.DepositsSeen = 1, archived.DepositsSeen+1
	live := cappedState(t)
	spend(live, 0)
	withEvent(t, live)
	for name, s := range map[string]*State{"archived": archived, "live": live} {
		b, err := s.encode()
		if err != nil {
			t.Fatalf("event %s: %v", name, err)
		}
		top := widest(t, s)
		t.Logf("state at every cap, event %s: %d bytes; at most %d with every number at its widest; bound %d", name, len(b), top, MaxStateBytes)
		if top > MaxStateBytes {
			t.Fatalf("a state at every cap with the event %s can reach %d bytes; the bound is %d", name, top, MaxStateBytes)
		}
	}
}

// Every cap is enforced where it is reached, and one tick at most activates
// MaxActivations staged commands and asks for another tick to carry on.
func TestFullBookAtEveryCap(t *testing.T) {
	placing, cancelling, idle, _ := capped(t)
	h := &harness{t: t, st: idle, block: 5000}
	open := ""
	for _, m := range state(t, idle).Engine.Rounds {
		if m.Status == "open" {
			open = m.ID
		}
	}
	fifth := order(engine.Sell, 60, 1_000, engine.GTC)
	fifth.RoundID, fifth.Expiry = open, mustSpec(s1+900*(MaxSliceRounds-1)).Cutoff
	if b := h.cmd(alice, fifth); b.Status != "staged" {
		t.Fatalf("fifth order: %+v", b)
	}
	if b := h.cmd(keeper, engine.Command{Op: engine.Register}); b.Status != "rejected" || b.Reason != "account capacity" {
		t.Fatalf("33rd account: %+v", b)
	}
	last := h.s().Engine.Time
	if r := h.ok(h.tick(last+1, rec{start: s1 + 900*MaxSliceRounds})); len(h.s().Engine.Rounds) != MaxSliceRounds {
		t.Fatalf("a ninth round was created: %d app events", len(r.AppEvents))
	}
	if b := h.sync(alice); b.Outcome.Reason != "order capacity" || len(b.View.Orders) != MaxAccountOrders {
		t.Fatalf("fifth order at activation: %+v", b.Outcome)
	}
	if h.credited(keeper, 1) {
		t.Fatal("33rd account's deposit was credited")
	}
	// Every account cancels all its orders: two ticks of sixteen.
	h.st = cancelling
	busy := h.s()
	r := h.ok(h.tick(last + 1))
	if s := h.s(); len(s.Staged) != MaxSliceAccounts-MaxActivations || len(s.Engine.Orders) != MaxAccountOrders*(MaxSliceAccounts-MaxActivations) ||
		len(r.AppEvents) != 2 || !asks(t, s, r.AppEvents[1]) || s.TickSeq != busy.TickSeq+1 {
		t.Fatalf("first tick: %d staged, %d orders, %d app events", len(s.Staged), len(s.Engine.Orders), len(r.AppEvents))
	}
	// The second tick asks for none. Each tick also sweeps sixteen holdings of
	// accounts no longer staged, oldest round first: by the second the first
	// round is empty and archived.
	r = h.ok(h.tick(last + 2))
	if s := h.s(); len(s.Staged) != 0 || len(s.Engine.Orders) != 0 || len(r.AppEvents) != 2 || r.AppEvents[1].EventSubType != ArchiveSubType || len(s.Engine.Rounds) != MaxSliceRounds-1 {
		t.Fatalf("second tick: %d staged, %d orders, %d app events", len(s.Staged), len(s.Engine.Orders), len(r.AppEvents))
	}
	// A state past a cap is refused however it was made: here with the
	// engine's own commands, applied around the adapter.
	for name, c := range map[string]engine.Command{
		"a fifth order":  {Op: engine.PlaceOrder, Account: alice, RoundID: open, Outcome: engine.Up, Side: engine.Sell, Price: 50, Quantity: 1_000, TIF: engine.GTC, Expiry: mustSpec(s1 + 900*(MaxSliceRounds-1)).Cutoff, MaxFee: 1_000},
		"a 33rd account": {Op: engine.Register, Account: keeper},
		"a ninth round":  {Op: engine.CreateRound, Round: func() *engine.RoundSpec { r := mustSpec(s1 + 900*MaxSliceRounds); return &r }()},
	} {
		s := state(t, idle)
		var err error
		if c.Account == "" {
			s.Engine, _, err = s.system(s.Engine, c)
		} else {
			n := uint64(1)
			if a := account(s.Engine, c.Account); a != nil {
				n = a.Nonce + 1
			}
			c, _ = command(c.Account, n, c)
			s.Engine, _, err = engine.Apply(s.Engine, c, s.user(c.Account))
		}
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := DecodeState(marshal(s)); err == nil {
			t.Errorf("a state with %s was accepted", name)
		}
	}
	// The busiest tick timed: 1 checkpoint, 7 resolutions, 16 cancel_all and
	// 16 sweeps, 40 engine commands; sixteen staged are left and asked for.
	// It publishes the clock, the seven settle records and the request.
	heavy, tick := heaviest(t)
	if r := h.ok(result(t, TrustedRequest(testApp, tick, heavy))); state(t, r.State).Engine.Sequence-state(t, heavy).Engine.Sequence != 40 ||
		len(state(t, r.State).Staged) != MaxSliceAccounts-MaxActivations || len(r.AppEvents) != 2+MaxSliceRounds-1 {
		t.Fatalf("the busiest tick: %d app events", len(r.AppEvents))
	}
	// The heaviest report: the open round resolves, all 32 holders are paid,
	// the round is archived and the slot it frees is taken by the next round,
	// in the one transition: 36 engine commands.
	st, report := cappedReport(t)
	r = result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, report, st))
	if n := state(t, r.State).Engine.Sequence - state(t, st).Engine.Sequence; r.Error != "" || body(t, r.Events[0]).Body.Status != "applied" || n != 1+1+MaxSliceAccounts+1+1 {
		t.Fatalf("the heaviest report: %q, %d engine commands", r.Error, n)
	}
	// The heaviest event result: the event resolves, all 32 holders are paid,
	// it is archived and the slot it frees is taken by the next round, in the
	// one transition: 35 engine commands (no checkpoint: the clock stays).
	st, resolve := cappedResolve(t)
	r = result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, resolve, st))
	if n := state(t, r.State).Engine.Sequence - state(t, st).Engine.Sequence; r.Error != "" || body(t, r.Events[0]).Body.Status != "applied" || n != 1+MaxSliceAccounts+1+1 {
		t.Fatalf("the heaviest result: %q, %d engine commands", r.Error, n)
	}
	// Sixteen place_orders on the full book, each one the engine refuses.
	h.st = placing
	h.ok(h.tick(last + 1))
	refused := 0
	for _, o := range h.s().Outcomes {
		if o.Reason == "insufficient available cash" {
			refused++
		}
	}
	if refused != MaxActivations || len(h.s().Engine.Orders) != MaxSliceAccounts*MaxAccountOrders {
		t.Fatalf("%d activations refused, want %d", refused, MaxActivations)
	}
}
