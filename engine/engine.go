package engine

import (
	"encoding/json"
	"sort"
)

func systemOp(o Operation) bool {
	switch o {
	case Deposit, CreateRound, OpenRound, Checkpoint, ResolveRound, VoidRound, ExportWithdrawal, ConfirmClaim:
		return true
	}
	return false
}

// Apply is atomic: it never changes input s, even on rejection. Exact retry of
// the latest accepted nonce returns the same receipt and unchanged state. Older
// nonces and conflicting reuse reject. Validation/authentication failures do not
// consume a nonce. The caller MUST supply a verified fresh context.
func Apply(s *State, c Command, x AuthenticatedContext) (*State, Receipt, error) {
	var empty Receipt
	if e := Validate(s); e != nil {
		return nil, empty, e
	}
	if c.Domain != s.Config.Domain || x.Domain != s.Config.Domain {
		return nil, empty, fail("wrong domain")
	}
	if !address(x.Principal) || c.Nonce == 0 || c.Nonce > MaxAtoms || c.ID != commandID(x.Principal, c.Nonce) {
		return nil, empty, fail("invalid principal, command ID or nonce")
	}
	if e := validateFields(c); e != nil {
		return nil, empty, e
	}
	if systemOp(c.Op) != x.System {
		return nil, empty, fail("wrong authorization class")
	}
	var previous uint64
	var previousDigest string
	var previousReceipt Receipt
	if x.System {
		if x.Principal != s.Config.Authority {
			return nil, empty, fail("wrong authority")
		}
		previous = s.AuthorityNonce
		previousDigest = s.AuthorityDigest
		previousReceipt = s.AuthorityReceipt
		if c.Op == Deposit {
			if !address(c.Account) {
				return nil, empty, fail("invalid deposit account")
			}
		} else if c.Account != "" {
			return nil, empty, fail("unexpected system account")
		}
	} else {
		if x.Principal == s.Config.Authority {
			return nil, empty, fail("authority cannot trade")
		}
		if c.Account != x.Principal {
			return nil, empty, fail("account not authorized")
		}
		a, e := s.account(c.Account)
		if e != nil && c.Op != Register {
			return nil, empty, e
		}
		if e == nil {
			previous = a.Nonce
			previousDigest = a.LastDigest
			previousReceipt = a.LastReceipt
		}
	}
	digest, e := CommandDigest(c)
	if e != nil {
		return nil, empty, e
	}
	if c.Nonce == previous && digest == previousDigest {
		n, e := clone(s)
		return n, copyReceipt(previousReceipt), e
	}
	if previous == ^uint64(0) || c.Nonce != previous+1 {
		return nil, empty, fail("replayed, conflicting or out-of-order nonce")
	}
	if x.Timestamp == 0 || x.Timestamp > MaxAtoms || x.Timestamp < s.Time {
		return nil, empty, fail("stale authenticated time")
	}
	if s.Sequence >= MaxAtoms {
		return nil, empty, fail("sequence exhausted")
	}
	n, e := clone(s)
	if e != nil {
		return nil, empty, e
	}
	n.Sequence++
	n.Time = x.Timestamp
	r := Receipt{Sequence: n.Sequence, CommandID: c.ID, Account: c.Account, Status: "accepted"}
	n.expire(&r)
	if e = n.execute(c, &r); e != nil {
		return nil, empty, e
	}
	n.prune()
	if x.System {
		n.AuthorityNonce = c.Nonce
		n.AuthorityDigest = digest
		n.AuthorityReceipt = r
	} else {
		a, _ := n.account(c.Account)
		a.Nonce = c.Nonce
		a.LastDigest = digest
		a.LastReceipt = r
	}
	journal, _ := json.Marshal(struct {
		Previous string  `json:"previous"`
		Digest   string  `json:"digest"`
		Time     uint64  `json:"time"`
		Receipt  Receipt `json:"receipt"`
	}{s.JournalHash, digest, x.Timestamp, r})
	n.JournalHash = hash(journal)
	n.canonicalize()
	if e = Validate(n); e != nil {
		return nil, empty, e
	}
	b, e := json.Marshal(n)
	if e != nil {
		return nil, empty, e
	}
	if len(b) > MaxSnapshotBytes {
		return nil, empty, fail("snapshot capacity")
	}
	return n, copyReceipt(r), nil
}

