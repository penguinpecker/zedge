package engine

import (
	"strings"
	"testing"
)

// A 25-day operator-resolved event, off the 300/900-second grid: trading from
// start, a cutoff, the earliest result one second later, a void only after
// voidableAfter. Up is Yes, Down is No.
var question = keccak([]byte("Will the test event happen? Rules text."))

const (
	evStart  uint64 = 1_000
	evCutoff        = evStart + 25*86_400
	evEnd           = evCutoff + 1
	evVoid          = evEnd + 90*86_400
	// Computed with Foundry's cast, independently of this package (TestEventSpecRejected).
	eventRegistryIDKnownAnswer = "0xa3e6198229542f70220a3adef5e1f8d6788845ba897b6f9668750d7ee54dc8e9"
)

func eventSpec(t testing.TB) RoundSpec {
	t.Helper()
	spec, err := NewEventSpec(config(), question, evStart, evCutoff, evEnd, evVoid)
	if err != nil {
		t.Fatal(err)
	}
	return spec
}

// setupEvent registers and funds the accounts and creates the event at start+5,
// as the harness's setup does for a price round. Orders expire at the cutoff.
func (h *harness) setupEvent(accounts ...string) {
	h.t.Helper()
	for _, a := range accounts {
		h.must(Command{Op: Register}, a, 1)
		h.deposit(a, 200*AtomScale)
	}
	spec := eventSpec(h.t)
	h.round = h.must(Command{Op: CreateRound, Round: &spec}, auth, evStart+5).RoundID
}

func (h *harness) eventOrder(who string, o Outcome, side Side, p, q uint64, tif TimeInForce) Receipt {
	return h.must(Command{Op: PlaceOrder, RoundID: h.round, Outcome: o, Side: side, Price: p, Quantity: q, TIF: tif, Expiry: evCutoff, MaxFee: MaxAtoms}, who, 0)
}

// refuse is reject that also names the reason.
func (h *harness) refuse(c Command, who string, at uint64, reason string) {
	h.t.Helper()
	c, x := h.command(c, who, at)
	if _, _, e := Apply(h.s, c, x); e == nil || e.Error() != reason {
		h.t.Fatalf("%s: %v, want %q", c.Op, e, reason)
	}
}

