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
	c.Oracle = RegistryConfig{ChainID: 26514, Registry: "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744", Oracle: "0xc800c3f18d35d492ae6b07655d7f31bfe98a4b6b",
		RulesHash: "0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6", BTCFeedID: BTCStreamsFeed, ETHFeedID: ETHStreamsFeed,
		Decimals: 18, ObservationWindow: 60, OpeningGrace: 150, VoidGrace: 300, CutoffBuffer: 30}
	return c
}

// Known answers for the planned mainnet registry (proxy 0x4DD4…6744 on 26514,
// profile contracts/deployment/hybrid-mainnet.json with the 300-second void
// grace; the rules hash equals the planned release's rulesHash in
// contracts/deployment/mainnet-addresses.json), computed independently of this
// package with Foundry:
//
//	cast keccak $(cast abi-encode "f(string,uint256,(address,address,bytes32,bytes32,uint8,uint8,uint32,uint32,uint32,uint32))" \
//	  "$RegistryRulesVersion" 26514 "(oracle,collateral,btcFeed,ethFeed,18,18,60,150,300,30)")
//	cast keccak $(cast abi-encode "f(uint256,address,bytes32,uint8,uint32,uint64)" 26514 proxy rulesHash asset duration 1791100800)
//
// The same two commands reproduce the retired registry's published hash and
// round IDs. No RPC, oracle signature, or mainnet execution is performed here.
// The proxy address is CREATE(deployer, nonce 3) and nothing is deployed yet:
// if the deployer's Horizen nonce moves first, the registry address and the
// four round IDs below are stale and must be regenerated (this test cannot tell).
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
		{"BTC", 300, "0xb4bcd96751ad786a84e0a2e4483daddd84a64109509e08578dd779ddbe5814d9"},
		{"BTC", 900, "0x87b9f68f1e7c1497c3007eae929a6474d06552d9cee57af34570455705e90ac5"},
		{"ETH", 300, "0x651f9d822dadb95f1cd04c3737ff87c19537eef6abc0f528e54727c632a88067"},
		{"ETH", 900, "0x99240e32bf55fba5be2c1bf346c42ed3086e60c7991f6371101e958e05f725e3"},
	}
	for _, v := range vectors {
		r, e := NewRoundSpec(c, v.asset, v.duration, 1791100800)
		if e != nil || r.RegistryRoundID != v.id || r.Cutoff != r.End-30 || r.OpeningDeadline != r.Start+210 || r.VoidableAfter != r.End+360 {
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
		func(r *RoundSpec) { r.Cutoff-- }, func(r *RoundSpec) { r.OpeningDeadline++ }, func(r *RoundSpec) { r.VoidableAfter++ },
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
	for _, legacy := range []uint32{1, 2} {
		c = config()
		c.Domain.RulesVersion = legacy
		if _, e := New(c); e == nil {
			t.Fatal("legacy domain accepted")
		}
		h := newHarness(t)
		h.s.Version = legacy
		if _, e := Encode(h.s); e == nil {
			t.Fatal("legacy snapshot reinterpreted")
		}
	}
	for grace, valid := range map[uint64]bool{0: false, 119: false, 120: true, 300: true, 86400: true, 21 * 86400: true, 21*86400 + 1: false} {
		c = config()
		c.Oracle.VoidGrace = grace
		if _, e := RegistryRulesHash(c); (e == nil) != valid {
			t.Fatalf("void grace %d validity", grace)
		}
	}
}

// Version 2 is not migrated: its domain, its field names and its commands
// without a registry inclusion time all reject under version 3.
func TestVersion2SnapshotsAndCommandsReject(t *testing.T) {
	h := newHarness(t)
	h.setup(alice)
	current, _ := Encode(h.s)
	for _, edit := range [][2]string{{`{"version":3,`, `{"version":2,`}, {`"rulesVersion":3`, `"rulesVersion":2`}, {`"voidGrace"`, `"settlementGrace"`}, {`"voidableAfter"`, `"resolutionDeadline"`}} {
		legacy := bytes.ReplaceAll(current, []byte(edit[0]), []byte(edit[1]))
		if bytes.Equal(legacy, current) {
			t.Fatalf("fixture has no %s", edit[0])
		}
		if _, e := Decode(legacy); e == nil {
			t.Fatalf("version-2 snapshot field %s accepted", edit[1])
		}
	}
	c, x := h.command(Command{Op: Mint, RoundID: h.round, Quantity: Lot}, alice, 0)
	c.Domain.RulesVersion = 2
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("version-2 command domain accepted")
	}
	// The registry time belongs to open/resolve/void only, and is mandatory there.
	h.reject(Command{Op: Mint, RoundID: h.round, Quantity: Lot, RegistryTime: 900}, alice, 0)
	h.reject(Command{Op: Checkpoint, RegistryTime: 900}, auth, 0)
	for _, op := range []Operation{ResolveRound, VoidRound} {
		c, x = h.command(Command{Op: op, RoundID: h.round, Evidence: hash([]byte("v2"))}, auth, 88211)
		if op == ResolveRound {
			c.Observation = testObservation("1", 1800)
		}
		if _, _, e := Apply(h.s, c, x); e != nil {
			t.Fatalf("control %s: %v", op, e)
		}
		c.RegistryTime = 0
		if _, _, e := Apply(h.s, c, x); e == nil {
			t.Fatalf("%s without registry time accepted", op)
		}
	}
	spec, _ := NewRoundSpec(h.s.Config, "ETH", 900, 1800)
	r := h.must(Command{Op: CreateRound, Round: &spec}, auth, 0)
	open := testObservation("1", 1800)
	open.FeedID = ETHStreamsFeed
	c, x = h.command(Command{Op: OpenRound, RoundID: r.RoundID, Observation: open, Evidence: hash([]byte("v2-open"))}, auth, 1800)
	if _, _, e := Apply(h.s, c, x); e != nil {
		t.Fatalf("control open: %v", e)
	}
	c.RegistryTime = 0
	if _, _, e := Apply(h.s, c, x); e == nil {
		t.Fatal("open without registry time accepted")
	}
}

