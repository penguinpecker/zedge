package guest

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"

	"github.com/penguinpecker/zedge/engine"
)

// The five entry points below take the host's arguments as plain bytes and
// return the result JSON. They never panic: a TinyGo panic is a wasm trap, and
// v0.2.0 keeps a trapped instance cached. Whatever they cannot accept becomes a
// result with a public error string, and the host leaves the state alone.

const requestTypeProcess = 1 // common.Process; the only type process_request accepts

// open decodes the stored state and checks it belongs to the application the
// host names.
func open(appID uint64, state []byte) (*State, string) {
	s, err := DecodeState(state)
	if err != nil {
		return nil, ErrState
	}
	if strconv.FormatUint(appID, 10) != s.Engine.Config.Domain.ApplicationID {
		return nil, ErrApplication
	}
	return s, ""
}

// commit encodes the new state with its effects.
func (s *State) commit(events []Event, appEvents []AppEvent, withdrawals []Withdrawal) []byte {
	b, err := s.encode()
	if err != nil {
		return failure(ErrInternal)
	}
	return Result{State: b, Events: events, AppEvents: appEvents, Withdrawals: withdrawals}.bytes()
}

func address(raw []byte) (string, bool) {
	a := "0x" + hex.EncodeToString(raw)
	return a, len(raw) == 20 && isAddress(a)
}

// user is the only place a user context is built: the principal is the sender
// the host supplied and the time is the last trusted clock. No byte of a
// client payload reaches it.
func (s *State) user(sender string) engine.AuthenticatedContext {
	return engine.AuthenticatedContext{Domain: s.Engine.Config.Domain, Principal: sender, Timestamp: s.Clock}
}

// system applies a command the adapter itself built (deposit credit,
// withdrawal export and claim credit, checkpoint) as the configured authority
// at the last trusted clock. Nothing a client sends can reach System: true.
func (s *State) system(e *engine.State, c engine.Command) (*engine.State, engine.Receipt, error) {
	cfg := e.Config
	c.Domain, c.Nonce = cfg.Domain, e.AuthorityNonce+1
	c.ID = engine.CommandID(cfg.Authority, c.Nonce)
	next, r, err := engine.Apply(e, c, engine.AuthenticatedContext{Domain: cfg.Domain, Principal: cfg.Authority, Timestamp: s.Clock, System: true})
	if err == nil && next.Sequence != e.Sequence+1 {
		err = errors.New("system command did not advance the ledger")
	}
	return next, r, err
}

// exitReserved reports whether, in this ledger, every account that still holds
// cash or shares could make one more withdrawal. A withdrawal costs two of the
// engine's external-evidence IDs and they are never reclaimed, so deposits and
// partial withdrawals stop while two IDs per funded account remain. Without
// this, one account recycling a single atom could use up every ID and lock
// every balance for good.
func exitReserved(e *engine.State) bool {
	funded := 0
	for _, a := range e.Accounts {
		holds := a.Cash != 0 || a.ReservedCash != 0
		for _, h := range a.Holdings {
			holds = holds || h.Up != 0 || h.Down != 0 || h.ReservedUp != 0 || h.ReservedDown != 0
		}
		if holds {
			funded++
		}
	}
	return maxEvidence-len(e.ExternalEvidence) >= 2*funded
}

// Deploy builds the first state from the constructor parameters. The
// application ID comes from the host argument, never from the parameters.
// salt is 32 bytes of host randomness, drawn by the wasm layer: it is the only
// secret in the state, and it keeps the state root Vela publishes from being
// matched against guesses at a private command.
func Deploy(appID uint64, params, salt []byte) []byte {
	if appID == 0 {
		return failure(ErrApplication)
	}
	var p DeployParams
	if len(params) == 0 || len(params) > MaxParamsBytes || !canonical(params, &p) || p.Engine.Domain.ApplicationID != "" {
		return failure(ErrParams)
	}
	p.Engine.Domain.ApplicationID = strconv.FormatUint(appID, 10)
	e, err := engine.New(p.Engine)
	if err != nil {
		return failure(ErrConfig)
	}
	if len(salt) != 32 || hex.EncodeToString(salt) == zeroSalt {
		return failure(ErrInternal)
	}
	s := &State{Version: StateVersion, ApplicationFingerprint: p.ApplicationFingerprint, Origin: p.Origin, Epoch: p.Epoch, Salt: hex.EncodeToString(salt), Staged: []Staged{}, Notices: []Notice{}, Engine: e}
	b, err := s.encode()
	if err != nil {
		return failure(ErrConfig)
	}
	return Result{State: b}.bytes()
}

// LoadModule is v0.2.0's cache warm-up call. Its result is discarded.
func LoadModule(uint64) []byte { return Result{}.bytes() }

