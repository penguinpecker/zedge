// Command scenario is a local conformance harness, never a live-chain adapter.
// Input is a test oracle fixture, not authenticated chain evidence. It refuses
// every chain except local Anvil (31337) and prints only test summary data.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/penguinpecker/zedge/engine"
)

type fixture struct {
	Source          string                    `json:"source"`
	ChainID         uint64                    `json:"chainId"`
	Registry        string                    `json:"registry"`
	Collateral      string                    `json:"collateral"`
	RegistryRoundID string                    `json:"registryRoundId"`
	Spec            engine.RoundSpec          `json:"spec"`
	Oracle          engine.RegistryConfig     `json:"oracle"`
	Opening         engine.StreamsObservation `json:"opening"`
	Closing         engine.StreamsObservation `json:"closing"`
	OpenedAt        uint64                    `json:"openedAt"`
	ResolvedAt      uint64                    `json:"resolvedAt"`
	ExpectedOutcome engine.Outcome            `json:"expectedOutcome"`
}

const alice = "0x1111111111111111111111111111111111111111"
const bob = "0x2222222222222222222222222222222222222222"
const authority = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func evidence(label string) string {
	h := sha256.Sum256([]byte("LOCAL-TEST-ONLY:" + label))
	return hex.EncodeToString(h[:])
}