func TestEventRound(t *testing.T) {
	spec := eventSpec(t)
	if spec.Asset != EventAsset || spec.Feed != question || spec.ObservationWindow != 0 || spec.OpeningDeadline != evStart || spec.End-spec.Start != 25*86_400+1 ||
		spec.End%300 == 0 || !hash32(spec.RegistryRoundID) || spec.RegistryRoundID == question {
		t.Fatalf("event spec: %+v", spec)
	}
	h := newHarness(t)
	h.setupEvent(alice, bob, carol)
	m, _ := h.s.round(h.round)
	if m.Status != "open" || m.Opening != nil || m.OpenEvidence != "" {
		t.Fatalf("created event: %+v", m)
	}
	// Opening is the price rounds' path only: the event is never scheduled.
	h.refuse(Command{Op: OpenRound, RoundID: h.round, Observation: testObservation("1", uint32(evStart)), Evidence: hash([]byte("open"))}, auth, evStart+6, "invalid opening observation")

	// Trade Yes: alice mints and offers ten Yes at 70; bob takes four.
	h.must(Command{Op: Mint, RoundID: h.round, Quantity: 10 * AtomScale}, alice, evStart+10)
	h.eventOrder(alice, Up, Sell, 70, 10*AtomScale, GTC)
	if r := h.eventOrder(bob, Up, Buy, 70, 4*AtomScale, IOC); len(r.Fills) != 1 || r.Fills[0].Quantity != 4*AtomScale {
		t.Fatalf("bob's buy: %+v", r)
	}
	// carol holds a complete set.
	h.must(Command{Op: Mint, RoundID: h.round, Quantity: 2 * AtomScale}, carol, 0)

	// Nothing trades or mints at the cutoff; the resting order is released.
	h.refuse(Command{Op: Mint, RoundID: h.round, Quantity: AtomScale}, carol, evCutoff, "round not open for minting")
	h.refuse(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Buy, Price: 70, Quantity: AtomScale, TIF: IOC, Expiry: evCutoff, MaxFee: MaxAtoms}, bob, evCutoff, "round closed")
	h.must(Command{Op: Checkpoint}, auth, evCutoff)
	if len(h.s.Orders) != 0 || h.account(alice).Holdings[0].ReservedUp != 0 {
		t.Fatal("the cutoff did not release alice's order")
	}

	// The result: refused before end, with an observation, without or with any
	// other outcome; accepted at end with No.
	result := func(o Outcome) Command {
		return Command{Op: ResolveRound, RoundID: h.round, Outcome: o, Evidence: spec.RegistryRoundID[2:]}
	}
	h.refuse(result(Down), auth, evEnd-1, "invalid event result")
	withObservation := result(Down)
	withObservation.Observation = testObservation("1", uint32(evEnd))
	h.refuse(withObservation, auth, evEnd, "invalid event result")
	// A price round's resolution, its observation naming the event's own feed
	// as the guest's settle writes it: on the price path it would read the
	// opening the event never has.
	priceShaped := result("")
	priceShaped.Observation = testObservation("1", uint32(evEnd))
	priceShaped.Observation.FeedID = question
	h.refuse(priceShaped, auth, evEnd, "invalid event result")
	for _, o := range []Outcome{"", Void, "yes"} {
		h.refuse(result(o), auth, evEnd, "invalid event result")
	}
	h.must(result(Down), auth, evEnd)
	if m, _ := h.s.round(h.round); m.Status != "resolved" || m.Outcome != Down || m.CloseEvidence != spec.RegistryRoundID[2:] || m.Closing != nil {
		t.Fatalf("resolved event: %+v", m)
	}
	h.refuse(result(Up), auth, evEnd+1, "round already settled")

	// No pays: alice's ten No and carol's two; bob's Yes pay nothing.
	for who, want := range map[string]uint64{alice: 10 * AtomScale, carol: 2 * AtomScale, bob: 0} {
		if r := h.must(Command{Op: Redeem, RoundID: h.round}, who, 0); r.Amount != want {
			t.Fatalf("%s redeemed %d, want %d", who, r.Amount, want)
		}
	}
	if a := h.account(alice).Cash; a != 200*AtomScale-10*AtomScale+notional(4*AtomScale, 70)-fee(notional(4*AtomScale, 70), 100)+10*AtomScale {
		t.Fatalf("alice's cash %d", a)
	}
	r := h.must(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
	if r.Archive == nil || r.Archive.Round.Spec != spec || r.Archive.Round.Outcome != Down {
		t.Fatalf("archive: %+v", r.Archive)
	}
	// Its time has passed: the event can never be created again.
	h.refuse(Command{Op: CreateRound, Round: &spec}, auth, 0, "round must be created before opening")
}

// The event can be created any time before its cutoff, start included, and is
// open at once; at the cutoff it never can.
func TestEventCreationWindow(t *testing.T) {
	spec := eventSpec(t)
	for _, at := range []uint64{1, evStart, evCutoff - 1} {
		h := newHarness(t)
		if r := h.must(Command{Op: CreateRound, Round: &spec}, auth, at); r.RoundID != RoundID(config(), spec) {
			t.Fatalf("created at %d: %+v", at, r)
		}
	}
	h := newHarness(t)
	h.refuse(Command{Op: CreateRound, Round: &spec}, auth, evCutoff, "round must be created before opening")
	// Price rounds still need their start ahead of the time.
	btc, _ := NewRoundSpec(config(), "BTC", 900, 900)
	h.refuse(Command{Op: CreateRound, Round: &btc}, auth, 900, "round must be created before opening")
}

// A resolution is a price comparison on a price round and a posted outcome on
// the event, never the other way round; after voidableAfter only the void.
func TestEventResultRefusals(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	close := Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("97000000000000000000000", 1800), Evidence: hash([]byte("close"))}
	withOutcome := close
	withOutcome.Outcome = Up
	h.refuse(withOutcome, auth, 1800, "invalid closing observation")
	h.must(close, auth, 1800)

	h = newHarness(t)
	h.setupEvent(alice)
	spec := eventSpec(t)
	result := Command{Op: ResolveRound, RoundID: h.round, Outcome: Up, Evidence: spec.RegistryRoundID[2:]}
	h.refuse(result, auth, evVoid+1, "invalid event result")
	late := result
	late.RegistryTime = evVoid // recorded in time, processed late
	h.must(late, auth, evVoid+1)

	// An outcome rides on resolve_round only.
	for _, c := range []Command{
		{Op: OpenRound, RoundID: h.round, Outcome: Up, Evidence: hash([]byte("x")), Observation: testObservation("1", uint32(evStart))},
		{Op: VoidRound, RoundID: h.round, Outcome: Void, Evidence: hash([]byte("x"))},
	} {
		h.refuse(c, auth, 0, "unexpected command fields")
	}
}