// Deposit credits the sender with collateral the endpoint already holds. A
// sender the engine has never seen is registered first, with the one register
// command that account could have sent itself. Any failure is an error result,
// which makes the endpoint refund the deposit as a claim.
func Deposit(appID uint64, sender, token, value, state []byte) []byte {
	s, problem := open(appID, state)
	if problem != "" {
		return failure(problem)
	}
	who, ok := address(sender)
	if !ok {
		return failure(ErrSender)
	}
	if t, ok := address(token); !ok || t != s.Engine.Config.Collateral {
		return failure(ErrToken)
	}
	for len(value) > 0 && value[0] == 0 {
		value = value[1:]
	}
	if len(value) == 0 || len(value) > 8 {
		return failure(ErrAmount)
	}
	var word [8]byte
	copy(word[8-len(value):], value)
	amount := binary.BigEndian.Uint64(word[:])
	if amount > engine.MaxAtoms {
		return failure(ErrAmount)
	}
	if s.Clock == 0 {
		return failure(ErrClock)
	}
	next, unknown := s.Engine, true
	for _, a := range next.Accounts {
		unknown = unknown && a.ID != who
	}
	if unknown {
		c := engine.Command{Domain: next.Config.Domain, ID: engine.CommandID(who, 1), Nonce: 1, Op: engine.Register, Account: who}
		var err error
		if next, _, err = engine.Apply(next, c, s.user(who)); err != nil {
			return failure(ErrDeposit)
		}
	}
	ordinal := s.Deposits + 1
	next, r, err := s.system(next, engine.Command{Op: engine.Deposit, Account: who, Amount: amount, Evidence: s.evidence("DEPOSIT", ordinal)})
	if err != nil || !exitReserved(next) {
		return failure(ErrDeposit)
	}
	s.Engine, s.Deposits = next, ordinal
	p, _ := engine.ProjectReceipt(r, who)
	return s.commit([]Event{s.receipt(who, s.nextNotice(who), receiptBody{Type: "deposit", Status: "credited", Receipt: &p, Deposit: ordinal, Registered: unknown})}, nil, nil)
}

// ProcessRequest handles the decrypted plaintext of a PROCESS request: the
// envelope session.ts produced, carrying an engine command or a sync request.
func ProcessRequest(appID uint64, sender []byte, requestType int32, payload, state []byte) []byte {
	if requestType != requestTypeProcess {
		return failure(ErrRequestType)
	}
	s, problem := open(appID, state)
	if problem != "" {
		return failure(problem)
	}
	who, ok := address(sender)
	if !ok {
		return failure(ErrSender)
	}
	var env requestEnvelope
	if len(payload) == 0 || len(payload) > MaxPayloadBytes || !canonical(payload, &env) {
		return failure(ErrEnvelope)
	}
	if env.Version != 1 || env.Kind != "command" || env.Domain != s.domain() || env.Epoch != s.Epoch {
		return failure(ErrContext)
	}
	if env.Account != who {
		return failure(ErrMismatch)
	}
	switch env.Body.Type {
	case "sync":
		if env.Body.Command != "" || env.RequestID != who+":sync" {
			return failure(ErrEnvelope)
		}
		return s.reply(who, env.RequestID, receiptBody{Type: "sync", Status: "requested"}, nil)
	case "command":
		// engine.DecodeCommand looks for trailing input by decoding into an
		// interface, which recurses once per nesting level. Only bytes already
		// known to be one canonical command may reach it.
		raw := []byte(env.Body.Command)
		var probe engine.Command
		if !canonical(raw, &probe) {
			return failure(ErrCommand)
		}
		c, err := engine.DecodeCommand(raw)
		if err != nil {
			return failure(ErrCommand)
		}
		if c.Account != who {
			return failure(ErrMismatch)
		}
		if c.ID != env.RequestID || c.ID != engine.CommandID(who, c.Nonce) || c.Domain != s.Engine.Config.Domain {
			return failure(ErrContext)
		}
		return s.command(who, c)
	}
	return failure(ErrEnvelope)
}

// reply ends every accepted process_request the same way, so that a request's
// public shape says nothing about what it was: one receipt of fixed size to the
// sender and one request for a tick (a public app event carrying the new tick
// number as a 32-byte big-endian word). A sync is the reply and nothing else.
func (s *State) reply(who, requestID string, body receiptBody, withdrawals []Withdrawal) []byte {
	if s.TickSeq >= engine.MaxAtoms {
		return failure(ErrInternal)
	}
	s.TickSeq++
	body.Tick = s.TickSeq
	data := make([]byte, 32)
	binary.BigEndian.PutUint64(data[24:], s.TickSeq)
	return s.commit([]Event{s.receipt(who, requestID, body)}, []AppEvent{{EventSubType: TickSubType, Data: data}}, withdrawals)
}

