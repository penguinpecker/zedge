// Package engine implements ZEDGE's deterministic, fully collateralized binary
// share ledger. It does not authenticate callers, provide a clock, verify an
// oracle, encrypt data, or execute token transfers. Those are adapter duties.
package engine

const (
	Version                 = 2
	AtomScale        uint64 = 1_000_000
	Lot              uint64 = 1_000
	MaxAtoms         uint64 = 1_000_000_000_000_000
	MaxAccounts             = 256
	MaxRounds               = 128
	MaxOrders               = 1024
	MaxWithdrawals          = 256
	MaxMatches              = 64
	MaxSnapshotBytes        = 8 * 1024 * 1024
)

type Outcome string

const (
	Up   Outcome = "up"
	Down Outcome = "down"
	Void Outcome = "void"
)

type Side string

const (
	Buy  Side = "buy"
	Sell Side = "sell"
)

type TimeInForce string

const (
	GTC TimeInForce = "gtc"
	IOC TimeInForce = "ioc"
)

type Operation string

const (
	Register          Operation = "register"
	Deposit           Operation = "deposit"
	CreateRound       Operation = "create_round"
	OpenRound         Operation = "open_round"
	Checkpoint        Operation = "checkpoint"
	Mint              Operation = "mint"
	Merge             Operation = "merge"
	PlaceOrder        Operation = "place_order"
	CancelOrder       Operation = "cancel_order"
	CancelAll         Operation = "cancel_all"
	ResolveRound      Operation = "resolve_round"
	VoidRound         Operation = "void_round"
	ArchiveRound      Operation = "archive_round"
	Redeem            Operation = "redeem"
	RequestWithdrawal Operation = "request_withdrawal"
	CancelWithdrawal  Operation = "cancel_withdrawal"
	ExportWithdrawal  Operation = "export_withdrawal"
	ConfirmClaim      Operation = "confirm_claim"
)

type Domain struct {
	ChainID       uint64 `json:"chainId"`
	Endpoint      string `json:"endpoint"`
	ApplicationID string `json:"applicationId"`
	RulesVersion  uint32 `json:"rulesVersion"`
}
type Config struct {
	Domain     Domain         `json:"domain"`
	Authority  string         `json:"authority"`
	Collateral string         `json:"collateral"`
	FeeBps     uint64         `json:"feeBps"`
	Oracle     RegistryConfig `json:"oracle"`
}

// RegistryConfig pins the exact public Streams registry policy. The adapter
// authenticates its canonical deployment/code; these values are not proof.
type RegistryConfig struct {
	ChainID           uint64 `json:"chainId"`
	Registry          string `json:"registry"`
	Oracle            string `json:"oracle"`
	RulesHash         string `json:"rulesHash"`
	BTCFeedID         string `json:"btcFeedId"`
	ETHFeedID         string `json:"ethFeedId"`
	Decimals          uint8  `json:"decimals"`
	ObservationWindow uint64 `json:"observationWindow"`
	OpeningGrace      uint64 `json:"openingGrace"`
	SettlementGrace   uint64 `json:"settlementGrace"`
	CutoffBuffer      uint64 `json:"cutoffBuffer"`
}

// StreamsObservation mirrors the authenticated schema-v3 boundary result.
// Price is an exact positive int192 decimal string at 18 decimals, never a
// JSON number, float, rounded uint64, or collateral-denominated amount.
type StreamsObservation struct {
	FeedID                string `json:"feedId"`
	Price                 string `json:"price"`
	ValidFromTimestamp    uint32 `json:"validFromTimestamp"`
	ObservationsTimestamp uint32 `json:"observationsTimestamp"`
	ExpiresAt             uint32 `json:"expiresAt"`
	ReportHash            string `json:"reportHash"`
	Decimals              uint8  `json:"decimals"`
}

// AuthenticatedContext is a trusted adapter input, NEVER part of user JSON.
// Constructing this struct is not authentication. The adapter must verify the
// principal, canonical chain time, domain, and external evidence before Apply.
// Timestamp must be fresh execution/commit context, not a historical checkpoint.
type AuthenticatedContext struct {
	Domain    Domain
	Principal string
	Timestamp uint64
	System    bool
}

type RoundSpec struct {
	Asset              string `json:"asset"`
	Feed               string `json:"feed"`
	RegistryRoundID    string `json:"registryRoundId"`
	Start              uint64 `json:"start"`
	End                uint64 `json:"end"`
	Cutoff             uint64 `json:"cutoff"`
	ObservationWindow  uint64 `json:"observationWindow"`
	OpeningDeadline    uint64 `json:"openingDeadline"`
	ResolutionDeadline uint64 `json:"resolutionDeadline"`
}

// Command is the canonical application command, not a wallet signing format.
// The adapter binds its canonical digest to authorization and verified context.
// Only fields relevant to Op may be nonzero; unknown JSON fields are rejected.
type Command struct {
	Domain       Domain              `json:"domain"`
	ID           string              `json:"id"`
	Nonce        uint64              `json:"nonce"`
	Op           Operation           `json:"op"`
	Account      string              `json:"account,omitempty"`
	RoundID      string              `json:"roundId,omitempty"`
	Round        *RoundSpec          `json:"round,omitempty"`
	Amount       uint64              `json:"amount,omitempty"`
	Outcome      Outcome             `json:"outcome,omitempty"`
	Side         Side                `json:"side,omitempty"`
	Price        uint64              `json:"price,omitempty"`
	Quantity     uint64              `json:"quantity,omitempty"`
	TIF          TimeInForce         `json:"tif,omitempty"`
	Expiry       uint64              `json:"expiry,omitempty"`
	MaxFee       uint64              `json:"maxFee,omitempty"`
	OrderID      string              `json:"orderId,omitempty"`
	WithdrawalID string              `json:"withdrawalId,omitempty"`
	Destination  string              `json:"destination,omitempty"`
	Evidence     string              `json:"evidence,omitempty"`
	Observation  *StreamsObservation `json:"observation,omitempty"`
}

