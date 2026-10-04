package engine

import (
	"bytes"
	"testing"
)

func TestArchiveRequiresAllEntitlementsRedeemed(t *testing.T) {
	h := newHarness(t)
	h.setup(alice, bob)
	h.mint(alice, AtomScale)
	h.reject(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
	h.must(Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("1", 1800), Evidence: hash([]byte("close"))}, auth, 1800)
	h.reject(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
	h.must(Command{Op: Redeem, RoundID: h.round}, alice, 0)
	custody, fees := h.s.Custody, h.s.Fees
	r := h.must(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
	if r.Archive == nil || len(h.s.Rounds) != 0 || h.s.ArchivedRounds != 1 || h.s.Custody != custody || h.s.Fees != fees {
		t.Fatal("archive changed money or missed record")
	}
	for _, a := range h.s.Accounts {
		if len(a.Holdings) != 0 {
			t.Fatal("drained holding not pruned")
		}
	}
	digest, err := ArchiveDigest(*r.Archive)
	if err != nil || digest != r.Archive.Hash || digest != h.s.ArchiveRoot {
		t.Fatal("archive digest not committed")
	}
	r.Archive.Round.Opening.Price = "99"
	if h.s.AuthorityReceipt.Archive.Round.Opening.Price == "99" {
		t.Fatal("returned archive aliases state")
	}
	h.reject(Command{Op: Redeem, RoundID: h.round}, alice, 0)
	h.reject(Command{Op: ArchiveRound, RoundID: h.round}, auth, 0)
}

func TestArchiveCapacityReuseAndPastRoundReplay(t *testing.T) {
	h := newHarness(t)
	var first RoundSpec
	previous := h.s.ArchiveRoot
	for i := 0; i < MaxRounds+2; i++ {
		start := uint64(900 + i*900)
		spec, _ := NewRoundSpec(h.s.Config, "BTC", 300, start)
		if i == 0 {
			first = spec
		}
		r := h.must(Command{Op: CreateRound, Round: &spec}, auth, start-1)
		h.must(Command{Op: VoidRound, RoundID: r.RoundID, Evidence: hash([]byte(r.RoundID))}, auth, spec.OpeningDeadline+1)
		a := h.must(Command{Op: ArchiveRound, RoundID: r.RoundID}, auth, 0)
		if a.Archive.PreviousRoot != previous || a.Archive.Count != uint64(i+1) {
			t.Fatal("archive sequence skipped")
		}
		previous = a.Archive.Hash
	}
	if h.s.ArchivedRounds != MaxRounds+2 || len(h.s.Rounds) != 0 {
		t.Fatal("lifetime round capacity remains")
	}
	h.reject(Command{Op: CreateRound, Round: &first}, auth, 0)
	encoded, err := Encode(h.s)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := Decode(encoded)
	if err != nil || restored.ArchiveRoot != previous {
		t.Fatal("archive root lost on restart")
	}
}

func TestArchiveRetryDoesNotAdvanceCommitment(t *testing.T) {
	h := newHarness(t)
	spec, _ := NewRoundSpec(h.s.Config, "ETH", 300, 900)
	r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
	h.must(Command{Op: VoidRound, RoundID: r.RoundID, Evidence: hash([]byte("void"))}, auth, 931)
	c, x := h.command(Command{Op: ArchiveRound, RoundID: r.RoundID}, auth, 0)
	n, receipt, err := Apply(h.s, c, x)
	if err != nil {
		t.Fatal(err)
	}
	retry, again, err := Apply(n, c, x)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := Encode(n)
	b, _ := Encode(retry)
	if !bytes.Equal(a, b) || receipt.Archive.Hash != again.Archive.Hash {
		t.Fatal("retry archived twice")
	}
	bad := *again.Archive
	bad.Round.Spec.Feed = BTCStreamsFeed
	if digest, _ := ArchiveDigest(bad); digest == again.Archive.Hash {
		t.Fatal("archive history tampering not committed")
	}
}
