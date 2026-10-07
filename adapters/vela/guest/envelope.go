package guest

import (
	"crypto/sha256"
	"encoding/json"
	"strings"

	"github.com/penguinpecker/zedge/engine"
)

// The plaintext adapters/vela/crypto/session.ts encrypts, in the key order
// JSON.stringify gives it. A receipt is the same envelope with kind "receipt".
type envelopeDomain struct {
	ChainID                uint64 `json:"chainId"`
	Endpoint               string `json:"endpoint"`
	ApplicationID          string `json:"applicationId"`
	ApplicationFingerprint string `json:"applicationFingerprint"`
	RulesHash              string `json:"rulesHash"`
	Origin                 string `json:"origin"`
}
type requestBody struct {
	Type    string `json:"type"`              // "command", "sync" or "report"
	Command string `json:"command,omitempty"` // canonical engine command JSON
	Report  string `json:"report,omitempty"`  // standard base64 of a Chainlink full report
	Pad     string `json:"pad"`               // zeros, so that the envelope is RequestBytes long
}
type requestEnvelope struct {
	Version   uint32         `json:"version"`
	Domain    envelopeDomain `json:"domain"`
	Account   string         `json:"account"`
	Epoch     string         `json:"epoch"`
	RequestID string         `json:"requestId"`
	Kind      string         `json:"kind"`
	Body      requestBody    `json:"body"`
}

// ReceiptBytes is the size class of a receipt's plaintext: every receipt is
// padded to the next multiple of it, and every receipt this build can produce
// fits in one (TestReceiptsAreOneSize). The executor encrypts without padding,
// so the on-chain length would otherwise give away the refusal reason, the
// kind of command, whether an outcome came back and the size of the account.
const ReceiptBytes = 8192

// RequestBytes is the one length of a request's plaintext: the client pads the
// body with zeros to it (adapters/vela/crypto/pad.ts), and the guest refuses
// any other length. The executor's ciphertext adds a fixed 28 bytes, so
// without this the on-chain request would give away the kind of command and,
// for an order, its outcome and side. Every request that could be accepted
// fits (TestRequestsAreOneSize).
const RequestBytes = 2048

// receiptAt is the trusted clock a receipt was produced at: the last tick
// applied before it. A command is judged at that time, not at its own block's.
type receiptAt struct {
	Tick      uint64 `json:"tick"`
	Block     uint64 `json:"block"`
	Timestamp uint64 `json:"timestamp"`
}

// receiptBody is what an account is told. Type "command" answers the account's
// own command, "sync" its own sync, "report" its own Chainlink report. Every
// receipt is produced by a request of the account it goes to.
type receiptBody struct {
	Type       string                  `json:"type"`
	Status     string                  `json:"status"`               // applied, retry, rejected, staged, requested
	Reason     string                  `json:"reason,omitempty"`     // rejected only
	Receipt    *engine.PrivateReceipt  `json:"receipt,omitempty"`    // engine.ProjectReceipt for this account
	Withdrawal uint64                  `json:"withdrawal,omitempty"` // payout ordinal of the accepted withdrawal
	Outcome    *outcomeReceipt         `json:"outcome,omitempty"`    // what a tick did with this account's staged command
	View       *engine.AccountSnapshot `json:"view,omitempty"`       // the account after this request; absent if it is not registered
	At         receiptAt               `json:"at"`
	Tick       uint64                  `json:"tick,omitempty"` // the tick this request asked for; absent on a report
	Pad        string                  `json:"pad"`            // zeros, to the size class
}

// outcomeReceipt is an outcome as its account collects it. An applied one
// carries the engine receipt of that command (its fills) for as long as it is
// still the account's stored last receipt.
type outcomeReceipt struct {
	Outcome
	Receipt *engine.PrivateReceipt `json:"receipt,omitempty"`
}
type receiptEnvelope struct {
	Version   uint32         `json:"version"`
	Domain    envelopeDomain `json:"domain"`
	Account   string         `json:"account"`
	Epoch     string         `json:"epoch"`
	RequestID string         `json:"requestId"`
	Kind      string         `json:"kind"`
	Body      receiptBody    `json:"body"`
}

// One constant subtype for every user event, so a subtype never names a
// recipient or a kind of receipt (unless the recipient registered a subtype
// seed with Vela: the executor then replaces it); one for the public request
// for a tick; and one for each public record (README section 11). The
// trigger answers the tick request and must ignore every other subtype.
var (
	ReceiptSubType = sha256.Sum256([]byte("zedge.vela.receipt.v1"))
	TickSubType    = sha256.Sum256([]byte("zedge.vela.tick.v1"))
	ClockSubType   = sha256.Sum256([]byte("zedge.vela.clock.v1"))
	ArchiveSubType = sha256.Sum256([]byte("zedge.vela.archive.v1"))
	SettleSubType  = sha256.Sum256([]byte("zedge.vela.settle.v1"))
	CreditSubType  = sha256.Sum256([]byte("zedge.vela.credit.v1"))
	PayoutSubType  = sha256.Sum256([]byte("zedge.vela.payout.v1"))
	ConfirmSubType = sha256.Sum256([]byte("zedge.vela.confirm.v1"))
)

func (s *State) domain() envelopeDomain {
	d := s.Engine.Config.Domain
	return envelopeDomain{d.ChainID, d.Endpoint, d.ApplicationID, s.ApplicationFingerprint, RulesHash(s.Engine.Config), s.Origin}
}

// receipt builds the event the host encrypts to account's registered key,
// stamped with the trusted clock, carrying the outcome this request collected
// and the account's view after it, and padded to its size class.
func (s *State) receipt(account, requestID string, body receiptBody) Event {
	body.At, body.Pad = receiptAt{s.LastTick, s.Block, s.Clock}, ""
	if s.taken != nil && s.taken.Account == account {
		body.Outcome = s.taken
	}
	if v, err := engine.AccountView(s.Engine, account); err == nil {
		body.View = &v
	}
	e := receiptEnvelope{1, s.domain(), account, s.Epoch, requestID, "receipt", body}
	data, _ := json.Marshal(e)
	if over := len(data) % ReceiptBytes; over != 0 {
		e.Body.Pad = strings.Repeat("0", ReceiptBytes-over)
		data, _ = json.Marshal(e)
	}
	return Event{UserID: account, EventSubType: ReceiptSubType, Data: data}
}
