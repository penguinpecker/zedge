package guest

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
	"golang.org/x/crypto/sha3"
)

// One script drives everything: the native unit tests, the cross-language
// vectors and the run through the upstream host runtime.

const (
	// A real application ID is uint64(bytes8(requestId)); this one has the top
	// bit set, so it reaches the guest as a negative i64.
	testApp     = uint64(0xf1e2d3c4b5a69788)
	endpoint    = "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9"
	trigger     = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // the engine authority
	collateral  = "0xcccccccccccccccccccccccccccccccccccccccc"
	outside     = "0x9999999999999999999999999999999999999999" // a withdrawal destination
	fingerprint = "abababababababababababababababababababababababababababababababab"
	origin      = "http://localhost:5173"
	epoch       = "1"
	// Wallet(keccak256("zedge-vela-guest-vector:<name>")) in guest.test.ts,
	// which checks these. Test-only accounts derived from a public label.
	alice  = "0xe5ec83f4b7c11debc83c32696238ace15468443e"
	bob    = "0x327437aced75d158d4624e85aa00e1906f44cde7"
	keeper = "0xeee7f8d404ca1acae6548f2bf3a530e4e6de08cd"
	house  = "0x4040404040404040404040404040404040404040" // the market maker of the stake limits

	t0, block0 = uint64(1_800_000_000), uint64(100)
	t1, block1 = t0 + 60, uint64(105)
)

// The salt the native runs deploy with. The wasm layer draws its own from the
// host; the tests that run the wasm treat it as an input.
var testSalt = bytes.Repeat([]byte{0x5a}, 32)

