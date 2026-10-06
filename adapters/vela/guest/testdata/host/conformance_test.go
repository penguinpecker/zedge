// EVALUATION ONLY: software TEE, no attestation, test token, fixture oracle; sender,
// amount and time are trusted from the manager. Not private, not secure, not
// production-ready.
//
// This file is ZEDGE code, but it only compiles inside the upstream Vela module:
// TestUpstreamConformance copies it to build/upstream/vela-*/app/zedgeconformance
// and runs it there. It drives the built guest through upstream's own host
// runtime and requires every result to equal what the adapter returned
// natively. No chain, no enclave, no encryption: the runtime boundary only.
package zedgeconformance_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/HorizenOfficial/vela/pkg/common"
	"github.com/HorizenOfficial/vela/pkg/logger"
	vela_wasm "github.com/HorizenOfficial/vela/pkg/wasm"
	ethCommon "github.com/ethereum/go-ethereum/common"
)

type event struct {
	UserID       string   `json:"userId"`
	EventSubType [32]byte `json:"eventSubType"`
	Data         []byte   `json:"data"`
}
type withdrawal struct {
	TokenAddress       string `json:"tokenAddress"`
	DestinationAddress string `json:"destinationAddress"`
	Amount             string `json:"amount"`
}
type step struct {
	Name        string       `json:"name"`
	Call        string       `json:"call"`
	Sender      string       `json:"sender"`
	Token       string       `json:"token"`
	Amount      uint64       `json:"amount"`
	Payload     []byte       `json:"payload"`
	Error       string       `json:"error"`
	HostError   string       `json:"hostError"`
	StateSHA256 string       `json:"stateSha256"`
	EngineHash  string       `json:"engineHash"`
	Events      []event      `json:"events"`
	AppEvents   []event      `json:"appEvents"`
	Withdrawals []withdrawal `json:"withdrawals"`
}

