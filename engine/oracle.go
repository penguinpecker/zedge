package engine

import (
	"encoding/binary"
	"encoding/hex"
	"strings"

	"golang.org/x/crypto/sha3"
)

const MaxOraclePrice = "3138550867693340381917894711603833208051177722232017256447"
const RegistryRulesVersion = "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half"
const BTCStreamsFeed = "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8"
const ETHStreamsFeed = "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9"
const maxStreamsTimestamp uint64 = 1<<32 - 1

// ValidOraclePrice accepts the positive range of Solidity int192 as canonical
// decimal text. The signed provider field is deliberately restricted to >0.
func ValidOraclePrice(price string) bool {
	if len(price) == 0 || len(price) > len(MaxOraclePrice) || price[0] == '0' {
		return false
	}
	for _, c := range price {
		if c < '0' || c > '9' {
			return false
		}
	}
	return len(price) < len(MaxOraclePrice) || price <= MaxOraclePrice
}

// CompareOraclePrices compares without narrowing, floating point or rounding.
func CompareOraclePrices(a, b string) (int, error) {
	if !ValidOraclePrice(a) || !ValidOraclePrice(b) {
		return 0, fail("invalid positive int192 price")
	}
	if len(a) < len(b) {
		return -1, nil
	}
	if len(a) > len(b) {
		return 1, nil
	}
	return strings.Compare(a, b), nil
}

func hash32(s string) bool {
	return len(s) == 66 && s[:2] == "0x" && isHex(s[2:], 64) && s != "0x"+strings.Repeat("0", 64)
}
func streamFeed(s string) bool { return hash32(s) && s[:6] == "0x0003" }
func keccak(b []byte) string {
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write(b)
	return "0x" + hex.EncodeToString(h.Sum(nil))
}
func abiUint(v uint64) []byte { b := make([]byte, 32); binary.BigEndian.PutUint64(b[24:], v); return b }
func abiHex(s string) []byte {
	raw, _ := hex.DecodeString(s[2:])
	b := make([]byte, 32)
	copy(b[32-len(raw):], raw)
	return b
}

func registryFieldsValid(c Config) bool {
	o := c.Oracle
	return o.ChainID > 0 && o.ChainID <= MaxAtoms && address(o.Registry) && address(o.Oracle) && address(c.Collateral) &&
		streamFeed(o.BTCFeedID) && streamFeed(o.ETHFeedID) && o.BTCFeedID != o.ETHFeedID && o.Decimals == 18 &&
		o.ObservationWindow <= 60 && o.OpeningGrace > 0 && o.OpeningGrace < 300 &&
		o.VoidGrace >= 120 && o.VoidGrace <= 21*86400 &&
		o.CutoffBuffer > 0 && o.CutoffBuffer < 300 && o.ObservationWindow+o.OpeningGrace < 300-o.CutoffBuffer
}

// RegistryRulesHash reproduces Solidity abi.encode(string,uint256,Config) for
// StreamsRoundRegistry exactly, including the dynamic version-string offset.
// It establishes metadata consistency, not code identity or chain finality.
func RegistryRulesHash(c Config) (string, error) {
	if !registryFieldsValid(c) {
		return "", fail("invalid Streams registry policy")
	}
	o := c.Oracle
	b := append(abiUint(12*32), abiUint(o.ChainID)...)
	for _, value := range []string{o.Oracle, c.Collateral, o.BTCFeedID, o.ETHFeedID} {
		b = append(b, abiHex(value)...)
	}
	for _, value := range []uint64{uint64(o.Decimals), uint64(o.Decimals), o.ObservationWindow, o.OpeningGrace, o.VoidGrace, o.CutoffBuffer} {
		b = append(b, abiUint(value)...)
	}
	b = append(b, abiUint(uint64(len(RegistryRulesVersion)))...)
	b = append(b, []byte(RegistryRulesVersion)...)
	for len(b)%32 != 0 {
		b = append(b, 0)
	}
	return keccak(b), nil
}

