// Package guest adapts the ZEDGE engine to the Vela v0.2.0 guest ABI for the
// local evaluation slice. Everything here is ordinary Go with no clock, no
// randomness and no map iteration; cmd/zedge-guest is the thin wasm layer.
// README.md is the protocol. Nothing in this package authenticates the host.
package guest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/penguinpecker/zedge/engine"
)

const (
	StateVersion    = 1
	MaxParamsBytes  = 16 << 10
	MaxPayloadBytes = 16_384 // MAX_PAYLOAD_BYTES in adapters/vela/crypto/session.ts
	// MaxStateBytes is the largest state the guest serves, and the largest
	// buffer the wasm layer hands the host. It is a measured bound, not the
	// engine's 8 MiB: TinyGo's collector keeps dead buffers that a constant in
	// the data section happens to point into, so larger states grow linear
	// memory without limit (README section 3). TestGuestSoak holds it.
	MaxStateBytes = 512 << 10
	// MaxClock is the largest block timestamp a tick may carry. No engine
	// round can start beyond it, and a wrong unit (milliseconds) is above it.
	MaxClock    = 1<<32 - 1
	maxEvidence = 4096 // the engine's external-evidence capacity
)

// DeployParams are the constructor parameters. Engine.Domain.ApplicationID
// must be empty: the application ID is derived on chain from the deploy
// request, so only the host can supply it.
type DeployParams struct {
	Engine                 engine.Config `json:"engine"`
	ApplicationFingerprint string        `json:"applicationFingerprint"`
	Origin                 string        `json:"origin"`
	Epoch                  string        `json:"epoch"`
}

// Staged is a book command (place_order, cancel_order, cancel_all) waiting for
// the tick that carries its commit timestamp. Designed, not built: this build
// never stages and refuses a state that holds one.
type Staged struct {
	Tick    uint64         `json:"tick"`
	Command engine.Command `json:"command"`
}

// Notice counts the receipts an account was sent that carry no command ID: in
// this build, its deposit receipts. The count is the last number used in
// "<account>:notice:<n>".
type Notice struct {
	Account string `json:"account"`
	Count   uint64 `json:"count"`
}

// State is the whole application state the host stores between calls.
type State struct {
	Version                uint32        `json:"version"`
	ApplicationFingerprint string        `json:"applicationFingerprint"`
	Origin                 string        `json:"origin"`
	Epoch                  string        `json:"epoch"`
	Salt                   string        `json:"salt"`        // 32 random bytes drawn at deploy; keeps the public state root unguessable
	Clock                  uint64        `json:"clock"`       // block.timestamp of the last accepted tick, 0 before the first
	Block                  uint64        `json:"block"`       // block.number that tick reported; recorded, never compared
	TickSeq                uint64        `json:"tickSeq"`     // ticks requested so far
	LastTick               uint64        `json:"lastTick"`    // highest tick applied
	Staged                 []Staged      `json:"staged"`      // always empty in this build
	Deposits               uint64        `json:"deposits"`    // credited deposits; the next one's ordinal is +1
	Withdrawals            uint64        `json:"withdrawals"` // withdrawals handed to the endpoint
	Notices                []Notice      `json:"notices"`     // sorted by account
	Engine                 *engine.State `json:"engine"`
}

func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

const zeroSalt = "0000000000000000000000000000000000000000000000000000000000000000"

func isAddress(s string) bool {
	return len(s) == 42 && s[:2] == "0x" && isHex(s[2:], 40) && s != "0x0000000000000000000000000000000000000000"
}

// The networks session.ts accepts: local Anvil, Horizen testnet, Base Sepolia.
func evaluationChain(id uint64) bool { return id == 31337 || id == 2651420 || id == 84532 }

func applicationID(s string) bool {
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && n > 0 && strconv.FormatUint(n, 10) == s
}

// originValid checks the shape only; session.ts enforces the URL rules, and a
// deployment whose origin it refuses can never be addressed.
func originValid(s string) bool {
	rest := ""
	switch {
	case len(s) > 8 && s[:8] == "https://":
		rest = s[8:]
	case len(s) > 7 && s[:7] == "http://":
		rest = s[7:]
	}
	if rest == "" || len(rest) > 253 {
		return false
	}
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == ':' || c == '[' || c == ']') {
			return false
		}
	}
	return true
}

