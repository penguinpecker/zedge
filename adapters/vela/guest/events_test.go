package guest

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

// The operator-resolved event of README section 13, natively.

func eventRegistryID(e *EventTerms) string {
	spec, err := e.spec(deployed())
	if err != nil {
		panic(err)
	}
	return spec.RegistryRoundID
}

// The event is created by the first tick, never at deploy; a deployment whose
// first tick is past the cutoff never has it. The tick request leaves it out.
func TestEventCreatedByTheFirstTick(t *testing.T) {
	r := result(t, Deploy(testApp, marshal(eventParams()), testSalt))
	if s := state(t, r.State); r.Error != "" || s.Event == nil || *s.Event != *testEvent() || s.Resolver != resolver || s.DepositsFrom != 2 || s.DepositsSeen != 2 || len(s.Engine.Rounds) != 0 {
		t.Fatalf("deploy: %q %+v", r.Error, s)
	}
	h := &harness{t: t, st: r.State, block: 1000}
	h.sync(keeper)
	h.ok(h.tick(t0))
	id := eventID(testEvent())
	if status(h.s(), id) != "open" || len(h.s().Engine.Rounds) != 3 {
		t.Fatalf("after the first tick: %+v", h.s().Engine.Rounds)
	}
	// The trigger is asked about the two BTC rounds only, exactly as in a
	// deployment without the event: it would spend a registry read on the event
	// in every tick, and the registry has no such round.
	asked := result(t, ProcessRequest(testApp, raw(keeper), requestTypeProcess, syncPayload(keeper), h.st)).AppEvents[0].Data
	if want := append(append(words(2, 3, 2, 0, 0), raw(registryID(s1))...), raw(registryID(s1+900))...); !bytes.Equal(asked, want) {
		t.Fatalf("tick request %x", asked)
	}
	plain := &harness{t: t, st: result(t, Deploy(testApp, marshal(testParams()), testSalt)).State, block: 1000}
	plain.sync(keeper)
	plain.ok(plain.tick(t0))
	if b := result(t, ProcessRequest(testApp, raw(keeper), requestTypeProcess, syncPayload(keeper), plain.st)).AppEvents[0].Data; !bytes.Equal(b[64:], asked[64:]) {
		t.Fatal("the tick request differs from a deployment without the event")
	}

	// Not while the eight slots are full: the tick's own registry records take
	// them first. The event comes once a slot is free.
	full := &harness{t: t, st: r.State, block: 1000}
	full.sync(keeper)
	var next []rec
	for k := uint64(0); k < MaxSliceRounds; k++ {
		next = append(next, rec{start: s1 + 900*k})
	}
	full.ok(full.tick(t0, next...))
	if status(full.s(), id) != "absent" || len(full.s().Engine.Rounds) != MaxSliceRounds {
		t.Fatalf("with the slots full: %d rounds", len(full.s().Engine.Rounds))
	}
	// The registry voids the first round, which never opened: archived at the
	// end of that tick, it frees its slot for the next.
	full.sync(keeper)
	full.ok(full.tick(s1+31, rec{start: s1, resolvedAt: s1 + 31, outcome: 3}))
	if status(full.s(), id) != "absent" || len(full.s().Engine.Rounds) != MaxSliceRounds-1 {
		t.Fatalf("after the void: %d rounds", len(full.s().Engine.Rounds))
	}
	full.sync(keeper)
	full.ok(full.tick(s1 + 32))
	if status(full.s(), id) != "open" {
		t.Fatal("the event was not created in the free slot")
	}

	late := &harness{t: t, st: r.State, block: 1000}
	late.sync(keeper)
	late.ok(late.tick(testEvent().Cutoff))
	if status(late.s(), id) != "absent" {
		t.Fatal("the event was created at its cutoff")
	}
}