type Holding struct {
	RoundID      string `json:"roundId"`
	Up           uint64 `json:"up"`
	Down         uint64 `json:"down"`
	ReservedUp   uint64 `json:"reservedUp"`
	ReservedDown uint64 `json:"reservedDown"`
}
type Account struct {
	ID           string    `json:"id"`
	Cash         uint64    `json:"cash"`
	ReservedCash uint64    `json:"reservedCash"`
	Holdings     []Holding `json:"holdings"`
	Nonce        uint64    `json:"nonce"`
	LastDigest   string    `json:"lastDigest"`
	LastReceipt  Receipt   `json:"lastReceipt"`
}
type Round struct {
	ID            string              `json:"id"`
	Spec          RoundSpec           `json:"spec"`
	Status        string              `json:"status"`
	Opening       *StreamsObservation `json:"opening,omitempty"`
	Closing       *StreamsObservation `json:"closing,omitempty"`
	OpenEvidence  string              `json:"openEvidence"`
	CloseEvidence string              `json:"closeEvidence"`
	Outcome       Outcome             `json:"outcome"`
	Locked        uint64              `json:"locked"`
	UpSupply      uint64              `json:"upSupply"`
	DownSupply    uint64              `json:"downSupply"`
}
type Order struct {
	ID             string  `json:"id"`
	Account        string  `json:"account"`
	RoundID        string  `json:"roundId"`
	Outcome        Outcome `json:"outcome"`
	Side           Side    `json:"side"`
	Price          uint64  `json:"price"`
	Original       uint64  `json:"original"`
	Remaining      uint64  `json:"remaining"`
	Filled         uint64  `json:"filled"`
	FilledNotional uint64  `json:"filledNotional"`
	FeePaid        uint64  `json:"feePaid"`
	MaxFee         uint64  `json:"maxFee"`
	ReservedCash   uint64  `json:"reservedCash"`
	Sequence       uint64  `json:"sequence"`
	Expiry         uint64  `json:"expiry"`
}
type Withdrawal struct {
	ID          string `json:"id"`
	Account     string `json:"account"`
	Destination string `json:"destination"`
	Amount      uint64 `json:"amount"`
	Status      string `json:"status"`
}
type Fill struct {
	MakerOrder string  `json:"makerOrder"`
	TakerOrder string  `json:"takerOrder"`
	Buyer      string  `json:"buyer"`
	Seller     string  `json:"seller"`
	RoundID    string  `json:"roundId"`
	Outcome    Outcome `json:"outcome"`
	Price      uint64  `json:"price"`
	Quantity   uint64  `json:"quantity"`
	BuyerFee   uint64  `json:"buyerFee"`
	SellerFee  uint64  `json:"sellerFee"`
}

// Receipt contains confidential participants and execution details. It is NOT
// safe to publish or forward wholesale to either trader. Adapter must project
// account-specific receipts and omit counterparty IDs.
type Receipt struct {
	Sequence         uint64        `json:"sequence"`
	CommandID        string        `json:"commandId"`
	Account          string        `json:"account,omitempty"`
	Status           string        `json:"status"`
	OrderID          string        `json:"orderId,omitempty"`
	RoundID          string        `json:"roundId,omitempty"`
	WithdrawalID     string        `json:"withdrawalId,omitempty"`
	Amount           uint64        `json:"amount,omitempty"`
	Fills            []Fill        `json:"fills,omitempty"`
	ReleasedOrders   []string      `json:"releasedOrders,omitempty"`
	PublicWithdrawal *Withdrawal   `json:"publicWithdrawal,omitempty"`
	Archive          *RoundArchive `json:"archive,omitempty"`
}

// RoundArchive is a terminal, fully redeemed round record. An adapter must
// durably retain it in the same commit as the new state and verify its hash.
type RoundArchive struct {
	Count        uint64 `json:"count"`
	PreviousRoot string `json:"previousRoot"`
	Round        Round  `json:"round"`
	Hash         string `json:"hash"`
}
type State struct {
	Version          uint32       `json:"version"`
	Config           Config       `json:"config"`
	Sequence         uint64       `json:"sequence"`
	Time             uint64       `json:"time"`
	JournalHash      string       `json:"journalHash"`
	AuthorityNonce   uint64       `json:"authorityNonce"`
	AuthorityDigest  string       `json:"authorityDigest"`
	AuthorityReceipt Receipt      `json:"authorityReceipt"`
	Accounts         []Account    `json:"accounts"`
	Rounds           []Round      `json:"rounds"`
	Orders           []Order      `json:"orders"`
	Withdrawals      []Withdrawal `json:"withdrawals"`
	Deposited        uint64       `json:"deposited"`
	Custody          uint64       `json:"custody"`
	Claimable        uint64       `json:"claimable"`
	PaidOut          uint64       `json:"paidOut"`
	Fees             uint64       `json:"fees"`
	ExternalEvidence []string     `json:"externalEvidence"`
	ArchivedRounds   uint64       `json:"archivedRounds"`
	ArchiveRoot      string       `json:"archiveRoot"`
}
