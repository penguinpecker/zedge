package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

const alice = "0x1111111111111111111111111111111111111111"
const bob = "0x2222222222222222222222222222222222222222"
const carol = "0x3333333333333333333333333333333333333333"
const auth = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func config() Config {
	c := Config{Domain: Domain{ChainID: 2651420, Endpoint: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ApplicationID: "zedge-test", RulesVersion: Version}, Authority: auth, Collateral: "0xcccccccccccccccccccccccccccccccccccccccc", FeeBps: 100,
		Oracle: RegistryConfig{ChainID: 2651420, Registry: "0xdddddddddddddddddddddddddddddddddddddddd", Oracle: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", BTCFeedID: BTCStreamsFeed, ETHFeedID: ETHStreamsFeed, Decimals: 18, ObservationWindow: 10, OpeningGrace: 20, VoidGrace: 86400, CutoffBuffer: 5}}
	c.Oracle.RulesHash, _ = RegistryRulesHash(c)
	return c
}

// Unsigned observations are deterministic test inputs, never authentication.
func testObservation(price string, at uint32) *StreamsObservation {
	return &StreamsObservation{FeedID: BTCStreamsFeed, Price: price, ValidFromTimestamp: at / 300 * 300, ObservationsTimestamp: at, ExpiresAt: at + 86400, ReportHash: "0x" + hash([]byte(fmt.Sprint(price, at))), Decimals: 18}
}

type harness struct {
	t     testing.TB
	s     *State
	round string
	event uint64
}

func newHarness(t testing.TB) *harness {
	t.Helper()
	s, e := New(config())
	if e != nil {
		t.Fatal(e)
	}
	return &harness{t: t, s: s}
}
func (h *harness) command(c Command, who string, at uint64) (Command, AuthenticatedContext) {
	h.t.Helper()
	sys := systemOp(c.Op)
	if sys {
		who = auth
		c.Nonce = h.s.AuthorityNonce + 1
	} else {
		c.Account = who
		a, e := h.s.account(who)
		if e != nil {
			c.Nonce = 1
		} else {
			c.Nonce = a.Nonce + 1
		}
	}
	c.Domain = h.s.Config.Domain
	c.ID = CommandID(who, c.Nonce)
	if at == 0 {
		at = h.s.Time
		if at == 0 {
			at = 1
		}
	}
	// Unless a test says otherwise, the registry included the mirrored event at
	// the moment the engine processes it.
	if (c.Op == OpenRound || c.Op == ResolveRound || c.Op == VoidRound) && c.RegistryTime == 0 {
		c.RegistryTime = at
	}
	return c, AuthenticatedContext{Domain: h.s.Config.Domain, Principal: who, Timestamp: at, System: sys}
}
func (h *harness) must(c Command, who string, at uint64) Receipt {
	h.t.Helper()
	c, x := h.command(c, who, at)
	s, r, e := Apply(h.s, c, x)
	if e != nil {
		h.t.Fatalf("%s: %v", c.Op, e)
	}
	h.s = s
	return r
}
func (h *harness) reject(c Command, who string, at uint64) {
	h.t.Helper()
	c, x := h.command(c, who, at)
	before, _ := Encode(h.s)
	if _, _, e := Apply(h.s, c, x); e == nil {
		h.t.Fatalf("expected rejection: %s", c.Op)
	}
	after, _ := Encode(h.s)
	if !bytes.Equal(before, after) {
		h.t.Fatal("rejected transition mutated source")
	}
}
func (h *harness) deposit(who string, n uint64) {
	h.t.Helper()
	h.event++
	h.must(Command{Op: Deposit, Account: who, Amount: n, Evidence: hash([]byte(fmt.Sprint(h.event)))}, auth, 0)
}
func (h *harness) setup(accounts ...string) {
	h.t.Helper()
	for _, a := range accounts {
		h.must(Command{Op: Register}, a, 1)
		h.deposit(a, 200*AtomScale)
	}
	spec, _ := NewRoundSpec(config(), "BTC", 900, 900)
	r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
	h.round = r.RoundID
	h.must(Command{Op: OpenRound, RoundID: h.round, Observation: testObservation("97000000000000000000000", 900), Evidence: hash([]byte("open"))}, auth, 900)
}
func (h *harness) mint(who string, q uint64) {
	h.must(Command{Op: Mint, RoundID: h.round, Quantity: q}, who, 0)
}
func (h *harness) order(who string, side Side, p, q uint64, tif TimeInForce) Receipt {
	return h.must(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: side, Price: p, Quantity: q, TIF: tif, Expiry: 1795, MaxFee: MaxAtoms}, who, 0)
}
func (h *harness) account(who string) *Account {
	h.t.Helper()
	a, e := h.s.account(who)
	if e != nil {
		h.t.Fatal(e)
	}
	return a
}

func TestCompleteSetAndPartialMakerPriceFill(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, 100*AtomScale)
	ask := h.order(alice, Sell, 60, 20*AtomScale, GTC)
	r := h.order(bob, Buy, 70, 10*AtomScale, IOC)
	if len(r.Fills) != 1 || r.Fills[0].Price != 60 || r.Fills[0].Quantity != 10*AtomScale {
		t.Fatalf("wrong fill %+v", r)
	}
	a := h.account(alice)
	b := h.account(bob)
	if b.Cash != 193_940000 || b.ReservedCash != 0 || a.Cash != 105_940000 {
		t.Fatalf("wrong cash %d %d", a.Cash, b.Cash)
	}
	o, _ := h.s.order(ask.OrderID)
	if o.Remaining != 10*AtomScale || h.s.Fees != 120000 {
		t.Fatal("wrong residual/fees")
	}
	if b.holding(h.round).Up != 10*AtomScale {
		t.Fatal("shares missing")
	}
	h.must(Command{Op: CancelOrder, OrderID: ask.OrderID}, alice, 0)
	if h.account(alice).holding(h.round).ReservedUp != 0 {
		t.Fatal("cancel did not release")
	}
}

