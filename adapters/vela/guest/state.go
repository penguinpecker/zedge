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
	"slices"
	"strconv"
	"strings"

	"github.com/penguinpecker/zedge/engine"
)

const (
	StateVersion   = 3
	MaxParamsBytes = 16 << 10
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

	// The adapter's own caps (README section 9). The engine allows far more, but
	// a state with every one of these reached still fits MaxStateBytes
	// (TestStateAtEveryCapFitsTheBound), and a state past the bound could never
	// be shrunk again.
	MaxSliceAccounts = 32
	MaxSliceRounds   = 8
	MaxSliceMarkets  = 1
	MaxAccountOrders = 4  // active orders per account
	MaxFills         = 4  // fills per activated command
	MaxActivations   = 16 // staged commands applied per tick
	MaxSweeps        = 16 // settlement redeems per tick
	MaxArchives      = 4  // rounds archived per tick
	MaxRecords       = 16 // registry records in one trusted payload
	// MaxStagedBytes bounds a staged command's canonical JSON. Every book
	// command the engine could accept is at most 519 bytes; without the bound
	// 32 accounts could each park an 8 KiB command in the state until its tick.
	MaxStagedBytes = 576

	// HorizenMainnet is the one production chain. Its deployment mirrors one
	// market, BTC 900 (README section 2).
	HorizenMainnet = 26514
	// MinPublicCutoffBuffer is the least cutoff buffer, in seconds, a
	// deployment on any chain but local Anvil may have: twice the worst
	// measured sum of block-time lag and submission-to-commit wait (README
	// section 9, Cutoff).
	MinPublicCutoffBuffer = 30
)

// DeployParams are the constructor parameters. Engine.Domain.ApplicationID
// must be empty: the application ID is derived on chain from the deploy
// request, so only the host can supply it.
type DeployParams struct {
	Engine                 engine.Config `json:"engine"`
	ApplicationFingerprint string        `json:"applicationFingerprint"`
	Origin                 string        `json:"origin"`
	Epoch                  string        `json:"epoch"`
	Markets                []Market      `json:"markets"`
	StakeLimits            StakeLimits   `json:"stakeLimits"`
}

// StakeLimits bound what can ride on round outcomes, in collateral atoms
// (README section 9, Stake limits). They are fixed at deploy.
type StakeLimits struct {
	Account    uint64 `json:"account"`    // any account but the house, in one round
	Boundary   uint64 `json:"boundary"`   // every account but the house together, in the rounds that end at one time
	House      string `json:"house"`      // the market maker's account, exempt from the two above
	HouseTotal uint64 `json:"houseTotal"` // the house, in every open round together
}

// Market is one registry schedule the deployment mirrors (README section 10).
type Market struct {
	Asset    string `json:"asset"`    // BTC or ETH
	Duration uint64 `json:"duration"` // 300 or 900 seconds
}

// Staged is a book command (place_order, cancel_order, cancel_all) waiting for
// the tick that carries its commit timestamp (README section 9).
type Staged struct {
	Tick    uint64         `json:"tick"` // the tick its staging request asked for
	Command engine.Command `json:"command"`
}

