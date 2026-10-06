package guest

import (
	"bytes"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

// The rules of README sections 9 and 10, natively, one deployment per test.

const carol = "0xcacacacacacacacacacacacacacacacacacacaca"

var id1, id2 = engine.RoundID(deployed(), mustSpec(s1)), engine.RoundID(deployed(), mustSpec(s1+900))

// opened1 is round 1 as the registry reports it once its opening is recorded.
var opened1 = rec{start: s1, openedAt: s1 + 3, opening: observed(s1, s1+3, p0)}

type harness struct {
	t     *testing.T
	st    []byte
	block uint64
}

// newHarness deploys, sets the clock, funds each account with 100 tokens,
// creates rounds 1 and 2, opens round 1 at s1+5 and has every account mint
// five shares in it.
func newHarness(t *testing.T, accounts ...string) *harness {
	t.Helper()
	h := &harness{t: t, st: result(t, Deploy(testApp, marshal(testParams()), testSalt)).State, block: 1000}
	h.sync(keeper)
	h.ok(h.tick(t0))
	for _, who := range accounts {
		if r := h.deposit(who, 100_000_000); r.Error != "" {
			t.Fatal(r.Error)
		}
	}
	h.sync(keeper)
	h.ok(h.tick(t0+100, rec{start: s1}, rec{start: s1 + 900}))
	h.sync(keeper)
	h.ok(h.tick(s1+5, opened1))
	for _, who := range accounts {
		if b := h.cmd(who, engine.Command{Op: engine.Mint, RoundID: id1, Quantity: 5_000_000}); b.Status != "applied" {
			t.Fatalf("mint: %+v", b)
		}
	}
	return h
}

func (h *harness) s() *State { return state(h.t, h.st) }

func (h *harness) send(who string, payload []byte) receiptBody {
	h.t.Helper()
	r := result(h.t, ProcessRequest(testApp, raw(who), requestTypeProcess, payload, h.st))
	if r.Error != "" {
		h.t.Fatalf("%s: %s", who, r.Error)
	}
	h.st = r.State
	return body(h.t, r.Events[0]).Body
}

func (h *harness) sync(who string) receiptBody { return h.send(who, syncPayload(who)) }

// next is the account's next nonce.
func (h *harness) next(who string) uint64 {
	if a := account(h.s().Engine, who); a != nil {
		return a.Nonce + 1
	}
	return 1
}

func (h *harness) cmd(who string, c engine.Command) receiptBody {
	h.t.Helper()
	return h.send(who, commandPayload(who, h.next(who), c))
}

func (h *harness) deposit(who string, amount uint64) Result {
	r := result(h.t, Deposit(testApp, raw(who), raw(collateral), new(big.Int).SetUint64(amount).Bytes(), h.st))
	if r.Error == "" {
		h.st = r.State
	}
	return r
}

// tickN applies tick n at timestamp at, with registry records.
func (h *harness) tickN(n, at uint64, records ...rec) Result {
	h.block++
	r := result(h.t, TrustedRequest(testApp, tick2(n, h.block, at, records...), h.st))
	if r.Error == "" {
		h.st = r.State
	}
	return r
}

// tick applies the latest tick requested.
func (h *harness) tick(at uint64, records ...rec) Result {
	return h.tickN(h.s().TickSeq, at, records...)
}

func (h *harness) ok(r Result) Result {
	h.t.Helper()
	if r.Error != "" {
		h.t.Fatal(r.Error)
	}
	return r
}

// counts is (applied, skipped) from a tick's clock record.
func counts(r Result) (uint64, uint64) {
	d := r.AppEvents[0].Data
	return new(big.Int).SetBytes(d[96:128]).Uint64(), new(big.Int).SetBytes(d[128:160]).Uint64()
}

func status(s *State, id string) string {
	for _, m := range s.Engine.Rounds {
		if m.ID == id {
			return m.Status
		}
	}
	return "absent"
}

// order is an Up order in round 1 that expires at its cutoff.
func order(side engine.Side, price, quantity uint64, tif engine.TimeInForce) engine.Command {
	return engine.Command{Op: engine.PlaceOrder, RoundID: id1, Outcome: engine.Up, Side: side, Price: price, Quantity: quantity, TIF: tif, Expiry: cut1, MaxFee: quantity}
}

func TestStagingRules(t *testing.T) {
	h := newHarness(t, alice, bob, carol)
	before := h.s()
	// S2: only a registered account's next command is staged. Anything else
	// reaches the engine, which can only refuse it or recognise a retry.
	if b := h.send(keeper, commandPayload(keeper, 1, order(engine.Sell, 60, 1_000_000, engine.GTC))); b.Status != "rejected" || b.Reason != "unknown account" || b.View != nil {
		t.Fatalf("unregistered: %+v", b)
	}
	if b := h.send(alice, commandPayload(alice, h.next(alice)+1, order(engine.Sell, 60, 1_000_000, engine.GTC))); b.Status != "rejected" || b.Reason != "replayed, conflicting or out-of-order nonce" {
		t.Fatalf("skipped nonce: %+v", b)
	}
	// A staged command waits in the state, so its size is bounded; every
	// command the engine could accept is well inside the bound.
	padded := order(engine.Sell, 60, 1_000_000, engine.GTC)
	padded.RoundID = strings.Repeat("ab", 300)
	if b := h.cmd(alice, padded); b.Status != "rejected" || b.Reason != "command too large to stage" || len(h.s().Staged) != 0 {
		t.Fatalf("padded command: %+v", b)
	}
	// S5: staged under the tick its own reply asks for. Nothing in the engine
	// changes, nothing is reserved, no nonce is used.
	sell := commandPayload(alice, h.next(alice), order(engine.Sell, 60, 1_000_000, engine.GTC))
	b, s := h.send(alice, sell), h.s()
	if b.Status != "staged" || b.Tick != s.TickSeq || len(s.Staged) != 1 || s.Staged[0].Tick != s.TickSeq || !bytes.Equal(marshal(s.Engine), marshal(before.Engine)) ||
		b.View.Nonce != h.next(alice)-1 || len(b.View.Orders) != 0 || b.View.Holdings[0].ReservedUp != 0 {
		t.Fatalf("staging: %+v %+v", b, s.Staged)
	}
	item := string(marshal(s.Staged))
	// S3: frozen until activated. The same bytes again change nothing but the
	// tick count; anything else is refused; a deposit fails; a sync works.
	if b := h.send(alice, sell); b.Status != "staged" || string(marshal(h.s().Staged)) != item {
		t.Fatalf("resend: %+v", b)
	}
	for _, c := range []engine.Command{{Op: engine.CancelAll}, {Op: engine.RequestWithdrawal, Amount: 1, Destination: alice}, {Op: engine.Merge, RoundID: id1, Quantity: 1000}} {
		if b := h.cmd(alice, c); b.Status != "rejected" || b.Reason != "a staged command is waiting for its tick" {
			t.Fatalf("%s while staged: %+v", c.Op, b)
		}
	}
	if r := h.deposit(alice, 1); r.Error != ErrDeposit {
		t.Fatalf("deposit while staged: %q", r.Error)
	}
	if b := h.sync(alice); b.Status != "requested" || string(marshal(h.s().Staged)) != item || !bytes.Equal(marshal(h.s().Engine), marshal(before.Engine)) {
		t.Fatalf("sync while staged: %+v", b)
	}
	// Activation: her next request collects it.
	h.ok(h.tick(s1 + 6))
	if b := h.sync(alice); b.Outcome == nil || b.Outcome.Status != "applied" || b.Outcome.Receipt.Status != "resting" || len(b.View.Orders) != 1 {
		t.Fatalf("alice's outcome: %+v", b.Outcome)
	}
}

// A0: only what an order leaves resting counts against MaxAccountOrders. An
// account quoting four orders can still take with an IOC, or with a GTC that
// fills on arrival; a GTC that would rest a fifth is refused whole, fills and all.
func TestOrderCapCountsRestingOrders(t *testing.T) {
	h := newHarness(t, alice, bob)
	for i := uint64(0); i < MaxAccountOrders; i++ {
		h.cmd(alice, order(engine.Sell, 70+i, 1_000, engine.GTC))
		h.ok(h.tick(s1 + 6 + i))
	}
	down := func(side engine.Side, quantity uint64, tif engine.TimeInForce) engine.Command {
		c := order(side, 50, quantity, tif)
		c.Outcome = engine.Down
		return c
	}
	h.cmd(bob, down(engine.Sell, 2_000_000, engine.GTC))
	h.ok(h.tick(s1 + 11))
	for _, c := range []struct {
		name     string
		order    engine.Command
		outcome  string
		fills    int
		bobRests uint64
	}{
		{"an IOC", down(engine.Buy, 1_000_000, engine.IOC), "", 1, 1_000_000},
		{"a GTC filled on arrival", down(engine.Buy, 500_000, engine.GTC), "", 1, 500_000},
		{"a GTC that would rest a fifth order", down(engine.Buy, 1_000_000, engine.GTC), "order capacity", 0, 500_000},
	} {
		if b := h.cmd(alice, c.order); b.Status != "staged" {
			t.Fatalf("%s at four orders: %+v", c.name, b)
		}
		h.ok(h.tick(h.s().Clock + 1))
		b := h.sync(alice)
		if b.Outcome.Reason != c.outcome || (c.fills > 0) != (b.Outcome.Receipt != nil && len(b.Outcome.Receipt.Fills) == c.fills) || len(b.View.Orders) != MaxAccountOrders {
			t.Fatalf("%s at four orders: %+v", c.name, b.Outcome)
		}
		if v := h.sync(bob).View; len(v.Orders) != 1 || v.Orders[0].Remaining != c.bobRests {
			t.Fatalf("%s: bob's order %+v", c.name, v.Orders)
		}
	}
}

// An item is judged at its tick's block timestamp T: admitted at cutoff - 1,
// refused at the cutoff, and a resting order is released by the checkpoint of
// the first tick at or past the cutoff, before anything in that tick is
// activated. No fill happens at or after the cutoff.
func TestCutoff(t *testing.T) {
	h := newHarness(t, alice, bob, carol)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	staged := h.st
	h.ok(h.tick(cut1))
	if b := h.sync(alice); b.Outcome.Status != "rejected" || b.Outcome.Reason != "round closed" || len(b.View.Orders) != 0 {
		t.Fatalf("activation at the cutoff: %+v", b.Outcome)
	}
	h.st = staged
	h.ok(h.tick(cut1 - 1))
	if b := h.sync(alice); b.Outcome.Status != "applied" || len(b.View.Orders) != 1 || b.View.Holdings[0].ReservedUp != 1_000_000 {
		t.Fatalf("activation a second before the cutoff: %+v", b.Outcome)
	}
	// A crossing buy staged before the cutoff, whose tick is stamped at it.
	h.cmd(bob, order(engine.Buy, 60, 1_000_000, engine.IOC))
	if r := h.ok(h.tick(cut1)); len(r.AppEvents) != 1 {
		t.Fatalf("tick at the cutoff: %d app events", len(r.AppEvents))
	}
	if b := h.sync(bob); b.Outcome.Status != "rejected" || b.Outcome.Reason != "round closed" || b.View.Cash != 95_000_000 || len(b.View.Holdings[0:1]) != 1 || b.View.Holdings[0].Up != 5_000_000 {
		t.Fatalf("buy at the cutoff: %+v %+v", b.Outcome, b.View)
	}
	if b := h.sync(alice); len(b.View.Orders) != 0 || b.View.Holdings[0].Up != 5_000_000 || b.View.Holdings[0].ReservedUp != 0 {
		t.Fatalf("alice's order after the cutoff: %+v", b.View)
	}
	// Staging judges no time: an order staged after the cutoff is refused at
	// activation.
	if b := h.cmd(carol, order(engine.Sell, 60, 1_000, engine.GTC)); b.Status != "staged" || b.At.Timestamp != cut1 {
		t.Fatalf("staging after the cutoff: %+v", b)
	}
	h.ok(h.tick(cut1 + 1))
	if b := h.sync(carol); b.Outcome.Status != "rejected" || b.Outcome.Reason != "round closed" {
		t.Fatalf("activation after the cutoff: %+v", b.Outcome)
	}
}

// Ticks may be skipped, never replayed or reordered. A later tick activates
// every item due by its number, in tick order, at its own time.
func TestTicksOutOfOrder(t *testing.T) {
	h := newHarness(t, alice, bob)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	a := h.s().TickSeq
	h.cmd(bob, order(engine.Buy, 60, 1_000_000, engine.IOC))
	h.sync(keeper)
	c := h.s().TickSeq
	h.ok(h.tickN(c, s1+20))
	s := h.s()
	if len(s.Staged) != 0 || len(s.Outcomes) != 2 || s.Outcomes[0] != (Outcome{bob, engine.CommandID(bob, 3), a + 1, "applied", ""}) ||
		s.Outcomes[1] != (Outcome{alice, engine.CommandID(alice, 3), a, "applied", ""}) || len(s.Engine.Orders) != 0 {
		t.Fatalf("tick %d: %+v, %d orders", c, s.Outcomes, len(s.Engine.Orders))
	}
	for _, k := range []uint64{a, a + 1, c} {
		if r := h.tickN(k, s1+21); r.Error != ErrTick {
			t.Fatalf("tick %d after tick %d: %q", k, c, r.Error)
		}
	}
	h.sync(keeper)
	if r := h.tick(s1 + 19); r.Error != ErrTime {
		t.Fatalf("a pending tick behind the clock: %q", r.Error)
	}
	if b := h.sync(bob); b.Outcome.Receipt.Status != "filled" || len(b.Outcome.Receipt.Fills) != 1 || b.At.Timestamp != s1+20 {
		t.Fatalf("bob: %+v", b.Outcome)
	}
}

// A round is voided in the engine only from the registry's recorded void, in
// the tick before activation, so an order staged for it is refused; the sweep
// then pays half of each outcome share and the empty round is archived.
func TestStagedOrderForAVoidedRound(t *testing.T) {
	h := newHarness(t, alice, bob)
	// Round 2 never opened; the registry voided it after its opening deadline.
	second := order(engine.Buy, 60, 1_000, engine.GTC)
	second.RoundID, second.Expiry = id2, s1+900+895
	h.cmd(alice, second)
	r := h.ok(h.tick(s1+900+40, rec{start: s1 + 900, resolvedAt: s1 + 900 + 31, outcome: 3}))
	if applied, skipped := counts(r); applied != 1 || skipped != 0 || len(r.AppEvents) != 2 || r.AppEvents[1].EventSubType != ArchiveSubType {
		t.Fatalf("void of round 2: applied %d, skipped %d, %d app events", applied, skipped, len(r.AppEvents))
	}
	// Activation runs after the mirror and before the archive: the round is void.
	if b := h.sync(alice); b.Outcome.Status != "rejected" || b.Outcome.Reason != "round closed" {
		t.Fatalf("order for round 2: %+v", b.Outcome)
	}
	// Round 1 opened and holds shares. The clock passing voidableAfter voids
	// nothing; the registry's record does.
	voidable := mustSpec(s1).VoidableAfter
	h.ok(h.tick(voidable + 5))
	if m := h.s().Engine.Rounds[0]; m.Status != "open" {
		t.Fatalf("round 1 after voidableAfter without a record: %s", m.Status)
	}
	h.cmd(alice, order(engine.Sell, 60, 1_000, engine.GTC))
	voided := opened1
	voided.outcome, voided.resolvedAt = 3, voidable+6
	r = h.ok(h.tick(voidable+10, voided))
	if applied, _ := counts(r); applied != 1 || len(r.AppEvents) != 2 || len(h.s().Engine.Rounds) != 0 {
		t.Fatalf("void of round 1: applied %d, %d app events", applied, len(r.AppEvents))
	}
	for _, who := range []string{alice, bob} {
		if b := h.sync(who); b.View.Cash != 100_000_000 || len(b.View.Holdings) != 0 || who == alice && b.Outcome.Reason != "round closed" {
			t.Fatalf("%s after the void: %+v %+v", who, b.View, b.Outcome)
		}
	}
}

// Activation runs in tick order, so a cancel and a crossing order resolve the
// way they were committed, whichever tick passes them.
func TestCancelRacingActivation(t *testing.T) {
	h := newHarness(t, alice, bob)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	h.ok(h.tick(s1 + 6))
	h.sync(alice)
	// The buy was committed first: it takes the whole order, the cancel finds nothing.
	h.cmd(bob, order(engine.Buy, 60, 1_000_000, engine.IOC))
	h.cmd(alice, engine.Command{Op: engine.CancelOrder, OrderID: engine.CommandID(alice, 3)})
	h.ok(h.tick(s1 + 7))
	if b := h.sync(alice); b.Outcome.Status != "rejected" || b.Outcome.Reason != "unknown active order" || b.View.Cash != 95_000_000+594_000 {
		t.Fatalf("cancel after the fill: %+v %+v", b.Outcome, b.View)
	}
	if b := h.sync(bob); b.Outcome.Status != "applied" || len(b.Outcome.Receipt.Fills) != 1 {
		t.Fatalf("the fill: %+v", b.Outcome)
	}
	// The cancel was committed first: the buy finds an empty book. The refused
	// cancel used no nonce, so this order takes it.
	n := h.next(alice)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	h.ok(h.tick(s1 + 8))
	h.sync(alice)
	h.cmd(alice, engine.Command{Op: engine.CancelOrder, OrderID: engine.CommandID(alice, n)})
	h.cmd(bob, order(engine.Buy, 60, 1_000_000, engine.IOC))
	h.ok(h.tick(s1 + 9))
	if b := h.sync(alice); b.Outcome.Status != "applied" || b.Outcome.Receipt.Status != "cancelled" || len(b.View.Orders) != 0 {
		t.Fatalf("cancel before the buy: %+v", b.Outcome)
	}
	if b := h.sync(bob); b.Outcome.Status != "applied" || b.Outcome.Receipt.Status != "ioc_complete" || len(b.Outcome.Receipt.Fills) != 0 {
		t.Fatalf("the buy after the cancel: %+v", b.Outcome)
	}
}

func TestExactRetries(t *testing.T) {
	h := newHarness(t, alice, bob)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	buy := commandPayload(bob, h.next(bob), order(engine.Buy, 60, 400_000, engine.IOC))
	h.send(bob, buy)
	h.ok(h.tick(s1 + 6))
	tick := tick2(h.s().LastTick, h.block, s1+6)
	// Activated: the same bytes are the engine's exact retry, with the original
	// receipt and no second effect. The outcome comes back with it.
	before := h.s()
	b, after := h.send(bob, buy), h.s()
	if b.Status != "retry" || len(b.Receipt.Fills) != 1 || b.Outcome == nil || len(b.Outcome.Receipt.Fills) != 1 || len(after.Staged) != 0 ||
		!bytes.Equal(marshal(after.Engine), marshal(before.Engine)) {
		t.Fatalf("retry after activation: %+v", b)
	}
	// A replayed tick fails: nothing activates twice.
	if r := result(t, TrustedRequest(testApp, tick, h.st)); r.Error != ErrTick {
		t.Fatalf("replayed tick: %q", r.Error)
	}
	// Refused at activation: the nonce is still free, and the same bytes are
	// staged again under a new tick.
	broke := commandPayload(bob, h.next(bob), order(engine.Buy, 60, 200_000_000, engine.IOC))
	h.send(bob, broke)
	h.ok(h.tick(s1 + 7))
	b = h.send(bob, broke)
	if b.Outcome.Status != "rejected" || b.Outcome.Reason != "insufficient available cash" || b.Status != "staged" || h.s().Staged[0].Tick != b.Tick {
		t.Fatalf("resend after a refusal: %+v", b)
	}
}

// No refusal reason depends on another account's orders: a cancel of someone
// else's order reads the same whether that order still rests or is gone, so
// an account with nothing in it cannot watch another's order fill.
func TestCancelCannotProbeAnotherAccount(t *testing.T) {
	const mallory = "0x0000000000000000000000000000000000000bad"
	h := newHarness(t, alice, bob)
	h.cmd(mallory, engine.Command{Op: engine.Register})
	n := h.next(alice)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	h.ok(h.tick(s1 + 6))
	probe := engine.Command{Op: engine.CancelOrder, OrderID: engine.CommandID(alice, n)}
	h.cmd(mallory, probe)
	h.ok(h.tick(s1 + 7))
	resting := h.sync(mallory).Outcome
	rested := activeOrders(h.s().Engine, alice)
	// Bob's buy takes the whole order; the probe staged right after it is
	// activated right after it.
	h.cmd(bob, order(engine.Buy, 60, 1_000_000, engine.IOC))
	h.cmd(mallory, probe)
	h.ok(h.tick(s1 + 8))
	gone := h.sync(mallory).Outcome
	if rested != 1 || activeOrders(h.s().Engine, alice) != 0 || resting.Reason != "unknown active order" || gone.Reason != resting.Reason {
		t.Fatalf("probe while the order rests: %q; after it filled: %q", resting.Reason, gone.Reason)
	}
}

// The clock record ends with the payload's Keccak-256, the hash the endpoint
// put into the trusted request's ID, so a tick fed anything but the trigger's
// answer publishes something else: a forged round record of the same shape,
// or a version-1 payload in place of a version-2 one with no records.
func TestClockRecordBindsThePayload(t *testing.T) {
	h := &harness{t: t, st: result(t, Deploy(testApp, marshal(testParams()), testSalt)).State, block: 1000}
	h.sync(keeper)
	h.ok(h.tick(t0))
	h.sync(keeper)
	h.ok(h.tick(t0+100, rec{start: s1}, rec{start: s1 + 900}))
	h.sync(keeper)
	k := h.s().TickSeq
	forged := opened1
	forged.opening = observed(s1, s1+3, "1000000000000000000") // $1, not $97,000
	for name, p := range map[string][2][]byte{
		"a forged record": {tick2(k, 2000, s1+5, opened1), tick2(k, 2000, s1+5, forged)},
		"version 1":       {tick2(k, 2000, s1+5), tickPayload(k, 2000, s1+5)},
	} {
		genuine, fed := h.ok(result(t, TrustedRequest(testApp, p[0], h.st))), h.ok(result(t, TrustedRequest(testApp, p[1], h.st)))
		if bytes.Equal(genuine.AppEvents[0].Data, fed.AppEvents[0].Data) || !bytes.Equal(fed.AppEvents[0].Data[:160], genuine.AppEvents[0].Data[:160]) ||
			!bytes.Equal(fed.AppEvents[0].Data[160:], keccak(p[1])) {
			t.Errorf("%s: the clock record does not show the payload it was fed", name)
		}
	}
}

// A taker facing more than MaxFills makers is refused whole and has to split.
func TestMatchingWorkLimit(t *testing.T) {
	makers := []string{"0x0000000000000000000000000000000000000a01", "0x0000000000000000000000000000000000000a02", "0x0000000000000000000000000000000000000a03",
		"0x0000000000000000000000000000000000000a04", "0x0000000000000000000000000000000000000a05"}
	h := newHarness(t, append(makers, alice)...)
	for _, who := range makers {
		h.cmd(who, order(engine.Sell, 60, 1_000, engine.GTC))
	}
	h.ok(h.tick(s1 + 6))
	h.cmd(alice, order(engine.Buy, 60, 5_000, engine.IOC))
	h.ok(h.tick(s1 + 7))
	if b := h.cmd(alice, order(engine.Buy, 60, 4_000, engine.IOC)); b.Outcome.Reason != "matching work limit; split order" || len(b.View.Orders) != 0 || len(h.s().Engine.Orders) != len(makers) {
		t.Fatalf("five fills: %+v", b.Outcome)
	}
	h.ok(h.tick(s1 + 8))
	if b := h.sync(alice); b.Outcome.Status != "applied" || len(b.Outcome.Receipt.Fills) != MaxFills || len(h.s().Engine.Orders) != 1 {
		t.Fatalf("four fills: %+v", b.Outcome)
	}
}

func TestRoundMirror(t *testing.T) {
	h := newHarness(t, alice)
	// Nothing is created for a round that has started or a market the
	// deployment does not mirror, and nothing is done for a round with no news.
	h.sync(keeper)
	r := h.ok(h.tick(s1+6, opened1, rec{start: t0}, rec{asset: 1, start: s1 + 1800}, rec{start: s1 + 1800, duration: 300}))
	if applied, skipped := counts(r); applied != 0 || skipped != 4 || len(h.s().Engine.Rounds) != 2 {
		t.Fatalf("no news: applied %d, skipped %d", applied, skipped)
	}
	// A record the engine refuses, or one that does not decode, is skipped and
	// the tick still applies: round 2's opening recorded after its deadline;
	// a void stamped before the deadline (registryTime is the registry's,
	// never T); an asset that does not exist.
	late := rec{start: s1 + 900, openedAt: s1 + 900 + 31, opening: observed(s1+900, s1+900+31, p0)}
	early := rec{start: s1 + 900, resolvedAt: s1 + 900 + 30, outcome: 3}
	payload := tick2(h.s().TickSeq+1, h.block+1, s1+900+40, late, early, rec{start: s1 + 2700})
	payload[len(payload)-18*32-1] = 2 // the last record's asset
	h.sync(keeper)
	r = h.ok(result(t, TrustedRequest(testApp, payload, h.st)))
	h.st = r.State
	if applied, skipped := counts(r); applied != 0 || skipped != 3 || h.s().Clock != s1+900+40 || status(h.s(), id2) != "scheduled" {
		t.Fatalf("refused records: applied %d, skipped %d", applied, skipped)
	}
	// The engine decides the outcome; a record that disagrees is skipped.
	resolved := opened1
	resolved.outcome, resolved.resolvedAt, resolved.closing = 2, s1+902, observed(s1+900, s1+902, p0) // a tie is Up
	h.sync(keeper)
	if applied, _ := counts(h.ok(h.tick(s1+900+41, resolved))); applied != 0 {
		t.Fatal("a resolution the engine disagrees with was mirrored")
	}
	resolved.outcome = 1
	h.sync(keeper)
	if r := h.ok(h.tick(s1+900+42, resolved)); len(r.AppEvents) != 2 || len(h.s().Engine.Rounds) != 1 {
		t.Fatalf("resolution: %d app events, %d rounds", len(r.AppEvents), len(h.s().Engine.Rounds))
	}
	// Records apply in (start, asset, duration) order: with one slot left the
	// earlier round takes it, whatever order the payload lists them in.
	var future []rec
	for k := uint64(3); k <= 9; k++ {
		future = append(future, rec{start: s1 + 900*k})
	}
	h.sync(keeper)
	r = h.ok(h.tick(s1+900+43, future[6], future[5], future[4], future[3], future[2], future[1], future[0]))
	if applied, skipped := counts(r); applied != 7 || skipped != 0 || len(h.s().Engine.Rounds) != MaxSliceRounds {
		t.Fatalf("filling the slots: applied %d, skipped %d, %d rounds", applied, skipped, len(h.s().Engine.Rounds))
	}
	h.sync(keeper)
	r = h.ok(h.tick(s1+900+44, rec{start: s1 + 900*11}, rec{start: s1 + 900*10}))
	if applied, skipped := counts(r); applied != 0 || skipped != 2 {
		t.Fatalf("a ninth round: applied %d, skipped %d", applied, skipped)
	}
	// The next request asks about every round the engine holds as scheduled
	// or open, 8 of them; the trigger's answer is framed by n.
	if b := h.sync(keeper); b.Tick != h.s().TickSeq {
		t.Fatal(b)
	}
	for name, p := range map[string][]byte{
		"version 3":          append(words(3), tick2(h.s().TickSeq, h.block+1, s1+900+45)[32:]...),
		"one word short":     tick2(h.s().TickSeq, h.block+1, s1+900+45, rec{start: s1})[:7*32+18*32],
		"one word long":      append(tick2(h.s().TickSeq, h.block+1, s1+900+45), words(0)...),
		"seventeen records":  tick2(h.s().TickSeq, h.block+1, s1+900+45, slices.Repeat([]rec{{start: s1}}, 17)...),
		"count over 64 bits": func() []byte { p := tick2(h.s().TickSeq, h.block+1, s1+900+45); p[6*32] = 1; return p }(),
		"version 1, 7 words": append(tickPayload(h.s().TickSeq, h.block+1, s1+900+45), words(0)...),
		"version 2, 6 words": tick2(h.s().TickSeq, h.block+1, s1+900+45)[:6*32],
		"partial final word": tick2(h.s().TickSeq, h.block+1, s1+900+45)[:7*32-1],
		"record count on v1": append(tickPayload(h.s().TickSeq, h.block+1, s1+900+45), words(1)...),
	} {
		if r := result(t, TrustedRequest(testApp, p, h.st)); r.Error != ErrTrusted {
			t.Errorf("%s: %q", name, r.Error)
		}
	}
	// A version-1 payload is a plain clock tick.
	if r := h.ok(result(t, TrustedRequest(testApp, tickPayload(h.s().TickSeq, h.block+1, s1+900+45), h.st))); len(r.AppEvents) != 1 || !bytes.Equal(r.AppEvents[0].Data[96:160], words(0, 0)) {
		t.Fatal("version 1 in the order build")
	}
}

func TestSweepAndArchive(t *testing.T) {
	resolved := opened1
	resolved.outcome, resolved.resolvedAt, resolved.closing = 1, s1+902, observed(s1+900, s1+902, "97000000000000000000001")
	// An account with a staged command is not swept; the tick that activates
	// its command sweeps it, in its own name, and the empty round is archived.
	h := newHarness(t, alice, bob)
	h.sync(keeper)
	k := h.s().TickSeq
	h.cmd(alice, engine.Command{Op: engine.CancelAll})
	if r := h.ok(h.tickN(k, s1+905, resolved)); len(r.AppEvents) != 1 {
		t.Fatalf("resolution: %d app events", len(r.AppEvents))
	}
	s := h.s()
	if a := account(s.Engine, bob); a.Nonce != 3 || a.Cash != 100_000_000 || a.LastReceipt.CommandID != engine.CommandID(bob, 3) || a.LastReceipt.Amount != 5_000_000 {
		t.Fatalf("bob swept: %+v", a)
	}
	if a := account(s.Engine, alice); a.Nonce != 2 || a.Cash != 95_000_000 {
		t.Fatalf("alice staged and swept: %+v", a)
	}
	r := h.ok(h.tick(s1 + 906))
	if a := account(h.s().Engine, alice); a.Nonce != 4 || a.Cash != 100_000_000 || len(r.AppEvents) != 2 {
		t.Fatalf("alice after her tick: %+v, %d app events", a, len(r.AppEvents))
	}
	var record engine.RoundArchive
	if !canonical(r.AppEvents[1].Data, &record) || record.Count != 1 || record.Round.ID != id1 || record.Round.Outcome != engine.Up || len(h.s().Engine.Rounds) != 1 {
		t.Fatalf("archive record: %s", r.AppEvents[1].Data)
	}
	if digest, err := engine.ArchiveDigest(record); err != nil || digest != record.Hash || h.s().Engine.ArchiveRoot != record.Hash {
		t.Fatalf("archive digest %s, record %s, root %s", digest, record.Hash, h.s().Engine.ArchiveRoot)
	}

	// MaxSweeps per tick: of 17 holders, the 17th by address is left, and
	// redeems for itself; the next tick archives the round.
	var holders []string
	for i := 1; i <= MaxSweeps+1; i++ {
		holders = append(holders, fmt.Sprintf("0x%040x", 0xb00+i))
	}
	h = newHarness(t, holders...)
	h.sync(keeper)
	h.ok(h.tick(s1+905, resolved))
	last := holders[MaxSweeps]
	for _, who := range holders {
		if a := account(h.s().Engine, who); (a.Cash == 100_000_000) != (who != last) {
			t.Fatalf("%s after the sweep: cash %d", who, a.Cash)
		}
	}
	if b := h.cmd(last, engine.Command{Op: engine.Redeem, RoundID: id1}); b.Status != "applied" || b.Receipt.Amount != 5_000_000 || b.View.Cash != 100_000_000 {
		t.Fatalf("the holder's own redeem: %+v", b)
	}
	if r := h.ok(h.tick(s1 + 906)); len(r.AppEvents) != 2 || r.AppEvents[1].EventSubType != ArchiveSubType {
		t.Fatalf("archive after the last redeem: %d app events", len(r.AppEvents))
	}

	// MaxArchives per tick: five unopened rounds voided at once.
	h = newHarness(t, alice)
	var five, voided []rec
	for k := uint64(2); k <= 6; k++ {
		five = append(five, rec{start: s1 + 900*k})
		voided = append(voided, rec{start: s1 + 900*k, resolvedAt: s1 + 900*k + 31, outcome: 3})
	}
	h.sync(keeper)
	h.ok(h.tick(s1+6, five...))
	h.sync(keeper)
	r = h.ok(h.tick(s1+900*6+100, voided...))
	if applied, _ := counts(r); applied != 5 || len(r.AppEvents) != 1+MaxArchives {
		t.Fatalf("five voids: applied %d, %d app events", applied, len(r.AppEvents))
	}
	h.sync(keeper)
	if r := h.ok(h.tick(s1 + 900*6 + 101)); len(r.AppEvents) != 2 {
		t.Fatalf("the fifth archive: %d app events", len(r.AppEvents))
	}
}

// An outcome goes back once, with the account's next accepted request of any
// kind; a request that fails in public collects nothing.
func TestOutcomeCollection(t *testing.T) {
	h := newHarness(t, alice, bob)
	h.cmd(alice, order(engine.Sell, 60, 1_000_000, engine.GTC))
	h.ok(h.tick(s1 + 6))
	before := h.st
	if r := result(t, ProcessRequest(testApp, raw(alice), requestTypeProcess, []byte(`{"version":1`), h.st)); r.Error != ErrEnvelope || !bytes.Equal(before, h.st) {
		t.Fatal(r.Error)
	}
	r := h.deposit(alice, 1_000_000)
	if b := body(t, r.Events[0]).Body; r.Error != "" || b.Type != "deposit" || b.Outcome == nil || b.Outcome.Receipt.OrderID != engine.CommandID(alice, 3) || len(h.s().Outcomes) != 0 {
		t.Fatalf("deposit receipt: %+v", b)
	}
	if b := h.sync(alice); b.Outcome != nil || b.View.Cash != 96_000_000 {
		t.Fatalf("second collection: %+v", b.Outcome)
	}
	// The view is the account's own; an unregistered sender has none.
	if b := h.sync(keeper); b.View != nil || b.Outcome != nil {
		t.Fatalf("keeper: %+v", b)
	}
	if v := h.sync(bob).View; v.Account != bob || len(v.Orders) != 0 || strings.Contains(string(marshal(v)), alice) {
		t.Fatalf("bob's view: %+v", v)
	}
}

// The script's full round, natively: what each account was told, and the
// ledger at the end. The conformance test runs the same steps in the wasm.
func TestFullRound(t *testing.T) {
	steps := run(t, script())
	for _, s := range steps[len(steps)-len(round()):] {
		if s.Error != "" {
			t.Fatalf("%s: %s", s.Name, s.Error)
		}
	}
	told := func(name string) receiptBody { return body(t, find(t, steps, name).Events[0]).Body }
	if o := told("alice collects the outcome of her order for an unknown round").Outcome; o.Status != "rejected" || o.Reason != "unknown round" || o.Receipt != nil {
		t.Fatalf("first outcome: %+v", o)
	}
	if applied, skipped := counts(Result{AppEvents: find(t, steps, "tick 13 opens round 1 and creates round 3").AppEvents}); applied != 2 || skipped != 0 {
		t.Fatalf("tick 13: applied %d, skipped %d", applied, skipped)
	}
	if b := told("alice collects her order's outcome and stages a cancel"); b.Outcome.Receipt.Status != "resting" || b.View.Orders[0].Filled != 400_000 || b.View.Orders[0].Remaining != 600_000 || b.View.Cash != 148_237_600 {
		t.Fatalf("alice, maker: %+v %+v", b.Outcome, b.View)
	}
	if b := told("bob collects his fill"); len(b.Outcome.Receipt.Fills) != 1 || b.Outcome.Receipt.Fills[0] != (engine.PrivateFill{OrderID: engine.CommandID(bob, 3), Role: "taker", Side: engine.Buy, RoundID: id1, Outcome: engine.Up, Price: 60, Quantity: 400_000, Fee: 2_400}) ||
		b.View.Cash != 9_757_600 || b.View.Holdings[0].Up != 400_000 {
		t.Fatalf("bob, taker: %+v %+v", b.Outcome, b.View)
	}
	settle := find(t, steps, "tick 21 resolves round 1, sweeps and archives it, opens round 2 and creates round 4")
	var record engine.RoundArchive
	if applied, skipped := counts(Result{AppEvents: settle.AppEvents}); applied != 3 || skipped != 0 || len(settle.AppEvents) != 2 || !canonical(settle.AppEvents[1].Data, &record) || record.Round.ID != id1 || record.Round.Outcome != engine.Up {
		t.Fatalf("tick 21: %d app events", len(settle.AppEvents))
	}
	if s := state(t, settle.after); status(s, id2) != "open" || len(s.Engine.Rounds) != 3 {
		t.Fatalf("rounds after tick 21: %+v", s.Engine.Rounds)
	}
	// The sweep redeemed in alice's name, so her stored receipt is no longer
	// the cancel's: the outcome comes back without it.
	if b := told("alice collects her cancel, whose receipt the sweep replaced"); b.Outcome.CommandID != engine.CommandID(alice, 5) || b.Outcome.Status != "applied" || b.Outcome.Receipt != nil || b.View.Nonce != 6 {
		t.Fatalf("alice's cancel: %+v %+v", b.Outcome, b.View)
	}
	e := state(t, steps[len(steps)-1].after).Engine
	if e.Fees != 4_800 || e.Custody != e.Fees+30 || e.PaidOut != 284_995_200 || e.Deposited != 285_000_030 || len(e.Orders) != 0 {
		t.Fatalf("final ledger: fees %d, custody %d, paid out %d, deposited %d", e.Fees, e.Custody, e.PaidOut, e.Deposited)
	}
}
