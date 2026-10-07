package guest

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/penguinpecker/zedge/engine"
)

// The guest's own check of Chainlink reports (README section 12), first on
// every report the keeper recorded from Solana, against what an independent
// implementation read from each (testdata/chainlink.json).
func TestChainlinkKnownAnswers(t *testing.T) {
	c := testChainlink()
	for i, v := range chainlinkFile.Reports {
		o, reason := c.verify(raw(v.Report))
		if v.FeedID != engine.BTCStreamsFeed {
			if reason != "report: not the pinned feed" {
				t.Errorf("report %d of another feed: %q", i, reason)
			}
			continue
		}
		want := engine.StreamsObservation{FeedID: v.FeedID, Price: v.Price, ValidFromTimestamp: v.ValidFromTimestamp, ObservationsTimestamp: v.ObservationsTimestamp, ExpiresAt: v.ExpiresAt, ReportHash: v.ReportHash, Decimals: 18}
		if reason != "" || o != want {
			t.Fatalf("report %d: %q %+v", i, reason, o)
		}
		// Each signer the independent implementation recovered is one the
		// guest needs: without it pinned, the report fails.
		for _, signer := range v.Signers {
			d := testChainlink()
			d.Configs[0].Signers = slices.DeleteFunc(d.Configs[0].Signers, func(s string) bool { return s == signer })
			if _, reason := d.verify(raw(v.Report)); reason != "report: not signed by the pinned signers" {
				t.Fatalf("report %d without %s pinned: %q", i, signer, reason)
			}
		}
	}
	if len(chainlinkFile.Reports) != 11 {
		t.Fatalf("%d recorded reports", len(chainlinkFile.Reports))
	}
}

// Every way a recorded report can be altered is refused.
func TestChainlinkReportsRejected(t *testing.T) {
	c := testChainlink()
	good := raw(chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report)
	edit := func(f func(p []byte) []byte) []byte { return f(slices.Clone(good)) }
	flip := func(at int) []byte { return edit(func(p []byte) []byte { p[at] ^= 1; return p }) }
	const blob, rs, ss = 0xe0 + 32, 0x220 + 32, 0x300 + 32
	for name, x := range map[string]struct {
		report []byte
		want   string
	}{
		"empty":                   {nil, "report: malformed"},
		"one byte short":          {good[:len(good)-1], "report: malformed"},
		"one byte long":           {append(slices.Clone(good), 0), "report: malformed"},
		"unknown digest":          {flip(31), "report: unknown config digest"},
		"another blob offset":     {flip(3*32 + 31), "report: malformed"},
		"another signature count": {flip(0x220 + 31), "report: malformed"},
		"a price changed":         {flip(blob + 200), "report: not signed by the pinned signers"},
		"the context changed":     {flip(32 + 31), "report: not signed by the pinned signers"},
		"a signature changed":     {flip(ss + 31), "report: not signed by the pinned signers"},
		"a recovery byte of 2":    {edit(func(p []byte) []byte { p[6*32] = 2; return p }), "report: bad signature"},
		// 4 would recover the same key in a compact signature; ecrecover refuses it.
		"a recovery byte of 4": {edit(func(p []byte) []byte { p[6*32] += 4; return p }), "report: bad signature"},
		"a zero r":             {edit(func(p []byte) []byte { copy(p[rs:rs+32], make([]byte, 32)); return p }), "report: bad signature"},
		"one signer twice": {edit(func(p []byte) []byte {
			copy(p[rs+32:rs+64], p[rs:rs+32])
			copy(p[ss+32:ss+64], p[ss:ss+32])
			p[6*32+1] = p[6*32]
			return p
		}), "report: not signed by the pinned signers"},
		// Five signatures where the config needs f+1 = 6: re-encoded strictly,
		// so only the count is wrong.
		"five signatures": {func() []byte {
			p := append(slices.Clone(good[:0x220]), words(5)...)
			p = append(append(p, good[rs:rs+5*32]...), words(5)...)
			p = append(p, good[ss:ss+5*32]...)
			binary.BigEndian.PutUint64(p[5*32+24:], 0x220+32+5*32)
			return p
		}(), "report: malformed"},
	} {
		if _, reason := c.verify(x.report); reason != x.want {
			t.Errorf("%s: %q, want %q", name, reason, x.want)
		}
	}
	// A second pinned digest (the newer DON configuration on Base) does not
	// change what the first accepts.
	two := testChainlink()
	two.Configs = append(two.Configs, DONConfig{Digest: "0x00097e7edb2c4d5a5787110573f962512c3ce37b1e7458b7cb18e9ada581cb69", F: 5, Signers: slices.Clone(two.Configs[0].Signers)})
	if _, reason := two.verify(good); reason != "" {
		t.Fatalf("with two digests pinned: %q", reason)
	}
}