func TestPriceTimePriorityAndPriceProtection(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob, carol)
	h.mint(alice, 5*AtomScale)
	h.mint(carol, 5*AtomScale)
	expensive := h.order(alice, Sell, 70, AtomScale, GTC)
	first := h.order(carol, Sell, 60, AtomScale, GTC)
	second := h.order(alice, Sell, 60, AtomScale, GTC)
	r := h.order(bob, Buy, 60, 3*AtomScale, IOC)
	if len(r.Fills) != 2 || r.Fills[0].MakerOrder != first.OrderID || r.Fills[1].MakerOrder != second.OrderID {
		t.Fatal("price-time failed")
	}
	if len(h.s.Orders) != 1 || h.s.Orders[0].ID != expensive.OrderID {
		t.Fatal("price limit violated")
	}
	if h.account(bob).ReservedCash != 0 {
		t.Fatal("IOC cash locked")
	}
}

func TestCumulativeFeeRoundingAcrossFragments(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob, carol)
	h.mint(alice, 3*Lot)
	bid := h.order(bob, Buy, 1, 3*Lot, GTC)
	for i := 0; i < 3; i++ {
		h.order(alice, Sell, 1, Lot, IOC)
	}
	b := h.account(bob)
	if b.Cash != 200*AtomScale-31 {
		t.Fatalf("buyer fee rounding: cash %d", b.Cash)
	}
	if h.s.Fees != 4 {
		t.Fatalf("fees %d", h.s.Fees)
	}
	if _, e := h.s.order(bid.OrderID); e == nil {
		t.Fatal("filled order retained")
	}
}