// Outcome is what activation did with an account's staged command. The account
// collects it with its next accepted request.
type Outcome struct {
	Account   string `json:"account"`
	CommandID string `json:"commandId"`
	Tick      uint64 `json:"tick"`
	Status    string `json:"status"`           // applied or rejected
	Reason    string `json:"reason,omitempty"` // rejected only
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
	Markets                []Market      `json:"markets"`
	StakeLimits            StakeLimits   `json:"stakeLimits"`
	Salt                   string        `json:"salt"`        // 32 random bytes drawn at deploy; keeps the public state root unguessable
	Clock                  uint64        `json:"clock"`       // block.timestamp of the last accepted tick, 0 before the first
	Block                  uint64        `json:"block"`       // block.number that tick reported; recorded, never compared
	TickSeq                uint64        `json:"tickSeq"`     // ticks requested so far
	LastTick               uint64        `json:"lastTick"`    // highest tick applied
	Staged                 []Staged      `json:"staged"`      // ascending tick, at most one per account
	Outcomes               []Outcome     `json:"outcomes"`    // sorted by account, at most one per account
	Deposits               uint64        `json:"deposits"`    // credited deposits; the next one's ordinal is +1
	Withdrawals            uint64        `json:"withdrawals"` // withdrawals handed to the endpoint
	Notices                []Notice      `json:"notices"`     // sorted by account
	Engine                 *engine.State `json:"engine"`

	taken *outcomeReceipt // the outcome this request's receipt hands back; never stored
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

// The networks session.ts accepts: local Anvil, Horizen mainnet, Horizen
// testnet, Base Sepolia.
func supportedChain(id uint64) bool {
	return id == 31337 || id == HorizenMainnet || id == 2651420 || id == 84532
}

func marketValid(m Market) bool {
	return (m.Asset == "BTC" || m.Asset == "ETH") && (m.Duration == 300 || m.Duration == 900)
}

func bookOp(op engine.Operation) bool {
	return op == engine.PlaceOrder || op == engine.CancelOrder || op == engine.CancelAll
}

func account(e *engine.State, id string) *engine.Account {
	for i := range e.Accounts {
		if e.Accounts[i].ID == id {
			return &e.Accounts[i]
		}
	}
	return nil
}

func activeOrders(e *engine.State, id string) int {
	n := 0
	for _, o := range e.Orders {
		if o.Account == id {
			n++
		}
	}
	return n
}

// stakes is, for every account and every round of e (in their orders), what
// the account has riding on that round's outcome, in two measures. worst is
// the most its payout if Up and its payout if Down can differ once its resting
// orders have filled in whichever way widens that gap: shares count whether
// free or reserved by a sell, and a resting buy counts as bought, so neither
// minting and selling nor splitting into small orders hides any. held is that
// gap for the shares it holds now, those offered for sale included, and
// counts no resting buy. A complete set counts nothing in either. Only open
// rounds count: a scheduled round holds nothing, a settled one risks nothing.
// e must have passed engine.Validate.
func stakes(e *engine.State) (worst, held [][]int64) {
	at := func(round string) int {
		return slices.IndexFunc(e.Rounds, func(m engine.Round) bool { return m.ID == round })
	}
	worst, held = make([][]int64, len(e.Accounts)), make([][]int64, len(e.Accounts))
	for i, a := range e.Accounts {
		up, down, gap := make([]int64, len(e.Rounds)), make([]int64, len(e.Rounds)), make([]int64, len(e.Rounds))
		for _, h := range a.Holdings {
			r := at(h.RoundID)
			up[r] += int64(h.Up+h.ReservedUp) - int64(h.Down)
			down[r] += int64(h.Down+h.ReservedDown) - int64(h.Up)
			gap[r] += int64(h.Up+h.ReservedUp) - int64(h.Down+h.ReservedDown)
		}
		for _, o := range e.Orders {
			if o.Account == a.ID && o.Side == engine.Buy {
				if o.Outcome == engine.Up {
					up[at(o.RoundID)] += int64(o.Remaining)
				} else {
					down[at(o.RoundID)] += int64(o.Remaining)
				}
			}
		}
		worst[i], held[i] = make([]int64, len(e.Rounds)), make([]int64, len(e.Rounds))
		for r, m := range e.Rounds {
			if m.Status == "open" {
				worst[i][r], held[i][r] = max(up[r], down[r]), max(gap[r], -gap[r])
			}
		}
	}
	return worst, held
}

// exceeded names the first stake limit e breaks, or is empty. The per-account
// and house limits are on worst stakes, the all-accounts limit on held ones: a
// resting buy locks only its price, so counted at its size, a few one-cent
// bids would fill the shared limit for everyone else at almost no cost. Only a
// place_order can raise a stake: a fill never raises a maker's worst stake,
// which already counted the order as filled, and it raises held stakes only
// inside the place_order that makes it, which is checked here against the
// whole ledger. So a ledger within the limits stays within them unless a
// place_order is refused here.
func (l StakeLimits) exceeded(e *engine.State) string {
	worst, held := stakes(e)
	var house int64
	users := make([]int64, len(e.Rounds)) // every account but the house, per round
	for i, a := range e.Accounts {
		for r, v := range worst[i] {
			switch {
			case a.ID == l.House:
				house += v
			case v > int64(l.Account):
				return "stake limit: account per round"
			default:
				users[r] += held[i][r]
			}
		}
	}
	if house > int64(l.HouseTotal) {
		return "stake limit: house total"
	}
	for _, m := range e.Rounds {
		var total int64
		for r, n := range e.Rounds {
			if n.Spec.End == m.Spec.End {
				total += users[r]
			}
		}
		if total > int64(l.Boundary) {
			return "stake limit: all accounts at this closing time"
		}
	}
	return ""
}

// valid checks the limits' shapes and, against the engine configuration c,
// that they can work: a per-account limit above the all-accounts one could
// never bind, and the house must be an account that can trade (the authority
// never can) and not the endpoint or the token.
func (l StakeLimits) valid(c engine.Config) bool {
	for _, v := range []uint64{l.Account, l.Boundary, l.HouseTotal} {
		if v == 0 || v > engine.MaxAtoms {
			return false
		}
	}
	return l.Account <= l.Boundary && isAddress(l.House) && l.House != c.Authority && l.House != c.Domain.Endpoint && l.House != c.Collateral
}

func marshalCommand(c engine.Command) []byte { b, _ := json.Marshal(c); return b }

// stagedBy is the index of the account's staged command, or -1.
func (s *State) stagedBy(id string) int {
	for i, x := range s.Staged {
		if x.Command.Account == id {
			return i
		}
	}
	return -1
}

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
		!isHex(s.Salt, 64) || s.Salt == zeroSalt || len(s.Markets) < 1 || len(s.Markets) > MaxSliceMarkets {
		return errors.New("invalid adapter identity")
	}
	for _, m := range s.Markets {
		if !marketValid(m) {
			return errors.New("invalid market")
		}
	}
	if err := engine.Validate(s.Engine); err != nil {
		return err
	}
	e := s.Engine
	if !s.StakeLimits.valid(e.Config) {
		return errors.New("invalid adapter identity")
	}
	// The trigger reads the registry in the block whose timestamp it reports,
	// so the registry must be on the endpoint's own chain. A public chain's
	// clock runs on real time, so its cutoff buffer has a floor. On mainnet
	// the trading fee is 0: no engine operation pays collected fees out, so
	// they would stay in the endpoint's custody for good.
	if d := e.Config.Domain; !supportedChain(d.ChainID) || !applicationID(d.ApplicationID) || e.Config.Oracle.ChainID != d.ChainID ||
		d.ChainID != 31337 && e.Config.Oracle.CutoffBuffer < MinPublicCutoffBuffer ||
		d.ChainID == HorizenMainnet && (!slices.Equal(s.Markets, []Market{{"BTC", 900}}) || e.Config.FeeBps != 0) {
		return errors.New("not a supported deployment")
	}
	if s.Clock > MaxClock || s.Block > engine.MaxAtoms || s.TickSeq > engine.MaxAtoms || s.LastTick > s.TickSeq ||
		(s.LastTick == 0) != (s.Clock == 0) || e.Time > s.Clock {
		return errors.New("invalid clock")
	}
	if len(e.Accounts) > MaxSliceAccounts || len(e.Rounds) > MaxSliceRounds {
		return errors.New("slice capacity")
	}
	for _, a := range e.Accounts {
		if activeOrders(e, a.ID) > MaxAccountOrders {
			return errors.New("slice capacity")
		}
	}
	if reason := s.StakeLimits.exceeded(e); reason != "" {
		return errors.New(reason)
	}
	// A staged command is its account's next one, so nothing else of that
	// account can have been accepted since; one per account, in tick order.
	if s.Staged == nil || s.Outcomes == nil {
		return errors.New("invalid staged commands or outcomes")
	}
	for i, x := range s.Staged {
		a := account(e, x.Command.Account)
		if !bookOp(x.Command.Op) || a == nil || x.Command.Nonce != a.Nonce+1 || len(marshalCommand(x.Command)) > MaxStagedBytes || x.Tick == 0 || x.Tick > s.TickSeq ||
			i > 0 && s.Staged[i-1].Tick >= x.Tick || s.stagedBy(a.ID) != i {
			return errors.New("invalid staged command")
		}
	}
	for i, o := range s.Outcomes {
		if account(e, o.Account) == nil || !strings.HasPrefix(o.CommandID, o.Account+":") || o.Tick == 0 || o.Tick > s.LastTick ||
			o.Status != "applied" && o.Status != "rejected" || (o.Status == "applied") != (o.Reason == "") || i > 0 && s.Outcomes[i-1].Account >= o.Account {
			return errors.New("invalid outcome")
		}
	}
	// Every evidence ID in the engine is one this adapter derived: one per
	// deposit, two per withdrawal. No withdrawal outlives its transition.
	if s.Deposits > maxEvidence || s.Withdrawals > maxEvidence || uint64(len(e.ExternalEvidence)) != s.Deposits+2*s.Withdrawals ||
		e.Claimable != 0 || len(e.Withdrawals) != 0 {
		return errors.New("custody bookkeeping mismatch")
	}
	if s.Notices == nil || len(s.Notices) > MaxSliceAccounts {
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