// Finding D7. The registry judges its windows at block inclusion; the engine
// mirrors that time and must not substitute the later moment it processes the
// event, nor let its own clock make a void valid.
func TestRegistryInclusionTimeGovernsDeadlines(t *testing.T) {
	h := &harness{t: t}
	var err error
	if h.s, err = New(mainnetPolicy()); err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{alice, bob} {
		h.must(Command{Op: Register}, a, 1)
		h.deposit(a, 200*AtomScale)
	}
	const start = 1_800_000_000
	spec, _ := NewRoundSpec(h.s.Config, "BTC", 300, start)
	h.round = h.must(Command{Op: CreateRound, Round: &spec}, auth, 1).RoundID
	open := Command{Op: OpenRound, RoundID: h.round, Observation: testObservation("97000000000000000000000", start), Evidence: hash([]byte("open"))}
	void := Command{Op: VoidRound, RoundID: h.round, Evidence: hash([]byte("void"))}

	// An unrelated command moves the engine past the opening deadline before
	// the confirmed registry event reaches it.
	h.must(Command{Op: Checkpoint}, auth, spec.OpeningDeadline+1)
	void.RegistryTime = spec.OpeningDeadline
	h.reject(void, auth, 0)
	void.RegistryTime = spec.OpeningDeadline + 1
	missing := *h
	missing.must(void, auth, 0)
	open.RegistryTime = spec.OpeningDeadline + 1
	h.reject(open, auth, 0)
	// A report cannot postdate the block that recorded it, whatever the time is now.
	future := open
	future.Observation, future.RegistryTime = testObservation("97000000000000000000000", start+30), start+29
	h.reject(future, auth, 0)
	open.RegistryTime = spec.OpeningDeadline
	h.must(open, auth, 0)

	h.mint(alice, 10*AtomScale)
	h.must(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Sell, Price: 60, Quantity: 10 * AtomScale, TIF: GTC, Expiry: spec.Cutoff, MaxFee: MaxAtoms}, alice, 0)
	h.must(Command{Op: PlaceOrder, RoundID: h.round, Outcome: Up, Side: Buy, Price: 60, Quantity: 10 * AtomScale, TIF: IOC, Expiry: spec.Cutoff, MaxFee: MaxAtoms}, bob, 0)

	// The engine clock runs past every deadline before the result is mirrored.
	h.must(Command{Op: Checkpoint}, auth, spec.VoidableAfter+10)
	void.RegistryTime = spec.VoidableAfter
	h.reject(void, auth, 0)
	void.RegistryTime = spec.VoidableAfter + 1
	timeout := *h
	timeout.must(void, auth, 0)
	resolve := Command{Op: ResolveRound, RoundID: h.round, Observation: testObservation("97000000000000000000001", uint32(spec.End)), Evidence: hash([]byte("close"))}
	resolve.RegistryTime = spec.VoidableAfter + 11
	h.reject(resolve, auth, 0)
	resolve.RegistryTime = spec.End - 1
	h.reject(resolve, auth, 0)
	future = resolve
	future.Observation, future.RegistryTime = testObservation("97000000000000000000001", uint32(spec.End)+30), spec.End+29
	h.reject(future, auth, 0)
	// Mined six days after end, far beyond the retired one-hour window and the
	// voidableAfter (end + 360 s) that nobody used: the closing price still decides.
	resolve.RegistryTime = spec.End + 6*86400
	h.must(resolve, auth, spec.End+6*86400)
	if paid := h.must(Command{Op: Redeem, RoundID: h.round}, bob, 0).Amount; paid != 10*AtomScale {
		t.Fatalf("winner paid %d", paid)
	}
	if paid := h.must(Command{Op: Redeem, RoundID: h.round}, alice, 0).Amount; paid != 0 {
		t.Fatalf("loser paid %d", paid)
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
