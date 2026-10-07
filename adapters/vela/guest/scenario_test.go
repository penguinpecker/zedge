package guest

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"slices"
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

// The Base side of custody in the tests: placeholder vault and inbox, the
// real Base USDC.
var testCustody = Custody{ChainID: BaseMainnet, Vault: "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", Inbox: "0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b",
	USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}

// chainlinkVectors are the Chainlink reports of testdata/chainlink.json, with
// what an independent implementation read from each.
type chainlinkVector struct {
	FeedID                string   `json:"feedId"`
	ValidFromTimestamp    uint32   `json:"validFromTimestamp"`
	ObservationsTimestamp uint32   `json:"observationsTimestamp"`
	ExpiresAt             uint32   `json:"expiresAt"`
	Price                 string   `json:"price"`
	ReportHash            string   `json:"reportHash"`
	Signers               []string `json:"signers"`
	Report                string   `json:"report"`
}

var chainlinkFile = func() (v struct {
	Digest  string            `json:"digest"`
	F       uint64            `json:"f"`
	Signers []string          `json:"signers"`
	Reports []chainlinkVector `json:"reports"`
}) {
	b, err := os.ReadFile("testdata/chainlink.json")
	if err == nil {
		err = json.Unmarshal(b, &v)
	}
	if err != nil {
		panic(err)
	}
	return v
}()

// testChainlink pins the DON configuration every recorded BTC report is signed
// under (Base ConfigSet at block 30,184,132).
func testChainlink() Chainlink {
	return Chainlink{FeedID: engine.BTCStreamsFeed, Configs: []DONConfig{{Digest: chainlinkFile.Digest, F: chainlinkFile.F, Signers: slices.Clone(chainlinkFile.Signers)}}}
}