func registryValid(c Config) bool {
	h, err := RegistryRulesHash(c)
	return err == nil && hash32(c.Oracle.RulesHash) && h == c.Oracle.RulesHash
}

// RegistryRoundID reproduces the registry's fixed ABI/Keccak identity.
func RegistryRoundID(c Config, asset string, duration, start uint64) (string, error) {
	if !registryValid(c) || (asset != "BTC" && asset != "ETH") || (duration != 300 && duration != 900) ||
		start == 0 || start%duration != 0 || start > maxStreamsTimestamp-duration-c.Oracle.ObservationWindow {
		return "", fail("invalid Streams round identity")
	}
	assetID := uint64(0)
	if asset == "ETH" {
		assetID = 1
	}
	b := append(abiUint(c.Oracle.ChainID), abiHex(c.Oracle.Registry)...)
	b = append(b, abiHex(c.Oracle.RulesHash)...)
	for _, value := range []uint64{assetID, duration, start} {
		b = append(b, abiUint(value)...)
	}
	return keccak(b), nil
}

// NewRoundSpec derives every registry term rather than trusting copied fields.
func NewRoundSpec(c Config, asset string, duration, start uint64) (RoundSpec, error) {
	id, err := RegistryRoundID(c, asset, duration, start)
	if err != nil {
		return RoundSpec{}, err
	}
	o := c.Oracle
	feed := o.BTCFeedID
	if asset == "ETH" {
		feed = o.ETHFeedID
	}
	end := start + duration
	return RoundSpec{Asset: asset, Feed: feed, RegistryRoundID: id, Start: start, End: end,
		Cutoff: end - o.CutoffBuffer, ObservationWindow: o.ObservationWindow,
		OpeningDeadline: start + o.ObservationWindow + o.OpeningGrace, VoidableAfter: end + o.ObservationWindow + o.VoidGrace}, nil
}

// EventAsset marks an operator-resolved Yes/No round: Up is Yes, Down is No.
const EventAsset = "EVENT"

// NewEventSpec derives an event round from the Keccak-256 of its exact rules
// text (question) and its times: trading from start until cutoff, a result at
// or after end, a void only after voidableAfter. Its registry round ID uses
// asset 2, which the registry never issues, so it can never name a price
// round; it commits the question and every time. No observation window, and
// the opening deadline is start: the round is created open.
func NewEventSpec(c Config, question string, start, cutoff, end, voidableAfter uint64) (RoundSpec, error) {
	if !registryValid(c) || !hash32(question) || start == 0 || start >= cutoff || cutoff > end || end >= voidableAfter || voidableAfter > maxStreamsTimestamp {
		return RoundSpec{}, fail("invalid event round")
	}
	b := append(abiUint(c.Oracle.ChainID), abiHex(c.Oracle.Registry)...)
	b = append(append(append(b, abiHex(c.Oracle.RulesHash)...), abiUint(2)...), abiHex(question)...)
	for _, value := range []uint64{start, cutoff, end, voidableAfter} {
		b = append(b, abiUint(value)...)
	}
	return RoundSpec{Asset: EventAsset, Feed: question, RegistryRoundID: keccak(b), Start: start, End: end, Cutoff: cutoff, OpeningDeadline: start, VoidableAfter: voidableAfter}, nil
}

func validateObservation(o *StreamsObservation, feed string, boundary, window, now uint64) error {
	if o == nil || o.FeedID != feed || !ValidOraclePrice(o.Price) || o.Decimals != 18 || !hash32(o.ReportHash) || o.ValidFromTimestamp == 0 ||
		uint64(o.ValidFromTimestamp) > boundary || uint64(o.ObservationsTimestamp) < boundary ||
		uint64(o.ObservationsTimestamp) > boundary+window || uint64(o.ObservationsTimestamp) > now ||
		o.ExpiresAt < o.ObservationsTimestamp {
		return fail("invalid Streams boundary observation")
	}
	// Do not reapply now<=expiresAt: a Base-authenticated report may arrive later.
	// Signature/expiry-at-source, canonical chain input, and sender authentication
	// remain required adapter checks; this is deterministic policy validation.
	return nil
}
