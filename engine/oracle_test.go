package engine

import (
	"bytes"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
)

func mainnetPolicy() Config {
	c := config()
	c.Collateral = "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c"
	c.Oracle = RegistryConfig{ChainID: 26514, Registry: "0xdd3beaa92e5819333a5d5ccd185704427fab0e91", Oracle: "0xc800c3f18d35d492ae6b07655d7f31bfe98a4b6b",
		RulesHash: "0x591860792894f856c548d908b50aac9bbecd793794da13ac995bf9d248aa7d7c", BTCFeedID: BTCStreamsFeed, ETHFeedID: ETHStreamsFeed,
		Decimals: 18, ObservationWindow: 60, OpeningGrace: 150, SettlementGrace: 3600, CutoffBuffer: 30}
	return c
}

// Public deployed rules hash plus independently encoded viem ABI vectors. No
// RPC, oracle signature, or mainnet execution is performed by this test.
func TestRegistryKeccakConformance(t *testing.T) {
	c := mainnetPolicy()
	h, err := RegistryRulesHash(c)
	if err != nil || h != c.Oracle.RulesHash {
		t.Fatalf("rules hash differs: %s %v", h, err)
	}
	vectors := []struct {
		asset    string
		duration uint64
		id       string
	}{
		{"BTC", 300, "0xdf5935ba7590986f2cd86d4dc4ef5b1621b3e32da5cd1c64d582e7a4249ca556"},
		{"BTC", 900, "0xf112d564c6db17d54bd81072fdf1179780a6fc488cff984e8952b925b05d3124"},
		{"ETH", 300, "0x88257428740e8c98742f578924d1bdcb9cc955fac982c9edcb981705cf471f76"},
		{"ETH", 900, "0x6ddc52d8f378c42fb7420ef78955759d2e530f4fd5ce1c32cda8e1a7923a9fd1"},
	}
	for _, v := range vectors {
		r, e := NewRoundSpec(c, v.asset, v.duration, 1791100800)
		if e != nil || r.RegistryRoundID != v.id || r.Cutoff != r.End-30 || r.OpeningDeadline != r.Start+210 || r.ResolutionDeadline != r.End+3660 {
			t.Fatalf("round vector %s/%d: %+v %v", v.asset, v.duration, r, e)
		}
	}
}

func TestExactPriceRangeAndCanonicalEncoding(t *testing.T) {
	bound := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 191), big.NewInt(1))
	if bound.String() != MaxOraclePrice {
		t.Fatal("price limit differs from signed int192")
	}
	for _, price := range []string{"", "0", "00", "01", "+1", "-1", "1.0", "1e18", " 1", "1 ", "１", MaxOraclePrice + "0", "3138550867693340381917894711603833208051177722232017256448"} {
		if ValidOraclePrice(price) {
			t.Fatalf("accepted invalid price %q", price)
		}
	}
	for _, price := range []string{"1", "97000000000000000000000", MaxOraclePrice} {
		if !ValidOraclePrice(price) {
			t.Fatalf("rejected exact price %q", price)
		}
	}
	for _, pair := range [][2]string{{"999", "1000"}, {"97000000000000000000000", "97000000000000000000001"}, {"3138550867693340381917894711603833208051177722232017256446", MaxOraclePrice}} {
		if n, e := CompareOraclePrices(pair[0], pair[1]); n != -1 || e != nil {
			t.Fatal("lost exact atom comparison")
		}
	}
	c := Command{Domain: config().Domain, ID: CommandID(auth, 1), Nonce: 1, Op: OpenRound, RoundID: strings.Repeat("a", 64), Evidence: strings.Repeat("b", 64), Observation: testObservation(MaxOraclePrice, 900)}
	b, _ := json.Marshal(c)
	decoded, e := DecodeCommand(b)
	if e != nil || decoded.Observation.Price != MaxOraclePrice {
		t.Fatal("exact decimal text did not round-trip")
	}
	bad := bytes.Replace(b, []byte(`"price":"`+MaxOraclePrice+`"`), []byte(`"price":`+MaxOraclePrice), 1)
	if _, e := DecodeCommand(bad); e == nil {
		t.Fatal("JSON numeric oracle price accepted")
	}
}

func TestAllMarketsPreserveOneAtomOutcomes(t *testing.T) {
	for _, asset := range []string{"BTC", "ETH"} {
		for _, duration := range []uint64{300, 900} {
			for _, delta := range []int64{-1, 0, 1} {
				h := newHarness(t)
				spec, err := NewRoundSpec(h.s.Config, asset, duration, 900)
				if err != nil {
					t.Fatal(err)
				}
				r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
				opening := testObservation("97000000000000000000000", uint32(spec.Start))
				opening.FeedID = spec.Feed
				h.must(Command{Op: OpenRound, RoundID: r.RoundID, Observation: opening, Evidence: hash([]byte("open"))}, auth, spec.Start)
				p, _ := new(big.Int).SetString(opening.Price, 10)
				closing := testObservation(p.Add(p, big.NewInt(delta)).String(), uint32(spec.End))
				closing.FeedID = spec.Feed
				h.must(Command{Op: ResolveRound, RoundID: r.RoundID, Observation: closing, Evidence: hash([]byte("close"))}, auth, spec.End)
				want := Up
				if delta < 0 {
					want = Down
				}
				if h.s.Rounds[0].Outcome != want {
					t.Fatalf("%s/%d delta %d rounded result", asset, duration, delta)
				}
				encoded, e := Encode(h.s)
				if e != nil {
					t.Fatal(e)
				}
				restored, e := Decode(encoded)
				if e != nil || restored.Rounds[0].Closing.Price != closing.Price {
					t.Fatal("snapshot lost exact price")
				}
			}
		}
	}
}

