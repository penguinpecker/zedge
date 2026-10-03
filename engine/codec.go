package engine

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
)

func fail(s string) error  { return errors.New(s) }
func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func address(s string) bool {
	return len(s) == 42 && s[:2] == "0x" && isHex(s[2:], 40) && s != "0x0000000000000000000000000000000000000000"
}
func identifier(s string) bool {
	if len(s) < 1 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}
func domainValid(d Domain) bool {
	return d.ChainID > 0 && d.ChainID <= MaxAtoms && address(d.Endpoint) && identifier(d.ApplicationID) && d.RulesVersion == Version
}
func add(a, b uint64) (uint64, error) {
	if a > MaxAtoms || b > MaxAtoms || a > MaxAtoms-b {
		return 0, fail("amount overflow")
	}
	return a + b, nil
}
func notional(q, p uint64) uint64                 { return q / 100 * p }            // lot=1000 ensures exact cents.
func fee(n, bps uint64) uint64                    { return (n*bps + 9999) / 10000 } // n<=MaxAtoms, bps<=1000.
func commandID(principal string, n uint64) string { return principal + ":" + strconv.FormatUint(n, 10) }
func CommandID(principal string, n uint64) string { return commandID(principal, n) }
func CommandDigest(c Command) (string, error) {
	b, e := json.Marshal(c)
	if e != nil {
		return "", e
	}
	return hash(b), nil
}

// RoundID commits the deployment, collateral, fee policy, asset, oracle feed and
// exact time/void policy. A recurring market label is not an acceptable round ID.
func RoundID(c Config, r RoundSpec) string {
	b, _ := json.Marshal(struct {
		Config Config    `json:"config"`
		Round  RoundSpec `json:"round"`
	}{c, r})
	return hash(b)
}
func Encode(s *State) ([]byte, error) {
	if e := Validate(s); e != nil {
		return nil, e
	}
	return json.Marshal(s)
}
func StateHash(s *State) (string, error) {
	b, e := Encode(s)
	if e != nil {
		return "", e
	}
	return hash(b), nil
}
func strictDecode(b []byte, v any, limit int) error {
	if len(b) == 0 || len(b) > limit {
		return fail("encoded input size out of bounds")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return fail("trailing JSON")
	}
	return nil
}