func TestSelfTradeCancelsIncomingOnly(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	h.mint(alice, AtomScale)
	ask := h.order(alice, Sell, 60, AtomScale, GTC)
	r := h.order(alice, Buy, 60, AtomScale, GTC)
	if r.Status != "self_trade_cancelled" || len(r.Fills) != 0 || len(h.s.Orders) != 1 || h.s.Orders[0].ID != ask.OrderID || h.account(alice).ReservedCash != 0 {
		t.Fatal("self trade policy failed")
	}
}

func TestExpiryCutoffAndRejectedTransitionAtomicity(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, AtomScale)
	h.order(alice, Sell, 50, AtomScale, GTC)
	h.order(bob, Buy, 40, AtomScale, GTC)
	h.reject(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Buy, Price: 50, Quantity: Lot, TIF: IOC, Expiry: 1795, MaxFee: 100}, bob, 1795)
	if len(h.s.Orders) != 2 {
		t.Fatal("failed request expired orders in input")
	}
	r := h.must(Command{Op: Checkpoint}, auth, 1795)
	if len(r.ReleasedOrders) != 2 || len(h.s.Orders) != 0 || h.account(bob).ReservedCash != 0 {
		t.Fatal("cutoff did not release reservations")
	}
	h.reject(Command{Op: Mint, RoundID: h.round, Quantity: Lot}, alice, 1795)
}

func TestResolutionTieUpAndRedemption(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, 10*AtomScale)
	h.order(alice, Sell, 60, 10*AtomScale, GTC)
	h.order(bob, Buy, 60, 10*AtomScale, IOC)
	h.must(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("97000000000000000000000", 1800), Evidence: hash([]byte("close"))}, auth, 1800)
	r := h.must(Command{Op: Redeem, RoundID: h.round}, bob, 0)
	if r.Amount != 10*AtomScale {
		t.Fatal("winner payout incorrect")
	}
	r = h.must(Command{Op: Redeem, RoundID: h.round}, alice, 0)
	if r.Amount != 0 {
		t.Fatal("loser payout nonzero")
	}
	m, _ := h.s.round(h.round)
	if m.Locked != 0 || m.UpSupply != 0 || m.DownSupply != 0 {
		t.Fatal("collateral not emptied")
	}
	h.reject(Command{Op: Redeem, RoundID: h.round}, bob, 0)
	h.reject(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}, auth, 88211)
}

func TestVoidHalfPayoutAndMerge(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, 2*AtomScale)
	h.must(Command{Op: Merge, RoundID: h.round, Quantity: AtomScale}, alice, 0)
	h.order(alice, Sell, 60, AtomScale, GTC)
	h.order(bob, Buy, 60, AtomScale, IOC)
	h.reject(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}, auth, 88210)
	h.must(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}, auth, 88211)
	for _, who := range []string{alice, bob} {
		r := h.must(Command{Op: Redeem, RoundID: h.round}, who, 0)
		if r.Amount != AtomScale/2 {
			t.Fatal("void not half")
		}
	}
}

