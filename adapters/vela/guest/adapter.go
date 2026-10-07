package guest

import (
	"encoding/base64"
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

// commit encodes the new state with its effects. No result carries a Vela
// withdrawal: the endpoint holds no custody (README section 7).
func (s *State) commit(events []Event, appEvents []AppEvent) []byte {
	b, err := s.encode()
	if err != nil {
		return failure(ErrInternal)
	}
	return Result{State: b, Events: events, AppEvents: appEvents}.bytes()
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
// withdrawal export and claim credit, checkpoint, rounds) as the configured authority
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
	s := &State{Version: StateVersion, ApplicationFingerprint: p.ApplicationFingerprint, Origin: p.Origin, Epoch: p.Epoch, Markets: p.Markets, StakeLimits: p.StakeLimits,
		Chainlink: p.Chainlink, Custody: p.Custody, Salt: hex.EncodeToString(salt), Staged: []Staged{}, Outcomes: []Outcome{}, Unconfirmed: []Unconfirmed{}, Engine: e}
	b, err := s.encode()
	if err != nil {
		return failure(ErrConfig)
	}
	return Result{State: b}.bytes()
}

// LoadModule is v0.2.0's cache warm-up call. Its result is discarded.
func LoadModule(uint64) []byte { return Result{}.bytes() }

// Deposit refuses every Vela deposit: the money is in the Base vault, and the
// engine learns of it only from the inbox through a tick (README section 6).
// The endpoint refunds what it took as a claim.
func Deposit(uint64, []byte, []byte, []byte, []byte) []byte { return failure(ErrToken) }

// ProcessRequest handles the decrypted plaintext of a PROCESS request: the
// envelope session.ts produced, carrying an engine command, a sync request or
// a Chainlink report.
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
		if env.Body.Command != "" || env.Body.Report != "" || env.RequestID != who+":sync" {
			return failure(ErrEnvelope)
		}
		return s.reply(who, env.RequestID, receiptBody{Type: "sync", Status: "requested"}, nil)
	case "report":
		full, err := base64.StdEncoding.DecodeString(env.Body.Report)
		if env.Body.Command != "" || err != nil || base64.StdEncoding.EncodeToString(full) != env.Body.Report || !strings.HasPrefix(env.RequestID, who+":report:") {
			return failure(ErrEnvelope)
		}
		return s.report(who, env.RequestID, full)
	case "command":
		if env.Body.Report != "" {
			return failure(ErrEnvelope)
		}
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

// reply ends every accepted command or sync the same way, so that a request's
// public shape says nothing about what it was: one receipt of fixed size to the
// sender and one request for a tick (README section 8). A sync is the reply and
// nothing else; an accepted withdrawal adds its public payout record.
func (s *State) reply(who, requestID string, body receiptBody, payout []AppEvent) []byte {
	ask, ok := s.ask()
	if !ok {
		return failure(ErrInternal)
	}
	body.Tick = s.TickSeq
	return s.commit([]Event{s.receipt(who, requestID, body)}, append([]AppEvent{ask}, payout...))
}

// ask requests the next tick: a public app event whose data is, as 32-byte
// words, the new tick number, the next Base deposit index wanted, the number
// of rounds the engine holds as scheduled, as open, and of settled rounds the
// registry has still to confirm, then their registry round IDs in that order
// (README sections 8 and 10).
func (s *State) ask() (AppEvent, bool) {
	if s.TickSeq >= engine.MaxAtoms {
		return AppEvent{}, false
	}
	s.TickSeq++
	var scheduled, open, confirm []byte
	held := map[string]bool{}
	for _, m := range s.rounds() {
		id, _ := hex.DecodeString(m.Spec.RegistryRoundID[2:])
		switch m.Status {
		case "scheduled":
			scheduled = append(scheduled, id...)
		case "open":
			open = append(open, id...)
		}
		held[m.Spec.RegistryRoundID] = m.Status == "scheduled" || m.Status == "open"
	}
	// An open round is asked about as open already; the rest wait for the
	// registry's outcome as confirmations.
	for _, u := range s.Unconfirmed {
		if !held[u.Round] {
			id, _ := hex.DecodeString(u.Round[2:])
			confirm = append(confirm, id...)
		}
	}
	data := append(words(s.TickSeq, s.DepositsSeen+1, uint64(len(scheduled)/32), uint64(len(open)/32), uint64(len(confirm)/32)), scheduled...)
	return AppEvent{EventSubType: TickSubType, Data: append(append(data, open...), confirm...)}, true
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
	case c.Op == engine.RequestWithdrawal && (c.Destination == cfg.Domain.Endpoint || c.Destination == cfg.Authority || c.Destination == s.Custody.Vault):
		// A payout to the vault itself, or to an address that is not a user's
		// (the endpoint, the trigger), never reaches anyone.
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
	var payout []AppEvent
	if c.Op == engine.RequestWithdrawal {
		// One transition carries the request, the export and the claim credit:
		// the public payout record it publishes is what the payout signer pays
		// on Base (README section 7), so no withdrawal is ever left half done.
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
		s.Withdrawals = ordinal
		w := x.PublicWithdrawal
		payout = []AppEvent{s.payout(payoutWithdrawal, w.Account, w.Destination, amountWord(w.Amount))}
		body.Withdrawal = s.Payouts
	}
	s.Engine = next
	return s.reply(who, c.ID, body, payout)
}

// Payout kinds and settle sources (README section 11).
const (
	payoutWithdrawal, payoutRefund                = 1, 2
	settleOpen, settleResolve, settleVoid         = 1, 2, 3
	sourceReport, sourceRegistry, sourceOwnVoid   = 1, 2, 3
	confirmDisagree, confirmAgree, confirmDropped = 0, 1, 2
	creditCredited, creditRefunded                = 1, 2
)

// payout takes the next payout ordinal and returns its public record: the
// vault on Base pays it once, by (applicationId, ordinal), to a signature the
// payout signer makes from this record alone.
func (s *State) payout(kind uint64, account, to string, amount []byte) AppEvent {
	s.Payouts++
	app, _ := strconv.ParseUint(s.Engine.Config.Domain.ApplicationID, 10, 64)
	data := append(words(app, s.Payouts, kind), addressWord(account)...)
	return AppEvent{EventSubType: PayoutSubType, Data: append(append(data, addressWord(to)...), amount...)}
}

func addressWord(a string) []byte {
	b := make([]byte, 32)
	hex.Decode(b[12:], []byte(a[2:]))
	return b
}

func amountWord(v uint64) []byte { return words(v) }

// report applies a Chainlink report for a round boundary B straight from its
// DON signatures (README section 12): at T = max(clock, B), it resolves the
// round that ends at B, redeems every holder of it, opens the round that
// starts at B, archives and creates the next rounds, all in this one
// transition. The sender gets one receipt and the chain the settle records;
// no tick is asked for: the clock already moved.
func (s *State) report(who, requestID string, full []byte) []byte {
	if s.Clock == 0 {
		return failure(ErrClock)
	}
	o, reason := s.Chainlink.verify(full)
	b := uint64(o.ObservationsTimestamp)
	if reason == "" && requestID != who+":report:"+strconv.FormatUint(b, 10) {
		return failure(ErrContext)
	}
	if reason == "" && b%s.Markets[0].Duration != 0 {
		reason = "report: not a boundary report"
	}
	answer := func(status, reason string, events []AppEvent) []byte {
		return s.commit([]Event{s.receipt(who, requestID, receiptBody{Type: "report", Status: status, Reason: reason})}, events)
	}
	// Only a round this report can open or resolve is worth an engine call. A
	// round is not opened past its opening deadline: the registry can no longer
	// open it and will void it, so the book would disagree with the record.
	opens := func(m engine.Round) bool {
		return m.Spec.Start == b && m.Status == "scheduled" && max(s.Clock, b) <= m.Spec.OpeningDeadline
	}
	due := slices.ContainsFunc(s.Engine.Rounds, func(m engine.Round) bool {
		return m.Spec.End == b && m.Status == "open" || opens(m)
	})
	if reason == "" && !due {
		reason = "report: nothing to apply"
		for _, m := range s.Engine.Rounds {
			if m.Opening != nil && m.Opening.ReportHash == o.ReportHash || m.Closing != nil && m.Closing.ReportHash == o.ReportHash {
				reason = "report: already applied"
			}
		}
	}
	if reason != "" {
		return answer("rejected", reason, nil)
	}
	before, clock := s.Engine, s.Clock
	s.Clock = max(s.Clock, b)
	if !s.checkpoint() {
		return failure(ErrInternal)
	}
	var events []AppEvent
	for _, m := range s.rounds() {
		if m.Spec.End == b && m.Status == "open" {
			if e, ok := s.settle(m, engine.ResolveRound, &o, b, sourceReport); ok {
				events = append(append(events, e), s.unconfirm(m.Spec.RegistryRoundID)...)
				n := -1
				s.redeemRound(m.ID, &n)
			}
		}
	}
	for _, m := range s.rounds() {
		if opens(m) {
			if e, ok := s.settle(m, engine.OpenRound, &o, b, sourceReport); ok {
				events = append(append(events, e), s.unconfirm(m.Spec.RegistryRoundID)...)
			}
		}
	}
	if len(events) == 0 {
		// A round was due, but the engine refused it (an opening past its
		// deadline in a test configuration, say): nothing changes.
		s.Engine, s.Clock = before, clock
		return answer("rejected", "report: refused by the engine", nil)
	}
	events = append(events, s.archive()...)
	events = append(events, s.upkeep()...)
	return answer("applied", "", events)
}

// checkpoint applies the engine's checkpoint at the clock, which releases
// expired orders.
func (s *State) checkpoint() bool {
	next, _, err := s.system(s.Engine, engine.Command{Op: engine.Checkpoint})
	if err == nil {
		s.Engine = next
	}
	return err == nil
}

// settle opens, resolves or voids round m as the authority and returns its
// public settle record. A resolution's outcome is the engine's own.
func (s *State) settle(m engine.Round, op engine.Operation, o *engine.StreamsObservation, registryTime, source uint64) (AppEvent, bool) {
	c := engine.Command{Op: op, RoundID: m.ID, RegistryTime: registryTime}
	if o != nil {
		x := *o
		x.FeedID = m.Spec.Feed
		c.Observation, c.Evidence = &x, x.ReportHash[2:]
	} else {
		c.Evidence = m.Spec.RegistryRoundID[2:]
	}
	next, _, err := s.system(s.Engine, c)
	if err != nil {
		return AppEvent{}, false
	}
	s.Engine = next
	kind := map[engine.Operation]uint64{engine.OpenRound: settleOpen, engine.ResolveRound: settleResolve, engine.VoidRound: settleVoid}[op]
	var outcome uint64
	price, at, hash := make([]byte, 32), uint64(0), make([]byte, 32)
	for _, n := range next.Rounds {
		if n.ID == m.ID {
			outcome = outcomeNumber(n.Outcome)
		}
	}
	if o != nil {
		p, _ := new(big.Int).SetString(o.Price, 10)
		p.FillBytes(price)
		at = uint64(o.ObservationsTimestamp)
		hex.Decode(hash, []byte(o.ReportHash[2:]))
	}
	id, _ := hex.DecodeString(m.Spec.RegistryRoundID[2:])
	data := append(append(append(append(id, words(kind, outcome)...), price...), words(at)...), hash...)
	return AppEvent{EventSubType: SettleSubType, Data: append(data, words(source)...)}, true
}

func outcomeNumber(o engine.Outcome) uint64 {
	return map[engine.Outcome]uint64{engine.Up: 1, engine.Down: 2, engine.Void: 3}[o]
}

// unconfirm records what the engine settled round id with, from the engine
// itself, until the registry's own record arrives. Past MaxUnconfirmed the
// oldest is given up, publicly.
func (s *State) unconfirm(id string) (events []AppEvent) {
	var m engine.Round
	for _, n := range s.Engine.Rounds {
		if n.Spec.RegistryRoundID == id {
			m = n
		}
	}
	u := Unconfirmed{Round: id, Opening: m.Opening.ReportHash}
	if m.Closing != nil {
		u.Closing, u.Outcome = m.Closing.ReportHash, outcomeNumber(m.Outcome)
	}
	if i := slices.IndexFunc(s.Unconfirmed, func(v Unconfirmed) bool { return v.Round == id }); i >= 0 {
		s.Unconfirmed[i] = u
		return nil
	}
	if len(s.Unconfirmed) == MaxUnconfirmed {
		events = append(events, confirmation(s.Unconfirmed[0], confirmDropped, 0, ""))
		s.Unconfirmed = s.Unconfirmed[1:]
	}
	s.Unconfirmed = append(s.Unconfirmed, u)
	return events
}

// confirmation is the public record of a comparison with the registry:
// roundId, agree, engine outcome, registry outcome, engine closing hash,
// registry closing hash.
func confirmation(u Unconfirmed, agree, registryOutcome uint64, registryClosing string) AppEvent {
	h := func(x string) []byte {
		b := make([]byte, 32)
		if x != "" {
			hex.Decode(b, []byte(x[2:]))
		}
		return b
	}
	data := append(append(h(u.Round), words(agree, u.Outcome, registryOutcome)...), h(u.Closing)...)
	return AppEvent{EventSubType: ConfirmSubType, Data: append(data, h(registryClosing)...)}
}

// upkeep voids the scheduled rounds that never opened, once nobody could
// open them any more, and creates the rounds of the next two slots of every
// market after the clock (README section 10).
func (s *State) upkeep() (events []AppEvent) {
	grace := s.Engine.Config.Oracle.VoidGrace
	for _, m := range s.rounds() {
		if m.Status == "scheduled" && s.Clock > m.Spec.OpeningDeadline+grace {
			if e, ok := s.settle(m, engine.VoidRound, nil, s.Clock, sourceOwnVoid); ok {
				events = append(events, e)
			}
		}
	}
	for _, k := range s.Markets {
		first := (s.Clock/k.Duration + 1) * k.Duration
		for _, start := range []uint64{first, first + k.Duration} {
			spec, err := engine.NewRoundSpec(s.Engine.Config, k.Asset, k.Duration, start)
			if err != nil || len(s.Engine.Rounds) >= MaxSliceRounds || slices.ContainsFunc(s.Engine.Rounds, func(m engine.Round) bool { return m.Spec.RegistryRoundID == spec.RegistryRoundID }) {
				continue
			}
			if next, _, err := s.system(s.Engine, engine.Command{Op: engine.CreateRound, Round: &spec}); err == nil {
				s.Engine = next
			}
		}
	}
	return events
}

// tick is a trusted payload from the trigger contract, version 3: the words
// 3, chainId, endpoint, blockNumber, blockTimestamp, tick, n, d, then n <=
// MaxRecords registry records of 19 words each (section 10) and d <=
// MaxDeposits Base deposit records of 3 words each (section 6).
type tick struct {
	version, chainID, block, timestamp, number uint64
	endpoint                                   string
	records                                    []record
	deposits                                   []deposit
}

// deposit is one inbox record: the vault's deposit index, the depositor and
// the amount in Base USDC atoms. ok is false if the record does not decode as
// the inbox writes it; processing stops there and waits.
type deposit struct {
	index   uint64
	account string
	amount  []byte // the 32-byte word as the inbox stored it
	atoms   uint64 // the amount, if the engine can hold it; else 0
	ok      bool
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
	t = tick{version: word(p, 0, 3, &ok), chainID: word(p, 1, all, &ok), block: word(p, 3, all, &ok), timestamp: word(p, 4, all, &ok), number: word(p, 5, all, &ok)}
	for _, b := range p[64:76] {
		ok = ok && b == 0
	}
	t.endpoint = "0x" + hex.EncodeToString(p[76:96])
	if !ok || t.version != 3 || n < 8 {
		return t, false
	}
	count, deposits := int(word(p, 6, MaxRecords, &ok)), int(word(p, 7, MaxDeposits, &ok))
	ok = ok && n == 8+19*count+3*deposits
	for i := 0; ok && i < count; i++ {
		t.records = append(t.records, decodeRecord(p[32*(8+19*i):32*(27+19*i)]))
	}
	for i, at := 0, 8+19*count; ok && i < deposits; i, at = i+1, at+3 {
		d := deposit{ok: true, amount: p[32*(at+2) : 32*(at+3)]}
		d.index = word(p, at, engine.MaxAtoms, &d.ok)
		for _, b := range p[32*(at+1) : 32*(at+1)+12] {
			d.ok = d.ok && b == 0
		}
		d.account = "0x" + hex.EncodeToString(p[32*(at+1)+12:32*(at+2)])
		// The inbox stores at most a uint96 and never zero.
		big96, atoms := true, true
		v := word(p, at+2, engine.MaxAtoms, &atoms)
		for _, b := range d.amount[:20] {
			big96 = big96 && b == 0
		}
		if atoms {
			d.atoms = v
		}
		d.ok = d.ok && big96 && isAddress(d.account) && new(big.Int).SetBytes(d.amount).Sign() > 0
		t.deposits = append(t.deposits, d)
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

// TrustedRequest applies a tick at T = max(clock, the block timestamp the
// trigger reported): a Chainlink report may already have moved the clock past
// Horizen's block time, and a tick behind it must still run. It sets the
// trusted clock, checkpoints the engine (releasing expired orders), credits
// the Base deposits in index order, mirrors the registry records and compares
// those of rounds it settled itself, voids and creates its own rounds,
// activates staged book commands, sweeps settled shares and archives finished
// rounds, all at T (sections 6 to 10). It publishes what it applied under
// ClockSubType, then the credit, payout, settle, confirm and archive records.
// It sends no receipt to anyone. It asks for another tick only when staged
// commands it was due to activate are left over.
func TrustedRequest(appID uint64, payload, state []byte) []byte {
	s, problem := open(appID, state)
	if problem != "" {
		return failure(problem)
	}
	t, ok := decodeTick(payload)
	d := s.Engine.Config.Domain
	// A timestamp above MaxClock is not a time in seconds any round could use,
	// and accepting one would move the clock past every round for good.
	if !ok || t.chainID != d.ChainID || t.endpoint != d.Endpoint || t.timestamp == 0 || t.timestamp > MaxClock || t.block > engine.MaxAtoms {
		return failure(ErrTrusted)
	}
	if t.number <= s.LastTick || t.number > s.TickSeq {
		return failure(ErrTick)
	}
	// The block number is recorded, not compared: the engine never reads it,
	// and a second ordering rule would only be a second way to stop the clock.
	s.Clock, s.Block, s.LastTick = max(s.Clock, t.timestamp), t.block, t.number
	if !s.checkpoint() {
		return failure(ErrInternal)
	}
	events, credited := s.credit(t.deposits)
	settled, applied := s.mirror(t.records)
	events = append(append(events, settled...), s.upkeep()...)
	s.activate(t.number)
	s.sweep()
	// The payload's Keccak-256 is what the endpoint put into this trusted
	// request's ID, so a clock record fed anything but the trigger's answer is
	// provable from the chain, records included (section 8.4).
	k := sha3.NewLegacyKeccak256()
	k.Write(payload)
	clock := append(words(s.LastTick, s.Block, s.Clock, uint64(applied), uint64(len(t.records)-applied), uint64(credited)), k.Sum(nil)...)
	events = append(append([]AppEvent{{EventSubType: ClockSubType, Data: clock}}, events...), s.archive()...)
	if len(s.Staged) > 0 && s.Staged[0].Tick <= t.number {
		// Left over by MaxActivations: the trigger answers this request too,
		// and the next tick carries on where this one stopped.
		ask, ok := s.ask()
		if !ok {
			return failure(ErrInternal)
		}
		events = append(events, ask)
	}
	return s.commit(nil, events)
}

// credit applies the inbox's deposit records in index order, exactly once
// each: an index already seen is skipped, a gap or an undecodable record
// stops it, and the next index is either credited to its depositor's engine
// account (registering the account first, as its own nonce-1 register) with
// the Base deposit as evidence, or, if the engine or the adapter's caps refuse
// it, refunded in full through a payout. Each publishes one credit record.
// It returns the records and the number of deposits processed.
func (s *State) credit(deposits []deposit) (events []AppEvent, n int) {
	for _, d := range deposits {
		if !d.ok || d.index > s.DepositsSeen+1 {
			break
		}
		if d.index <= s.DepositsSeen {
			continue
		}
		next, ok := s.Engine, d.atoms != 0
		if ok && account(next, d.account) == nil {
			c := engine.Command{Domain: next.Config.Domain, ID: engine.CommandID(d.account, 1), Nonce: 1, Op: engine.Register, Account: d.account}
			var err error
			next, _, err = engine.Apply(next, c, s.user(d.account))
			ok = err == nil && len(next.Accounts) <= MaxSliceAccounts
		}
		if ok {
			var err error
			next, _, err = s.system(next, engine.Command{Op: engine.Deposit, Account: d.account, Amount: d.atoms, Evidence: s.baseEvidence(d.index)})
			ok = err == nil && exitReserved(next)
		}
		s.DepositsSeen, n = d.index, n+1
		data := append(append(words(d.index), addressWord(d.account)...), d.amount...)
		if ok {
			s.Engine, s.Deposits = next, s.Deposits+1
			events = append(events, AppEvent{EventSubType: CreditSubType, Data: append(data, words(creditCredited, 0)...)})
			continue
		}
		refund := s.payout(payoutRefund, d.account, d.account, d.amount)
		events = append(events, AppEvent{EventSubType: CreditSubType, Data: append(data, words(creditRefunded, s.Payouts)...)}, refund)
	}
	return events, n
}

// mirror applies the registry records in (start, asset, duration) order and
// returns their settle records and how many changed the engine. For each
// record it applies the first rule that fits and looks again, until none fits
// or the engine refuses. Then every record with an outcome for a round the
// guest settled from a report is compared with what the guest did, and the
// comparison published: the engine's result stands either way (section 10).
func (s *State) mirror(records []record) (events []AppEvent, applied int) {
	sort.SliceStable(records, func(i, j int) bool {
		a, b := records[i], records[j]
		return earlier(a.start, a.asset, a.duration, b.start, b.asset, b.duration)
	})
	for _, r := range records {
		moved := false
		for r.ok {
			e, ok := s.mirrorStep(r)
			if !ok {
				break
			}
			moved, events = true, append(events, e...)
		}
		if moved {
			applied++
		}
	}
	for _, r := range records {
		i := slices.IndexFunc(s.Unconfirmed, func(u Unconfirmed) bool { return u.Round == r.id })
		if !r.ok || r.outcome == 0 || i < 0 {
			continue
		}
		u := s.Unconfirmed[i]
		for _, m := range s.Engine.Rounds {
			if m.Spec.RegistryRoundID == u.Round {
				u.Closing, u.Outcome = "", outcomeNumber(m.Outcome)
				if m.Closing != nil {
					u.Closing = m.Closing.ReportHash
				}
			}
		}
		closing := r.closing.ReportHash
		if !hash32(closing) {
			closing = ""
		}
		agree := uint64(confirmDisagree)
		if u.Opening == r.opening.ReportHash && u.Closing == closing && u.Outcome == r.outcome {
			agree = confirmAgree
		}
		events = append(events, confirmation(u, agree, r.outcome, closing))
		s.Unconfirmed = slices.Delete(s.Unconfirmed, i, i+1)
	}
	return events, applied
}

// mirrorStep applies one engine command for the record, as the authority at
// the tick's time T, and returns the settle record it made, if any.
// registryTime is always the registry's own recorded block timestamp, never T;
// an open round is voided only from a recorded outcome.
func (s *State) mirrorStep(r record) ([]AppEvent, bool) {
	e := s.Engine
	var m *engine.Round
	for i := range e.Rounds {
		if e.Rounds[i].Spec.RegistryRoundID == r.id {
			m = &e.Rounds[i]
		}
	}
	switch {
	case m == nil:
		// Created by the tick that also created the registry round. The engine
		// refuses a round whose start has passed: it never exists here.
		if !slices.Contains(s.Markets, Market{r.asset, r.duration}) || len(e.Rounds) >= MaxSliceRounds {
			return nil, false
		}
		spec, err := engine.NewRoundSpec(e.Config, r.asset, r.duration, r.start)
		if err != nil || spec.RegistryRoundID != r.id {
			return nil, false
		}
		next, _, err := s.system(e, engine.Command{Op: engine.CreateRound, Round: &spec})
		if err != nil {
			return nil, false
		}
		s.Engine = next
		return nil, true
	case m.Status == "scheduled" && r.openedAt != 0:
		x, ok := s.settle(*m, engine.OpenRound, &r.opening, r.openedAt, sourceRegistry)
		return []AppEvent{x}, ok
	case m.Status == "open" && (r.outcome == 1 || r.outcome == 2):
		// The engine decides the outcome itself; it must be the registry's.
		before := s.Engine
		x, ok := s.settle(*m, engine.ResolveRound, &r.closing, r.resolvedAt, sourceRegistry)
		for _, n := range s.Engine.Rounds {
			if ok && n.ID == m.ID && outcomeNumber(n.Outcome) != r.outcome {
				s.Engine, ok = before, false
			}
		}
		return []AppEvent{x}, ok
	case (m.Status == "scheduled" || m.Status == "open") && r.outcome == 3:
		x, ok := s.settle(*m, engine.VoidRound, nil, r.resolvedAt, sourceRegistry)
		return []AppEvent{x}, ok
	}
	return nil, false
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
		// A5: an order that would take any stake past its limit is refused
		// whole, fills and all (README section 9, Stake limits).
		if err == nil && c.Op == engine.PlaceOrder {
			if reason := s.StakeLimits.exceeded(next); reason != "" {
				err = errors.New(reason)
			}
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

// sweep redeems settled shares, oldest round first, at most MaxSweeps
// attempts per tick. Without it, one lot left in each round by an account
// that never returns would hold every round slot for good.
func (s *State) sweep() {
	n := MaxSweeps
	for _, m := range s.rounds() {
		if (m.Status == "resolved" || m.Status == "void") && !s.redeemRound(m.ID, &n) {
			return
		}
	}
}

// redeemRound redeems the shares of settled round id in the name of each
// account that still holds some and has nothing staged: the one redeem
// command the account could have sent itself, with its next nonce, at the
// clock. Each attempt spends one of *budget; a negative budget never runs
// out. It returns false once the budget is spent.
func (s *State) redeemRound(id string, budget *int) bool {
	for i := range s.Engine.Accounts {
		a := s.Engine.Accounts[i]
		j := slices.IndexFunc(a.Holdings, func(h engine.Holding) bool { return h.RoundID == id })
		if j < 0 || a.Holdings[j].Up == 0 && a.Holdings[j].Down == 0 || s.stagedBy(a.ID) >= 0 {
			continue
		}
		if *budget == 0 {
			return false
		}
		*budget--
		c := engine.Command{Domain: s.Engine.Config.Domain, ID: engine.CommandID(a.ID, a.Nonce+1), Nonce: a.Nonce + 1, Op: engine.Redeem, Account: a.ID, RoundID: id}
		if next, _, err := engine.Apply(s.Engine, c, s.user(a.ID)); err == nil {
			s.Engine = next
		}
	}
	return true
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