// Base deposits at or below depositsFrom are never credited; the next index
// is, and the custody bookkeeping counts from depositsFrom.
func TestEventDepositsFrom(t *testing.T) {
	h := &harness{t: t, st: result(t, Deploy(testApp, marshal(eventParams()), testSalt)).State, block: 1000}
	tick := func(deposits ...dep) Result {
		h.sync(keeper)
		h.block++
		r := h.ok(result(t, TrustedRequest(testApp, tick3(h.s().TickSeq, h.block, max(h.s().Clock, t0), nil, deposits), h.st)))
		h.st = r.State
		return r
	}
	if r := tick(dep{1, carol, 7}, dep{2, carol, 7}); len(r.AppEvents) != 1 || h.s().DepositsSeen != 2 || h.s().Deposits != 0 || account(h.s().Engine, carol) != nil {
		t.Fatalf("indexes 1 and 2: %d app events, seen %d", len(r.AppEvents), h.s().DepositsSeen)
	}
	if r := tick(dep{2, carol, 7}, dep{3, alice, 5}, dep{5, bob, 1}); len(r.AppEvents) != 2 || h.s().DepositsSeen != 3 || account(h.s().Engine, alice).Cash != 5 || account(h.s().Engine, bob) != nil {
		t.Fatalf("index 3: %d app events, seen %d", len(r.AppEvents), h.s().DepositsSeen)
	}
	// A refund is a payout of a deposit seen after depositsFrom.
	if r := tick(dep{4, bob, engine.MaxAtoms + 1}); r.AppEvents[1].EventSubType != CreditSubType || h.s().Payouts != 1 || h.s().DepositsSeen != 4 || h.s().Deposits != 1 {
		t.Fatalf("refund: payouts %d, seen %d", h.s().Payouts, h.s().DepositsSeen)
	}
	asked := result(t, ProcessRequest(testApp, raw(keeper), requestTypeProcess, syncPayload(keeper), h.st)).AppEvents[0].Data
	if !bytes.Equal(asked[32:64], words(5)) {
		t.Fatalf("next index asked %x", asked[32:64])
	}
}

// eventTrade is a deployment with the event in which alice minted ten shares
// and offers six Yes at 70, bob bought four, and carol minted two.
func eventTrade(t *testing.T) *harness {
	h := newHarnessWith(t, eventParams(), alice, bob, carol)
	id, cutoff := eventID(testEvent()), testEvent().Cutoff
	h.cmd(alice, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 10_000_000})
	h.cmd(alice, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Sell, Price: 70, Quantity: 6_000_000, TIF: engine.GTC, Expiry: cutoff, MaxFee: 100_000})
	h.ok(h.tick(s1 + 6))
	h.cmd(bob, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Buy, Price: 70, Quantity: 4_000_000, TIF: engine.IOC, Expiry: cutoff, MaxFee: 100_000})
	h.ok(h.tick(s1 + 7))
	h.cmd(carol, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 2_000_000})
	if a := account(h.s().Engine, bob); len(a.Holdings) != 2 {
		t.Fatalf("bob's fill: %+v", a.Holdings)
	}
	return h
}