// A funded pair pays exactly one collateral unit in every round state (the
// vault's rule). Reserved shares stay locked, minting still stops at cutoff and
// merging before redeeming never changes what a settled round pays in total.
func TestMergeCompletePairAtAnyTime(t *testing.T) {
	for _, settle := range []Operation{ResolveRound, VoidRound} {
		h := newHarness(t)
		h.setup(alice, bob)
		merge := func(q, at uint64) Receipt {
			return h.must(Command{Op: Merge, RoundID: h.round, Quantity: q}, alice, at)
		}
		next, _ := NewRoundSpec(h.s.Config, "BTC", 900, 1800)
		scheduled := h.must(Command{Op: CreateRound, Round: &next}, auth, 0).RoundID
		h.reject(Command{Op: Merge, RoundID: scheduled, Quantity: Lot}, alice, 0)
		h.mint(alice, 10*AtomScale)
		h.order(alice, Sell, 60, 4*AtomScale, GTC)
		h.order(bob, Buy, 60, 2*AtomScale, IOC)
		h.reject(Command{Op: Merge, RoundID: h.round, Quantity: 7 * AtomScale}, alice, 0)
		merge(AtomScale, 0)
		h.reject(Command{Op: Mint, RoundID: h.round, Quantity: Lot}, alice, 1795)
		if r := merge(AtomScale, 1795); len(r.ReleasedOrders) != 1 || h.account(alice).holding(h.round).ReservedUp != 0 {
			t.Fatal("cutoff sweep did not release the resting sell before the merge")
		}
		merge(AtomScale, 1800)
		if settle == VoidRound {
			h.must(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}, auth, 88211)
		} else {
			h.must(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("1", 1800), Evidence: hash([]byte("close"))}, auth, 1800)
		}
		direct := *h
		direct.must(Command{Op: Redeem, RoundID: h.round}, alice, 0)
		h.reject(Command{Op: Merge, RoundID: h.round, Quantity: 6 * AtomScale}, alice, 0)
		if merge(2*AtomScale, 0).Amount != 2*AtomScale {
			t.Fatal("settled pair did not pay one unit")
		}
		h.must(Command{Op: Redeem, RoundID: h.round}, alice, 0)
		if got, want := h.account(alice).Cash, direct.account(alice).Cash; got != want {
			t.Fatalf("%s: merge then redeem paid %d, redeem alone %d", settle, got, want)
		}
		h.must(Command{Op: Redeem, RoundID: h.round}, bob, 0)
		if m, _ := h.s.round(h.round); m.Locked != 0 || m.UpSupply != 0 || m.DownSupply != 0 {
			t.Fatal("collateral not emptied")
		}
		h.must(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
	}
}

func TestWithdrawalTwoPhaseAndClaimConservation(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	r := h.must(Command{Op: RequestWithdrawal, Amount: 20 * AtomScale, Destination: bob}, alice, 0)
	if h.s.Custody != 200*AtomScale || h.s.Claimable != 0 {
		t.Fatal("intent prematurely exported")
	}
	h.must(Command{Op: CancelWithdrawal, WithdrawalID: r.WithdrawalID}, alice, 0)
	r = h.must(Command{Op: RequestWithdrawal, Amount: 20 * AtomScale, Destination: bob}, alice, 0)
	x := h.must(Command{Op: ExportWithdrawal, WithdrawalID: r.WithdrawalID, Evidence: hash([]byte("export"))}, auth, 0)
	if x.PublicWithdrawal == nil || x.PublicWithdrawal.Destination != bob || h.s.Custody != 180*AtomScale || h.s.Claimable != 20*AtomScale {
		t.Fatal("wrong export")
	}
	h.reject(Command{Op: CancelWithdrawal, WithdrawalID: r.WithdrawalID}, alice, 0)
	h.must(Command{Op: ConfirmClaim, WithdrawalID: r.WithdrawalID, Evidence: hash([]byte("claim"))}, auth, 0)
	if h.s.PaidOut != 20*AtomScale || h.s.Claimable != 0 || h.account(alice).Cash != 180*AtomScale {
		t.Fatal("claim double-debited")
	}
	h.reject(Command{Op: ConfirmClaim, WithdrawalID: r.WithdrawalID, Evidence: hash([]byte("claim2"))}, auth, 0)
}

func TestReplayAndEvidenceRejection(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	c, x := h.command(Command{Op: Mint, RoundID: h.round, Quantity: Lot}, alice, 0)
	s, r, e := Apply(h.s, c, x)
	if e != nil {
		t.Fatal(e)
	}
	again, rr, e := Apply(s, c, x)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := Encode(s)
	bb, _ := Encode(again)
	j, _ := json.Marshal(r)
	jj, _ := json.Marshal(rr)
	if !bytes.Equal(b, bb) || !bytes.Equal(j, jj) {
		t.Fatal("retry not idempotent")
	}
	c.Quantity = 2 * Lot
	if _, _, e = Apply(s, c, x); e == nil {
		t.Fatal("conflicting nonce accepted")
	}
	h.s = s
	h.reject(Command{Op: Deposit, Account: alice, Amount: 1, Evidence: hash([]byte("1"))}, auth, 0)
}