func copyReceipt(r Receipt) Receipt {
	r.Fills = append([]Fill(nil), r.Fills...)
	r.ReleasedOrders = append([]string(nil), r.ReleasedOrders...)
	if r.PublicWithdrawal != nil {
		w := *r.PublicWithdrawal
		r.PublicWithdrawal = &w
	}
	return r
}

func (s *State) execute(c Command, r *Receipt) error {
	switch c.Op {
	case Register:
		if _, e := s.account(c.Account); e == nil {
			return fail("account already registered")
		}
		if len(s.Accounts) >= MaxAccounts {
			return fail("account capacity")
		}
		s.Accounts = append(s.Accounts, Account{ID: c.Account, Holdings: []Holding{}})
		return nil
	case Checkpoint:
		return nil
	case Deposit:
		if c.Amount == 0 || c.Amount > MaxAtoms {
			return fail("invalid deposit amount")
		}
		a, e := s.account(c.Account)
		if e != nil {
			return e
		}
		if e = s.consumeEvidence(c.Evidence); e != nil {
			return e
		}
		if s.Deposited > MaxAtoms-c.Amount {
			return fail("lifetime deposit capacity")
		}
		s.Deposited += c.Amount
		s.Custody += c.Amount
		a.Cash += c.Amount
		r.Amount = c.Amount
		return nil
	case CreateRound:
		if c.Round == nil {
			return fail("missing round")
		}
		if e := validateSpec(*c.Round); e != nil {
			return e
		}
		if s.Time >= c.Round.Start {
			return fail("round must be created before opening")
		}
		if len(s.Rounds) >= MaxRounds {
			return fail("round capacity")
		}
		id := RoundID(s.Config, *c.Round)
		if _, e := s.round(id); e == nil {
			return fail("round already exists")
		}
		s.Rounds = append(s.Rounds, Round{ID: id, Spec: *c.Round, Status: "scheduled"})
		r.RoundID = id
		return nil
	case OpenRound:
		m, e := s.round(c.RoundID)
		if e != nil {
			return e
		}
		if m.Status != "scheduled" || s.Time < m.Spec.Start || s.Time > m.Spec.OpeningDeadline || c.ObservedAt < m.Spec.Start || c.ObservedAt > m.Spec.Start+m.Spec.ObservationWindow || c.ObservedAt > s.Time || c.OraclePrice == 0 || c.OraclePrice > MaxAtoms || !isHex(c.Evidence, 64) {
			return fail("invalid opening observation")
		}
		m.Status = "open"
		m.OpenPrice = c.OraclePrice
		m.OpenObservedAt = c.ObservedAt
		m.OpenEvidence = c.Evidence
		r.RoundID = m.ID
		return nil
	case Mint, Merge:
		return s.completeSet(c, r)
	case PlaceOrder:
		return s.place(c, r)
	case CancelOrder:
		o, e := s.order(c.OrderID)
		if e != nil {
			return e
		}
		if o.Account != c.Account {
			return fail("order not owned")
		}
		s.release(o)
		r.OrderID = c.OrderID
		r.Status = "cancelled"
		return nil
	case CancelAll:
		if c.RoundID != "" {
			if _, e := s.round(c.RoundID); e != nil {
				return e
			}
		}
		for i := range s.Orders {
			o := &s.Orders[i]
			if o.Account == c.Account && (c.RoundID == "" || o.RoundID == c.RoundID) && o.Remaining > 0 {
				r.ReleasedOrders = append(r.ReleasedOrders, o.ID)
				s.release(o)
			}
		}
		r.Status = "cancelled"
		return nil
	case ResolveRound, VoidRound:
		m, e := s.round(c.RoundID)
		if e != nil {
			return e
		}
		if m.Status == "resolved" || m.Status == "void" {
			return fail("round already settled")
		}
		if !isHex(c.Evidence, 64) {
			return fail("missing settlement evidence")
		}
		if c.Op == ResolveRound {
			if m.Status != "open" || s.Time < m.Spec.End || s.Time > m.Spec.ResolutionDeadline || c.ObservedAt < m.Spec.End || c.ObservedAt > m.Spec.End+m.Spec.ObservationWindow || c.ObservedAt > s.Time || c.OraclePrice == 0 || c.OraclePrice > MaxAtoms {
				return fail("invalid closing observation")
			}
			m.Status = "resolved"
			m.ClosePrice = c.OraclePrice
			m.CloseObservedAt = c.ObservedAt
			m.Outcome = Down
			if c.OraclePrice >= m.OpenPrice {
				m.Outcome = Up
			}
		} else {
			deadline := m.Spec.ResolutionDeadline
			if m.Status == "scheduled" {
				deadline = m.Spec.OpeningDeadline
			}
			if s.Time <= deadline {
				return fail("void timeout not reached")
			}
			m.Status = "void"
			m.Outcome = Void
		}
		m.CloseEvidence = c.Evidence
		r.RoundID = m.ID
		return nil
	case Redeem:
		return s.redeem(c, r)
	case RequestWithdrawal:
		if c.Amount == 0 || c.Amount > MaxAtoms || !address(c.Destination) {
			return fail("invalid withdrawal")
		}
		if len(s.Withdrawals) >= MaxWithdrawals {
			return fail("withdrawal capacity")
		}
		a, _ := s.account(c.Account)
		if a.Cash < c.Amount {
			return fail("insufficient available cash")
		}
		a.Cash -= c.Amount
		s.Withdrawals = append(s.Withdrawals, Withdrawal{ID: c.ID, Account: c.Account, Destination: c.Destination, Amount: c.Amount, Status: "pending"})
		r.WithdrawalID = c.ID
		r.Amount = c.Amount
		return nil
	case CancelWithdrawal:
		w, e := s.withdrawal(c.WithdrawalID)
		if e != nil {
			return e
		}
		if w.Account != c.Account || w.Status != "pending" {
			return fail("withdrawal not cancellable")
		}
		a, _ := s.account(c.Account)
		a.Cash += w.Amount
		w.Status = "cancelled"
		r.WithdrawalID = w.ID
		r.Amount = w.Amount
		return nil
	case ExportWithdrawal:
		w, e := s.withdrawal(c.WithdrawalID)
		if e != nil {
			return e
		}
		if w.Status != "pending" {
			return fail("withdrawal not pending")
		}
		if e = s.consumeEvidence(c.Evidence); e != nil {
			return e
		}
		s.Custody -= w.Amount
		s.Claimable += w.Amount
		w.Status = "claimable"
		out := *w
		r.PublicWithdrawal = &out
		r.Account = w.Account
		r.WithdrawalID = w.ID
		r.Amount = w.Amount
		return nil
	case ConfirmClaim:
		w, e := s.withdrawal(c.WithdrawalID)
		if e != nil {
			return e
		}
		if w.Status != "claimable" {
			return fail("withdrawal not claimable")
		}
		if e = s.consumeEvidence(c.Evidence); e != nil {
			return e
		}
		s.Claimable -= w.Amount
		s.PaidOut += w.Amount
		w.Status = "claimed"
		r.Account = w.Account
		r.WithdrawalID = w.ID
		r.Amount = w.Amount
		return nil
	}
	return fail("unknown operation")
}
func (s *State) completeSet(c Command, r *Receipt) error {
	m, e := s.round(c.RoundID)
	if e != nil {
		return e
	}
	if m.Status != "open" || s.Time >= m.Spec.Cutoff {
		return fail("round not open for complete sets")
	}
	if c.Quantity == 0 || c.Quantity > MaxAtoms || c.Quantity%Lot != 0 {
		return fail("invalid share quantity")
	}
	a, _ := s.account(c.Account)
	h := a.holding(m.ID)
	if c.Op == Mint {
		if a.Cash < c.Quantity {
			return fail("insufficient available cash")
		}
		a.Cash -= c.Quantity
		h.Up += c.Quantity
		h.Down += c.Quantity
		m.UpSupply += c.Quantity
		m.DownSupply += c.Quantity
		m.Locked += c.Quantity
	} else {
		if h.Up < c.Quantity || h.Down < c.Quantity {
			return fail("insufficient available complete sets")
		}
		h.Up -= c.Quantity
		h.Down -= c.Quantity
		m.UpSupply -= c.Quantity
		m.DownSupply -= c.Quantity
		m.Locked -= c.Quantity
		a.Cash += c.Quantity
	}
	r.Amount = c.Quantity
	r.RoundID = m.ID
	return nil
}
func (s *State) redeem(c Command, r *Receipt) error {
	m, e := s.round(c.RoundID)
	if e != nil {
		return e
	}
	if m.Status != "resolved" && m.Status != "void" {
		return fail("round unsettled")
	}
	a, _ := s.account(c.Account)
	h := a.holding(m.ID)
	if h.Up == 0 && h.Down == 0 {
		return fail("nothing to redeem")
	}
	if h.ReservedUp != 0 || h.ReservedDown != 0 {
		return fail("shares still reserved")
	}
	var paid uint64
	switch m.Outcome {
	case Up:
		paid = h.Up
	case Down:
		paid = h.Down
	case Void:
		paid = h.Up/2 + h.Down/2
	}
	if paid > m.Locked {
		return fail("settlement collateral shortfall")
	}
	m.Locked -= paid
	m.UpSupply -= h.Up
	m.DownSupply -= h.Down
	a.Cash += paid
	h.Up = 0
	h.Down = 0
	r.Amount = paid
	r.RoundID = m.ID
	return nil
}
func (s *State) expire(r *Receipt) {
	for i := range s.Orders {
		o := &s.Orders[i]
		m, _ := s.round(o.RoundID)
		if s.Time >= o.Expiry || s.Time >= m.Spec.Cutoff || m.Status != "open" {
			r.ReleasedOrders = append(r.ReleasedOrders, o.ID)
			s.release(o)
		}
	}
}
func (s *State) release(o *Order) {
	a, _ := s.account(o.Account)
	if o.Side == Buy {
		a.ReservedCash -= o.ReservedCash
		a.Cash += o.ReservedCash
		o.ReservedCash = 0
	} else {
		h := a.holding(o.RoundID)
		if o.Outcome == Up {
			h.ReservedUp -= o.Remaining
			h.Up += o.Remaining
		} else {
			h.ReservedDown -= o.Remaining
			h.Down += o.Remaining
		}
	}
	o.Remaining = 0
}
func (s *State) prune() {
	orders := s.Orders[:0]
	for _, o := range s.Orders {
		if o.Remaining > 0 {
			orders = append(orders, o)
		}
	}
	s.Orders = orders
	ws := s.Withdrawals[:0]
	for _, w := range s.Withdrawals {
		if w.Status == "pending" || w.Status == "claimable" {
			ws = append(ws, w)
		}
	}
	s.Withdrawals = ws
}
func (s *State) canonicalize() {
	sort.Slice(s.Accounts, func(i, j int) bool { return s.Accounts[i].ID < s.Accounts[j].ID })
	for i := range s.Accounts {
		a := &s.Accounts[i]
		sort.Slice(a.Holdings, func(i, j int) bool { return a.Holdings[i].RoundID < a.Holdings[j].RoundID })
	}
	sort.Slice(s.Rounds, func(i, j int) bool { return s.Rounds[i].ID < s.Rounds[j].ID })
	sort.Slice(s.Orders, func(i, j int) bool { return s.Orders[i].Sequence < s.Orders[j].Sequence })
	sort.Slice(s.Withdrawals, func(i, j int) bool { return s.Withdrawals[i].ID < s.Withdrawals[j].ID })
	sort.Strings(s.ExternalEvidence)
}