// testDON signs reports with keys derived from public labels, so that the
// checks on the blob can be reached with valid signatures. Test-only keys.
type testDON struct {
	digest string
	keys   []*secp256k1.PrivateKey
}

func newTestDON(n int) testDON {
	d := testDON{digest: "0x0009" + sha("zedge-test-don")[4:]}
	for i := 0; i < n; i++ {
		k := secp256k1.PrivKeyFromBytes(keccak([]byte(fmt.Sprint("zedge-test-don-signer:", i))))
		d.keys = append(d.keys, k)
	}
	return d
}

func (d testDON) config(f uint64) Chainlink {
	c := DONConfig{Digest: d.digest, F: f}
	for _, k := range d.keys {
		c.Signers = append(c.Signers, "0x"+hex.EncodeToString(keccak(k.PubKey().SerializeUncompressed()[1:])[12:]))
	}
	return Chainlink{FeedID: engine.BTCStreamsFeed, Configs: []DONConfig{c}}
}

// sign builds the full report for a v3 blob with signatures by the first
// f+1 keys.
func (d testDON) sign(f int, feed string, validFrom, at, expires uint64, price *big.Int) []byte {
	blob := append(raw(feed), words(validFrom, at, 0, 0, expires)...)
	p := make([]byte, 32)
	if price.Sign() < 0 { // int192 sign-extended to 256 bits
		new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 256), price).FillBytes(p)
	} else {
		price.FillBytes(p)
	}
	blob = append(append(blob, p...), make([]byte, 64)...)
	ctx := append(raw(d.digest), make([]byte, 64)...)
	h := keccak(append(keccak(blob), ctx...))
	n := f + 1
	vs := make([]byte, 32)
	var r, s []byte
	for i := 0; i < n; i++ {
		sig := ecdsa.SignCompact(d.keys[i], h, false)
		vs[i] = sig[0] - 27
		r, s = append(r, sig[1:33]...), append(s, sig[33:]...)
	}
	out := append(ctx, words(0xe0, 0x220, uint64(0x220+32+32*n))...)
	out = append(append(append(out, vs...), words(uint64(len(blob)))...), blob...)
	out = append(append(append(out, words(uint64(n))...), r...), words(uint64(n))...)
	return append(out, s...)
}

func TestChainlinkBlobRules(t *testing.T) {
	d := newTestDON(4)
	c := d.config(1)
	at := b1
	good := d.sign(1, engine.BTCStreamsFeed, at, at, at+86400, big.NewInt(85_000))
	if o, reason := c.verify(good); reason != "" || o.Price != "85000" || o.ObservationsTimestamp != uint32(at) {
		t.Fatalf("the test DON's report: %q %+v", reason, o)
	}
	top := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 191), big.NewInt(1)) // the largest int192
	if o, reason := c.verify(d.sign(1, engine.BTCStreamsFeed, at, at, at, top)); reason != "" || o.Price != engine.MaxOraclePrice {
		t.Fatalf("the largest price: %q %s", reason, o.Price)
	}
	for name, c2 := range map[string]struct {
		report []byte
		want   string
	}{
		"zero price":               {d.sign(1, engine.BTCStreamsFeed, at, at, at+1, big.NewInt(0)), "report: invalid observation"},
		"negative price":           {d.sign(1, engine.BTCStreamsFeed, at, at, at+1, big.NewInt(-1)), "report: invalid observation"},
		"price past int192":        {d.sign(1, engine.BTCStreamsFeed, at, at, at+1, new(big.Int).Lsh(big.NewInt(1), 191)), "report: invalid observation"},
		"valid from after":         {d.sign(1, engine.BTCStreamsFeed, at+1, at, at+1, big.NewInt(1)), "report: invalid observation"},
		"expired before":           {d.sign(1, engine.BTCStreamsFeed, at, at, at-1, big.NewInt(1)), "report: invalid observation"},
		"a time past 32 bits":      {d.sign(1, engine.BTCStreamsFeed, at, at, MaxClock+1, big.NewInt(1)), "report: invalid observation"},
		"the ETH feed":             {d.sign(1, engine.ETHStreamsFeed, at, at, at+1, big.NewInt(1)), "report: not the pinned feed"},
		"three signatures for f=2": {d.sign(1, engine.BTCStreamsFeed, at, at, at+1, big.NewInt(1)), "report: malformed"},
	} {
		cfg := c
		if strings.HasPrefix(name, "three") {
			cfg = d.config(1)
			cfg.Configs[0].F = 2
			cfg.Configs[0].Signers = append(cfg.Configs[0].Signers, "0x"+strings.Repeat("7", 40), "0x"+strings.Repeat("8", 40), "0x"+strings.Repeat("9", 40))
		}
		if _, reason := cfg.verify(c2.report); reason != c2.want {
			t.Errorf("%s: %q, want %q", name, reason, c2.want)
		}
	}
	// An f+1 quorum of any pinned signers counts, not only the first ones.
	other := testDON{digest: d.digest, keys: []*secp256k1.PrivateKey{d.keys[3], d.keys[2]}}
	if _, reason := c.verify(other.sign(1, engine.BTCStreamsFeed, at, at, at+1, big.NewInt(1))); reason != "" {
		t.Fatalf("another quorum: %q", reason)
	}
}