func TestAuthorizationAndCanonicalCodec(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	c, x := h.command(Command{Op: Mint, RoundID: h.round, Quantity: Lot}, alice, 0)
	x.Domain.ChainID++
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("wrong domain accepted")
	}
	x.Domain = c.Domain
	x.Principal = bob
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("wrong principal accepted")
	}
	x.Principal = alice
	x.Timestamp = 899
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("stale clock accepted")
	}
	c.Op = Deposit
	c.Amount = 10
	c.Evidence = hash([]byte("evil"))
	c.RoundID = ""
	c.Quantity = 0
	x.Timestamp = 900
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("user deposit accepted")
	}
	b, _ := Encode(h.s)
	decoded, e := Decode(b)
	if e != nil {
		t.Fatal(e)
	}
	again, _ := Encode(decoded)
	if !bytes.Equal(b, again) {
		t.Fatal("non-deterministic encoding")
	}
	if _, e = Decode(append([]byte(" "), b...)); e == nil {
		t.Fatal("noncanonical snapshot accepted")
	}
	bad := append([]byte(`{"version":1,`), b[1:]...)
	if _, e = Decode(bad); e == nil {
		t.Fatal("duplicate key accepted")
	}
	cmd, _ := json.Marshal(c)
	cmd = append(cmd[:len(cmd)-1], []byte(`,"timestamp":900}`)...)
	if _, e = DecodeCommand(cmd); e == nil {
		t.Fatal("user clock field accepted")
	}
}

func TestOverflowBoundsAndTamperedState(t *testing.T) {
	h := newHarness(t)
	h.must(Command{Op: Register}, alice, 1)
	h.deposit(alice, MaxAtoms)
	h.reject(Command{Op: Deposit, Account: alice, Amount: 1, Evidence: hash([]byte("overflow"))}, auth, 0)
	h.reject(Command{Op: RequestWithdrawal, Amount: ^uint64(0), Destination: bob}, alice, 0)
	bad, _ := clone(h.s)
	bad.Accounts[0].Cash++
	if e := Validate(bad); e == nil {
		t.Fatal("unbacked account accepted")
	}
	bad, _ = clone(h.s)
	bad.Custody = ^uint64(0)
	if e := Validate(bad); e == nil {
		t.Fatal("overflow accepted")
	}
}

func TestMatchingWorkBoundIsAtomic(t *testing.T) {
	h := newHarness(t)
	h.setup(bob)
	for i := 0; i < 65; i++ {
		who := fmt.Sprintf("0x%040x", i+256)
		h.must(Command{Op: Register}, who, 0)
		h.deposit(who, AtomScale)
		h.mint(who, Lot)
		h.order(who, Sell, 50, Lot, GTC)
	}
	h.reject(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Buy, Price: 50, Quantity: 65 * Lot, TIF: IOC, Expiry: 1795, MaxFee: MaxAtoms}, bob, 0)
	if len(h.s.Orders) != 65 {
		t.Fatal("partial match committed on work limit")
	}
}