// Only the resolver's EIP-712 signature over this deployment's event and the
// outcome settles the event, from its end on; it pays every holder in the
// same transition and leaves nothing to confirm.
func TestResolve(t *testing.T) {
	h := eventTrade(t)
	id, e := eventID(testEvent()), testEvent()
	yes := signResult(resolverKey, deployed(), id, 1)
	resolve := func(who string, payload []byte) Result {
		return result(t, ProcessRequest(testApp, raw(who), requestTypeProcess, payload, h.st))
	}
	// Before the end the engine refuses it, in private: the clock may only be stale.
	r := resolve(carol, resolvePayload(carol, 1, yes))
	if b := body(t, r.Events[0]).Body; r.Error != "" || b.Type != "resolve" || b.Status != "rejected" || b.Reason != "resolve: refused by the engine" || b.Tick != 0 ||
		r.AppEvents != nil || !bytes.Equal(marshal(state(t, r.State).Engine), marshal(h.s().Engine)) || state(t, r.State).TickSeq != h.s().TickSeq {
		t.Fatalf("before the end: %q %+v", r.Error, b)
	}
	other := func(f func(*engine.Config)) engine.Config { c := deployed(); f(&c); return c }
	bad := func(edit func([]byte)) string { s := raw(yes); edit(s); return "0x" + hex.EncodeToString(s) }
	reportBody := base64.StdEncoding.EncodeToString(raw(chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report))
	for name, c := range map[string]struct {
		payload []byte
		want    string
	}{
		"signed by another key":       {resolvePayload(carol, 1, signResult(malloryKey, deployed(), id, 1)), ErrMismatch},
		"the outcome not the signed":  {resolvePayload(carol, 2, yes), ErrMismatch},
		"another application's":       {resolvePayload(carol, 1, signResult(resolverKey, other(func(c *engine.Config) { c.Domain.ApplicationID = "8" }), id, 1)), ErrMismatch},
		"another chain's":             {resolvePayload(carol, 1, signResult(resolverKey, other(func(c *engine.Config) { c.Domain.ChainID = 26514 }), id, 1)), ErrMismatch},
		"another endpoint's":          {resolvePayload(carol, 1, signResult(resolverKey, other(func(c *engine.Config) { c.Domain.Endpoint = outside }), id, 1)), ErrMismatch},
		"another round's":             {resolvePayload(carol, 1, signResult(resolverKey, deployed(), id1, 1)), ErrMismatch},
		"a signature of no key":       {resolvePayload(carol, 1, bad(func(s []byte) { copy(s[:32], make([]byte, 32)) })), ErrMismatch},
		"v of 29":                     {resolvePayload(carol, 1, bad(func(s []byte) { s[64] = 29 })), ErrEnvelope},
		"v of 0":                      {resolvePayload(carol, 1, bad(func(s []byte) { s[64] = 0 })), ErrEnvelope},
		"64 bytes":                    {resolvePayload(carol, 1, yes[:130]), ErrEnvelope},
		"66 bytes":                    {resolvePayload(carol, 1, yes+"00"), ErrEnvelope},
		"uppercase hex":               {resolvePayload(carol, 1, "0x"+strings.ToUpper(yes[2:])), ErrEnvelope},
		"no 0x":                       {resolvePayload(carol, 1, yes[2:]), ErrEnvelope},
		"no outcome":                  {resolvePayload(carol, 0, yes), ErrEnvelope},
		"outcome 3":                   {resolvePayload(carol, 3, signResult(resolverKey, deployed(), id, 3)), ErrEnvelope},
		"no signature":                {resolvePayload(carol, 1, ""), ErrEnvelope},
		"under a sync's ID":           {envelope(carol, carol+":sync", requestBody{Type: "resolve", Outcome: 1, Signature: yes}), ErrEnvelope},
		"under another account's ID":  {envelope(carol, bob+":resolve", requestBody{Type: "resolve", Outcome: 1, Signature: yes}), ErrEnvelope},
		"with a command":              {envelope(carol, carol+":resolve", requestBody{Type: "resolve", Command: "x", Outcome: 1, Signature: yes}), ErrEnvelope},
		"with a report":               {envelope(carol, carol+":resolve", requestBody{Type: "resolve", Report: "AAAA", Outcome: 1, Signature: yes}), ErrEnvelope},
		"a sync with an outcome":      {envelope(carol, carol+":sync", requestBody{Type: "sync", Outcome: 1}), ErrEnvelope},
		"a sync with a signature":     {envelope(carol, carol+":sync", requestBody{Type: "sync", Signature: yes}), ErrEnvelope},
		"a report with an outcome":    {envelope(carol, carol+":report:1791270900", requestBody{Type: "report", Report: reportBody, Outcome: 1}), ErrEnvelope},
		"a command with a signature":  {envelope(carol, carol+":1", requestBody{Type: "command", Command: `{"x":1}`, Signature: yes}), ErrEnvelope},
		"for an account not the host": {resolvePayload(bob, 1, yes), ErrMismatch},
	} {
		if len(c.payload) != RequestBytes {
			t.Fatalf("%s: %d bytes", name, len(c.payload))
		}
		if got := resolve(carol, c.payload).Error; got != c.want {
			t.Errorf("%s: error %q, want %q", name, got, c.want)
		}
	}

	// At the end; bob has a command staged, so the resolution cannot redeem
	// him and the next tick's sweep does.
	h.sync(keeper)
	h.ok(h.tick(e.End))
	if b := h.cmd(bob, engine.Command{Op: engine.CancelAll}); b.Status != "staged" {
		t.Fatalf("bob's cancel_all: %+v", b)
	}
	before := h.s()
	cash := func(s *State, who string) uint64 { return account(s.Engine, who).Cash }
	r = resolve(carol, resolvePayload(carol, 1, yes))
	h.st = r.State
	after := h.s()
	if b := body(t, r.Events[0]).Body; r.Error != "" || b.Type != "resolve" || b.Status != "applied" || b.Tick != 0 || after.TickSeq != before.TickSeq || after.Clock != before.Clock ||
		len(r.AppEvents) != 1 || !bytes.Equal(r.AppEvents[0].Data, settleWords(eventRegistryID(e), settleResolve, 1, nil, sourceResolver)) {
		t.Fatalf("the result: %q %+v, %d app events", r.Error, b, len(r.AppEvents))
	}
	// Yes pays: alice's six (two came back at the cutoff) and carol's two.
	if cash(after, alice) != cash(before, alice)+6_000_000 || cash(after, carol) != cash(before, carol)+2_000_000 || cash(after, bob) != cash(before, bob) ||
		status(after, id) != "resolved" || !slices.Equal(after.Unconfirmed, before.Unconfirmed) {
		t.Fatalf("payouts: alice %d, carol %d, bob %d", cash(after, alice)-cash(before, alice), cash(after, carol)-cash(before, carol), cash(after, bob)-cash(before, bob))
	}
	r = h.ok(h.tick(e.End + 1))
	if cash(h.s(), bob) != cash(after, bob)+4_000_000 || status(h.s(), id) != "absent" || r.AppEvents[len(r.AppEvents)-1].EventSubType != ArchiveSubType {
		t.Fatalf("the sweep after the result: bob %d, %s", cash(h.s(), bob), status(h.s(), id))
	}
	if b := h.send(carol, resolvePayload(carol, 1, yes)); b.Status != "rejected" || b.Reason != "resolve: nothing to apply" {
		t.Fatalf("the result again: %+v", b)
	}

	// Without an event no signature counts; before the first tick nothing does.
	if got := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, resolvePayload(alice, 1, yes), newHarness(t, alice).st)).Error; got != ErrMismatch {
		t.Errorf("no event: %q", got)
	}
	if got := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, resolvePayload(alice, 1, yes), result(t, Deploy(testApp, marshal(eventParams()), testSalt)).State)).Error; got != ErrClock {
		t.Errorf("before the first tick: %q", got)
	}
}