// Decode only accepts canonical serialization. This rejects duplicate keys,
// alternate numeric spellings, whitespace and field order ambiguity.
func Decode(b []byte) (*State, error) {
	var s State
	if e := strictDecode(b, &s, MaxSnapshotBytes); e != nil {
		return nil, e
	}
	canonical, e := Encode(&s)
	if e != nil {
		return nil, e
	}
	if !bytes.Equal(canonical, b) {
		return nil, fail("noncanonical snapshot")
	}
	return &s, nil
}
func DecodeCommand(b []byte) (Command, error) {
	var c Command
	if e := strictDecode(b, &c, 8192); e != nil {
		return c, e
	}
	canonical, e := json.Marshal(c)
	if e != nil {
		return c, e
	}
	if !bytes.Equal(canonical, b) {
		return c, fail("noncanonical command")
	}
	return c, nil
}
func New(c Config) (*State, error) {
	s := &State{Version: Version, Config: c, JournalHash: hash([]byte("ZEDGE_ENGINE_V1")), Accounts: []Account{}, Rounds: []Round{}, Orders: []Order{}, Withdrawals: []Withdrawal{}, ExternalEvidence: []string{}}
	if e := Validate(s); e != nil {
		return nil, e
	}
	return s, nil
}
func clone(s *State) (*State, error) {
	b, e := json.Marshal(s)
	if e != nil {
		return nil, e
	}
	if len(b) > MaxSnapshotBytes {
		return nil, fail("snapshot capacity")
	}
	var n State
	e = json.Unmarshal(b, &n)
	return &n, e
}
func (s *State) account(id string) (*Account, error) {
	for i := range s.Accounts {
		if s.Accounts[i].ID == id {
			return &s.Accounts[i], nil
		}
	}
	return nil, fail("unknown account")
}
func (s *State) round(id string) (*Round, error) {
	for i := range s.Rounds {
		if s.Rounds[i].ID == id {
			return &s.Rounds[i], nil
		}
	}
	return nil, fail("unknown round")
}
func (s *State) order(id string) (*Order, error) {
	for i := range s.Orders {
		if s.Orders[i].ID == id {
			return &s.Orders[i], nil
		}
	}
	return nil, fail("unknown active order")
}
func (s *State) withdrawal(id string) (*Withdrawal, error) {
	for i := range s.Withdrawals {
		if s.Withdrawals[i].ID == id {
			return &s.Withdrawals[i], nil
		}
	}
	return nil, fail("unknown withdrawal")
}
func (a *Account) holding(id string) *Holding {
	for i := range a.Holdings {
		if a.Holdings[i].RoundID == id {
			return &a.Holdings[i]
		}
	}
	a.Holdings = append(a.Holdings, Holding{RoundID: id})
	return &a.Holdings[len(a.Holdings)-1]
}
func (s *State) consumeEvidence(e string) error {
	if !isHex(e, 64) {
		return fail("external evidence must be 32-byte lowercase hex")
	}
	for _, v := range s.ExternalEvidence {
		if v == e {
			return fail("external evidence already consumed")
		}
	}
	if len(s.ExternalEvidence) >= 4096 {
		return fail("external evidence capacity")
	}
	s.ExternalEvidence = append(s.ExternalEvidence, e)
	return nil
}
func validateSpec(r RoundSpec) error {
	if (r.Asset != "BTC" && r.Asset != "ETH") || !identifier(r.Feed) || r.Start == 0 || r.End <= r.Start || r.End-r.Start != 300 && r.End-r.Start != 900 || r.Start%(r.End-r.Start) != 0 || r.Cutoff <= r.Start || r.Cutoff >= r.End || r.End > MaxAtoms || r.ObservationWindow > 60 || r.OpeningDeadline < r.Start+r.ObservationWindow || r.OpeningDeadline >= r.Cutoff || r.ResolutionDeadline < r.End+r.ObservationWindow || r.ResolutionDeadline-r.End > 86400 {
		return fail("invalid round specification")
	}
	return nil
}
func validateFields(c Command) error {
	z := c
	z.Domain = Domain{}
	z.ID = ""
	z.Nonce = 0
	z.Op = ""
	z.Account = ""
	switch c.Op {
	case Register, Checkpoint:
	case Deposit:
		z.Amount = 0
		z.Evidence = ""
	case CreateRound:
		z.Round = nil
	case OpenRound, ResolveRound:
		z.RoundID = ""
		z.Evidence = ""
		z.ObservedAt = 0
		z.OraclePrice = 0
	case VoidRound:
		z.RoundID = ""
		z.Evidence = ""
	case Mint, Merge:
		z.RoundID = ""
		z.Quantity = 0
	case PlaceOrder:
		z.RoundID = ""
		z.Outcome = ""
		z.Side = ""
		z.Price = 0
		z.Quantity = 0
		z.TIF = ""
		z.Expiry = 0
		z.MaxFee = 0
	case CancelOrder:
		z.OrderID = ""
	case CancelAll:
		z.RoundID = ""
	case Redeem:
		z.RoundID = ""
	case RequestWithdrawal:
		z.Amount = 0
		z.Destination = ""
	case CancelWithdrawal:
		z.WithdrawalID = ""
	case ExportWithdrawal, ConfirmClaim:
		z.WithdrawalID = ""
		z.Evidence = ""
	default:
		return fail("unknown operation")
	}
	if z != (Command{}) {
		return fail("unexpected command fields")
	}
	return nil
}
func require(ok bool, msg string) error {
	if !ok {
		return fmt.Errorf("invariant: %s", msg)
	}
	return nil
}
