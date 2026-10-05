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
	Type    string `json:"type"`              // "command" or "sync"
	Command string `json:"command,omitempty"` // canonical engine command JSON
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
// kind of command and the number of digits in every amount.
const ReceiptBytes = 2048

// receiptAt is the trusted clock a receipt was produced at: the last tick
// applied before it. A command is judged at that time, not at its own block's.
type receiptAt struct {
	Tick      uint64 `json:"tick"`
	Block     uint64 `json:"block"`
	Timestamp uint64 `json:"timestamp"`
}

// receiptBody is what an account is told. Type "command" answers the account's
// own command, "sync" its own sync, "deposit" reports a credit. Every receipt
// is produced by a request of the account it goes to.
type receiptBody struct {
	Type       string                 `json:"type"`
	Status     string                 `json:"status"`               // applied, retry, rejected, credited, requested
	Reason     string                 `json:"reason,omitempty"`     // rejected only
	Receipt    *engine.PrivateReceipt `json:"receipt,omitempty"`    // engine.ProjectReceipt for this account
	Deposit    uint64                 `json:"deposit,omitempty"`    // ordinal of the credited deposit
	Registered bool                   `json:"registered,omitempty"` // this deposit registered the account; its nonce is now 1
	Withdrawal uint64                 `json:"withdrawal,omitempty"` // ordinal of the withdrawal handed to the endpoint
	At         receiptAt              `json:"at"`
	Tick       uint64                 `json:"tick,omitempty"` // the tick this request asked for
	Pad        string                 `json:"pad"`            // zeros, to the size class
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
// for a tick; and one for the public record of the tick that was applied. The
// trigger answers the second and must ignore the third.
var (
	ReceiptSubType = sha256.Sum256([]byte("zedge.vela.receipt.v1"))
	TickSubType    = sha256.Sum256([]byte("zedge.vela.tick.v1"))
	ClockSubType   = sha256.Sum256([]byte("zedge.vela.clock.v1"))
)

func (s *State) domain() envelopeDomain {
	d := s.Engine.Config.Domain
	return envelopeDomain{d.ChainID, d.Endpoint, d.ApplicationID, s.ApplicationFingerprint, RulesHash(s.Engine.Config), s.Origin}
}

// receipt builds the event the host encrypts to account's registered key,
// stamped with the trusted clock and padded to its size class.
func (s *State) receipt(account, requestID string, body receiptBody) Event {
	body.At, body.Pad = receiptAt{s.LastTick, s.Block, s.Clock}, ""
	e := receiptEnvelope{1, s.domain(), account, s.Epoch, requestID, "receipt", body}
	data, _ := json.Marshal(e)
	if over := len(data) % ReceiptBytes; over != 0 {
		e.Body.Pad = strings.Repeat("0", ReceiptBytes-over)
		data, _ = json.Marshal(e)
	}
	return Event{UserID: account, EventSubType: ReceiptSubType, Data: data}
}