func testParams() DeployParams {
	return DeployParams{Engine: testConfig(), ApplicationFingerprint: fingerprint, Origin: origin, Epoch: epoch, Markets: []Market{{"BTC", 900}}, StakeLimits: testLimits,
		Chainlink: testChainlink(), Custody: testCustody}
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

// tickPayload is the trigger's answer with no registry or deposit record: a
// plain clock tick.
func tickPayload(number, block, timestamp uint64) []byte {
	return tick3(number, block, timestamp, nil, nil)
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

// tick2 is the trigger's answer with registry records and no deposit.
func tick2(number, block, timestamp uint64, records ...rec) []byte {
	return tick3(number, block, timestamp, records, nil)
}

// dep is a Base deposit as the inbox records it.
type dep struct {
	index   uint64
	account string
	amount  uint64
}

// deps is n deposits of amount atoms from consecutive accounts 0x…<first>,
// with vault indexes from index on.
func deps(index, first, n, amount uint64) []dep {
	var d []dep
	for i := uint64(0); i < n; i++ {
		d = append(d, dep{index + i, fmt.Sprintf("0x%040x", first+i), amount})
	}
	return d
}

// tick3 is the trigger's version-3 answer: the clock words, the record and
// deposit counts, 19 words per registry record, 3 per deposit record.
func tick3(number, block, timestamp uint64, records []rec, deposits []dep) []byte {
	p := words(3, 31337, 0, block, timestamp, number, uint64(len(records)), uint64(len(deposits)))
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
	for _, d := range deposits {
		p = append(append(append(p, words(d.index)...), addressWord(d.account)...), words(d.amount)...)
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
		{Name: "deposit through the endpoint fails", Call: "deposit", Sender: alice, Token: collateral, Amount: 200_000_000},
		{Name: "command before the first tick fails", Call: "process", Sender: bob, Payload: commandPayload(bob, 1, engine.Command{Op: engine.Register})},
		{Name: "sync asks for tick 1", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick 1 sets the clock and credits alice's first Base deposit, registering her", Call: "trusted", Payload: tick3(1, block0, t0, nil, []dep{{1, alice, 200_000_000}})},
		{Name: "explicit register after a deposit is a retry", Call: "process", Sender: alice, Payload: register},
		{Name: "bob registers", Call: "process", Sender: bob, Payload: commandPayload(bob, 1, engine.Command{Op: engine.Register})},
		{Name: "alice withdraws", Call: "process", Sender: alice, Payload: withdraw},
		{Name: "exact retry of the withdrawal has no effect", Call: "process", Sender: alice, Payload: withdraw},
		{Name: "alice's command from bob fails", Call: "process", Sender: bob, Payload: withdraw},
		{Name: "overdraft is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.RequestWithdrawal, Amount: 1_000_000_000, Destination: outside})},
		{Name: "withdrawal to the vault is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: testCustody.Vault})},
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
		{Name: "tick 9 behind the clock applies at the clock, skipping seven", Call: "trusted", Payload: tickPayload(9, block1, t0-1)},
		{Name: "restart", Call: "restart"},
		{Name: "tick 10 checkpoints the engine and credits bob's deposit", Call: "trusted", Payload: tick3(10, block1, t1, nil, []dep{{2, bob, 75_000_000}})},
		{Name: "bob withdraws everything", Call: "process", Sender: bob, Payload: commandPayload(bob, 2, engine.Command{Op: engine.RequestWithdrawal, Amount: 75_000_000, Destination: bob})},
		// One byte more than the guest will take: its allocate returns 0 and the
		// host fails the request before any guest logic runs.
		{Name: "payload over the allocation cap fails", Call: "process", Sender: alice, Payload: bytes.Repeat([]byte{' '}, MaxStateBytes+1), HostError: "allocate returned null pointer"},
		{Name: "tick stamped in milliseconds fails", Call: "trusted", Payload: tickPayload(11, block1+1, (t1+1)*1000)},
		{Name: "tick with an earlier block number is accepted", Call: "trusted", Payload: tickPayload(11, block0, t1+1)},
	}
	// Fill the slice's 32 account slots with one-atom Base deposits, eight a
	// tick, then one more, which is refunded.
	for k, first := uint64(12), uint64(3); first <= MaxSliceAccounts+1; k, first = k+1, first+MaxDeposits {
		n := min(MaxDeposits, MaxSliceAccounts+2-first)
		name := fmt.Sprintf("tick %d credits accounts %d to %d", k, first, first+n-1)
		if first+n > MaxSliceAccounts+1 {
			name = fmt.Sprintf("tick %d credits accounts %d to %d and refunds the deposit past the account limit", k, first, MaxSliceAccounts)
		}
		steps = append(steps, step{Name: "keeper syncs for deposits", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
			step{Name: name, Call: "trusted", Payload: tick3(k, block1+k, t1+k, nil, deps(first, first, n, 1))})
	}
	return append(append(steps, round(15)...), reports()...)
}

// The first BTC 900-second round after t0, and the price it opens at.
const (
	s1, p0 = t0 + 900, "97000000000000000000000"
	cut1   = s1 + 900 - 5 // its cutoff
)

// round is one full round through the mirror and the book: open, mint, rest,
// partial fill, cancel, resolve, the sweep's redeem, archive, withdraw. k is
// the last tick asked for before it. Times are the registry's and the
// trigger's, chosen by hand.
func round(k uint64) []step {
	r1, r2, r3, r4 := rec{start: s1}, rec{start: s1 + 900}, rec{start: s1 + 1800}, rec{start: s1 + 2700}
	opened := r1
	opened.openedAt, opened.opening = s1+3, observed(s1, s1+3, p0)
	resolved := opened
	resolved.resolvedAt, resolved.outcome, resolved.closing = s1+902, 1, observed(s1+900, s1+902, "97000000000000000000001")
	r2open := r2
	r2open.openedAt, r2open.opening = s1+903, observed(s1+900, s1+903, p0)
	id := engine.RoundID(deployed(), mustSpec(s1))
	sell := commandPayload(alice, 4, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Sell, Price: 60, Quantity: 1_000_000, TIF: engine.GTC, Expiry: cut1, MaxFee: 6_000})
	n := func(i uint64) string { return fmt.Sprint(k + i) }
	return []step{
		{Name: "keeper syncs for the round mirror", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick " + n(1) + " sees the two rounds the guest created", Call: "trusted", Payload: tick2(k+1, 110, t0+100, r1, r2)},
		{Name: "alice collects the outcome of her order for an unknown round", Call: "process", Sender: alice, Payload: syncPayload(alice)},
		{Name: "tick " + n(2) + " opens round 1 and creates round 3", Call: "trusted", Payload: tick2(k+2, 111, s1+5, r3, opened)},
		{Name: "alice mints two shares", Call: "process", Sender: alice, Payload: commandPayload(alice, 3, engine.Command{Op: engine.Mint, RoundID: id, Quantity: 2_000_000})},
		{Name: "alice stages a resting sell", Call: "process", Sender: alice, Payload: sell},
		{Name: "alice's resend while staged is staged again", Call: "process", Sender: alice, Payload: sell},
		{Name: "alice's withdrawal while staged is rejected in private", Call: "process", Sender: alice, Payload: commandPayload(alice, 5, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: alice})},
		{Name: "tick " + n(4) + " rests alice's order", Call: "trusted", Payload: tick2(k+4, 112, s1+10)},
		{Name: "bob stages a buy", Call: "process", Sender: bob, Payload: commandPayload(bob, 3, engine.Command{Op: engine.PlaceOrder, RoundID: id, Outcome: engine.Up, Side: engine.Buy, Price: 60, Quantity: 400_000, TIF: engine.IOC, Expiry: cut1, MaxFee: 2_400})},
		{Name: "tick " + n(7) + " credits bob ten tokens and fills him against part of alice's order", Call: "trusted", Payload: tick3(k+7, 113, s1+20, nil, []dep{{MaxSliceAccounts + 2, bob, 10_000_000}})},
		{Name: "alice collects her order's outcome and stages a cancel", Call: "process", Sender: alice, Payload: commandPayload(alice, 5, engine.Command{Op: engine.CancelOrder, OrderID: alice + ":4"})},
		{Name: "bob collects his fill", Call: "process", Sender: bob, Payload: syncPayload(bob)},
		{Name: "tick " + n(9) + " cancels the rest of alice's order", Call: "trusted", Payload: tick2(k+9, 114, s1+30)},
		{Name: "keeper syncs before the close", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "tick " + n(10) + " resolves round 1, sweeps and archives it, opens round 2 and creates round 4", Call: "trusted", Payload: tick2(k+10, 120, s1+905, r4, resolved, r2open)},
		{Name: "alice collects her cancel, whose receipt the sweep replaced", Call: "process", Sender: alice, Payload: syncPayload(alice)},
		{Name: "alice withdraws everything", Call: "process", Sender: alice, Payload: commandPayload(alice, 7, engine.Command{Op: engine.RequestWithdrawal, Amount: 149_837_600, Destination: alice})},
		{Name: "bob withdraws everything again", Call: "process", Sender: bob, Payload: commandPayload(bob, 5, engine.Command{Op: engine.RequestWithdrawal, Amount: 10_157_600, Destination: bob})},
	}
}

// The report scenario runs at the times of the recorded Chainlink reports:
// round 0 runs from b0 to b1, and the report for b1 resolves it and opens
// round 1.
const (
	tr, b0, b1 = uint64(1_791_269_200), uint64(1_791_270_000), uint64(1_791_270_900)
	pr0        = "85000000000000000000000" // round 0's opening price, below the report's
)

// chainlinkReport is the recorded report of feed at second at (the n-th copy).
func chainlinkReport(feed string, at uint32, n int) chainlinkVector {
	for _, v := range chainlinkFile.Reports {
		if v.FeedID == feed && v.ObservationsTimestamp == at {
			if n == 0 {
				return v
			}
			n--
		}
	}
	panic(fmt.Sprint("no recorded report for ", feed, " at ", at))
}

// reportPayload is the report request of account carrying the full report
// hex, under the request ID of second at.
func reportPayload(account, full string, at uint32) []byte {
	return envelope(account, fmt.Sprint(account, ":report:", at), requestBody{Type: "report", Report: base64.StdEncoding.EncodeToString(raw(full))})
}

// reportObservation is the observation the registry stores for a report.
func reportObservation(v chainlinkVector) *engine.StreamsObservation {
	return &engine.StreamsObservation{FeedID: v.FeedID, Price: v.Price, ValidFromTimestamp: v.ValidFromTimestamp, ObservationsTimestamp: v.ObservationsTimestamp, ExpiresAt: v.ExpiresAt, ReportHash: v.ReportHash, Decimals: 18}
}

// reports is a second deployment driven by real Chainlink reports (README
// section 12): Base deposits, a trade in round 0, the report for b1 that
// resolves round 0, pays the winners and opens round 1 in one transition,
// the reports that must be refused, a payout, deposits out of order, and the
// registry's confirmation of round 0.
func reports() []step {
	btc, other := engine.BTCStreamsFeed, "0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f"
	close1, copy1 := chainlinkReport(btc, uint32(b1), 0), chainlinkReport(btc, uint32(b1), 1)
	flipped := raw(close1.Report)
	flipped[0xe0+32+200] ^= 1 // a byte of the price
	r0, r1 := rec{start: b0}, rec{start: b1}
	r0.openedAt, r0.opening = b0+3, observed(b0, b0+3, pr0)
	confirmed := r0
	confirmed.resolvedAt, confirmed.outcome, confirmed.closing = b1+35, 1, reportObservation(close1)
	id0 := engine.RoundID(deployed(), mustSpec(b0))
	cut0 := mustSpec(b0).Cutoff
	return []step{
		{Name: "reports: restart, so that the host deploys afresh", Call: "restart"},
		{Name: "reports: deploy", Call: "deploy", Payload: marshal(testParams())},
		{Name: "reports: keeper syncs", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "reports: tick 1 credits alice, bob and the house and creates rounds 0 and 1", Call: "trusted", Payload: tick3(1, 200, tr, nil, []dep{{1, alice, 100_000_000}, {2, bob, 100_000_000}, {3, house, 1_000_000_000}})},
		{Name: "reports: keeper syncs for the opening", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "reports: tick 2 opens round 0 from the registry", Call: "trusted", Payload: tick2(2, 201, b0+5, r0, r1)},
		{Name: "reports: the house mints twenty shares", Call: "process", Sender: house, Payload: commandPayload(house, 2, engine.Command{Op: engine.Mint, RoundID: id0, Quantity: 20_000_000})},
		{Name: "reports: the house stages a resting sell of ten Up", Call: "process", Sender: house, Payload: commandPayload(house, 3, engine.Command{Op: engine.PlaceOrder, RoundID: id0, Outcome: engine.Up, Side: engine.Sell, Price: 55, Quantity: 10_000_000, TIF: engine.GTC, Expiry: cut0, MaxFee: 100_000})},
		{Name: "reports: tick 4 rests the house's sell", Call: "trusted", Payload: tickPayload(4, 202, b0+10)},
		{Name: "reports: bob stages a buy of four Up", Call: "process", Sender: bob, Payload: commandPayload(bob, 2, engine.Command{Op: engine.PlaceOrder, RoundID: id0, Outcome: engine.Up, Side: engine.Buy, Price: 60, Quantity: 4_000_000, TIF: engine.IOC, Expiry: cut0, MaxFee: 100_000})},
		{Name: "reports: tick 5 fills bob against the house", Call: "trusted", Payload: tickPayload(5, 203, b0+20)},
		// Anyone with a registered key may send a report: here alice.
		{Name: "reports: alice's report for b1 resolves round 0, pays the winners and opens round 1", Call: "process", Sender: alice, Payload: reportPayload(alice, close1.Report, uint32(b1))},
		{Name: "reports: the other copy of that report is already applied", Call: "process", Sender: alice, Payload: reportPayload(alice, copy1.Report, uint32(b1))},
		{Name: "reports: a report for a second past the boundary is refused", Call: "process", Sender: keeper, Payload: reportPayload(keeper, chainlinkReport(btc, uint32(b1)+2760, 0).Report, uint32(b1)+2760)},
		{Name: "reports: a report of another feed is refused", Call: "process", Sender: keeper, Payload: reportPayload(keeper, chainlinkReport(other, uint32(b1), 0).Report, uint32(b1))},
		{Name: "reports: a report with a changed price is refused", Call: "process", Sender: keeper, Payload: reportPayload(keeper, "0x"+hex.EncodeToString(flipped), uint32(b1))},
		{Name: "reports: bob withdraws one token to Base", Call: "process", Sender: bob, Payload: commandPayload(bob, 4, engine.Command{Op: engine.RequestWithdrawal, Amount: 1_000_000, Destination: bob})},
		{Name: "reports: keeper syncs for deposits", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "reports: tick 7 waits at a gap in the deposit indexes", Call: "trusted", Payload: tick3(7, 204, b1+10, nil, []dep{{5, alice, 1_000_000}})},
		{Name: "reports: keeper syncs for the registry's record", Call: "process", Sender: keeper, Payload: syncPayload(keeper)},
		{Name: "reports: tick 8 skips a repeated deposit, credits two and confirms round 0", Call: "trusted", Payload: tick3(8, 205, b1+40, []rec{confirmed}, []dep{{3, house, 1_000_000_000}, {4, alice, 5_000_000}, {5, alice, 1_000_000}})},
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
