package engine

import "strings"

type AccountSnapshot struct {
	Account      string       `json:"account"`
	Sequence     uint64       `json:"sequence"`
	Nonce        uint64       `json:"nonce"`
	Cash         uint64       `json:"cash"`
	ReservedCash uint64       `json:"reservedCash"`
	Holdings     []Holding    `json:"holdings"`
	Orders       []Order      `json:"orders"`
	Withdrawals  []Withdrawal `json:"withdrawals"`
}
type PrivateFill struct {
	OrderID  string  `json:"orderId"`
	Role     string  `json:"role"`
	Side     Side    `json:"side"`
	RoundID  string  `json:"roundId"`
	Outcome  Outcome `json:"outcome"`
	Price    uint64  `json:"price"`
	Quantity uint64  `json:"quantity"`
	Fee      uint64  `json:"fee"`
}
type PrivateReceipt struct {
	Sequence       uint64        `json:"sequence"`
	CommandID      string        `json:"commandId,omitempty"`
	Status         string        `json:"status"`
	RoundID        string        `json:"roundId,omitempty"`
	OrderID        string        `json:"orderId,omitempty"`
	WithdrawalID   string        `json:"withdrawalId,omitempty"`
	Amount         uint64        `json:"amount,omitempty"`
	Fills          []PrivateFill `json:"fills,omitempty"`
	ReleasedOrders []string      `json:"releasedOrders,omitempty"`
}

// AccountView contains only this account's state and excludes internal receipts,
// state roots and journal hashes. Caller must authenticate account ownership;
// this function is a projection, not an authorization or encryption mechanism.
func AccountView(s *State, account string) (AccountSnapshot, error) {
	if e := Validate(s); e != nil {
		return AccountSnapshot{}, e
	}
	a, e := s.account(account)
	if e != nil {
		return AccountSnapshot{}, e
	}
	v := AccountSnapshot{Account: account, Sequence: s.Sequence, Nonce: a.Nonce, Cash: a.Cash, ReservedCash: a.ReservedCash, Holdings: append([]Holding{}, a.Holdings...), Orders: []Order{}, Withdrawals: []Withdrawal{}}
	for _, o := range s.Orders {
		if o.Account == account {
			v.Orders = append(v.Orders, o)
		}
	}
	for _, w := range s.Withdrawals {
		if w.Account == account {
			v.Withdrawals = append(v.Withdrawals, w)
		}
	}
	return v, nil
}

// ProjectReceipt strips counterparty account/order IDs, unrelated expirations
// and other users' command/withdrawal metadata. It intentionally retains the
// trader's own execution price, size and fee. An uninvolved account gets false.
func ProjectReceipt(r Receipt, account string) (PrivateReceipt, bool) {
	if !address(account) {
		return PrivateReceipt{}, false
	}
	p := PrivateReceipt{Sequence: r.Sequence, Status: "account_update"}
	relevant := false
	if r.Account == account {
		relevant = true
		p.Status = r.Status
		p.RoundID = r.RoundID
		p.Amount = r.Amount
		p.WithdrawalID = r.WithdrawalID
		if strings.HasPrefix(r.CommandID, account+":") {
			p.CommandID = r.CommandID
		}
		if strings.HasPrefix(r.OrderID, account+":") {
			p.OrderID = r.OrderID
		}
	}
	for _, f := range r.Fills {
		if f.Buyer != account && f.Seller != account {
			continue
		}
		relevant = true
		v := PrivateFill{RoundID: f.RoundID, Outcome: f.Outcome, Price: f.Price, Quantity: f.Quantity, Side: Buy, Fee: f.BuyerFee, Role: "taker", OrderID: f.TakerOrder}
		if f.Seller == account {
			v.Side = Sell
			v.Fee = f.SellerFee
		}
		if strings.HasPrefix(f.MakerOrder, account+":") {
			v.Role = "maker"
			v.OrderID = f.MakerOrder
		}
		p.Fills = append(p.Fills, v)
	}
	for _, id := range r.ReleasedOrders {
		if strings.HasPrefix(id, account+":") {
			relevant = true
			p.ReleasedOrders = append(p.ReleasedOrders, id)
		}
	}
	if !relevant {
		return PrivateReceipt{}, false
	}
	return p, true
}
