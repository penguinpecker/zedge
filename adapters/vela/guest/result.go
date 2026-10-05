package guest

import "encoding/json"

// The JSON body every export returns behind a 4-byte little-endian length.
// Shapes follow Vela v0.2.0 pkg/wasm/common; written here, nothing imported.
type Event struct {
	UserID       string   `json:"userId"`
	EventSubType [32]byte `json:"eventSubType"`
	Data         []byte   `json:"data"`
}
type AppEvent struct {
	EventSubType [32]byte `json:"eventSubType"`
	Data         []byte   `json:"data"`
}
type Withdrawal struct {
	TokenAddress       string `json:"tokenAddress"`
	DestinationAddress string `json:"destinationAddress"`
	Amount             string `json:"amount"`
}
type Result struct {
	State       []byte       `json:"state"`
	Events      []Event      `json:"events"`
	AppEvents   []AppEvent   `json:"appEvents"`
	Withdrawals []Withdrawal `json:"withdrawals"`
	Fuel        string       `json:"fuel"`
	Error       string       `json:"error,omitempty"`
}

// Fuel is self-reported on v0.2.0 and nothing meters the guest, so it is a
// constant: the fee is then the endpoint's minimum.
const fuel = "0x1"

// Public error strings. The host signs them into an on-chain failure, so they
// are constants that say nothing about any account. Engine rejections never
// travel this way: they go to the sender inside an encrypted receipt.
const (
	ErrBuffer      = "zedge: bad buffer"
	ErrParams      = "zedge: malformed parameters"
	ErrConfig      = "zedge: invalid configuration"
	ErrState       = "zedge: invalid state"
	ErrApplication = "zedge: wrong application"
	ErrSender      = "zedge: malformed sender"
	ErrToken       = "zedge: unsupported token"
	ErrAmount      = "zedge: invalid amount"
	ErrClock       = "zedge: clock not initialised"
	ErrDeposit     = "zedge: deposit rejected"
	ErrRequestType = "zedge: unsupported request type"
	ErrEnvelope    = "zedge: malformed envelope"
	ErrContext     = "zedge: wrong context"
	ErrMismatch    = "zedge: sender mismatch"
	ErrCommand     = "zedge: malformed command"
	ErrTrusted     = "zedge: malformed trusted payload"
	ErrTick        = "zedge: stale or unknown tick"
	ErrTime        = "zedge: clock regression"
	ErrInternal    = "zedge: internal error"
)

func (r Result) bytes() []byte {
	r.Fuel = fuel
	b, err := json.Marshal(r)
	if err != nil {
		return []byte(`{"error":"wasm serialization error"}`) // the host's reserved sentinel
	}
	return b
}

func failure(message string) []byte { return Result{Error: message}.bytes() }

// BadBuffer is the result for a pointer the module did not hand out.
func BadBuffer() []byte { return failure(ErrBuffer) }