func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestGuestMatchesNativeAdapter(t *testing.T) {
	wasm, err := os.ReadFile(os.Getenv("ZEDGE_GUEST_WASM"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(os.Getenv("ZEDGE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Application uint64 `json:"application"`
		Salt        string `json:"salt"` // the salt the native run deployed with
		Steps       []step `json:"steps"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	log := logger.NewLogger(&logger.Config{Kind: "zerolog", Console: true, ConsoleLevel: "error"})
	ctx, app := context.Background(), common.NewApplicationId(fixture.Application)
	rt := vela_wasm.NewWasmtimeRuntime(log, 0)
	defer func() { _ = rt.Close() }()

	var state []byte
	var slowest, final time.Duration
	var slowestName string
	started := time.Now()
	for _, s := range fixture.Steps {
		var next []byte
		var events []common.PlainEvent
		var appEvents []common.AppEvent
		var withdrawals []common.Withdrawal
		var message string
		began := time.Now()
		switch s.Call {
		case "deploy":
			if next, _, err = rt.Deploy(ctx, app, s.Payload, wasm); err != nil {
				message = err.Error()
			}
		case "deposit":
			st, ev, ae, _, failure := rt.Deposit(ctx, app, ethCommon.HexToAddress(s.Sender), ethCommon.HexToAddress(s.Token), new(big.Int).SetUint64(s.Amount), state, wasm)
			if next, events, appEvents = st, ev, ae; failure != nil {
				message = failure.ExternalMessage()
			}
		case "process", "trusted":
			kind, sender := common.Process, ethCommon.HexToAddress(s.Sender)
			if s.Call == "trusted" {
				kind, sender = common.TrustProcess, ethCommon.Address{}
			}
			st, ev, ae, w, report, _, failure := rt.ProcessRequest(ctx, app, sender, kind, s.Payload, state, wasm)
			if next, events, appEvents, withdrawals = st, ev, ae, w; failure != nil {
				message = failure.ExternalMessage()
			}
			if len(report) != 0 {
				t.Fatalf("%s: the guest produced a report", s.Name)
			}
		case "restart":
			// A new runtime has no cached module. All that survives is the state.
			_ = rt.Close()
			rt = vela_wasm.NewWasmtimeRuntime(log, 0)
			continue
		case "load":
			// A state built natively (the state at every cap): the host stores it as it is.
			state = s.Payload
			continue
		default:
			t.Fatalf("%s: unknown call %q", s.Name, s.Call)
		}
		if d := time.Since(began); d > slowest && s.Call != "deploy" {
			slowest, slowestName = d, s.Name
		}
		if d := time.Since(began); d > 100*time.Millisecond && s.Call != "deploy" {
			t.Logf("%s: %s", s.Name, d.Round(time.Millisecond))
		}

		if s.Error != "" {
			// The guest's own error text must come back. A trap would not carry it.
			// Where the host has to refuse before the guest runs, its text is named.
			want := s.Error
			if s.HostError != "" {
				want = s.HostError
			}
			if !strings.Contains(message, want) {
				t.Fatalf("%s: host reported %q, want %q", s.Name, message, want)
			}
			continue
		}
		if message != "" {
			t.Fatalf("%s: host reported %q, the native adapter succeeded", s.Name, message)
		}
		if s.Call == "deploy" {
			// The guest draws its salt from this host's random source, so its first
			// state differs from the native one in that field and nowhere else.
			// Every later step then runs on the native salt: the guest keeps nothing
			// between calls, so the state it is handed is all there is.
			var drawn struct {
				Salt string `json:"salt"`
			}
			if err = json.Unmarshal(next, &drawn); err != nil || len(drawn.Salt) != 64 || drawn.Salt == fixture.Salt || strings.Trim(drawn.Salt, "0") == "" {
				t.Fatalf("deploy: the guest's salt is %q", drawn.Salt)
			}
			next = bytes.Replace(next, []byte(drawn.Salt), []byte(fixture.Salt), 1)
			t.Logf("deploy drew salt %s…", drawn.Salt[:8])
		}
		state, final = next, time.Since(began)
		if got := digest(state); got != s.StateSHA256 {
			t.Fatalf("%s: guest state %s, native state %s", s.Name, got, s.StateSHA256)
		}
		var wrapper struct {
			Engine json.RawMessage `json:"engine"`
		}
		if err = json.Unmarshal(state, &wrapper); err != nil {
			t.Fatal(err)
		}
		if got := digest(wrapper.Engine); got != s.EngineHash {
			t.Fatalf("%s: guest engine state hash %s, native %s", s.Name, got, s.EngineHash)
		}
		if len(events) != len(s.Events) || len(appEvents) != len(s.AppEvents) || len(withdrawals) != len(s.Withdrawals) {
			t.Fatalf("%s: %d events, %d app events, %d withdrawals; native %d, %d, %d", s.Name, len(events), len(appEvents), len(withdrawals), len(s.Events), len(s.AppEvents), len(s.Withdrawals))
		}
		for i, e := range events {
			if w := s.Events[i]; strings.ToLower(e.UserID.Hex()) != w.UserID || e.EventSubType != w.EventSubType || !bytes.Equal(e.Data, w.Data) {
				t.Fatalf("%s: event %d differs from the native adapter", s.Name, i)
			}
		}
		for i, e := range appEvents {
			if w := s.AppEvents[i]; e.EventSubType != w.EventSubType || !bytes.Equal(e.Data, w.Data) {
				t.Fatalf("%s: app event %d differs from the native adapter", s.Name, i)
			}
		}
		for i, got := range withdrawals {
			w := s.Withdrawals[i]
			amount, ok := new(big.Int).SetString(strings.TrimPrefix(w.Amount, "0x"), 16)
			if !ok || strings.ToLower(got.TokenAddress.Hex()) != w.TokenAddress || strings.ToLower(got.DestinationAddress.Hex()) != w.DestinationAddress || got.Amount.ToInt().Cmp(amount) != 0 {
				t.Fatalf("%s: withdrawal %d differs from the native adapter", s.Name, i)
			}
		}
	}
	last := fixture.Steps[len(fixture.Steps)-1]
	if got := digest(state); got != last.StateSHA256 {
		t.Fatalf("final guest state %s, native state %s", got, last.StateSHA256)
	}
	t.Logf("%d steps in %s; final state %d bytes; engine state hash %s; last accepted step %s; slowest step after deploy %s (%q)",
		len(fixture.Steps), time.Since(started).Round(time.Millisecond), len(state), last.EngineHash, final.Round(time.Microsecond), slowest.Round(time.Microsecond), slowestName)
}