func FuzzCommandSequences(f *testing.F) {
	f.Add([]byte{1, 2, 4, 3, 7, 9, 0, 2, 4, 2, 8}, false)
	f.Add([]byte{255, 255, 0, 1, 3, 5, 8}, false)
	// The same sequences on an operator-resolved event with the price round's times.
	f.Add([]byte{1, 2, 4, 3, 7, 9, 0, 2, 4, 2, 8}, true)
	f.Add([]byte{255, 255, 0, 1, 3, 5, 8}, true)
	f.Add([]byte{2, 3, 9, 10, 4, 1}, true)
	f.Fuzz(func(t *testing.T, data []byte, event bool) {
		if len(data) > 128 {
			data = data[:128]
		}
		h := newHarness(t)
		h.setup(alice, bob, carol)
		if event {
			spec, _ := NewEventSpec(config(), question, 900, 1795, 1796, 88210)
			h.round = h.must(Command{Op: CreateRound, Round: &spec}, auth, 0).RoundID
		}
		for _, who := range []string{alice, bob, carol} {
			h.mint(who, 20*AtomScale)
		}
		for i, v := range data {
			who := []string{alice, bob, carol}[int(v)%3]
			q := (uint64(v)%10 + 1) * Lot
			c := Command{Op: Mint, RoundID: h.round, Quantity: q}
			switch v % 7 {
			case 1:
				c.Op = Merge
			case 2, 3:
				c = Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Buy, Price: uint64(v)%99 + 1, Quantity: q, TIF: GTC, Expiry: 1795, MaxFee: MaxAtoms}
				if v%7 == 3 {
					c.Side = Sell
				}
				if v%2 == 0 {
					c.Outcome = Down
				}
			case 4:
				if len(h.s.Orders) > 0 {
					c = Command{Op: CancelOrder, OrderID: h.s.Orders[int(v)%len(h.s.Orders)].ID}
				}
			case 5:
				c = Command{Op: RequestWithdrawal, Amount: q, Destination: who}
			case 6:
				if len(h.s.Withdrawals) > 0 {
					c = Command{Op: CancelWithdrawal, WithdrawalID: h.s.Withdrawals[0].ID}
				}
			}
			c, x := h.command(c, who, 900+uint64(i))
			before, _ := Encode(h.s)
			a, ra, ea := Apply(h.s, c, x)
			b, rb, eb := Apply(h.s, c, x)
			after, _ := Encode(h.s)
			if !bytes.Equal(before, after) {
				t.Fatal("Apply mutated source")
			}
			if (ea == nil) != (eb == nil) {
				t.Fatal("non-deterministic rejection")
			}
			if ea == nil {
				ab, _ := Encode(a)
				bb, _ := Encode(b)
				ar, _ := json.Marshal(ra)
				br, _ := json.Marshal(rb)
				if !bytes.Equal(ab, bb) || !bytes.Equal(ar, br) {
					t.Fatal("non-deterministic transition")
				}
				if e := Validate(a); e != nil {
					t.Fatal(e)
				}
				h.s = a
			}
		}
		mode := byte(0)
		if len(data) > 0 {
			mode = data[0] % 3
		}
		if mode == 2 {
			h.must(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("fuzz-void"))}, auth, 88211)
		} else if event {
			outcome := Down
			if mode == 1 {
				outcome = Up
			}
			h.must(Command{Op: ResolveRound, RoundID: h.round, Outcome: outcome, Evidence: hash([]byte("fuzz-result"))}, auth, 1800)
		} else {
			price := "1"
			if mode == 1 {
				price = "97000000000000000000000"
			}
			h.must(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation(price, 1800), Evidence: hash([]byte("fuzz-close"))}, auth, 1800)
		}
		for i, who := range []string{alice, bob, carol} {
			// Merging the paired part after settlement must leave nothing behind either.
			held := *h.account(who).holding(h.round)
			if pair := min(held.Up, held.Down); pair > 0 && len(data) > i && data[i]&1 == 1 {
				h.must(Command{Op: Merge, RoundID: h.round, Quantity: pair}, who, 0)
				held.Up, held.Down = held.Up-pair, held.Down-pair
			}
			if held.Up+held.Down > 0 {
				h.must(Command{Op: Redeem, RoundID: h.round}, who, 0)
			}
		}
		m, _ := h.s.round(h.round)
		if m.Locked != 0 || m.UpSupply != 0 || m.DownSupply != 0 {
			t.Fatal("portfolio settlement left unredeemed supply")
		}
	})
}
