package engine

import "strconv"

// Validate checks conservation, reservations, supply, ordering and structural
// bounds on every transition and snapshot load. It is not an authenticity proof;
// the adapter must authenticate the previous state commitment.
func Validate(s *State) error {
	if s == nil || s.Version != Version || !domainValid(s.Config.Domain) || !address(s.Config.Authority) || !address(s.Config.Collateral) || !registryValid(s.Config) || s.Config.FeeBps > 1000 || !isHex(s.JournalHash, 64) {
		return fail("invalid configuration/state version")
	}
	if s.Accounts == nil || s.Rounds == nil || s.Orders == nil || s.Withdrawals == nil || s.ExternalEvidence == nil || len(s.Accounts) > MaxAccounts || len(s.Rounds) > MaxRounds || len(s.Orders) > MaxOrders || len(s.Withdrawals) > MaxWithdrawals || len(s.ExternalEvidence) > 4096 {
		return fail("invalid state capacity/arrays")
	}
	if s.Deposited > MaxAtoms || s.Custody > MaxAtoms || s.Claimable > MaxAtoms || s.PaidOut > MaxAtoms || s.Fees > MaxAtoms {
		return fail("state amount out of bounds")
	}
	x, e := add(s.Custody, s.Claimable)
	if e != nil {
		return e
	}
	x, e = add(x, s.PaidOut)
	if e != nil || x != s.Deposited {
		return fail("external custody conservation")
	}
	if s.Sequence == 0 {
		if s.Time != 0 || s.AuthorityNonce != 0 || s.AuthorityDigest != "" || len(s.Accounts) > 0 || len(s.Rounds) > 0 || s.Deposited != 0 {
			return fail("invalid genesis")
		}
	} else if s.Time == 0 {
		return fail("missing state time")
	}
	if s.AuthorityNonce > s.Sequence {
		return fail("authority nonce exceeds sequence")
	}
	if s.Sequence > MaxAtoms || s.Time > MaxAtoms {
		return fail("sequence/time capacity")
	}
	if !isHex(s.ArchiveRoot, 64) || s.ArchivedRounds > s.Sequence || s.ArchivedRounds == 0 && s.ArchiveRoot != hash([]byte("ZEDGE_ARCHIVES_V3")) {
		return fail("invalid archive commitment")
	}
	if s.AuthorityNonce > 0 && (!isHex(s.AuthorityDigest, 64) || s.AuthorityReceipt.CommandID != commandID(s.Config.Authority, s.AuthorityNonce) || s.AuthorityReceipt.Sequence > s.Sequence) {
		return fail("invalid authority receipt")
	}
	liabilities := s.Fees
	for i := range s.Accounts {
		a := &s.Accounts[i]
		if !address(a.ID) || a.ID == s.Config.Authority || i > 0 && s.Accounts[i-1].ID >= a.ID || a.Nonce == 0 || a.Nonce > s.Sequence || !isHex(a.LastDigest, 64) || a.LastReceipt.CommandID != commandID(a.ID, a.Nonce) || a.LastReceipt.Sequence > s.Sequence || a.Holdings == nil || len(a.Holdings) > MaxRounds {
			return fail("invalid account")
		}
		liabilities, e = add(liabilities, a.Cash)
		if e != nil {
			return e
		}
		liabilities, e = add(liabilities, a.ReservedCash)
		if e != nil {
			return e
		}
		var expected uint64
		for j := range s.Orders {
			o := &s.Orders[j]
			if o.Account == a.ID && o.Side == Buy {
				expected, e = add(expected, o.ReservedCash)
				if e != nil {
					return e
				}
			}
		}
		if expected != a.ReservedCash {
			return fail("cash reservation mismatch")
		}
		for j := range a.Holdings {
			h := &a.Holdings[j]
			if j > 0 && a.Holdings[j-1].RoundID >= h.RoundID {
				return fail("unordered holdings")
			}
			if _, e = s.round(h.RoundID); e != nil {
				return e
			}
			for _, v := range []uint64{h.Up, h.Down, h.ReservedUp, h.ReservedDown} {
				if v > MaxAtoms || v%Lot != 0 {
					return fail("invalid share atoms")
				}
			}
			var u, d uint64
			for k := range s.Orders {
				o := &s.Orders[k]
				if o.Account == a.ID && o.RoundID == h.RoundID && o.Side == Sell {
					if o.Outcome == Up {
						u, e = add(u, o.Remaining)
					} else {
						d, e = add(d, o.Remaining)
					}
					if e != nil {
						return e
					}
				}
			}
			if u != h.ReservedUp || d != h.ReservedDown {
				return fail("share reservation mismatch")
			}
		}
	}
	for i := range s.Rounds {
		m := &s.Rounds[i]
		if e = validateSpec(s.Config, m.Spec); e != nil {
			return e
		}
		if m.ID != RoundID(s.Config, m.Spec) || i > 0 && s.Rounds[i-1].ID >= m.ID {
			return fail("invalid round identity")
		}
		if m.Locked > MaxAtoms || m.UpSupply > MaxAtoms || m.DownSupply > MaxAtoms || m.UpSupply%Lot != 0 || m.DownSupply%Lot != 0 {
			return fail("round amount out of bounds")
		}
		var u, d uint64
		for j := range s.Accounts {
			for _, h := range s.Accounts[j].Holdings {
				if h.RoundID == m.ID {
					u, e = add(u, h.Up)
					if e != nil {
						return e
					}
					u, e = add(u, h.ReservedUp)
					if e != nil {
						return e
					}
					d, e = add(d, h.Down)
					if e != nil {
						return e
					}
					d, e = add(d, h.ReservedDown)
					if e != nil {
						return e
					}
				}
			}
		}
		if u != m.UpSupply || d != m.DownSupply {
			return fail("outcome supply mismatch")
		}
		switch {
		case m.Spec.Asset == EventAsset:
			if e = validateEvent(m, u, d, s.Time); e != nil {
				return e
			}
		case m.Status == "scheduled":
			if m.Opening != nil || m.Closing != nil || m.Outcome != "" || m.Locked != 0 || u != 0 || d != 0 || m.OpenEvidence != "" || m.CloseEvidence != "" {
				return fail("invalid scheduled round")
			}
		case m.Status == "open":
			if validateObservation(m.Opening, m.Spec.Feed, m.Spec.Start, m.Spec.ObservationWindow, s.Time) != nil || !isHex(m.OpenEvidence, 64) || m.Closing != nil || m.CloseEvidence != "" || m.Outcome != "" || m.Locked != u || u != d {
				return fail("unbacked open round")
			}
		case m.Status == "resolved":
			if !isHex(m.OpenEvidence, 64) || !isHex(m.CloseEvidence, 64) || s.Time < m.Spec.End || validateObservation(m.Opening, m.Spec.Feed, m.Spec.Start, m.Spec.ObservationWindow, s.Time) != nil || validateObservation(m.Closing, m.Spec.Feed, m.Spec.End, m.Spec.ObservationWindow, s.Time) != nil {
				return fail("invalid resolution")
			}
			out := Down
			comparison, _ := CompareOraclePrices(m.Closing.Price, m.Opening.Price)
			if comparison >= 0 {
				out = Up
			}
			if m.Outcome != out || out == Up && m.Locked != u || out == Down && m.Locked != d {
				return fail("settlement collateral mismatch")
			}
		case m.Status == "void":
			if m.Outcome != Void || !isHex(m.CloseEvidence, 64) || s.Time <= m.Spec.VoidableAfter && m.Opening != nil || s.Time <= m.Spec.OpeningDeadline && m.Opening == nil || m.Locked != u/2+d/2 || m.Closing != nil {
				return fail("void collateral mismatch")
			}
			if m.Opening == nil {
				if m.OpenEvidence != "" || u != 0 || d != 0 {
					return fail("invalid missing-opening void")
				}
			} else if validateObservation(m.Opening, m.Spec.Feed, m.Spec.Start, m.Spec.ObservationWindow, s.Time) != nil || !isHex(m.OpenEvidence, 64) {
				return fail("invalid void opening")
			}
		default:
			return fail("invalid round status")
		}
		liabilities, e = add(liabilities, m.Locked)
		if e != nil {
			return e
		}
	}
	for i := range s.Orders {
		o := &s.Orders[i]
		a, e := s.account(o.Account)
		if e != nil {
			return e
		}
		m, e := s.round(o.RoundID)
		if e != nil {
			return e
		}
		if !address(o.Account) || o.Side != Buy && o.Side != Sell || o.Outcome != Up && o.Outcome != Down || o.Price < 1 || o.Price > 99 || o.Original == 0 || o.Original > MaxAtoms || o.Remaining == 0 || o.Remaining > o.Original || o.Filled > o.Original || o.Filled+o.Remaining != o.Original || o.Original%Lot != 0 || o.Remaining%Lot != 0 || o.Filled%Lot != 0 || o.FilledNotional > MaxAtoms || o.FeePaid != fee(o.FilledNotional, s.Config.FeeBps) || o.MaxFee > MaxAtoms || o.FeePaid > o.MaxFee || o.Sequence == 0 || o.Sequence > s.Sequence || i > 0 && s.Orders[i-1].Sequence >= o.Sequence || m.Status != "open" || s.Time >= m.Spec.Cutoff || o.Expiry <= s.Time || o.Expiry > m.Spec.Cutoff {
			return fail("invalid active order")
		}
		// IDs encode owner nonce and cannot be shared by two active orders.
		if len(o.ID) <= len(o.Account)+1 || o.ID[:len(o.Account)+1] != o.Account+":" {
			return fail("invalid order ID")
		}
		nonce, err := strconv.ParseUint(o.ID[len(o.Account)+1:], 10, 64)
		if err != nil || nonce == 0 || nonce > a.Nonce || o.ID != commandID(o.Account, nonce) {
			return fail("invalid order nonce")
		}
		if o.FilledNotional > notional(o.Filled, 99) || o.FilledNotional < notional(o.Filled, 1) {
			return fail("invalid filled notional")
		}
		for j := 0; j < i; j++ {
			if s.Orders[j].ID == o.ID {
				return fail("duplicate order")
			}
		}
		if o.Side == Buy {
			if o.ReservedCash != s.reserved(o) {
				return fail("order cash reservation mismatch")
			}
		} else {
			if o.ReservedCash != 0 {
				return fail("sell order cash reservation")
			}
			found := false
			for _, h := range a.Holdings {
				if h.RoundID == o.RoundID {
					found = true
				}
			}
			if !found {
				return fail("missing seller inventory")
			}
		}
	}
	var claims uint64
	for i := range s.Withdrawals {
		w := &s.Withdrawals[i]
		if _, e = s.account(w.Account); e != nil {
			return e
		}
		if !address(w.Destination) || w.Amount == 0 || w.Amount > MaxAtoms || i > 0 && s.Withdrawals[i-1].ID >= w.ID {
			return fail("invalid withdrawal")
		}
		switch w.Status {
		case "pending":
			liabilities, e = add(liabilities, w.Amount)
		case "claimable":
			claims, e = add(claims, w.Amount)
		default:
			return fail("invalid withdrawal status")
		}
		if e != nil {
			return e
		}
	}
	if claims != s.Claimable || liabilities != s.Custody {
		return fail("internal liability conservation")
	}
	for i, v := range s.ExternalEvidence {
		if !isHex(v, 64) || i > 0 && s.ExternalEvidence[i-1] >= v {
			return fail("invalid/repeated evidence")
		}
	}
	return nil
}

// validateEvent checks an operator-resolved event round: created open, it never
// holds an observation or an opening; resolved, it pays the posted outcome and
// carries its evidence; voided, only after voidableAfter, half a share each.
func validateEvent(m *Round, u, d, now uint64) error {
	bare := m.Opening == nil && m.Closing == nil && m.OpenEvidence == ""
	switch m.Status {
	case "open":
		if bare && m.CloseEvidence == "" && m.Outcome == "" && m.Locked == u && u == d {
			return nil
		}
	case "resolved":
		if bare && isHex(m.CloseEvidence, 64) && now >= m.Spec.End && (m.Outcome == Up && m.Locked == u || m.Outcome == Down && m.Locked == d) {
			return nil
		}
	case "void":
		if bare && isHex(m.CloseEvidence, 64) && now > m.Spec.VoidableAfter && m.Outcome == Void && m.Locked == u/2+d/2 {
			return nil
		}
	}
	return fail("invalid event round")
}