func testConfig() engine.Config {
	c := engine.Config{Domain: engine.Domain{ChainID: 31337, Endpoint: endpoint, RulesVersion: engine.Version}, Authority: trigger, Collateral: collateral, FeeBps: 100,
		Oracle: engine.RegistryConfig{ChainID: 31337, Registry: "0xdddddddddddddddddddddddddddddddddddddddd", Oracle: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", BTCFeedID: engine.BTCStreamsFeed, ETHFeedID: engine.ETHStreamsFeed, Decimals: 18, ObservationWindow: 10, OpeningGrace: 20, VoidGrace: 86400, CutoffBuffer: 5}}
	c.Oracle.RulesHash, _ = engine.RegistryRulesHash(c)
	return c
}

// The evaluation's stake limits: 50 tokens per account per round, 200 for
// every account but the house at one closing time, 2,000 for the house.
var testLimits = StakeLimits{Account: 50_000_000, Boundary: 200_000_000, House: house, HouseTotal: 2_000_000_000}

func testParams() DeployParams {
	return DeployParams{Engine: testConfig(), ApplicationFingerprint: fingerprint, Origin: origin, Epoch: epoch, Markets: []Market{{"BTC", 900}}, StakeLimits: testLimits}
}

func deployed() engine.Config {
	c := testConfig()
	c.Domain.ApplicationID = fmt.Sprint(testApp)
	return c
}

func testDomain() envelopeDomain {
	c := deployed()
	return envelopeDomain{c.Domain.ChainID, c.Domain.Endpoint, c.Domain.ApplicationID, fingerprint, RulesHash(c), origin}
}

func marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func keccak(b []byte) []byte { k := sha3.NewLegacyKeccak256(); k.Write(b); return k.Sum(nil) }

// clockRecord is the clock record a tick with this payload publishes.
func clockRecord(payload []byte, v ...uint64) []byte { return append(words(v...), keccak(payload)...) }

func raw(a string) []byte { b, _ := hex.DecodeString(a[2:]); return b }

// envelope is the plaintext session.ts encryptCommand produces for this body
// once ../crypto/pad.ts has padded it to RequestBytes. One that cannot fit is
// left unpadded, and longer.
func envelope(account, requestID string, body requestBody) []byte {
	return padded(requestEnvelope{1, testDomain(), account, epoch, requestID, "command", body})
}

func padded(e requestEnvelope) []byte {
	e.Body.Pad = ""
	if short := RequestBytes - len(marshal(e)); short > 0 {
		e.Body.Pad = strings.Repeat("0", short)
	}
	return marshal(e)
}

// command fills in the domain and ID and wraps the canonical command.
func command(account string, nonce uint64, c engine.Command) (engine.Command, []byte) {
	c.Domain, c.Account, c.Nonce, c.ID = deployed().Domain, account, nonce, engine.CommandID(account, nonce)
	return c, envelope(account, c.ID, requestBody{Type: "command", Command: string(marshal(c))})
}

func commandPayload(account string, nonce uint64, c engine.Command) []byte {
	_, b := command(account, nonce, c)
	return b
}

func syncPayload(account string) []byte {
	return envelope(account, account+":sync", requestBody{Type: "sync"})
}

// tickPayload is what the trigger returns: abi.encode(uint256 1, uint256
// chainId, address endpoint, uint256 blockNumber, uint256 blockTimestamp,
// uint256 tick).
func tickPayload(number, block, timestamp uint64) []byte {
	p := make([]byte, 192)
	for i, v := range []uint64{1, 31337, 0, block, timestamp, number} {
		binary.BigEndian.PutUint64(p[32*i+24:], v)
	}
	copy(p[76:96], raw(endpoint))
	return p
}

// rec is a registry round as the trigger reports it in a version-2 payload
// (README section 10). The zero value is a BTC 900-second round that has not
// opened yet.
type rec struct {
	asset, duration                      uint64 // 0 BTC, 1 ETH; 0 means 900
	start, openedAt, resolvedAt, outcome uint64
	opening, closing                     *engine.StreamsObservation
}

func (r rec) id() string {
	asset, duration := "BTC", r.duration
	if r.asset == 1 {
		asset = "ETH"
	}
	if duration == 0 {
		duration = 900
	}
	id, err := engine.RegistryRoundID(deployed(), asset, duration, r.start)
	if err != nil {
		panic(err)
	}
	return id
}

// observed is a valid registry observation for a boundary, recorded at "at".
func observed(boundary, at uint64, price string) *engine.StreamsObservation {
	return &engine.StreamsObservation{FeedID: engine.BTCStreamsFeed, Price: price, ValidFromTimestamp: uint32(boundary - 1), ObservationsTimestamp: uint32(min(boundary+1, at)),
		ExpiresAt: uint32(boundary + 86400), ReportHash: "0x" + sha(fmt.Sprint("report:", boundary, ":", price)), Decimals: 18}
}

// tick2 is the trigger's version-2 answer: the version-1 words with version 2,
// then the record count and 19 words per record.
func tick2(number, block, timestamp uint64, records ...rec) []byte {
	p := words(2, 31337, 0, block, timestamp, number, uint64(len(records)))
	copy(p[76:96], raw(endpoint))
	for _, r := range records {
		duration := r.duration
		if duration == 0 {
			duration = 900
		}
		w := append(raw(r.id()), words(r.asset, duration, r.start, r.openedAt, r.resolvedAt, r.outcome)...)
		for _, o := range []*engine.StreamsObservation{r.opening, r.closing} {
			if o == nil {
				o = &engine.StreamsObservation{Price: "0", ReportHash: "0x" + strings.Repeat("0", 64)}
			}
			price, _ := new(big.Int).SetString(o.Price, 10)
			w = append(w, price.FillBytes(make([]byte, 32))...)
			w = append(w, words(uint64(o.ValidFromTimestamp), uint64(o.ObservationsTimestamp), uint64(o.ExpiresAt))...)
			w = append(w, raw(o.ReportHash)...)
			w = append(w, words(uint64(o.Decimals))...)
		}
		p = append(p, w...)
	}
	return p
}

type step struct {
	Name    string `json:"name"`
	Call    string `json:"call"` // deploy, deposit, process, trusted, restart, load (Payload is the state)
	Sender  string `json:"sender,omitempty"`
	Token   string `json:"token,omitempty"`
	Amount  uint64 `json:"amount,omitempty"`
	Payload []byte `json:"payload,omitempty"`
	// What the native adapter returned; the guest must return the same.
	Error string `json:"error,omitempty"`
	// Set when the host must refuse the call before the guest sees it: the
	// text the host's own failure carries, in place of Error.
	HostError   string       `json:"hostError,omitempty"`
	StateSHA256 string       `json:"stateSha256"`
	EngineHash  string       `json:"engineHash"`
	Events      []Event      `json:"events"`
	AppEvents   []AppEvent   `json:"appEvents"`
	Withdrawals []Withdrawal `json:"withdrawals"`

	before, after []byte // the stored state around this step
}

func nested(depth int) string { return strings.Repeat("[", depth) + strings.Repeat("]", depth) }

func script() []step {
	withdraw := commandPayload(alice, 2, engine.Command{Op: engine.RequestWithdrawal, Amount: 50_000_000, Destination: outside})
	register := commandPayload(alice, 1, engine.Command{Op: engine.Register})
	order := engine.Command{Op: engine.PlaceOrder, RoundID: strings.Repeat("ab", 32), Outcome: engine.Up, Side: engine.Buy, Price: 55, Quantity: 1_000_000, TIF: engine.IOC, Expiry: t0 + 100, MaxFee: 10_000}
	trailer := envelope(alice, engine.CommandID(alice, 3), requestBody{Type: "command", Command: string(marshal(engine.Command{Domain: deployed().Domain, ID: engine.CommandID(alice, 3), Nonce: 3, Op: engine.Register, Account: alice})) + nested(600)})
	steps := []step{
		{Name: "deploy", Call: "deploy", Payload: marshal(testParams())},
		{Name: "deposit before the first tick fails", Call: "deposit", Sender: alice, Token: collateral, Amount: 200_000_000},
		{Name: "command before the first tick fails", Call: "process", Sender: bob, Payload: commandPayload(bob, 1, engine.Command{Op: engine.Register})},
		{Name: "sync asks for tick 1", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick 1 sets the clock", Call: "trusted", Payload: tickPayload(1, block0, t0)},
		{Name: "first deposit registers and credits alice", Call: "deposit", Sender: alice, Token: collateral, Amount: 200_000_000},
		{Name: "deposit of another token fails", Call: "deposit", Sender: alice, Token: outside, Amount: 1},
		{Name: "deposit of ETH fails", Call: "deposit", Sender: alice, Token: "0x0000000000000000000000000000000000000000", Amount: 1},
		{Name: "explicit register after a deposit is a retry", Call: "process", Sender: alice, Payload: register},
		{Name: "bob registers", Call: "process", Sender: bob, Payload: commandPayload(bob, 1, engine.Command{Op: engine.Register})},
		{Name: "alice withdraws", Call: "process", Sender: alice, Payload: withdraw},
		{Name: "exact retry of the withdrawal has no effect", Call: "process", Sender: alice, Payload: withdraw},
		{Name: "alice's command from bob fails", Call: "process", Sender: bob, Payload: withdraw},
		{Name: "overdraft is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.RequestWithdrawal, Amount: 1_000_000_000, Destination: outside})},
		{Name: "withdrawal to the endpoint is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: endpoint})},
		{Name: "order for an unknown round is staged", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, order)},
		{Name: "authority command from a user is rejected in private", Call: "process", Sender: bob, Payload: commandPayload(bob, 2, engine.Command{Op: engine.Deposit, Amount: 1_000_000, Evidence: strings.Repeat("cd", 32)})},
		{Name: "truncated envelope fails", Call: "process", Sender: alice, Payload: []byte(`{"version":1`)},
		{Name: "deeply nested payload fails", Call: "process", Sender: alice, Payload: []byte(nested(8000))},
		{Name: "command with a nested trailer fails", Call: "process", Sender: alice, Payload: trailer},
		{Name: "oversized payload fails", Call: "process", Sender: alice, Payload: []byte(strings.Repeat(" ", RequestBytes+1))},
		{Name: "replayed tick fails", Call: "trusted", Payload: tickPayload(1, block0, t0)},
		// Every accepted request asked for a tick: 2 to 9 are pending here.
		{Name: "tick nobody asked for fails", Call: "trusted", Payload: tickPayload(10, block1, t1)},
		{Name: "malformed tick fails", Call: "trusted", Payload: tickPayload(2, block1, t1)[:191]},
		{Name: "sync asks for tick 10", Call: "process", Sender: alice, Payload: syncPayload(alice)},
		{Name: "tick behind the clock fails", Call: "trusted", Payload: tickPayload(10, block1, t0-1)},
		{Name: "restart", Call: "restart"},
		{Name: "tick 10 checkpoints the engine and skips eight", Call: "trusted", Payload: tickPayload(10, block1, t1)},
		{Name: "bob deposits", Call: "deposit", Sender: bob, Token: collateral, Amount: 75_000_000},
		{Name: "bob withdraws everything", Call: "process", Sender: bob, Payload: commandPayload(bob, 2, engine.Command{Op: engine.RequestWithdrawal, Amount: 75_000_000, Destination: bob})},
	}
	// Fill the slice's 32 account slots with one-atom deposits, then one more.
	for i := 3; i <= MaxSliceAccounts+1; i++ {
		who := fmt.Sprintf("0x%040x", i)
		name := fmt.Sprintf("account %d of %d", i, MaxSliceAccounts)
		if i > MaxSliceAccounts {
			name = "deposit past the account limit fails"
		}
		steps = append(steps, step{Name: name, Call: "deposit", Sender: who, Token: collateral, Amount: 1})
	}
	steps = append(steps,
		// One byte more than the guest will take: its allocate returns 0 and the
		// host fails the request before any guest logic runs.
		step{Name: "payload over the allocation cap fails", Call: "process", Sender: alice, Payload: bytes.Repeat([]byte{' '}, MaxStateBytes+1), HostError: "allocate returned null pointer"},
		step{Name: "tick stamped in milliseconds fails", Call: "trusted", Payload: tickPayload(11, block1+1, (t1+1)*1000)},
		step{Name: "tick with an earlier block number is accepted", Call: "trusted", Payload: tickPayload(11, block0, t1+1)},
	)
	return append(steps, round()...)
}

// The first BTC 900-second round after t0, and the price it opens at.
const (
	s1, p0 = t0 + 900, "97000000000000000000000"
	cut1   = s1 + 900 - 5 // its cutoff
)

// round is one full round through the mirror and the book: create, open,
// mint, rest, partial fill, cancel, resolve, the sweep's redeem, archive,
// withdraw. Times are the registry's and the trigger's, chosen by hand.
func round() []step {
	r1, r2, r3, r4 := rec{start: s1}, rec{start: s1 + 900}, rec{start: s1 + 1800}, rec{start: s1 + 2700}
	opened := r1
	opened.openedAt, opened.opening = s1+3, observed(s1, s1+3, p0)
	resolved := opened
	resolved.resolvedAt, resolved.outcome, resolved.closing = s1+902, 1, observed(s1+900, s1+902, "97000000000000000000001")
	r2open := r2
	r2open.openedAt, r2open.opening = s1+903, observed(s1+900, s1+903, p0)
	id := engine.RoundID(deployed(), mustSpec(s1))
	sell := commandPayload(alice, 4, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Sell, Price: 60, Quantity: 1_000_000, TIF: engine.GTC, Expiry: cut1, MaxFee: 6_000})
	return []step{
		{Name: "keeper syncs for the round mirror", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick 12 creates the next two rounds", Call: "trusted", Payload: tick2(12, 110, t0+100, r1, r2)},
		{Name: "alice collects the outcome of her order for an unknown round", Call: "process", Sender: alice, Payload: syncPayload(alice)},
		{Name: "tick 13 opens round 1 and creates round 3", Call: "trusted", Payload: tick2(13, 111, s1+5, r3, opened)},
		{Name: "alice mints two shares", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 2_000_000})},
		{Name: "alice stages a resting sell", Call: "process", Sender: alice, Payload: sell},
		{Name: "alice's resend while staged is staged again", Call: "process", Sender: alice, Payload: sell},
		{Name: "alice's withdrawal while staged is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 5, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: alice})},
		{Name: "tick 15 rests alice's order", Call: "trusted", Payload: tick2(15, 112, s1+10)},
		{Name: "bob deposits ten tokens", Call: "deposit", Sender: bob, Token: collateral, Amount: 10_000_000},
		{Name: "bob stages a buy", Call: "process", Sender: bob, Payload: commandPayload(bob, 3, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Buy, Price: 60, Quantity: 400_000, TIF: engine.IOC, Expiry: cut1, MaxFee: 2_400})},
		{Name: "tick 18 fills bob against part of alice's order", Call: "trusted", Payload: tick2(18, 113, s1+20)},
		{Name: "alice collects her order's outcome and stages a cancel", Call: "process", Sender: alice, Payload: commandPayload(alice, 5, engine.Command{Op: engine.CancelOrder, OrderID: alice + ":4"})},
		{Name: "bob collects his fill", Call: "process", Sender: bob, Payload: syncPayload(bob)},
		{Name: "tick 20 cancels the rest of alice's order", Call: "trusted", Payload: tick2(20, 114, s1+30)},
		{Name: "keeper syncs before the close", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick 21 resolves round 1, sweeps and archives it, opens round 2 and creates round 4", Call: "trusted", Payload: tick2(21, 120, s1+905, r4, resolved, r2open)},
		{Name: "alice collects her cancel, whose receipt the sweep replaced", Call: "process", Sender: alice, Payload: syncPayload(alice)},
		{Name: "alice withdraws everything", Call: "process", Sender: alice, Payload: commandPayload(alice, 7, engine.Command{Op: engine.RequestWithdrawal, Amount: 149_837_600, Destination: alice})},
		{Name: "bob withdraws everything again", Call: "process", Sender: bob, Payload: commandPayload(bob, 5, engine.Command{Op: engine.RequestWithdrawal, Amount: 10_157_600, Destination: bob})},
	}
}

func mustSpec(start uint64) engine.RoundSpec {
	spec, err := engine.NewRoundSpec(deployed(), "BTC", 900, start)
	if err != nil {
		panic(err)
	}
	return spec
}

// inflate returns base grown to exactly target bytes by adding fills to the
// accounts' stored last receipts, which engine.Validate does not read. It is
// how the tests reach state sizes this build's own commands cannot.
func inflate(t testing.TB, base []byte, target int) []byte {
	t.Helper()
	s := state(t, base)
	fill := engine.Fill{MakerOrder: alice + ":7", TakerOrder: bob + ":9", Buyer: alice, Seller: bob, RoundID: sha("round"), Outcome: engine.Up, Price: 55, Quantity: 1000, BuyerFee: 1, SellerFee: 1}
	a := s.Engine.Accounts
	for i := (target-len(base))/(len(marshal(fill))+1) - 12; i > 0; i-- {
		a[i%len(a)].LastReceipt.Fills = append(a[i%len(a)].LastReceipt.Fills, fill)
	}
	last := &a[0].LastReceipt
	last.Fills = append(last.Fills, engine.Fill{})
	short := target - len(marshal(s))
	if short < 0 {
		t.Fatalf("cannot inflate a %d-byte state to %d bytes", len(base), target)
	}
	last.Fills[len(last.Fills)-1].MakerOrder = strings.Repeat("x", short)
	b := marshal(s)
	if len(b) != target {
		t.Fatalf("inflated state is %d bytes, want %d", len(b), target)
	}
	return b
}

// sameButTick reports whether after is before with one more tick requested
// and nothing else changed: what a private refusal, a retry or a sync leaves.
func sameButTick(t testing.TB, before, after []byte) bool {
	t.Helper()
	s := state(t, after)
	s.TickSeq--
	return bytes.Equal(marshal(s), before)
}

// run executes the script natively, recording every result and the state
// before each step.
func run(t testing.TB, steps []step) []step {
	t.Helper()
	var state []byte
	for i := range steps {
		s := &steps[i]
		s.before = state
		var out []byte
		switch s.Call {
		case "deploy":
			out = Deploy(testApp, s.Payload, testSalt)
		case "deposit":
			out = Deposit(testApp, raw(s.Sender), raw(s.Token), new(big.Int).SetUint64(s.Amount).Bytes(), state)
		case "process":
			out = ProcessRequest(testApp, raw(s.Sender), requestTypeProcess, s.Payload, state)
		case "trusted":
			out = TrustedRequest(testApp, s.Payload, state)
		case "restart":
		case "load":
			state = s.Payload
		default:
			t.Fatalf("unknown call %q", s.Call)
		}
		if out != nil {
			var r Result
			if err := json.Unmarshal(out, &r); err != nil {
				t.Fatalf("%s: result is not JSON: %v", s.Name, err)
			}
			s.Error, s.Events, s.AppEvents, s.Withdrawals = r.Error, r.Events, r.AppEvents, r.Withdrawals
			if r.Error == "" {
				state = r.State
			} else if r.State != nil || r.Events != nil || r.AppEvents != nil || r.Withdrawals != nil {
				t.Fatalf("%s: an error result carried effects", s.Name)
			}
		}
		s.after = state
		if state != nil {
			decoded, err := DecodeState(state)
			if err != nil {
				t.Fatalf("%s: returned state does not decode: %v", s.Name, err)
			}
			h := sha256.Sum256(state)
			s.StateSHA256 = hex.EncodeToString(h[:])
			if s.EngineHash, err = engine.StateHash(decoded.Engine); err != nil {
				t.Fatal(err)
			}
		}
	}
	return steps
}

func find(t testing.TB, steps []step, name string) *step {
	t.Helper()
	for i := range steps {
		if steps[i].Name == name {
			return &steps[i]
		}
	}
	t.Fatalf("no step %q", name)
	return nil
}

func body(t testing.TB, e Event) receiptEnvelope {
	t.Helper()
	var r receiptEnvelope
	if !canonical(e.Data, &r) {
		t.Fatalf("receipt is not canonical JSON: %s", e.Data)
	}
	if e.EventSubType != ReceiptSubType || r.Version != 1 || r.Kind != "receipt" || r.Domain != testDomain() || r.Epoch != epoch || r.Account != e.UserID {
		t.Fatalf("receipt has the wrong context: %s", e.Data)
	}
	if len(e.Data) != ReceiptBytes || strings.Trim(r.Body.Pad, "0") != "" {
		t.Fatalf("receipt is %d bytes, not one size class of zero padding", len(e.Data))
	}
	return r
}