func epochValid(s string) bool {
	if len(s) < 1 || len(s) > 10 || s[0] == '0' {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// canonical decodes b into v and reports whether b is exactly the encoding
// json.Marshal gives back. That rejects unknown and duplicate keys, other key
// orders, whitespace and trailing bytes. v must hold no interface-typed field:
// decoding into one recurses once per nesting level, and a wasm stack is small.
func canonical(b []byte, v any) bool {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return false
	}
	again, err := json.Marshal(v)
	return err == nil && bytes.Equal(again, b)
}

func (s *State) validate() error {
	if s == nil || s.Version != StateVersion || !isHex(s.ApplicationFingerprint, 64) || !originValid(s.Origin) || !epochValid(s.Epoch) ||
		!isHex(s.Salt, 64) || s.Salt == zeroSalt {
		return errors.New("invalid adapter identity")
	}
	if err := engine.Validate(s.Engine); err != nil {
		return err
	}
	e := s.Engine
	// The trigger reads the registry in the block whose timestamp it reports,
	// so the registry must be on the endpoint's own chain.
	if d := e.Config.Domain; !evaluationChain(d.ChainID) || !applicationID(d.ApplicationID) || e.Config.Oracle.ChainID != d.ChainID {
		return errors.New("not an evaluation deployment")
	}
	if s.Clock > MaxClock || s.Block > engine.MaxAtoms || s.TickSeq > engine.MaxAtoms || s.LastTick > s.TickSeq ||
		(s.LastTick == 0) != (s.Clock == 0) || e.Time > s.Clock {
		return errors.New("invalid clock")
	}
	if s.Staged == nil || len(s.Staged) != 0 {
		return errors.New("staged commands are not supported by this build")
	}
	// Every evidence ID in the engine is one this adapter derived: one per
	// deposit, two per withdrawal. No withdrawal outlives its transition.
	if s.Deposits > maxEvidence || s.Withdrawals > maxEvidence || uint64(len(e.ExternalEvidence)) != s.Deposits+2*s.Withdrawals ||
		e.Claimable != 0 || len(e.Withdrawals) != 0 {
		return errors.New("custody bookkeeping mismatch")
	}
	if s.Notices == nil || len(s.Notices) > engine.MaxAccounts {
		return errors.New("invalid notices")
	}
	for i, n := range s.Notices {
		if !isAddress(n.Account) || n.Count == 0 || n.Count > engine.MaxAtoms || i > 0 && s.Notices[i-1].Account >= n.Account {
			return errors.New("invalid notices")
		}
	}
	return nil
}

func (s *State) encode() ([]byte, error) {
	if err := s.validate(); err != nil {
		return nil, err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxStateBytes {
		return nil, errors.New("state capacity")
	}
	return b, nil
}

// DecodeState accepts only the canonical encoding of a valid state.
func DecodeState(b []byte) (*State, error) {
	if len(b) == 0 || len(b) > MaxStateBytes {
		return nil, errors.New("state size out of bounds")
	}
	var s State
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return nil, err
	}
	again, err := s.encode()
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(again, b) {
		return nil, errors.New("noncanonical state")
	}
	return &s, nil
}

// RulesHash is the envelope domain's rulesHash: SHA-256 of the canonical
// engine configuration (domain, authority, collateral, fee, oracle policy).
func RulesHash(c engine.Config) string {
	b, _ := json.Marshal(c)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// evidence derives the ID the engine deduplicates for the n-th deposit,
// withdrawal export or claim credit of this deployment. It names an ordinal,
// not a chain event: v0.2.0 gives the guest no request identity to bind.
func (s *State) evidence(kind string, ordinal uint64) string {
	d := s.Engine.Config.Domain
	h := sha256.Sum256([]byte("ZEDGE_VELA_V1:" + kind + ":" + strconv.FormatUint(d.ChainID, 10) + ":" + d.Endpoint + ":" + d.ApplicationID + ":" + strconv.FormatUint(ordinal, 10)))
	return hex.EncodeToString(h[:])
}

// nextNotice returns the request ID for the next unsolicited receipt to account.
func (s *State) nextNotice(account string) string {
	i := 0
	for i < len(s.Notices) && s.Notices[i].Account < account {
		i++
	}
	if i == len(s.Notices) || s.Notices[i].Account != account {
		s.Notices = append(s.Notices, Notice{})
		copy(s.Notices[i+1:], s.Notices[i:])
		s.Notices[i] = Notice{Account: account}
	}
	s.Notices[i].Count++
	return account + ":notice:" + strconv.FormatUint(s.Notices[i].Count, 10)
}