func run() error {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 16_385))
	if err != nil {
		return err
	}
	if len(input) > 16_384 {
		return fmt.Errorf("test fixture too large")
	}
	var f fixture
	d := json.NewDecoder(bytes.NewReader(input))
	d.DisallowUnknownFields()
	if err = d.Decode(&f); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("trailing input")
	}
	if f.Source != "local-evm-test-fixture" || f.ChainID != 31337 || f.Spec.Start < 2 || f.OpenedAt < f.Spec.Start || f.ResolvedAt < f.Spec.End || len(f.RegistryRoundID) != 66 || f.RegistryRoundID != f.Spec.RegistryRoundID || f.Oracle.ChainID != f.ChainID || f.Oracle.Registry != f.Registry {
		return fmt.Errorf("only explicit local EVM fixtures are accepted")
	}
	cfg := engine.Config{Domain: engine.Domain{ChainID: 31337, Endpoint: f.Registry, ApplicationID: "local-conformance", RulesVersion: engine.Version}, Authority: authority, Collateral: f.Collateral, FeeBps: 100, Oracle: f.Oracle}
	s, err := engine.New(cfg)
	if err != nil {
		return err
	}
	// The engine derives both registry identities from the policy fields alone. The harness
	// compares these with what the compiled contract returned.
	rulesHash, err := engine.RegistryRulesHash(cfg)
	if err != nil {
		return err
	}
	registryRoundID, err := engine.RegistryRoundID(cfg, f.Spec.Asset, f.Spec.End-f.Spec.Start, f.Spec.Start)
	if err != nil {
		return err
	}
	nonces := map[string]uint64{}
	apply := func(c engine.Command, principal string, at uint64, system bool) (engine.Receipt, error) {
		c.Domain = cfg.Domain
		c.Nonce = nonces[principal] + 1
		c.ID = engine.CommandID(principal, c.Nonce)
		if !system {
			c.Account = principal
		}
		n, r, e := engine.Apply(s, c, engine.AuthenticatedContext{Domain: cfg.Domain, Principal: principal, Timestamp: at, System: system})
		if e != nil {
			return r, fmt.Errorf("%s: %w", c.Op, e)
		}
		s = n
		nonces[principal] = c.Nonce
		return r, nil
	}
	for _, account := range []string{alice, bob} {
		if _, err = apply(engine.Command{Op: engine.Register}, account, f.Spec.Start-1, false); err != nil {
			return err
		}
		if _, err = apply(engine.Command{Op: engine.Deposit, Account: account, Amount: 200 * engine.AtomScale, Evidence: evidence(account)}, authority, f.Spec.Start-1, true); err != nil {
			return err
		}
	}
	r, err := apply(engine.Command{Op: engine.CreateRound, Round: &f.Spec}, authority, f.Spec.Start-1, true)
	if err != nil {
		return err
	}
	round := r.RoundID
	// A registry event can be mirrored only after it is included, so the engine clock is
	// already past the event's own time: one second is enough to cross an inclusive deadline.
	// Every window must be judged at the registry time the command carries (finding D7).
	opened, settled := f.OpenedAt+1, f.ResolvedAt+1
	if _, err = apply(engine.Command{Op: engine.OpenRound, RoundID: round, Observation: &f.Opening, Evidence: evidence(f.RegistryRoundID + ":open"), RegistryTime: f.OpenedAt}, authority, opened, true); err != nil {
		return err
	}
	if _, err = apply(engine.Command{Op: engine.Mint, RoundID: round, Quantity: 100 * engine.AtomScale}, alice, opened, false); err != nil {
		return err
	}
	ask, err := apply(engine.Command{Op: engine.PlaceOrder, RoundID: round, Outcome: engine.Up, Side: engine.Sell, Price: 60, Quantity: 20 * engine.AtomScale, TIF: engine.GTC, Expiry: f.Spec.Cutoff, MaxFee: engine.AtomScale}, alice, opened, false)
	if err != nil {
		return err
	}
	fill, err := apply(engine.Command{Op: engine.PlaceOrder, RoundID: round, Outcome: engine.Up, Side: engine.Buy, Price: 70, Quantity: 10 * engine.AtomScale, TIF: engine.IOC, Expiry: f.Spec.Cutoff, MaxFee: engine.AtomScale}, bob, opened, false)
	if err != nil {
		return err
	}
	if len(fill.Fills) != 1 || fill.Fills[0].Price != 60 || fill.Fills[0].Quantity != 10*engine.AtomScale {
		return fmt.Errorf("unexpected execution")
	}
	if _, err = apply(engine.Command{Op: engine.CancelOrder, OrderID: ask.OrderID}, alice, opened, false); err != nil {
		return err
	}
	settle := engine.Command{Op: engine.ResolveRound, RoundID: round, Observation: &f.Closing, Evidence: evidence(f.RegistryRoundID + ":close"), RegistryTime: f.ResolvedAt}
	if f.ExpectedOutcome == engine.Void {
		// The registry voids an opened round only strictly after voidableAfter. The engine must
		// refuse that exact second too, although its own clock is already past it.
		settle = engine.Command{Op: engine.VoidRound, RoundID: round, Evidence: evidence(f.RegistryRoundID + ":void"), RegistryTime: f.Spec.VoidableAfter}
		if _, err = apply(settle, authority, settled, true); err == nil {
			return fmt.Errorf("engine voided at voidableAfter")
		}
		settle.RegistryTime = f.ResolvedAt
	}
	if _, err = apply(settle, authority, settled, true); err != nil {
		return err
	}
	if s.Rounds[0].Outcome != f.ExpectedOutcome {
		return fmt.Errorf("contract/engine outcome mismatch")
	}
	for _, account := range []string{alice, bob} {
		if _, err = apply(engine.Command{Op: engine.Redeem, RoundID: round}, account, settled, false); err != nil {
			return err
		}
	}
	var amount uint64
	for _, a := range s.Accounts {
		if a.ID == bob {
			amount = a.Cash
		}
	}
	w, err := apply(engine.Command{Op: engine.RequestWithdrawal, Amount: amount, Destination: bob}, bob, settled, false)
	if err != nil {
		return err
	}
	if _, err = apply(engine.Command{Op: engine.ExportWithdrawal, WithdrawalID: w.WithdrawalID, Evidence: evidence("withdraw")}, authority, settled, true); err != nil {
		return err
	}
	if _, err = apply(engine.Command{Op: engine.ConfirmClaim, WithdrawalID: w.WithdrawalID, Evidence: evidence("claim")}, authority, settled, true); err != nil {
		return err
	}
	if err = engine.Validate(s); err != nil {
		return err
	}
	stateHash, err := engine.StateHash(s)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		EvaluationOnly  bool           `json:"evaluationOnly"`
		RulesHash       string         `json:"rulesHash"`
		RegistryRoundID string         `json:"registryRoundId"`
		EngineRoundID   string         `json:"engineRoundId"`
		Outcome         engine.Outcome `json:"outcome"`
		Sequence        uint64         `json:"sequence"`
		Deposited       uint64         `json:"deposited"`
		Custody         uint64         `json:"custody"`
		PaidOut         uint64         `json:"paidOut"`
		Fees            uint64         `json:"fees"`
		StateHash       string         `json:"stateHash"`
	}{true, rulesHash, registryRoundID, round, s.Rounds[0].Outcome, s.Sequence, s.Deposited, s.Custody, s.PaidOut, s.Fees, stateHash})
}