func TestStreamsBoundaryAndFeedRejectAtomically(t *testing.T) {
	mutations := []func(*StreamsObservation){
		func(o *StreamsObservation) { o.FeedID = ETHStreamsFeed }, func(o *StreamsObservation) { o.Decimals = 8 },
		func(o *StreamsObservation) { o.ValidFromTimestamp = 901 }, func(o *StreamsObservation) { o.ValidFromTimestamp = 0 },
		func(o *StreamsObservation) { o.ObservationsTimestamp = 899 }, func(o *StreamsObservation) { o.ObservationsTimestamp = 911 },
		func(o *StreamsObservation) { o.ExpiresAt = 899 }, func(o *StreamsObservation) { o.ReportHash = "0x" + strings.Repeat("0", 64) },
		func(o *StreamsObservation) { o.Price = "-1" }, func(o *StreamsObservation) { o.Price = MaxOraclePrice + "0" },
	}
	for _, mutate := range mutations {
		h := newHarness(t)
		spec, _ := NewRoundSpec(h.s.Config, "BTC", 900, 900)
		r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
		o := testObservation("1", 900)
		mutate(o)
		h.reject(Command{Op: OpenRound, RoundID: r.RoundID, Observation: o, Evidence: hash([]byte("bad"))}, auth, 910)
	}
	h := newHarness(t)
	spec, _ := NewRoundSpec(h.s.Config, "BTC", 900, 900)
	r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 1)
	o := testObservation("1", 910)
	o.ExpiresAt = 910
	h.reject(Command{Op: OpenRound, RoundID: r.RoundID, Observation: o, Evidence: hash([]byte("future"))}, auth, 909)
	// Source verification already authenticated expiry. Destination arrival may be later.
	h.must(Command{Op: OpenRound, RoundID: r.RoundID, Observation: o, Evidence: hash([]byte("valid"))}, auth, 930)
	o.Price = "99"
	if h.s.Rounds[0].Opening.Price != "1" {
		t.Fatal("caller mutation changed committed observation")
	}
}

func TestRoundBindingRejectsSubstitutedIdentityAndPolicy(t *testing.T) {
	mutations := []func(*RoundSpec){
		func(r *RoundSpec) { r.RegistryRoundID = "0x" + strings.Repeat("a", 64) }, func(r *RoundSpec) { r.Feed = ETHStreamsFeed },
		func(r *RoundSpec) { r.Cutoff-- }, func(r *RoundSpec) { r.OpeningDeadline++ }, func(r *RoundSpec) { r.ResolutionDeadline++ },
		func(r *RoundSpec) { r.ObservationWindow++ }, func(r *RoundSpec) { r.Asset = "ETH" }, func(r *RoundSpec) { r.Start++ },
	}
	for _, mutate := range mutations {
		h := newHarness(t)
		spec, _ := NewRoundSpec(h.s.Config, "BTC", 900, 900)
		mutate(&spec)
		h.reject(Command{Op: CreateRound, Round: &spec}, auth, 1)
	}
	c := config()
	c.Oracle.Oracle = "0xffffffffffffffffffffffffffffffffffffffff"
	if _, e := New(c); e == nil {
		t.Fatal("substituted oracle accepted under prior rulesHash")
	}
	c = config()
	old, _ := RegistryRoundID(c, "BTC", 300, 900)
	c.Oracle.Registry = "0xffffffffffffffffffffffffffffffffffffffff"
	newID, e := RegistryRoundID(c, "BTC", 300, 900)
	if e != nil || newID == old {
		t.Fatal("registry endpoint not bound")
	}
	c = config()
	c.Oracle.ChainID++
	if _, e := New(c); e == nil {
		t.Fatal("cross-chain rulesHash reuse accepted")
	}
	c = config()
	if _, e := NewRoundSpec(c, "BTC", 300, maxStreamsTimestamp-100); e == nil {
		t.Fatal("schema3 overflow accepted")
	}
	c = config()
	c.Domain.RulesVersion = 1
	if _, e := New(c); e == nil {
		t.Fatal("legacy domain accepted")
	}
	h := newHarness(t)
	h.s.Version = 1
	if _, e := Encode(h.s); e == nil {
		t.Fatal("legacy snapshot reinterpreted")
	}
}

func FuzzExactOraclePriceComparison(f *testing.F) {
	f.Add("97000000000000000000000", "97000000000000000000001")
	f.Add(MaxOraclePrice, "1")
	f.Add("-1", "0")
	f.Add("999", "1000")
	f.Fuzz(func(t *testing.T, a, b string) {
		if len(a) > 100 || len(b) > 100 {
			return
		}
		n, e := CompareOraclePrices(a, b)
		if !ValidOraclePrice(a) || !ValidOraclePrice(b) {
			if e == nil {
				t.Fatal("invalid price compared")
			}
			return
		}
		aa, _ := new(big.Int).SetString(a, 10)
		bb, _ := new(big.Int).SetString(b, 10)
		if e != nil || n != aa.Cmp(bb) {
			t.Fatal("comparison differs from arbitrary precision")
		}
	})
}
