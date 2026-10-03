package engine

func (s *State) reserved(o *Order) uint64 {
	worst := notional(o.Remaining, o.Price)
	return worst + fee(o.FilledNotional+worst, s.Config.FeeBps) - o.FeePaid
}
func (s *State) place(c Command, r *Receipt) error {
	m, e := s.round(c.RoundID)
	if e != nil {
		return e
	}
	if m.Status != "open" || s.Time < m.Spec.Start || s.Time >= m.Spec.Cutoff {
		return fail("round closed")
	}
	if c.Outcome != Up && c.Outcome != Down || c.Side != Buy && c.Side != Sell || c.TIF != GTC && c.TIF != IOC || c.Price < 1 || c.Price > 99 || c.Quantity == 0 || c.Quantity > MaxAtoms || c.Quantity%Lot != 0 || c.Expiry <= s.Time || c.Expiry > m.Spec.Cutoff {
		return fail("invalid order")
	}
	if c.MaxFee > MaxAtoms || c.MaxFee < fee(notional(c.Quantity, c.Price), s.Config.FeeBps) {
		return fail("fee cap insufficient")
	}
	s.prune()
	if len(s.Orders) >= MaxOrders {
		return fail("order capacity")
	}
	a, _ := s.account(c.Account)
	o := Order{ID: c.ID, Account: c.Account, RoundID: c.RoundID, Outcome: c.Outcome, Side: c.Side, Price: c.Price, Original: c.Quantity, Remaining: c.Quantity, Sequence: s.Sequence, Expiry: c.Expiry, MaxFee: c.MaxFee}
	if o.Side == Buy {
		o.ReservedCash = s.reserved(&o)
		if a.Cash < o.ReservedCash {
			return fail("insufficient available cash")
		}
		a.Cash -= o.ReservedCash
		a.ReservedCash += o.ReservedCash
	} else {
		h := a.holding(o.RoundID)
		if o.Outcome == Up {
			if h.Up < o.Remaining {
				return fail("insufficient available Up shares")
			}
			h.Up -= o.Remaining
			h.ReservedUp += o.Remaining
		} else {
			if h.Down < o.Remaining {
				return fail("insufficient available Down shares")
			}
			h.Down -= o.Remaining
			h.ReservedDown += o.Remaining
		}
	}
	r.OrderID = o.ID
	r.RoundID = o.RoundID
	for o.Remaining > 0 {
		idx := s.best(&o)
		if idx < 0 {
			break
		}
		maker := &s.Orders[idx]
		if maker.Account == o.Account {
			s.release(&o)
			r.Status = "self_trade_cancelled"
			break
		}
		if len(r.Fills) >= MaxMatches {
			return fail("matching work limit; split order")
		}
		q := o.Remaining
		if maker.Remaining < q {
			q = maker.Remaining
		}
		f, e := s.fill(maker, &o, q, maker.Price)
		if e != nil {
			return e
		}
		r.Fills = append(r.Fills, f)
	}
	if o.Remaining > 0 {
		if c.TIF == IOC {
			s.release(&o)
			r.Status = "ioc_complete"
		} else {
			s.Orders = append(s.Orders, o)
			r.Status = "resting"
		}
	} else if r.Status == "accepted" {
		r.Status = "filled"
	}
	return nil
}
func (s *State) best(t *Order) int {
	best := -1
	for i := range s.Orders {
		o := &s.Orders[i]
		if o.Remaining == 0 || o.RoundID != t.RoundID || o.Outcome != t.Outcome || o.Side == t.Side {
			continue
		}
		if t.Side == Buy && o.Price > t.Price || t.Side == Sell && o.Price < t.Price {
			continue
		}
		if best < 0 {
			best = i
			continue
		}
		b := &s.Orders[best]
		better := t.Side == Buy && o.Price < b.Price || t.Side == Sell && o.Price > b.Price
		if better || o.Price == b.Price && o.Sequence < b.Sequence {
			best = i
		}
	}
	return best
}
func (s *State) fill(m, t *Order, q, p uint64) (Fill, error) {
	b, sell := t, m
	if m.Side == Buy {
		b, sell = m, t
	}
	buyer, _ := s.account(b.Account)
	seller, _ := s.account(sell.Account)
	n := notional(q, p)
	bn, e := add(b.FilledNotional, n)
	if e != nil {
		return Fill{}, e
	}
	sn, e := add(sell.FilledNotional, n)
	if e != nil {
		return Fill{}, e
	}
	bf := fee(bn, s.Config.FeeBps) - b.FeePaid
	sf := fee(sn, s.Config.FeeBps) - sell.FeePaid
	if b.FeePaid+bf > b.MaxFee || sell.FeePaid+sf > sell.MaxFee {
		return Fill{}, fail("execution fee cap exceeded")
	}
	if b.ReservedCash < n+bf || n < sf {
		return Fill{}, fail("fill reservation shortfall")
	}
	b.ReservedCash -= n + bf
	buyer.ReservedCash -= n + bf
	seller.Cash += n - sf
	s.Fees += bf + sf
	bh := buyer.holding(b.RoundID)
	sh := seller.holding(sell.RoundID)
	if b.Outcome == Up {
		if sh.ReservedUp < q {
			return Fill{}, fail("seller share shortfall")
		}
		sh.ReservedUp -= q
		bh.Up += q
	} else {
		if sh.ReservedDown < q {
			return Fill{}, fail("seller share shortfall")
		}
		sh.ReservedDown -= q
		bh.Down += q
	}
	b.Remaining -= q
	b.Filled += q
	b.FilledNotional = bn
	b.FeePaid += bf
	sell.Remaining -= q
	sell.Filled += q
	sell.FilledNotional = sn
	sell.FeePaid += sf
	needed := s.reserved(b)
	if needed > b.ReservedCash {
		return Fill{}, fail("remaining reservation shortfall")
	}
	release := b.ReservedCash - needed
	b.ReservedCash = needed
	buyer.ReservedCash -= release
	buyer.Cash += release
	return Fill{MakerOrder: m.ID, TakerOrder: t.ID, Buyer: b.Account, Seller: sell.Account, RoundID: b.RoundID, Outcome: b.Outcome, Price: p, Quantity: q, BuyerFee: bf, SellerFee: sf}, nil
}
