package guest

import (
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"slices"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/penguinpecker/zedge/engine"
	"golang.org/x/crypto/sha3"
)

// Chainlink pins the Data Streams DON whose reports the guest accepts by
// itself (README section 12): the feed, and per config digest the fault
// tolerance f and the signer addresses, as the Base verifier's ConfigSet
// recorded them. Any f+1 distinct pinned signers make a report genuine.
type Chainlink struct {
	FeedID  string      `json:"feedId"`
	Configs []DONConfig `json:"configs"`
}

type DONConfig struct {
	Digest  string   `json:"digest"`
	F       uint64   `json:"f"`
	Signers []string `json:"signers"` // lowercase addresses
}

const (
	// MaxDigests pinned config digests: the one in use and the next. Each
	// holds up to MaxSigners addresses in the state, and four would take the
	// state at every cap past MaxStateBytes (TestStateAtEveryCapFitsTheBound).
	MaxDigests = 2
	MaxSigners = 31 // Chainlink's own limit per config
	blobBytes  = 288
)

func (c Chainlink) valid(e engine.Config) bool {
	if c.FeedID != e.Oracle.BTCFeedID || len(c.Configs) < 1 || len(c.Configs) > MaxDigests {
		return false
	}
	for i, d := range c.Configs {
		if !hash32(d.Digest) || d.F < 1 || uint64(len(d.Signers)) < 3*d.F+1 || len(d.Signers) > MaxSigners ||
			slices.IndexFunc(c.Configs[:i], func(x DONConfig) bool { return x.Digest == d.Digest }) >= 0 {
			return false
		}
		for j, a := range d.Signers {
			if !isAddress(a) || slices.Contains(d.Signers[:j], a) {
				return false
			}
		}
	}
	return true
}

// verify checks a full report as the Base verifier would: the exact ABI shape
// abi.encode(bytes32[3] reportContext, bytes reportBlob, bytes32[] rs,
// bytes32[] ss, bytes32 rawVs) for a pinned digest, f+1 signatures that each
// recover to a distinct pinned signer over keccak256(keccak256(blob) ||
// reportContext), and a v3 blob of the pinned feed with a positive price. It
// returns the observation the registry would store, or the check that failed.
func (c Chainlink) verify(full []byte) (engine.StreamsObservation, string) {
	var o engine.StreamsObservation
	if len(full) < 7*32 {
		return o, "report: malformed"
	}
	i := slices.IndexFunc(c.Configs, func(d DONConfig) bool { return d.Digest == "0x"+hex.EncodeToString(full[:32]) })
	if i < 0 {
		return o, "report: unknown config digest"
	}
	d := c.Configs[i]
	n := int(d.F) + 1
	ss := 0x220 + 32 + 32*n
	ok := len(full) == ss+32+32*n
	for _, w := range [][2]int{{3, 0xe0}, {4, 0x220}, {5, ss}} {
		ok = ok && is(full[32*w[0]:], uint64(w[1]))
	}
	ok = ok && is(full[0xe0:], blobBytes) && is(full[0x220:], uint64(n)) && is(full[ss:], uint64(n))
	if !ok {
		return o, "report: malformed"
	}
	blob := full[0xe0+32 : 0xe0+32+blobBytes]
	k := sha3.NewLegacyKeccak256()
	k.Write(blob)
	reportHash := k.Sum(nil)
	k.Reset()
	k.Write(reportHash)
	k.Write(full[:96])
	digest := k.Sum(nil)
	seen := make([]string, 0, n)
	sig := make([]byte, 65)
	for j := 0; j < n; j++ {
		v := full[6*32+j]
		if v > 1 {
			return o, "report: bad signature"
		}
		sig[0] = 27 + v
		copy(sig[1:33], full[0x220+32+32*j:])
		copy(sig[33:], full[ss+32+32*j:])
		pub, _, err := ecdsa.RecoverCompact(sig, digest)
		if err != nil {
			return o, "report: bad signature"
		}
		k.Reset()
		k.Write(pub.SerializeUncompressed()[1:])
		signer := "0x" + hex.EncodeToString(k.Sum(nil)[12:])
		if !slices.Contains(d.Signers, signer) || slices.Contains(seen, signer) {
			return o, "report: not signed by the pinned signers"
		}
		seen = append(seen, signer)
	}
	// v3 blob: feedId, validFromTimestamp, observationsTimestamp, nativeFee,
	// linkFee, expiresAt, price (int192), bid, ask.
	feed := "0x" + hex.EncodeToString(blob[:32])
	validFrom, at, expires := blob[32:64], blob[64:96], blob[160:192]
	price := blob[192:224]
	ok = small(validFrom, MaxClock) && small(at, MaxClock) && small(expires, MaxClock)
	o = engine.StreamsObservation{FeedID: feed, Price: new(big.Int).SetBytes(price).String(), ValidFromTimestamp: uint32(word32(validFrom)),
		ObservationsTimestamp: uint32(word32(at)), ExpiresAt: uint32(word32(expires)), ReportHash: "0x" + hex.EncodeToString(reportHash), Decimals: 18}
	// A positive int192 has its top 65 bits clear.
	positive := price[8]&0x80 == 0 && new(big.Int).SetBytes(price).Sign() > 0
	for _, b := range price[:8] {
		positive = positive && b == 0
	}
	switch {
	case feed != c.FeedID:
		return o, "report: not the pinned feed"
	case !ok || !positive || o.ValidFromTimestamp > o.ObservationsTimestamp || o.ObservationsTimestamp > o.ExpiresAt:
		return o, "report: invalid observation"
	}
	return o, ""
}

// small reports whether the 32-byte word at the start of p is at most max.
func small(p []byte, max uint64) bool {
	for _, b := range p[:24] {
		if b != 0 {
			return false
		}
	}
	return binary.BigEndian.Uint64(p[24:32]) <= max
}

// is reports whether the 32-byte word at the start of p is exactly v.
func is(p []byte, v uint64) bool { return small(p, v) && word32(p) == v }

func word32(p []byte) uint64 { return binary.BigEndian.Uint64(p[24:32]) }