// settleWords is a settle record's data.
func settleWords(id string, kind, outcome uint64, o *engine.StreamsObservation, source uint64) []byte {
	price, at, hash := make([]byte, 32), uint64(0), make([]byte, 32)
	if o != nil {
		p, _ := new(big.Int).SetString(o.Price, 10)
		p.FillBytes(price)
		at, hash = uint64(o.ObservationsTimestamp), raw(o.ReportHash)
	}
	data := append(append(append(raw(id), words(kind, outcome)...), price...), words(at)...)
	return append(append(data, hash...), words(source)...)
}

func registryID(start uint64) string { return mustSpec(start).RegistryRoundID }

// The script's report scenario, natively: one report resolves round 0, pays
// both holders and opens round 1 in one transition; copies, other seconds,
// other feeds and altered reports are refused in private; the registry's own
// record of round 0 is compared and agrees.
func TestReportScenario(t *testing.T) {
	steps := run(t, script())
	close1 := reportObservation(chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0))
	told := func(name string) (receiptBody, *step) {
		s := find(t, steps, name)
		if s.Error != "" || len(s.Events) != 1 {
			t.Fatalf("%s: %q", name, s.Error)
		}
		return body(t, s.Events[0]).Body, s
	}
	b, s := told("reports: alice's report for b1 resolves round 0, pays the winners and opens round 1")
	id0 := engine.RoundID(deployed(), mustSpec(b0))
	if b.Type != "report" || b.Status != "applied" || b.Tick != 0 || len(s.AppEvents) != 3 ||
		!bytes.Equal(s.AppEvents[0].Data, settleWords(registryID(b0), settleResolve, 1, close1, sourceReport)) ||
		!bytes.Equal(s.AppEvents[1].Data, settleWords(registryID(b1), settleOpen, 0, close1, sourceReport)) || s.AppEvents[2].EventSubType != ArchiveSubType {
		t.Fatalf("the report's effects: %+v %d app events", b, len(s.AppEvents))
	}
	after, before := state(t, s.after), state(t, s.before)
	fee := uint64(22_000) // 1% of 4 shares at 0.55
	if after.Clock != b1 || after.TickSeq != before.TickSeq || after.LastTick != before.LastTick || status(after, id0) != "absent" ||
		status(after, engine.RoundID(deployed(), mustSpec(b1))) != "open" || status(after, engine.RoundID(deployed(), mustSpec(b1+1800))) != "scheduled" {
		t.Fatalf("after the report: clock %d, rounds %+v", after.Clock, after.Engine.Rounds)
	}
	// The winners are paid in the same transition: bob's four Up shares and
	// the house's sixteen; the house's Down shares are worth nothing.
	if a := account(after.Engine, bob); a.Cash != 100_000_000-2_200_000-fee+4_000_000 || len(a.Holdings) != 0 || a.Nonce != 3 {
		t.Fatalf("bob after the report: %+v", a)
	}
	if a := account(after.Engine, house); a.Cash != 1_000_000_000-20_000_000+2_200_000-fee+16_000_000 || len(a.Holdings) != 0 {
		t.Fatalf("the house after the report: %+v", a)
	}
	if !slices.Equal(after.Unconfirmed, []Unconfirmed{{registryID(b0), observed(b0, b0+3, pr0).ReportHash, close1.ReportHash, 1}, {registryID(b1), close1.ReportHash, "", 0}}) {
		t.Fatalf("unconfirmed: %+v", after.Unconfirmed)
	}
	for name, reason := range map[string]string{
		"reports: the other copy of that report is already applied":   "report: already applied",
		"reports: a report for a second past the boundary is refused": "report: not a boundary report",
		"reports: a report of another feed is refused":                "report: not the pinned feed",
		"reports: a report with a changed price is refused":           "report: not signed by the pinned signers",
	} {
		b, s := told(name)
		if b.Status != "rejected" || b.Reason != reason || s.AppEvents != nil || !bytes.Equal(marshal(state(t, s.after).Engine), marshal(state(t, s.before).Engine)) {
			t.Errorf("%s: %+v", name, b)
		}
	}
	// A withdrawal of the winnings is a payout record.
	_, s = told("reports: bob withdraws one token to Base")
	if len(s.AppEvents) != 2 || !bytes.Equal(s.AppEvents[1].Data, append(append(append(words(testApp, 1, payoutWithdrawal), addressWord(bob)...), addressWord(bob)...), words(1_000_000)...)) {
		t.Fatalf("bob's payout: %+v", s.AppEvents)
	}
	if s := find(t, steps, "reports: tick 7 waits at a gap in the deposit indexes"); len(s.AppEvents) != 1 || state(t, s.after).DepositsSeen != 3 {
		t.Fatalf("the gap: %d app events", len(s.AppEvents))
	}
	s = find(t, steps, "reports: tick 8 skips a repeated deposit, credits two and confirms round 0")
	var subtypes [][32]byte
	for _, e := range s.AppEvents {
		subtypes = append(subtypes, e.EventSubType)
	}
	confirm := append(append(raw(registryID(b0)), words(confirmAgree, 1, 1)...), append(raw(close1.ReportHash), raw(close1.ReportHash)...)...)
	if !slices.Equal(subtypes, [][32]byte{ClockSubType, CreditSubType, CreditSubType, ConfirmSubType}) || !bytes.Equal(s.AppEvents[3].Data, confirm) ||
		!bytes.Equal(s.AppEvents[0].Data[96:192], words(0, 1, 2)) {
		t.Fatalf("tick 8: %d app events", len(s.AppEvents))
	}
	if a := state(t, s.after); a.DepositsSeen != 5 || account(a.Engine, alice).Cash != 106_000_000 || len(a.Unconfirmed) != 1 || a.Unconfirmed[0].Round != registryID(b1) {
		t.Fatalf("after tick 8: %+v", a.Unconfirmed)
	}
}

