package guest

import (
	"bytes"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

// README section 9, Stake limits: testLimits is 50 tokens per account per
// round, 200 for every account but the house at one closing time, and 2,000
// for the house over every open round.

// around applies a command as the authority at the clock, outside any request.
func (h *harness) around(c engine.Command) {
	h.t.Helper()
	s := h.s()
	next, _, err := s.system(s.Engine, c)
	if err != nil {
		h.t.Fatalf("%s: %v", c.Op, err)
	}
	s.Engine = next
	h.st = marshal(s)
}

// place stages a book command, applies its tick a second later and returns
// the outcome the account then collects.
func (h *harness) place(who string, c engine.Command) *outcomeReceipt {
	h.t.Helper()
	if b := h.cmd(who, c); b.Status != "staged" {
		h.t.Fatalf("%s: %+v", who, b)
	}
	h.ok(h.tick(h.s().Clock + 1))
	return h.sync(who).Outcome
}

// rest is a resting buy at one cent in a round of the BTC round's time: it
// costs a hundredth of its size and nobody sells into it.
func rest(round string, outcome engine.Outcome, quantity uint64) engine.Command {
	return engine.Command{Op: engine.PlaceOrder, RoundID: round, Outcome: outcome, Side: engine.Buy, Price: 1, Quantity: quantity, TIF: engine.GTC, Expiry: cut1, MaxFee: quantity}
}

// stakeOf is what the account has riding on the round, by the adapter's rule.
func stakeOf(t *testing.T, s *State, who, round string) int64 {
	t.Helper()
	all, _ := stakes(s.Engine)
	for i, a := range s.Engine.Accounts {
		for r, m := range s.Engine.Rounds {
			if a.ID == who && m.ID == round {
				return all[i][r]
			}
		}
	}
	return 0
}

func applied(t *testing.T, name string, o *outcomeReceipt) {
	t.Helper()
	if o == nil || o.Status != "applied" {
		t.Fatalf("%s: %+v", name, o)
	}
}

func refused(t *testing.T, name, reason string, o *outcomeReceipt) {
	t.Helper()
	if o == nil || o.Status != "rejected" || o.Reason != reason {
		t.Fatalf("%s: %+v, want %q", name, o, reason)
	}
}

const (
	perRound   = "stake limit: account per round"
	atBoundary = "stake limit: all accounts at this closing time"
	houseLimit = "stake limit: house total"
	tokens     = uint64(1_000_000)
	atLimit    = 50 * tokens // testLimits.Account
)

// (a) One account in one round, whatever way it builds the position.
func TestStakeLimitPerAccount(t *testing.T) {
	h := newHarness(t, alice, bob, carol, house)
	// Many small orders add up: three resting buys reach the limit exactly,
	// and a fourth of one lot is refused.
	for _, q := range []uint64{20 * tokens, 20 * tokens, 10 * tokens} {
		applied(t, "a small buy", h.place(alice, rest(id1, engine.Up, q)))
	}
	refused(t, "one lot past the limit", perRound, h.place(alice, rest(id1, engine.Up, 1_000)))
	// Resting buys on both sides do not offset: only one side may fill.
	applied(t, "the other side, as large", h.place(alice, rest(id1, engine.Down, atLimit)))
	if v := h.sync(alice).View; len(v.Orders) != 4 || stakeOf(t, h.s(), alice, id1) != int64(atLimit) {
		t.Fatalf("alice: %d orders, stake %d", len(v.Orders), stakeOf(t, h.s(), alice, id1))
	}

	// Mint, then sell one side: never bought, still at stake. Bob holds 65
	// complete sets; offering 60 Up would leave him 60 short of Down.
	if b := h.cmd(bob, engine.Command{Op: engine.Mint, RoundID: id1, Quantity: 60 * tokens}); b.Status != "applied" {
		t.Fatalf("mint: %+v", b)
	}
	sell := order(engine.Sell, 99, 60*tokens, engine.GTC)
	refused(t, "mint then sell", perRound, h.place(bob, sell))
	sell.Quantity = atLimit
	applied(t, "mint then sell up to the limit", h.place(bob, sell))

	// A taker whose fills would pass the limit is refused whole: no fill,
	// and the maker's order is untouched.
	if b := h.cmd(house, engine.Command{Op: engine.Mint, RoundID: id1, Quantity: 90 * tokens}); b.Status != "applied" {
		t.Fatalf("house mint: %+v", b)
	}
	quote := order(engine.Sell, 50, 90*tokens, engine.GTC)
	quote.Outcome = engine.Down
	applied(t, "the house's quote", h.place(house, quote))
	take := order(engine.Buy, 50, 60*tokens, engine.IOC)
	take.Outcome = engine.Down
	refused(t, "a taker past the limit", perRound, h.place(carol, take))
	if v := h.sync(house).View; v.Orders[0].Remaining != 90*tokens {
		t.Fatalf("the refused taker filled: %+v", v.Orders)
	}
	take.Quantity = atLimit
	applied(t, "a taker up to the limit", h.place(carol, take))
	if b := h.sync(carol); b.View.Holdings[0].Down != 55*tokens || stakeOf(t, h.s(), carol, id1) != int64(atLimit) {
		t.Fatalf("carol after her fill: %+v", b.View.Holdings)
	}
	// At the limit, orders that leave her stake where it is are still taken:
	// a buy of the other side, and a sell of what she holds.
	applied(t, "a buy of the other side at the limit", h.place(carol, rest(id1, engine.Up, atLimit)))
	exit := order(engine.Sell, 60, atLimit, engine.GTC)
	exit.Outcome = engine.Down
	applied(t, "a sell at the limit", h.place(carol, exit))
}

// A maker's resting buy already counts as filled, so a fill never takes it
// past the limit and needs no check; after the fill the account still cannot
// add, and can still sell. A sell is not always a reduction: giving up the
// shares that hedge a resting buy of the other side raises the stake.
func TestStakeLimitCountsRestingOrdersAsFilled(t *testing.T) {
	h := newHarness(t, alice, bob, house)
	applied(t, "bob's resting buy of Down", h.place(bob, rest(id1, engine.Down, atLimit)))
	refused(t, "bob sells the Up that hedged it", perRound, h.place(bob, order(engine.Sell, 99, 5*tokens, engine.GTC)))

	applied(t, "alice's resting buy", h.place(alice, rest(id1, engine.Up, atLimit)))
	before := stakeOf(t, h.s(), alice, id1)
	if b := h.cmd(house, engine.Command{Op: engine.Mint, RoundID: id1, Quantity: atLimit}); b.Status != "applied" {
		t.Fatalf("house mint: %+v", b)
	}
	hit := order(engine.Sell, 1, atLimit, engine.IOC)
	o := h.place(house, hit)
	applied(t, "the house sells into it", o)
	if len(o.Receipt.Fills) != 1 || stakeOf(t, h.s(), alice, id1) != before || before != int64(atLimit) {
		t.Fatalf("fill: %+v, alice's stake %d then %d", o.Receipt, before, stakeOf(t, h.s(), alice, id1))
	}
	refused(t, "alice adds after the fill", perRound, h.place(alice, rest(id1, engine.Up, 1_000)))
	applied(t, "alice sells what she bought", h.place(alice, order(engine.Sell, 99, atLimit, engine.GTC)))
}

// newBoundary is newHarness with a second round that ends when round 1 does:
// an ETH round, created and opened around the adapter (a deployment mirrors
// one market, so only a state made this way can hold two rounds at one
// closing time).
func newBoundary(t *testing.T, accounts ...string) (*harness, string) {
	t.Helper()
	h := &harness{t: t, st: result(t, Deploy(testApp, marshal(testParams()), testSalt)).State, block: 1000}
	h.sync(keeper)
	h.ok(h.tick(t0))
	for _, who := range accounts {
		if r := h.deposit(who, 100*tokens); r.Error != "" {
			t.Fatal(r.Error)
		}
	}
	h.sync(keeper)
	h.ok(h.tick(t0+100, rec{start: s1}, rec{start: s1 + 900}))
	eth, err := engine.NewRoundSpec(deployed(), "ETH", 900, s1)
	if err != nil {
		t.Fatal(err)
	}
	h.around(engine.Command{Op: engine.CreateRound, Round: &eth})
	h.sync(keeper)
	h.ok(h.tick(s1+5, opened1))
	opening := observed(s1, s1+3, "3500000000000000000000")
	opening.FeedID = engine.ETHStreamsFeed
	id := engine.RoundID(deployed(), eth)
	h.around(engine.Command{Op: engine.OpenRound, RoundID: id, Evidence: opening.ReportHash[2:], RegistryTime: s1 + 3, Observation: opening})
	if status(h.s(), id) != "open" || status(h.s(), id1) != "open" {
		t.Fatal("two rounds are not open at one closing time")
	}
	return h, id
}

// take is an IOC buy of the outcome in the round at up to 50 cents.
func take(round string, outcome engine.Outcome, quantity uint64) engine.Command {
	c := rest(round, outcome, quantity)
	c.Price, c.TIF = 50, engine.IOC
	return c
}

// ask is a resting sell of the outcome in the round at 50 cents.
func ask(round string, outcome engine.Outcome, quantity uint64) engine.Command {
	c := take(round, outcome, quantity)
	c.Side, c.TIF = engine.Sell, engine.GTC
	return c
}

// (b) Every account but the house, over every round that ends at one time,
// and (c) the house, exempt from both, over every open round. The
// all-accounts limit counts the shares accounts hold, not their resting buys.
func TestStakeLimitAtOneClosingTime(t *testing.T) {
	a := []string{"0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3", "0x00000000000000000000000000000000000000a4"}
	h, eth := newBoundary(t, append(a, house)...)
	h.ok(h.deposit(house, 900*tokens))
	for _, r := range []string{id1, eth} {
		if b := h.cmd(house, engine.Command{Op: engine.Mint, RoundID: r, Quantity: 200 * tokens}); b.Status != "applied" {
			t.Fatalf("house mint: %+v", b)
		}
	}
	applied(t, "the house's ask, BTC Up", h.place(house, ask(id1, engine.Up, 150*tokens)))
	applied(t, "the house's ask, ETH Up", h.place(house, ask(eth, engine.Up, 100*tokens)))
	applied(t, "the house's ask, ETH Down", h.place(house, ask(eth, engine.Down, 100*tokens)))
	// Four positions of 50 across both rounds reach the 200 at this closing
	// time; the per-round limit lets a1 hold 50 in each round.
	applied(t, "a1 in BTC", h.place(a[0], take(id1, engine.Up, atLimit)))
	applied(t, "a1 in ETH", h.place(a[0], take(eth, engine.Down, atLimit)))
	applied(t, "a2 in BTC", h.place(a[1], take(id1, engine.Up, atLimit)))
	applied(t, "a3 in ETH", h.place(a[2], take(eth, engine.Up, atLimit)))
	// A fifth account gets no position in either round. Its resting bid is
	// taken, since only a fill would give it one, and a fill is refused
	// whichever side sends it: the house selling into the bid is refused too.
	refused(t, "a4 in ETH", atBoundary, h.place(a[3], take(eth, engine.Up, 1_000)))
	refused(t, "a4 in BTC", atBoundary, h.place(a[3], take(id1, engine.Up, 1_000)))
	applied(t, "a4's resting bid", h.place(a[3], rest(eth, engine.Up, atLimit)))
	sell := func(round string, quantity uint64) engine.Command {
		c := rest(round, engine.Up, quantity)
		c.Side, c.TIF = engine.Sell, engine.IOC
		return c
	}
	refused(t, "the house sells into a4's bid", atBoundary, h.place(house, sell(eth, 1_000)))
	applied(t, "a4 cancels", h.place(a[3], engine.Command{Op: engine.CancelAll, RoundID: eth}))
	// The house counts against neither limit, only its own total (200 so far).
	refused(t, "the house past its total", houseLimit, h.place(house, rest(eth, engine.Up, 1_900*tokens)))
	applied(t, "the house, past both user limits", h.place(house, rest(eth, engine.Up, 1_800*tokens)))
	// Room frees as positions close: a3 sells its ETH Up into the house's
	// bid, and a4 takes the space.
	applied(t, "a3 sells to the house", h.place(a[2], sell(eth, atLimit)))
	applied(t, "a4 in ETH after a3's sale", h.place(a[3], take(eth, engine.Up, atLimit)))
	refused(t, "a2 one lot more, in the other round", atBoundary, h.place(a[1], take(eth, engine.Down, 1_000)))
}

// A resting buy locks only its price and fee: a one-cent bid of 50 tokens
// locks about half a token, and comes back whole on cancel. Counted toward the
// all-accounts limit, four of them filled it for every other account for the
// whole round; counted at what they hold, they fill nothing.
func TestStakeLimitRestingBidsLeaveTheBoundary(t *testing.T) {
	g := []string{"0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2", "0x00000000000000000000000000000000000000b3", "0x00000000000000000000000000000000000000b4"}
	h := newHarness(t, append(g, alice, house)...)
	for _, who := range g {
		applied(t, "a one-cent bid at the account limit", h.place(who, rest(id1, engine.Up, atLimit)))
	}
	applied(t, "the house's ask", h.place(house, ask(id1, engine.Up, 5*tokens)))
	applied(t, "alice takes a lot from the house", h.place(alice, take(id1, engine.Up, 1_000)))
	down := ask(id1, engine.Down, 1_000)
	applied(t, "alice offers a lot of Down", h.place(alice, down))
	if b := h.sync(alice); len(b.View.Orders) != 1 {
		t.Fatalf("alice: %+v", b.View)
	}
}

// A refusal for a stake limit is a refusal like any other: the tick that
// refuses has the same effects, byte for byte, as the same tick with nothing
// to activate. And a state past a limit is refused however it was made.
func TestStakeLimitRefusalShape(t *testing.T) {
	h := newHarness(t, alice)
	applied(t, "alice at the limit", h.place(alice, rest(id1, engine.Up, atLimit)))
	if b := h.cmd(alice, rest(id1, engine.Up, 1_000)); b.Status != "staged" {
		t.Fatal(b.Status)
	}
	s := h.s()
	tick := tick2(s.TickSeq, h.block+1, s.Clock+1)
	refusing := result(t, TrustedRequest(testApp, tick, h.st))
	s.Staged = []Staged{}
	idle := result(t, TrustedRequest(testApp, tick, marshal(s)))
	if refusing.Error != "" || idle.Error != "" || refusing.Events != nil || refusing.Withdrawals != nil || !bytes.Equal(marshal(refusing.AppEvents), marshal(idle.AppEvents)) ||
		!bytes.Equal(marshal(state(t, refusing.State).Engine), marshal(state(t, idle.State).Engine)) {
		t.Fatalf("a refusing tick differs from an idle one: %+v", refusing)
	}
	if o := state(t, refusing.State).Outcomes; len(o) != 1 || o[0].Reason != perRound {
		t.Fatalf("outcome: %+v", o)
	}
	// The same order applied around the adapter makes a state the guest
	// refuses, as it does any state past a cap.
	s = h.s()
	s.Staged = []Staged{}
	c, _ := command(alice, account(s.Engine, alice).Nonce+1, rest(id1, engine.Up, 1_000))
	if s.Engine, _, _ = engine.Apply(s.Engine, c, s.user(alice)); s.Engine == nil {
		t.Fatal("the engine refused the order")
	}
	if _, err := DecodeState(marshal(s)); err == nil || err.Error() != perRound {
		t.Fatalf("a state past the per-round limit: %v", err)
	}
}

// The deployment the owner chose for Horizen mainnet: the registry deployed on
// 2026-10-06 behind its proxy, its price cache, USDC.e, BTC 900 only.
func mainnetParams() DeployParams {
	c := engine.Config{Domain: engine.Domain{ChainID: HorizenMainnet, Endpoint: endpoint, RulesVersion: engine.Version}, Authority: trigger,
		Collateral: "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c", FeeBps: 0,
		Oracle: engine.RegistryConfig{ChainID: HorizenMainnet, Registry: "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744", Oracle: "0xc800c3f18d35d492ae6b07655d7f31bfe98a4b6b",
			BTCFeedID: engine.BTCStreamsFeed, ETHFeedID: engine.ETHStreamsFeed, Decimals: 18, ObservationWindow: 60, OpeningGrace: 150, VoidGrace: 300, CutoffBuffer: 30}}
	c.Oracle.RulesHash, _ = engine.RegistryRulesHash(c)
	return DeployParams{Engine: c, ApplicationFingerprint: fingerprint, Origin: "https://zedge-markets.vercel.app", Epoch: epoch, Markets: []Market{{"BTC", 900}}, StakeLimits: testLimits,
		Chainlink: testChainlink(), Custody: testCustody}
}

func TestHorizenMainnetDeployment(t *testing.T) {
	p := mainnetParams()
	// Read from the registry proxy on Horizen (rulesHash, roundIdFor) on
	// 2026-10-06: the engine derives the same rules and round identities.
	if p.Engine.Oracle.RulesHash != "0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6" {
		t.Fatalf("rules hash %s is not the deployed registry's", p.Engine.Oracle.RulesHash)
	}
	for _, c := range []struct {
		duration uint64
		id       string
	}{{900, "0x87b9f68f1e7c1497c3007eae929a6474d06552d9cee57af34570455705e90ac5"}, {300, "0xb4bcd96751ad786a84e0a2e4483daddd84a64109509e08578dd779ddbe5814d9"}} {
		if id, err := engine.RegistryRoundID(p.Engine, "BTC", c.duration, 1791100800); err != nil || id != c.id {
			t.Fatalf("BTC %d at 1791100800: %s %v", c.duration, id, err)
		}
	}
	r := result(t, Deploy(testApp, marshal(p), testSalt))
	if r.Error != "" {
		t.Fatalf("mainnet deploy: %s", r.Error)
	}
	if s := state(t, r.State); s.StakeLimits != testLimits || s.Markets[0] != (Market{"BTC", 900}) || s.Engine.Config.Oracle.CutoffBuffer != MinPublicCutoffBuffer {
		t.Fatalf("mainnet state: %+v %+v", s.StakeLimits, s.Markets)
	}
	edit := func(f func(*DeployParams)) []byte { q := mainnetParams(); f(&q); return marshal(q) }
	for name, b := range map[string][]byte{
		"ETH 900 on mainnet": edit(func(q *DeployParams) { q.Markets = []Market{{"ETH", 900}} }),
		"BTC 300 on mainnet": edit(func(q *DeployParams) { q.Markets = []Market{{"BTC", 300}} }),
		"a buffer below the floor": edit(func(q *DeployParams) {
			q.Engine.Oracle.CutoffBuffer = MinPublicCutoffBuffer - 1
			q.Engine.Oracle.RulesHash, _ = engine.RegistryRulesHash(q.Engine)
		}),
		"a testnet below the floor": edit(func(q *DeployParams) {
			q.Engine.Domain.ChainID, q.Engine.Oracle.ChainID, q.Engine.Oracle.CutoffBuffer = 2651420, 2651420, MinPublicCutoffBuffer-1
			q.Engine.Oracle.RulesHash, _ = engine.RegistryRulesHash(q.Engine)
		}),
		// No engine operation pays fees out: on mainnet they would stay in the
		// endpoint's custody for good.
		"a trading fee on mainnet": edit(func(q *DeployParams) { q.Engine.FeeBps = 1 }),
	} {
		if got := result(t, Deploy(testApp, b, testSalt)).Error; got != ErrConfig {
			t.Errorf("%s: error %q", name, got)
		}
	}
	// The floor binds every public chain, at any market; local Anvil has none.
	testnet := edit(func(q *DeployParams) {
		q.Engine.Domain.ChainID, q.Engine.Oracle.ChainID, q.Markets = 2651420, 2651420, []Market{{"ETH", 300}}
		q.Engine.Oracle.RulesHash, _ = engine.RegistryRulesHash(q.Engine)
	})
	if got := result(t, Deploy(testApp, testnet, testSalt)).Error; got != "" {
		t.Errorf("a testnet at the floor: %q", got)
	}
	if testConfig().Oracle.CutoffBuffer >= MinPublicCutoffBuffer {
		t.Error("the local deployment no longer shows that Anvil has no floor")
	}

	// The combined application of 2026-10-09 (README section 13): BTC 900 and
	// the House event with the owner's times, its resolver and the first Base
	// deposit index it reads. The question is a stand-in for the Keccak-256 of
	// the published rules text; the registry ID is cast's (keccak of
	// abi.encode(26514, registry, rulesHash, 2, question, start, cutoff, end,
	// voidableAfter)).
	ev := mainnetParams()
	ev.Event = &EventTerms{Question: "0x8b274231f25af5afa0b3e27addf25da81482d7911d11663d3f9f6bafa0eeb4bd", Start: 1791504000, Cutoff: 1793743200, End: 1793743201, VoidableAfter: 1801439999}
	ev.Resolver, ev.DepositsFrom = resolver, 41
	spec, err := ev.Event.spec(ev.Engine)
	if err != nil || spec.RegistryRoundID != "0x74cc1384ba1a7ff802800f94848df98128a8d2cddb0f4221a39734e439a61943" || spec.End%900 == 0 {
		t.Fatalf("the House event: %+v %v", spec, err)
	}
	r = result(t, Deploy(testApp, marshal(ev), testSalt))
	if s := state(t, r.State); r.Error != "" || s.DepositsSeen != 41 || len(s.Engine.Rounds) != 0 {
		t.Fatalf("mainnet deploy with the event: %q", r.Error)
	}
	sync := padded(requestEnvelope{1, state(t, r.State).domain(), keeper, epoch, keeper + ":sync", "command", requestBody{Type: "sync"}})
	r = result(t, ProcessRequest(testApp, raw(keeper), requestTypeProcess, sync, r.State))
	tick := words(3, HorizenMainnet, 0, 1000, 1791600000, 1, 0, 0)
	copy(tick[76:96], raw(endpoint))
	r = result(t, TrustedRequest(testApp, tick, r.State))
	if s := state(t, r.State); r.Error != "" || len(s.Engine.Rounds) != 3 || status(s, engine.RoundID(s.Engine.Config, spec)) != "open" {
		t.Fatalf("the first mainnet tick: %q %+v", r.Error, s.Engine.Rounds)
	}
}