// Still open after voidableAfter, the event voids itself, and the same tick's
// sweep pays half a share each and archives it.
func TestEventTimeoutVoid(t *testing.T) {
	h := newHarnessWith(t, eventParams(), alice, bob)
	id, e := eventID(testEvent()), testEvent()
	h.cmd(alice, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 3_000_000})
	h.cmd(alice, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Down, Side: engine.Sell, Price: 20, Quantity: 1_000_000, TIF: engine.GTC, Expiry: e.Cutoff, MaxFee: 10_000})
	h.ok(h.tick(s1 + 6))
	h.cmd(bob, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Down, Side: engine.Buy, Price: 20, Quantity: 1_000_000, TIF: engine.IOC, Expiry: e.Cutoff, MaxFee: 10_000})
	h.ok(h.tick(s1 + 7))
	h.sync(keeper)
	h.ok(h.tick(e.VoidableAfter))
	if status(h.s(), id) != "open" {
		t.Fatal("voided at voidableAfter")
	}
	before := h.s()
	h.sync(keeper)
	r := h.ok(h.tick(e.VoidableAfter + 1))
	void := settleWords(eventRegistryID(e), settleVoid, 3, nil, sourceOwnVoid)
	if !slices.ContainsFunc(r.AppEvents, func(x AppEvent) bool { return bytes.Equal(x.Data, void) }) || status(h.s(), id) != "absent" {
		t.Fatalf("the timeout void: %s", status(h.s(), id))
	}
	if account(h.s().Engine, alice).Cash != account(before.Engine, alice).Cash+1_500_000+1_000_000 || account(h.s().Engine, bob).Cash != account(before.Engine, bob).Cash+500_000 {
		t.Fatal("a void pays half a share each")
	}
	if b := h.send(alice, resolvePayload(alice, 1, signResult(resolverKey, deployed(), id, 1))); b.Status != "rejected" || b.Reason != "resolve: nothing to apply" {
		t.Fatalf("a result after the void: %+v", b)
	}
}