// command applies a well-formed command from its authenticated sender. From
// here on a refusal is private: the transition succeeds, the ledger is the
// input ledger byte for byte, and the sender gets a "rejected" receipt.
func (s *State) command(who string, c engine.Command) []byte {
	if s.Clock == 0 {
		return failure(ErrClock)
	}
	refuse := func(reason string) []byte {
		return s.reply(who, c.ID, receiptBody{Type: "command", Status: "rejected", Reason: reason}, nil)
	}
	cfg := s.Engine.Config
	switch {
	case c.Op == engine.PlaceOrder || c.Op == engine.CancelOrder || c.Op == engine.CancelAll:
		// The book changes only in trusted_request, at a chain timestamp.
		return refuse("order book commands are not enabled in this build")
	case c.Op == engine.RequestWithdrawal && (c.Destination == cfg.Domain.Endpoint || c.Destination == cfg.Authority):
		// A claim credited to the endpoint or to the trigger never reaches a user.
		return refuse("withdrawal destination not allowed")
	}
	next, r, err := engine.Apply(s.Engine, c, s.user(who))
	if err != nil {
		return refuse(err.Error())
	}
	p, _ := engine.ProjectReceipt(r, who)
	if next.Sequence == s.Engine.Sequence {
		// Exact retry of the account's latest command: the original receipt
		// again, and no effect on the ledger or on custody.
		return s.reply(who, c.ID, receiptBody{Type: "command", Status: "retry", Receipt: &p}, nil)
	}
	body := receiptBody{Type: "command", Status: "applied", Receipt: &p}
	var withdrawals []Withdrawal
	if c.Op == engine.RequestWithdrawal {
		// One transition carries the request, the export and the claim credit:
		// the endpoint moves custody into pendingClaims in the same call that
		// accepts this state root, so no withdrawal is ever left half done.
		ordinal := s.Withdrawals + 1
		var x engine.Receipt
		if next, x, err = s.system(next, engine.Command{Op: engine.ExportWithdrawal, WithdrawalID: r.WithdrawalID, Evidence: s.evidence("WITHDRAWAL", ordinal)}); err == nil {
			next, _, err = s.system(next, engine.Command{Op: engine.ConfirmClaim, WithdrawalID: r.WithdrawalID, Evidence: s.evidence("CLAIM", ordinal)})
		}
		if err == nil && x.PublicWithdrawal == nil {
			err = errors.New("export produced no public withdrawal")
		}
		if err == nil && !exitReserved(next) {
			err = errors.New("exit reserve reached: only a withdrawal of the whole balance is accepted")
		}
		if err != nil {
			return refuse(err.Error())
		}
		withdrawals = []Withdrawal{{TokenAddress: cfg.Collateral, DestinationAddress: x.PublicWithdrawal.Destination, Amount: "0x" + strconv.FormatUint(x.PublicWithdrawal.Amount, 16)}}
		s.Withdrawals, body.Withdrawal = ordinal, ordinal
	}
	s.Engine = next
	return s.reply(who, c.ID, body, withdrawals)
}

// tick is trusted payload version 1: six 32-byte words, as abi.encode(uint256
// version, uint256 chainId, address endpoint, uint256 blockNumber, uint256
// blockTimestamp, uint256 tick) from the trigger contract.
type tick struct{ version, chainID, block, timestamp, number uint64 }

func decodeTick(p []byte) (t tick, endpoint string, ok bool) {
	if len(p) != 192 {
		return t, "", false
	}
	ok = true
	word := func(i int) uint64 {
		w := p[32*i : 32*i+32]
		for _, b := range w[:24] {
			ok = ok && b == 0
		}
		return binary.BigEndian.Uint64(w[24:])
	}
	t = tick{version: word(0), chainID: word(1), block: word(3), timestamp: word(4), number: word(5)}
	for _, b := range p[64:76] {
		ok = ok && b == 0
	}
	return t, "0x" + hex.EncodeToString(p[76:96]), ok
}

// TrustedRequest applies a tick: it moves the trusted clock to the block
// timestamp the trigger reported and checkpoints the engine at that time. It
// publishes what it applied (tick, block, timestamp) under ClockSubType, so
// anyone can compare it with the block that asked for the tick. It never emits
// TickSubType, so a tick cannot ask for another tick.
func TrustedRequest(appID uint64, payload, state []byte) []byte {
	s, problem := open(appID, state)
	if problem != "" {
		return failure(problem)
	}
	t, endpoint, ok := decodeTick(payload)
	d := s.Engine.Config.Domain
	// A timestamp above MaxClock is not a time in seconds any round could use,
	// and accepting one would leave every later tick behind the clock for good.
	if !ok || t.version != 1 || t.chainID != d.ChainID || endpoint != d.Endpoint || t.timestamp == 0 || t.timestamp > MaxClock || t.block > engine.MaxAtoms {
		return failure(ErrTrusted)
	}
	if t.number <= s.LastTick || t.number > s.TickSeq {
		return failure(ErrTick)
	}
	// The block number is recorded, not compared: the engine never reads it,
	// and a second ordering rule would only be a second way to stop the clock.
	if t.timestamp < s.Clock {
		return failure(ErrTime)
	}
	s.Clock, s.Block, s.LastTick = t.timestamp, t.block, t.number
	next, _, err := s.system(s.Engine, engine.Command{Op: engine.Checkpoint})
	if err != nil {
		return failure(ErrInternal)
	}
	s.Engine = next
	data := make([]byte, 96)
	binary.BigEndian.PutUint64(data[24:], s.LastTick)
	binary.BigEndian.PutUint64(data[56:], s.Block)
	binary.BigEndian.PutUint64(data[88:], s.Clock)
	return s.commit(nil, []AppEvent{{EventSubType: ClockSubType, Data: data}}, nil)
}