// A report that arrives after a tick moved the clock past its boundary still
// settles at the boundary: the clock stays where it is, and the round's
// times are the report's.
func TestReportAfterTheClock(t *testing.T) {
	steps := run(t, script())
	h := &harness{t: t, st: find(t, steps, "reports: tick 5 fills bob against the house").after, block: 5000}
	h.sync(keeper)
	h.ok(h.tick(b1 + 20))
	b := h.send(keeper, reportPayload(keeper, chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report, uint32(b1)))
	if s := h.s(); b.Status != "applied" || s.Clock != b1+20 || status(s, engine.RoundID(deployed(), mustSpec(b1))) != "open" || len(account(s.Engine, bob).Holdings) != 0 {
		t.Fatalf("a late report: %+v, clock %d", b, s.Clock)
	}
}

// A report that arrives after the next round's opening deadline still
// resolves the round ending at its boundary, but no longer opens the next one:
// the registry can no longer open it and will void it.
func TestReportPastTheOpeningDeadline(t *testing.T) {
	steps := run(t, script())
	h := &harness{t: t, st: find(t, steps, "reports: tick 5 fills bob against the house").after, block: 5000}
	late := mustSpec(b1).OpeningDeadline + 1
	h.sync(keeper)
	h.ok(h.tick(late))
	b := h.send(keeper, reportPayload(keeper, chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report, uint32(b1)))
	s := h.s()
	if b.Status != "applied" || s.Clock != late || status(s, engine.RoundID(deployed(), mustSpec(b0))) != "absent" ||
		status(s, engine.RoundID(deployed(), mustSpec(b1))) != "scheduled" || len(account(s.Engine, bob).Holdings) != 0 {
		t.Fatalf("a report past the opening deadline: %+v, clock %d, rounds %+v", b, s.Clock, s.Engine.Rounds)
	}
	// Sent again, it has nothing left to do (the resolved round is archived).
	if b := h.send(keeper, reportPayload(keeper, chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0).Report, uint32(b1))); b.Status != "rejected" || b.Reason != "report: nothing to apply" {
		t.Fatalf("the same report again: %+v", b)
	}
}

