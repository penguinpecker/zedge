package guest

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/penguinpecker/zedge/engine"
	"golang.org/x/crypto/sha3"
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
	s := &State{Version: StateVersion, ApplicationFingerprint: p.ApplicationFingerprint, Origin: p.Origin, Epoch: p.Epoch, Markets: p.Markets,
		Salt: hex.EncodeToString(salt), Staged: []Staged{}, Outcomes: []Outcome{}, Notices: []Notice{}, Engine: e}
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
	if s.stagedBy(who) >= 0 {
		return failure(ErrDeposit) // frozen until its staged command is activated (section 9, S3)
	}
	s.take(who)
	next, unknown := s.Engine, account(s.Engine, who) == nil
	if unknown {
		c := engine.Command{Domain: next.Config.Domain, ID: engine.CommandID(who, 1), Nonce: 1, Op: engine.Register, Account: who}
		var err error
		if next, _, err = engine.Apply(next, c, s.user(who)); err != nil || len(next.Accounts) > MaxSliceAccounts {
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
	if len(payload) != RequestBytes || !canonical(payload, &env) || strings.Trim(env.Body.Pad, "0") != "" {
		return failure(ErrEnvelope)
	}
	if env.Version != 1 || env.Kind != "command" || env.Domain != s.domain() || env.Epoch != s.Epoch {
		return failure(ErrContext)
	}
	if env.Account != who {
		return failure(ErrMismatch)
	}
	s.take(who)
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
	ask, ok := s.ask()
	if !ok {
		return failure(ErrInternal)
	}
	body.Tick = s.TickSeq
	return s.commit([]Event{s.receipt(who, requestID, body)}, []AppEvent{ask}, withdrawals)
}

// ask requests the next tick: a public app event whose data is the new tick
// number, then, for the round mirror (section 10), the number of rounds the
// engine holds as scheduled and as open and their registry round IDs in that
// order, all as 32-byte words.
func (s *State) ask() (AppEvent, bool) {
	if s.TickSeq >= engine.MaxAtoms {
		return AppEvent{}, false
	}
	s.TickSeq++
	var scheduled, open []byte
	for _, m := range s.rounds() {
		id, _ := hex.DecodeString(m.Spec.RegistryRoundID[2:])
		switch m.Status {
		case "scheduled":
			scheduled = append(scheduled, id...)
		case "open":
			open = append(open, id...)
		}
	}
	data := append(words(s.TickSeq, uint64(len(scheduled)/32), uint64(len(open)/32)), scheduled...)
	return AppEvent{EventSubType: TickSubType, Data: append(data, open...)}, true
}

// words is its arguments as 32-byte big-endian words.
func words(v ...uint64) []byte {
	b := make([]byte, 32*len(v))
	for i, x := range v {
		binary.BigEndian.PutUint64(b[32*i+24:], x)
	}
	return b
}

// rounds is the engine's rounds, oldest first: by start, asset, duration.
func (s *State) rounds() []engine.Round {
	r := slices.Clone(s.Engine.Rounds)
	sort.SliceStable(r, func(i, j int) bool {
		return earlier(r[i].Spec.Start, r[i].Spec.Asset, r[i].Spec.End-r[i].Spec.Start, r[j].Spec.Start, r[j].Spec.Asset, r[j].Spec.End-r[j].Spec.Start)
	})
	return r
}

func earlier(start uint64, asset string, duration, start2 uint64, asset2 string, duration2 uint64) bool {
	if start != start2 {
		return start < start2
	}
	if asset != asset2 {
		return asset < asset2
	}
	return duration < duration2
}

// take moves the account's outcome, if it has one, into the receipt this
// request sends it, and removes it from the state. An applied outcome carries
// the engine receipt of that command, read before this request applies
// anything, while it is still the account's stored last receipt: a later
// command of the account's own or a settlement sweep replaces it.
func (s *State) take(who string) {
	i := slices.IndexFunc(s.Outcomes, func(o Outcome) bool { return o.Account == who })
	if i < 0 {
		return
	}
	o := s.Outcomes[i]
	s.taken = &outcomeReceipt{Outcome: o}
	if a := account(s.Engine, who); o.Status == "applied" && a != nil && a.LastReceipt.CommandID == o.CommandID {
		p, _ := engine.ProjectReceipt(a.LastReceipt, who)
		s.taken.Receipt = &p
	}
	s.Outcomes = slices.Delete(s.Outcomes, i, i+1)
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
	staged := func() []byte { return s.reply(who, c.ID, receiptBody{Type: "command", Status: "staged"}, nil) }
	cfg := s.Engine.Config
	if i := s.stagedBy(who); i >= 0 {
		// Frozen until the staged command is activated (section 9, S3): only
		// the same bytes again are answered, with the item left as it was.
		if string(marshalCommand(s.Staged[i].Command)) == string(marshalCommand(c)) {
			return staged()
		}
		return refuse("a staged command is waiting for its tick")
	}
	a := account(s.Engine, who)
	switch {
	case bookOp(c.Op) && a != nil && c.Nonce == a.Nonce+1:
		// The book changes only in trusted_request, at the chain timestamp of
		// the transition that staged the command (section 9, S2 to S5). The
		// order cap is checked at activation, on what the order leaves resting.
		if len(marshalCommand(c)) > MaxStagedBytes {
			return refuse("command too large to stage")
		}
		s.Staged = append(s.Staged, Staged{Tick: s.TickSeq + 1, Command: c})
		return staged()
	case c.Op == engine.RequestWithdrawal && (c.Destination == cfg.Domain.Endpoint || c.Destination == cfg.Authority):
		// A claim credited to the endpoint or to the trigger never reaches a user.
		return refuse("withdrawal destination not allowed")
	}
	// A book command that is not the account's next one reaches the engine
	// only to be recognised as an exact retry or refused: the engine applies
	// no other nonce.
	next, r, err := engine.Apply(s.Engine, c, s.user(who))
	if err == nil && len(next.Accounts) > MaxSliceAccounts {
		err = errors.New("account capacity")
	}
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

// tick is a trusted payload from the trigger contract. Version 1 is six
// 32-byte words, abi.encode(uint256 1, uint256 chainId, address endpoint,
// uint256 blockNumber, uint256 blockTimestamp, uint256 tick) (section 8).
// Version 2 has the same words with version 2, then n <= MaxRecords and n
// registry records of 19 words each (section 10).
type tick struct {
	version, chainID, block, timestamp, number uint64
	endpoint                                   string
	records                                    []record
}

// record is one registry round as getRound read it in the block at the tick's
// timestamp. ok is false if any field does not decode; such a record is
// skipped, never fatal, so that one bad round cannot stop the clock.
type record struct {
	id                                    string // registry round ID, 0x-prefixed
	asset                                 string
	duration, start, openedAt, resolvedAt uint64
	outcome                               uint64 // 0 pending, 1 Up, 2 Down, 3 Void
	opening, closing                      engine.StreamsObservation
	ok                                    bool
}

// word reads word i of p as an integer no larger than max; *ok turns false if
// it is not one.
func word(p []byte, i int, max uint64, ok *bool) uint64 {
	w := p[32*i : 32*i+32]
	for _, b := range w[:24] {
		*ok = *ok && b == 0
	}
	v := binary.BigEndian.Uint64(w[24:])
	*ok = *ok && v <= max
	return v
}

func decodeTick(p []byte) (t tick, ok bool) {
	n := len(p) / 32
	if len(p)%32 != 0 || n < 6 {
		return t, false
	}
	ok = true
	all := ^uint64(0)
	t = tick{version: word(p, 0, 2, &ok), chainID: word(p, 1, all, &ok), block: word(p, 3, all, &ok), timestamp: word(p, 4, all, &ok), number: word(p, 5, all, &ok)}
	for _, b := range p[64:76] {
		ok = ok && b == 0
	}
	t.endpoint = "0x" + hex.EncodeToString(p[76:96])
	switch {
	case t.version == 1:
		ok = ok && n == 6
	case t.version == 2 && n >= 7:
		count := word(p, 6, MaxRecords, &ok)
		ok = ok && n == 7+19*int(count)
		for i := 0; ok && i < int(count); i++ {
			t.records = append(t.records, decodeRecord(p[32*(7+19*i):32*(26+19*i)]))
		}
	default:
		ok = false
	}
	return t, ok
}

func decodeRecord(p []byte) record {
	r := record{id: "0x" + hex.EncodeToString(p[:32]), ok: true, asset: "BTC"}
	if word(p, 1, 1, &r.ok) == 1 {
		r.asset = "ETH"
	}
	r.duration, r.start = word(p, 2, MaxClock, &r.ok), word(p, 3, MaxClock, &r.ok)
	r.openedAt, r.resolvedAt, r.outcome = word(p, 4, MaxClock, &r.ok), word(p, 5, MaxClock, &r.ok), word(p, 6, 3, &r.ok)
	r.opening, r.closing = observation(p[7*32:13*32], &r.ok), observation(p[13*32:], &r.ok)
	return r
}

// observation reads price (int192), validFromTimestamp, observationsTimestamp,
// expiresAt, reportHash, decimals. A negative or zero price reads as a
// number the engine refuses.
func observation(p []byte, ok *bool) engine.StreamsObservation {
	return engine.StreamsObservation{Price: new(big.Int).SetBytes(p[:32]).String(), ValidFromTimestamp: uint32(word(p, 1, MaxClock, ok)),
		ObservationsTimestamp: uint32(word(p, 2, MaxClock, ok)), ExpiresAt: uint32(word(p, 3, MaxClock, ok)),
		ReportHash: "0x" + hex.EncodeToString(p[128:160]), Decimals: uint8(word(p, 5, 255, ok))}
}

// TrustedRequest applies a tick at the block timestamp T the trigger reported:
// it moves the trusted clock to T, checkpoints the engine (releasing expired
// orders), mirrors the registry records, activates staged book commands,
// sweeps settled shares and archives finished rounds, all at T (sections 8 to
// 10). It publishes what it applied (tick, block, timestamp, records applied,
// records skipped, the payload's Keccak-256) under ClockSubType and each archive record under
// ArchiveSubType. It sends no receipt to anyone. It asks for another tick only
// when staged commands it was due to activate are left over.
func TrustedRequest(appID uint64, payload, state []byte) []byte {
	s, problem := open(appID, state)
	if problem != "" {
		return failure(problem)
	}
	t, ok := decodeTick(payload)
	d := s.Engine.Config.Domain
	// A timestamp above MaxClock is not a time in seconds any round could use,
	// and accepting one would leave every later tick behind the clock for good.
	if !ok || t.chainID != d.ChainID || t.endpoint != d.Endpoint || t.timestamp == 0 || t.timestamp > MaxClock || t.block > engine.MaxAtoms {
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
	applied := s.mirror(t.records)
	s.activate(t.number)
	s.sweep()
	// The payload's Keccak-256 is what the endpoint put into this trusted
	// request's ID, so a clock record fed anything but the trigger's answer is
	// provable from the chain, records included (section 8.4).
	k := sha3.NewLegacyKeccak256()
	k.Write(payload)
	clock := append(words(s.LastTick, s.Block, s.Clock, uint64(applied), uint64(len(t.records)-applied)), k.Sum(nil)...)
	events := append([]AppEvent{{EventSubType: ClockSubType, Data: clock}}, s.archive()...)
	if len(s.Staged) > 0 && s.Staged[0].Tick <= t.number {
		// Left over by MaxActivations: the trigger answers this request too,
		// and the next tick carries on where this one stopped.
		ask, ok := s.ask()
		if !ok {
			return failure(ErrInternal)
		}
		events = append(events, ask)
	}
	return s.commit(nil, events, nil)
}

// mirror applies the registry records in (start, asset, duration) order and
// returns how many changed the engine. For each record it applies the first
// rule that fits and looks again, until none fits or the engine refuses.
func (s *State) mirror(records []record) (applied int) {
	sort.SliceStable(records, func(i, j int) bool {
		a, b := records[i], records[j]
		return earlier(a.start, a.asset, a.duration, b.start, b.asset, b.duration)
	})
	for _, r := range records {
		moved := false
		for r.ok && s.mirrorStep(r) {
			moved = true
		}
		if moved {
			applied++
		}
	}
	return applied
}

// mirrorStep applies one engine command for the record, as the authority at
// the tick's time T. registryTime is always the registry's own recorded block
// timestamp, never T; a void is mirrored only from a recorded outcome.
func (s *State) mirrorStep(r record) bool {
	e := s.Engine
	var m *engine.Round
	for i := range e.Rounds {
		if e.Rounds[i].Spec.RegistryRoundID == r.id {
			m = &e.Rounds[i]
		}
	}
	observed := func(o engine.StreamsObservation) *engine.StreamsObservation { o.FeedID = m.Spec.Feed; return &o }
	var c engine.Command
	switch {
	case m == nil:
		// Created by the tick that also created the registry round. The engine
		// refuses a round whose start has passed: it never exists here.
		if !slices.Contains(s.Markets, Market{r.asset, r.duration}) || len(e.Rounds) >= MaxSliceRounds {
			return false
		}
		spec, err := engine.NewRoundSpec(e.Config, r.asset, r.duration, r.start)
		if err != nil || spec.RegistryRoundID != r.id {
			return false
		}
		c = engine.Command{Op: engine.CreateRound, Round: &spec}
	case m.Status == "scheduled" && r.openedAt != 0:
		c = engine.Command{Op: engine.OpenRound, RoundID: m.ID, Evidence: r.opening.ReportHash[2:], RegistryTime: r.openedAt, Observation: observed(r.opening)}
	case m.Status == "open" && (r.outcome == 1 || r.outcome == 2):
		c = engine.Command{Op: engine.ResolveRound, RoundID: m.ID, Evidence: r.closing.ReportHash[2:], RegistryTime: r.resolvedAt, Observation: observed(r.closing)}
	case (m.Status == "scheduled" || m.Status == "open") && r.outcome == 3:
		c = engine.Command{Op: engine.VoidRound, RoundID: m.ID, Evidence: r.id[2:], RegistryTime: r.resolvedAt}
	default:
		return false
	}
	next, _, err := s.system(e, c)
	if err != nil {
		return false
	}
	if c.Op == engine.ResolveRound {
		// The engine decides the outcome itself; it must be the registry's.
		want := map[uint64]engine.Outcome{1: engine.Up, 2: engine.Down}[r.outcome]
		for _, n := range next.Rounds {
			if n.ID == m.ID && n.Outcome != want {
				return false
			}
		}
	}
	s.Engine = next
	return true
}

// activate applies staged commands due by tick k in tick order, at most
// MaxActivations, each as its own account at the tick's time T. Each leaves an
// outcome for its account; a refusal consumes no nonce.
func (s *State) activate(k uint64) {
	for n := 0; n < MaxActivations && len(s.Staged) > 0 && s.Staged[0].Tick <= k; n++ {
		x := s.Staged[0]
		s.Staged = s.Staged[1:]
		c, o := x.Command, Outcome{Account: x.Command.Account, CommandID: x.Command.ID, Tick: x.Tick, Status: "applied"}
		next, r, err := engine.Apply(s.Engine, c, s.user(c.Account))
		if err == nil && len(r.Fills) > MaxFills {
			err = errors.New("matching work limit; split order")
		}
		// A0: only an order that would rest counts against the cap; an IOC, or
		// a GTC filled on arrival, never does.
		if err == nil && activeOrders(next, c.Account) > MaxAccountOrders {
			err = errors.New("order capacity")
		}
		if err != nil {
			o.Status, o.Reason = "rejected", err.Error()
			if o.Reason == "order not owned" {
				// Another account's order: no more than for one that is gone, so
				// that a cancel cannot probe whether someone's order still rests.
				o.Reason = "unknown active order"
			}
		} else {
			s.Engine = next
		}
		i, found := slices.BinarySearchFunc(s.Outcomes, o.Account, func(x Outcome, a string) int { return strings.Compare(x.Account, a) })
		if found {
			s.Outcomes[i] = o
		} else {
			s.Outcomes = slices.Insert(s.Outcomes, i, o)
		}
	}
}

// sweep redeems settled shares, oldest round first, in the name of each
// account that still holds some and has nothing staged: the one redeem
// command the account could have sent itself, with its next nonce, at T. At
// most MaxSweeps attempts per tick. Without it, one lot left in each round by
// an account that never returns would hold every round slot for good.
func (s *State) sweep() {
	n := 0
	for _, m := range s.rounds() {
		if m.Status != "resolved" && m.Status != "void" {
			continue
		}
		for i := range s.Engine.Accounts {
			a := s.Engine.Accounts[i]
			j := slices.IndexFunc(a.Holdings, func(h engine.Holding) bool { return h.RoundID == m.ID })
			if j < 0 || a.Holdings[j].Up == 0 && a.Holdings[j].Down == 0 || s.stagedBy(a.ID) >= 0 {
				continue
			}
			if n == MaxSweeps {
				return
			}
			n++
			c := engine.Command{Domain: s.Engine.Config.Domain, ID: engine.CommandID(a.ID, a.Nonce+1), Nonce: a.Nonce + 1, Op: engine.Redeem, Account: a.ID, RoundID: m.ID}
			if next, _, err := engine.Apply(s.Engine, c, s.user(a.ID)); err == nil {
				s.Engine = next
			}
		}
	}
}

// archive removes settled rounds that hold nothing any more, oldest first, at
// most MaxArchives per tick, and returns each archive record as a public app
// event: the engine requires the record to be kept with the new state, and it
// holds only public round data.
func (s *State) archive() (events []AppEvent) {
	for _, m := range s.rounds() {
		if len(events) == MaxArchives {
			break
		}
		if m.Status != "resolved" && m.Status != "void" || m.Locked != 0 || m.UpSupply != 0 || m.DownSupply != 0 {
			continue
		}
		next, r, err := s.system(s.Engine, engine.Command{Op: engine.ArchiveRound, RoundID: m.ID})
		if err != nil || r.Archive == nil {
			continue
		}
		s.Engine = next
		data, _ := json.Marshal(r.Archive)
		events = append(events, AppEvent{EventSubType: ArchiveSubType, Data: data})
	}
	return events
}
