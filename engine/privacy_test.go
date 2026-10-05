package engine

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestAccountAndReceiptProjectionDoNotRevealCounterparty(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob, carol)
	h.mint(alice, AtomScale)
	maker := h.order(alice, Sell, 60, AtomScale, GTC)
	r := h.order(bob, Buy, 60, AtomScale, IOC)
	for _, who := range []string{alice, bob} {
		p, ok := ProjectReceipt(r, who)
		if !ok || len(p.Fills) != 1 {
			t.Fatal("missing private receipt")
		}
		b, _ := json.Marshal(p)
		other := alice
		if who == alice {
			other = bob
		}
		if strings.Contains(string(b), other) {
			t.Fatal("counterparty leaked")
		}
		if who == alice && (p.CommandID != "" || p.Fills[0].OrderID != maker.OrderID || p.Fills[0].Role != "maker") {
			t.Fatal("wrong maker projection")
		}
	}
	if _, ok := ProjectReceipt(r, carol); ok {
		t.Fatal("uninvolved receipt disclosed")
	}
	v, e := AccountView(h.s, bob)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(v)
	for _, forbidden := range []string{alice, carol, "lastReceipt", "journalHash", "lastDigest"} {
		if strings.Contains(string(b), forbidden) {
			t.Fatalf("account view leaked %s", forbidden)
		}
	}
	v.Holdings[0].Up = 0
	if h.account(bob).holding(h.round).Up != AtomScale {
		t.Fatal("view aliases state")
	}
}

func TestRetryReceiptDoesNotAliasOrExportTwice(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	r := h.must(Command{Op: RequestWithdrawal, Amount: AtomScale, Destination: bob}, alice, 0)
	c, x := h.command(Command{Op: ExportWithdrawal, WithdrawalID: r.WithdrawalID, Evidence: hash([]byte("export"))}, auth, 0)
	a, first, e := Apply(h.s, c, x)
	if e != nil {
		t.Fatal(e)
	}
	retry, again, e := Apply(a, c, x)
	if e != nil {
		t.Fatal(e)
	}
	if retry.Sequence != a.Sequence || retry.Custody != a.Custody || retry.Claimable != a.Claimable {
		t.Fatal("retry exported twice")
	}
	if first.PublicWithdrawal == nil || again.PublicWithdrawal == nil {
		t.Fatal("stable replay receipt absent")
	}
	again.PublicWithdrawal.Amount = 1
	if a.AuthorityReceipt.PublicWithdrawal.Amount != AtomScale {
		t.Fatal("replay receipt aliases input state")
	}
	first.PublicWithdrawal.Amount = 2
	if a.AuthorityReceipt.PublicWithdrawal.Amount != AtomScale {
		t.Fatal("new receipt aliases output state")
	}
	// The adapter must use unchanged sequence to suppress external side effects;
	// idempotent receipts deliberately retain the original export description.
}

func TestSellFeeCapRejectsImprovedPriceAtomically(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, AtomScale)
	h.order(bob, Buy, 90, AtomScale, GTC)
	h.reject(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Sell, Price: 50, Quantity: AtomScale, TIF: IOC, Expiry: 1795, MaxFee: 5000}, alice, 0)
	if len(h.s.Orders) != 1 || h.s.Orders[0].Remaining != AtomScale {
		t.Fatal("fee rejection partially filled")
	}
	r := h.order(alice, Sell, 50, AtomScale, IOC)
	if r.Fills[0].Price != 90 || r.Fills[0].SellerFee != 9000 {
		t.Fatal("wrong price improvement fee")
	}
}

func TestAuthenticatedObservationWindowsAndTimeouts(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	h.mint(alice, AtomScale)
	h.reject(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("1", 1811), Evidence: hash([]byte("late-feed"))}, auth, 1811)
	h.reject(Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}, auth, 88210)
	// Resolution has no deadline: six days after end, and after voidableAfter, the closing price still settles.
	h.must(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("1", 1810), Evidence: hash([]byte("close-window"))}, auth, 1800+6*86400)
	m, _ := h.s.round(h.round)
	if m.Outcome != Down || m.Closing.ObservationsTimestamp != 1810 {
		t.Fatal("wrong boundary result")
	}
	bad, _ := clone(h.s)
	bad.Rounds[0].Closing.ObservationsTimestamp = 1811
	if e := Validate(bad); e == nil {
		t.Fatal("invalid observation in restored state")
	}
	missing := newHarness(t)
	missing.must(Command{Op: Register}, alice, 1)
	spec, _ := NewRoundSpec(config(), "ETH", 300, 900)
	r := missing.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
	missing.reject(Command{Op: OpenRound, RoundID: r.RoundID, Observation: testObservation("3000000000000000000000", 911), Evidence: hash([]byte("late"))}, auth, 920)
	missing.reject(Command{Op: OpenRound, RoundID: r.RoundID, Observation: testObservation("3000000000000000000000", 910), Evidence: hash([]byte("good"))}, auth, 931)
	missing.reject(Command{Op: VoidRound, RoundID: r.RoundID, Evidence: hash([]byte("missing"))}, auth, 930)
	// A never-opened round keeps its slot until a recorded void is mirrored.
	missing.reject(Command{Op: ArchiveRound, RoundID: r.RoundID}, auth, 931)
	missing.must(Command{Op: VoidRound, RoundID: r.RoundID, Evidence: hash([]byte("missing"))}, auth, 931)
	missing.must(Command{Op: ArchiveRound, RoundID: r.RoundID}, auth, 0)
}

func TestRoundIDBindsAllRulesAndDeployment(t *testing.T) {
	c := config()
	r, _ := NewRoundSpec(c, "BTC", 900, 900)
	id := RoundID(c, r)
	c.Domain.ChainID++
	if id == RoundID(c, r) {
		t.Fatal("chain not bound")
	}
	c = config()
	c.FeeBps++
	if id == RoundID(c, r) {
		t.Fatal("fee not bound")
	}
	c = config()
	r.Start++
	if id == RoundID(c, r) {
		t.Fatal("round boundary not bound")
	}
}

func TestCancelAllOnlyReleasesOwnersReservations(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.order(alice, Buy, 40, AtomScale, GTC)
	h.order(alice, Buy, 39, AtomScale, GTC)
	b := h.order(bob, Buy, 30, AtomScale, GTC)
	h.must(Command{Op: CancelAll}, alice, 0)
	if len(h.s.Orders) != 1 || h.s.Orders[0].ID != b.OrderID || h.account(alice).ReservedCash != 0 {
		t.Fatal("cancel all corrupted book")
	}
}

func FuzzSnapshotDecoder(f *testing.F) {
	s, _ := New(config())
	b, _ := Encode(s)
	f.Add(b)
	f.Add([]byte(`{"version":1}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 32768 {
			return
		}
		s, e := Decode(data)
		if e == nil {
			b, e := Encode(s)
			if e != nil || !bytes.Equal(b, data) {
				t.Fatal("accepted noncanonical snapshot")
			}
		}
	})
}