// Void only after voidableAfter, holdings and all, half a share each.
func TestEventTimeoutVoid(t *testing.T) {
	h := newHarness(t)
	h.setupEvent(alice, bob)
	h.must(Command{Op: Mint, RoundID: h.round, Quantity: 3 * AtomScale}, alice, evStart+10)
	h.eventOrder(alice, Down, Sell, 20, AtomScale, GTC)
	h.eventOrder(bob, Down, Buy, 20, AtomScale, IOC)
	void := Command{Op: VoidRound, RoundID: h.round, Evidence: eventSpec(t).RegistryRoundID[2:]}
	h.refuse(void, auth, evVoid, "void timeout not reached")
	h.must(void, auth, evVoid+1)
	for who, want := range map[string]uint64{alice: 3*AtomScale/2 + 2*AtomScale/2, bob: AtomScale / 2} {
		if r := h.must(Command{Op: Redeem, RoundID: h.round}, who, 0); r.Amount != want {
			t.Fatalf("%s redeemed %d, want %d", who, r.Amount, want)
		}
	}
	h.must(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
}

// Every term of the event's identity is derived, never copied.
func TestEventSpecRejected(t *testing.T) {
	c := config()
	for name, args := range map[string][5]uint64{
		"start 0":                  {0, evCutoff, evEnd, evVoid},
		"cutoff at start":          {evStart, evStart, evEnd, evVoid},
		"end before the cutoff":    {evStart, evCutoff, evCutoff - 1, evVoid},
		"voidable at end":          {evStart, evCutoff, evEnd, evEnd},
		"voidable past 32 bits":    {evStart, evCutoff, evEnd, maxStreamsTimestamp + 1},
		"times in reverse":         {evVoid, evEnd, evCutoff, evStart},
		"everything at one second": {evStart, evStart, evStart, evStart},
	} {
		if _, err := NewEventSpec(c, question, args[0], args[1], args[2], args[3]); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if spec, err := NewEventSpec(c, question, evStart, evCutoff, evCutoff, maxStreamsTimestamp); err != nil || spec.End != spec.Cutoff {
		t.Errorf("end at the cutoff and voidable at the 32-bit limit must be accepted: %v", err)
	}
	for name, q := range map[string]string{"empty": "", "zero": "0x" + strings.Repeat("0", 64), "uppercase": strings.ToUpper(question), "short": question[:65], "no prefix": question[2:] + "00"} {
		if _, err := NewEventSpec(c, q, evStart, evCutoff, evEnd, evVoid); err == nil {
			t.Errorf("question %s: accepted", name)
		}
	}
	bad := c
	bad.Oracle.RulesHash = "0x" + strings.Repeat("1", 64)
	if _, err := NewEventSpec(bad, question, evStart, evCutoff, evEnd, evVoid); err == nil {
		t.Error("an invalid registry policy was accepted")
	}

	h := newHarness(t)
	good := eventSpec(t)
	for name, edit := range map[string]func(*RoundSpec){
		"observation window": func(r *RoundSpec) { r.ObservationWindow = 1 },
		"opening deadline":   func(r *RoundSpec) { r.OpeningDeadline = r.Start + 1 },
		"another question":   func(r *RoundSpec) { r.Feed = keccak([]byte("another")) },
		"registry round ID":  func(r *RoundSpec) { r.RegistryRoundID = keccak([]byte("another")) },
		"a later end":        func(r *RoundSpec) { r.End++ },
		"an earlier cutoff":  func(r *RoundSpec) { r.Cutoff-- },
		"a later void":       func(r *RoundSpec) { r.VoidableAfter++ },
		"another start":      func(r *RoundSpec) { r.Start-- },
		"a price asset":      func(r *RoundSpec) { r.Asset = "BTC" },
	} {
		spec := good
		edit(&spec)
		c, x := h.command(Command{Op: CreateRound, Round: &spec}, auth, 1)
		if _, _, e := Apply(h.s, c, x); e == nil || e.Error() != "invalid round specification" {
			t.Errorf("%s: %v", name, e)
		}
	}
	// The known answer: cast keccak $(cast abi-encode
	// 'f(uint256,address,bytes32,uint8,bytes32,uint64,uint64,uint64,uint64)' 2651420
	// 0xdddd…dddd <rulesHash> 2 <question> 1000 2161000 2161001 9937001).
	if good.RegistryRoundID != eventRegistryIDKnownAnswer {
		t.Errorf("event registry round ID %s", good.RegistryRoundID)
	}
}

// Validate holds every event round to its one shape in each status.
func TestEventStatesRejected(t *testing.T) {
	open := newHarness(t)
	open.setupEvent(alice, bob)
	open.must(Command{Op: Mint, RoundID: open.round, Quantity: 3 * AtomScale}, alice, evStart+10)
	open.eventOrder(alice, Up, Sell, 60, AtomScale, GTC)
	open.eventOrder(bob, Up, Buy, 60, AtomScale, IOC)
	resolved := &harness{t: t, s: open.s, round: open.round}
	resolved.must(Command{Op: ResolveRound, RoundID: open.round, Outcome: Up, Evidence: hash([]byte("ev"))}, auth, evEnd)
	resolved.must(Command{Op: Redeem, RoundID: open.round}, bob, 0) // Yes is now short of No
	void := &harness{t: t, s: open.s, round: open.round}
	void.must(Command{Op: VoidRound, RoundID: open.round, Evidence: hash([]byte("ev"))}, auth, evVoid+1)

	obs := testObservation("1", uint32(evStart))
	evidence := hash([]byte("x"))
	for name, c := range map[string]struct {
		from *harness
		edit func(*State, *Round)
	}{
		"open, scheduled":           {open, func(s *State, m *Round) { m.Status = "scheduled" }},
		"open with an opening":      {open, func(s *State, m *Round) { m.Opening = obs }},
		"open with a closing":       {open, func(s *State, m *Round) { m.Closing = obs }},
		"open with open evidence":   {open, func(s *State, m *Round) { m.OpenEvidence = evidence }},
		"open with close evidence":  {open, func(s *State, m *Round) { m.CloseEvidence = evidence }},
		"open with an outcome":      {open, func(s *State, m *Round) { m.Outcome = Up }},
		"open, locked off":          {open, func(s *State, m *Round) { m.Locked += Lot }},
		"open, sides unequal":       {open, func(s *State, m *Round) { m.Locked += Lot; m.UpSupply += Lot; s.Accounts[0].Holdings[0].Up += Lot }},
		"resolved with an opening":  {resolved, func(s *State, m *Round) { m.Opening = obs }},
		"resolved with a closing":   {resolved, func(s *State, m *Round) { m.Closing = obs }},
		"resolved, open evidence":   {resolved, func(s *State, m *Round) { m.OpenEvidence = evidence }},
		"resolved without evidence": {resolved, func(s *State, m *Round) { m.CloseEvidence = "" }},
		"resolved before end":       {resolved, func(s *State, m *Round) { s.Time = evEnd - 1 }},
		"resolved as void":          {resolved, func(s *State, m *Round) { m.Outcome = Void }},
		"resolved as No":            {resolved, func(s *State, m *Round) { m.Outcome = Down }},
		"resolved, locked off":      {resolved, func(s *State, m *Round) { m.Locked += Lot }},
		"void with an opening":      {void, func(s *State, m *Round) { m.Opening = obs }},
		"void with a closing":       {void, func(s *State, m *Round) { m.Closing = obs }},
		"void, open evidence":       {void, func(s *State, m *Round) { m.OpenEvidence = evidence }},
		"void without evidence":     {void, func(s *State, m *Round) { m.CloseEvidence = "" }},
		"void at voidableAfter":     {void, func(s *State, m *Round) { s.Time = evVoid }},
		"void as Up":                {void, func(s *State, m *Round) { m.Outcome = Up }},
		"void, locked off":          {void, func(s *State, m *Round) { m.Locked += Lot }},
		"settled otherwise":         {void, func(s *State, m *Round) { m.Status = "closed" }},
	} {
		s, _ := clone(c.from.s)
		m, _ := s.round(open.round)
		c.edit(s, m)
		if e := Validate(s); e == nil || e.Error() != "invalid event round" {
			t.Errorf("%s: %v", name, e)
		}
	}
	for _, h := range []*harness{open, resolved, void} {
		if e := Validate(h.s); e != nil {
			t.Fatal(e)
		}
	}
}