// A report for a boundary equal to the event's end resolves the BTC round
// that ends there and leaves the event alone (the nil-opening crash path);
// with no BTC round due, it has nothing to apply.
func TestEventReportAtItsEnd(t *testing.T) {
	d := newTestDON(4)
	at := func(end uint64) (*harness, string) {
		p := eventParams()
		p.Chainlink = d.config(1)
		p.Event = &EventTerms{Question: testEvent().Question, Start: t0 - 1000, Cutoff: end - 5, End: end, VoidableAfter: end + 86400}
		h := newHarnessWith(t, p, alice)
		spec, _ := p.Event.spec(deployed())
		id := engine.RoundID(deployed(), spec)
		h.cmd(alice, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 1_000_000})
		return h, id
	}
	report := func(b uint64) []byte {
		full := d.sign(1, engine.BTCStreamsFeed, b, b, b+86400, new(big.Int).Mul(big.NewInt(98_000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)))
		return reportPayload(keeper, "0x"+hex.EncodeToString(full), uint32(b))
	}
	h, id := at(s1 + 900)
	if b := h.send(keeper, report(s1+900)); b.Status != "applied" || status(h.s(), id1) != "absent" || status(h.s(), id) != "open" || status(h.s(), id2) != "open" {
		t.Fatalf("report at the event's end: %+v", b)
	}
	h, id = at(s1 + 2700)
	if b := h.send(keeper, report(s1+2700)); b.Status != "rejected" || b.Reason != "report: nothing to apply" || status(h.s(), id) != "open" {
		t.Fatalf("report at the event's end alone: %+v", b)
	}
}

// The registry never holds the event: a record that names it is forged and
// is skipped, whatever it says. The timeout void stays the guest's own.
func TestEventMirrorGuard(t *testing.T) {
	h := newHarnessWith(t, eventParams(), alice)
	id, e := eventID(testEvent()), testEvent()
	reg := eventRegistryID(e)
	h.cmd(alice, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 1_000_000})
	// An outcome with an observation at the event's end, which the feed
	// substitution of settle would make the engine read as the event's own.
	yes := rec{forged: reg, start: e.Start, openedAt: e.Start, opening: observed(e.Start, e.Start, p0), resolvedAt: e.End, outcome: 1, closing: observed(e.End, e.End, p0)}
	h.sync(keeper)
	r := h.ok(h.tick(e.End, yes))
	if applied, skipped := counts(r); applied != 0 || skipped != 1 || status(h.s(), id) != "open" {
		t.Fatalf("a forged result: applied %d, skipped %d, %s", applied, skipped, status(h.s(), id))
	}
	void := rec{forged: reg, start: e.Start, resolvedAt: e.VoidableAfter + 1, outcome: 3}
	h.sync(keeper)
	r = h.ok(h.tick(e.VoidableAfter+1, void))
	own := settleWords(reg, settleVoid, 3, nil, sourceOwnVoid)
	if applied, skipped := counts(r); applied != 0 || skipped != 1 || !slices.ContainsFunc(r.AppEvents, func(x AppEvent) bool { return bytes.Equal(x.Data, own) }) {
		t.Fatalf("a forged void: applied %d, skipped %d", applied, skipped)
	}
}

// The script's event deployment: deposits from index 3, the event from the
// first tick, the result refused before the end and paid at once after it.
func TestEventScenario(t *testing.T) {
	steps := run(t, script())
	s := state(t, find(t, steps, "events: tick 1 creates the next two rounds and the event, skips indexes 1 and 2 and credits alice and bob").after)
	if s.DepositsSeen != 4 || s.Deposits != 2 || account(s.Engine, carol) != nil || status(s, eventID(testEvent())) != "open" {
		t.Fatalf("tick 1: seen %d, deposits %d", s.DepositsSeen, s.Deposits)
	}
	r := find(t, steps, "events: alice carries the resolver's No, which pays every holder and archives the event")
	after := state(t, r.after)
	if b := body(t, r.Events[0]).Body; b.Status != "applied" || len(r.AppEvents) != 2 || r.AppEvents[1].EventSubType != ArchiveSubType ||
		!bytes.Equal(r.AppEvents[0].Data, settleWords(eventRegistryID(testEvent()), settleResolve, 2, nil, sourceResolver)) || status(after, eventID(testEvent())) != "absent" {
		t.Fatalf("the result: %+v, %d app events", b, len(r.AppEvents))
	}
	// No pays alice's ten; bob's four Yes pay nothing.
	if a, b := account(after.Engine, alice), account(after.Engine, bob); a.Cash != 100_000_000-10_000_000+2_800_000-28_000+10_000_000 || b.Cash != 100_000_000-2_800_000-28_000 || len(a.Holdings) != 0 || len(b.Holdings) != 0 {
		t.Fatalf("after the result: alice %d, bob %d", a.Cash, b.Cash)
	}
	if b := body(t, find(t, steps, "events: the same result again has nothing to apply").Events[0]).Body; b.Status != "rejected" || b.Reason != "resolve: nothing to apply" {
		t.Fatalf("the result again: %+v", b)
	}
}