// The registry's record disagrees with what the guest did from a report: the
// guest's result stands and the disagreement is published. Past
// MaxUnconfirmed rounds, the oldest is given up in public.
func TestConfirmation(t *testing.T) {
	steps := run(t, script())
	h := &harness{t: t, st: find(t, steps, "reports: alice's report for b1 resolves round 0, pays the winners and opens round 1").after, block: 5000}
	cash := account(h.s().Engine, bob).Cash
	down := rec{start: b0, openedAt: b0 + 3, opening: observed(b0, b0+3, pr0), resolvedAt: b1 + 35, outcome: 2, closing: observed(b1, b1+2, "1")}
	h.sync(keeper)
	r := h.ok(h.tick(b1+40, down))
	confirm := append(append(raw(registryID(b0)), words(confirmDisagree, 1, 2)...), append(raw(reportObservation(chainlinkReport(engine.BTCStreamsFeed, uint32(b1), 0)).ReportHash), raw(down.closing.ReportHash)...)...)
	if len(r.AppEvents) != 2 || r.AppEvents[1].EventSubType != ConfirmSubType || !bytes.Equal(r.AppEvents[1].Data, confirm) || account(h.s().Engine, bob).Cash != cash || len(h.s().Unconfirmed) != 1 {
		t.Fatalf("a disagreement: %d app events, bob %d", len(r.AppEvents), account(h.s().Engine, bob).Cash)
	}
	// Fill the list to the cap with rounds the registry never confirms; the
	// next report settles two rounds and gives up the two oldest, in public.
	s := h.s()
	var fakes []Unconfirmed
	for i := 1; i < MaxUnconfirmed; i++ {
		fakes = append(fakes, Unconfirmed{fmt.Sprintf("0x%064x", i), "0x" + sha("open"), "0x" + sha("close"), 1})
	}
	s.Unconfirmed = append(fakes, s.Unconfirmed...)
	h.st = marshal(s)
	// Round 3 (b1 + 1800 to the recorded b1 + 2700) opens from the registry,
	// then the recorded report resolves it and opens round 4.
	b3 := b1 + 1800
	h.sync(keeper)
	h.ok(h.tick(b3+5, rec{start: b3, openedAt: b3 + 3, opening: observed(b3, b3+3, pr0)}))
	out := result(t, ProcessRequest(testApp, raw(keeper), requestTypeProcess, reportPayload(keeper, chainlinkReport(engine.BTCStreamsFeed, uint32(b3+900), 0).Report, uint32(b3+900)), h.st))
	h.st = out.State
	var gaveUp []string
	for _, e := range out.AppEvents {
		if e.EventSubType == ConfirmSubType && new(big.Int).SetBytes(e.Data[32:64]).Uint64() == confirmDropped {
			gaveUp = append(gaveUp, "0x"+hex.EncodeToString(e.Data[:32]))
		}
	}
	u := h.s().Unconfirmed
	if body(t, out.Events[0]).Body.Status != "applied" || !slices.Equal(gaveUp, []string{fakes[0].Round, fakes[1].Round}) || len(u) != MaxUnconfirmed ||
		u[MaxUnconfirmed-2].Round != registryID(b3) || u[MaxUnconfirmed-1].Round != registryID(b3+900) {
		t.Fatalf("past the cap: gave up %v, %+v", gaveUp, u)
	}
}

// A round that never opened is voided by the guest itself once nobody could
// open it any more: after its opening deadline and the void grace.
func TestOwnVoid(t *testing.T) {
	h := newHarness(t, alice)
	deadline := mustSpec(s1+900).OpeningDeadline + testConfig().Oracle.VoidGrace
	h.sync(keeper)
	h.ok(h.tick(deadline))
	if status(h.s(), id2) != "scheduled" {
		t.Fatal("voided at the deadline")
	}
	h.sync(keeper)
	r := h.ok(h.tick(deadline + 1))
	if status(h.s(), id2) != "absent" || r.AppEvents[1].EventSubType != SettleSubType ||
		!bytes.Equal(r.AppEvents[1].Data, settleWords(registryID(s1+900), settleVoid, 3, nil, sourceOwnVoid)) || status(h.s(), id1) != "open" {
		t.Fatalf("own void: %d app events", len(r.AppEvents))
	}
}
