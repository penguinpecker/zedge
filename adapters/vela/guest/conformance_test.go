package guest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/penguinpecker/zedge/engine"
)

const wasmPath = "build/zedge_guest.wasm"

// builtGuest returns the wasm build.sh produced, or skips. A wasm older than
// the source it was built from fails instead: it would test the wrong program.
func builtGuest(t *testing.T) []byte {
	t.Helper()
	wasm, err := os.ReadFile(wasmPath)
	if err != nil {
		t.Skipf("%s is absent: run ./build.sh (TinyGo 0.39.0, Binaryen 133, Go 1.25.14)", wasmPath)
	}
	built, _ := os.Stat(wasmPath)
	for _, pattern := range []string{"*.go", "cmd/zedge-guest/*.go", "../../../engine/*.go"} {
		sources, _ := filepath.Glob(pattern)
		for _, source := range sources {
			if info, err := os.Stat(source); err == nil && !strings.HasSuffix(source, "_test.go") && info.ModTime().After(built.ModTime()) {
				t.Fatalf("%s is older than %s: run ./build.sh", wasmPath, source)
			}
		}
	}
	return wasm
}

// functionImports reads the import section of a wasm module.
func functionImports(b []byte) ([]string, error) {
	bad := errors.New("malformed wasm")
	if len(b) < 8 || string(b[:4]) != "\x00asm" {
		return nil, bad
	}
	p := b[8:]
	uleb := func() (int, bool) {
		n := 0
		for shift := 0; shift < 35 && len(p) > 0; shift += 7 {
			c := p[0]
			p = p[1:]
			n |= int(c&0x7f) << shift
			if c&0x80 == 0 {
				return n, true
			}
		}
		return 0, false
	}
	name := func() (string, bool) {
		n, ok := uleb()
		if !ok || n > len(p) {
			return "", false
		}
		s := string(p[:n])
		p = p[n:]
		return s, true
	}
	var out []string
	for len(p) > 0 {
		id := p[0]
		p = p[1:]
		size, ok := uleb()
		if !ok || size > len(p) {
			return nil, bad
		}
		if id != 2 {
			p = p[size:]
			continue
		}
		count, ok := uleb()
		for i := 0; ok && i < count; i++ {
			module, a := name()
			field, b := name()
			if !a || !b || len(p) == 0 || p[0] != 0 { // 0 = function; nothing else is allowed anyway
				return nil, errors.New("import " + module + "." + field + " is not a function")
			}
			p = p[1:]
			_, ok = uleb() // type index
			out = append(out, module+"."+field)
		}
		if !ok {
			return nil, bad
		}
		return out, nil
	}
	return out, nil
}

// Vela v0.3.0 (dev 25af7d6, pkg/wasm/guest_imports.go) refuses a guest that
// declares any import outside these eight.
func TestGuestImports(t *testing.T) {
	imports, err := functionImports(builtGuest(t))
	if err != nil {
		t.Fatal(err)
	}
	allowed := " args_get args_sizes_get clock_time_get environ_get environ_sizes_get fd_write proc_exit random_get "
	for _, name := range imports {
		field, wasi := strings.CutPrefix(name, "wasi_snapshot_preview1.")
		if !wasi || !strings.Contains(allowed, " "+field+" ") {
			t.Errorf("import %s is outside the v0.3.0 allow-list", name)
		}
	}
	t.Logf("%d imports: %s", len(imports), strings.Join(imports, " "))
}

// TestGuestShim calls the wasm exports directly with hostile arguments, which
// the upstream runtime never sends. Needs node, which the repository already does.
func TestGuestShim(t *testing.T) {
	builtGuest(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	if out, err := exec.Command(node, "testdata/shim.mjs", wasmPath).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// TestGuestSoak repeats requests on states at the size bound, and on a state
// with every adapter cap reached (README section 9), in one guest instance, as
// the executor does, and fails if linear memory keeps growing or any result
// differs from the native adapter's. MaxStateBytes stands on this test:
// TinyGo's collector does not free large dead buffers reliably, and above
// about 0.7 MB a state makes memory double without limit. Its slowest calls
// are the measurement behind MaxActivations and MaxSweeps.
//
//	ZEDGE_SOAK_ROUNDS=400 go test -run TestGuestSoak -v .   # the long run
func TestGuestSoak(t *testing.T) {
	builtGuest(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	if testing.Short() {
		t.Skip("soak skipped in short mode")
	}
	type soakCall struct {
		Name    string `json:"name"`
		Call    string `json:"call"`
		Sender  []byte `json:"sender"`
		Token   []byte `json:"token"`
		Value   []byte `json:"value"`
		Payload []byte `json:"payload"`
		State   []byte `json:"state"`
		Expect  []byte `json:"expect"`
	}
	var calls []soakCall
	process := func(name, who string, payload, st []byte) {
		calls = append(calls, soakCall{name, "process", raw(who), nil, nil, payload, st, ProcessRequest(testApp, raw(who), requestTypeProcess, payload, st)})
	}
	withdrawal := func(amount uint64) []byte { // alice's next command at the end of the time-free steps
		return commandPayload(alice, 3, engine.Command{Op: engine.RequestWithdrawal, Amount: amount, Destination: outside})
	}
	steps := run(t, script())
	end := find(t, steps, "tick with an earlier block number is accepted").after // 32 accounts, 31 of them funded

	// A state as large as the guest takes, less the most one request adds.
	full := inflate(t, end, MaxStateBytes-2048)
	process("withdrawal at the size bound", alice, withdrawal(1), full)
	process("refusal at the size bound", alice, withdrawal(1<<40), full)
	process("sync at the size bound", bob, syncPayload(bob), full)
	five := []byte{5}
	calls = append(calls, soakCall{"deposit at the size bound", "deposit", raw(bob), raw(collateral), five, nil, full, Deposit(testApp, raw(bob), raw(collateral), five, full)})
	asked := result(t, ProcessRequest(testApp, raw(bob), requestTypeProcess, syncPayload(bob), full)).State
	tick := tickPayload(state(t, asked).TickSeq, block1+2, t1+2)
	calls = append(calls, soakCall{"tick at the size bound", "trusted", nil, nil, nil, tick, asked, TrustedRequest(testApp, tick, asked)})
	// The largest buffer the guest hands out, filled with something it refuses.
	process("largest payload", alice, bytes.Repeat([]byte{'['}, MaxStateBytes), full)

	// The exit reserve through the wasm: two evidence IDs left per funded account.
	s := state(t, end)
	spend(s, 2*(MaxSliceAccounts-1))
	closing := marshal(s)
	process("partial withdrawal into the exit reserve", alice, withdrawal(1), closing)
	process("full withdrawal from the exit reserve", alice, withdrawal(150_000_000), closing)

	// The state with every cap reached.
	placing, cancelling, idle, at := capped(t)
	nonce := account(state(t, idle).Engine, alice).Nonce + 1
	trusted := func(name string, st []byte) {
		calls = append(calls, soakCall{name, "trusted", nil, nil, nil, at, st, TrustedRequest(testApp, at, st)})
	}
	deposit := func(name string, st []byte) {
		calls = append(calls, soakCall{name, "deposit", raw(alice), raw(collateral), five, nil, st, Deposit(testApp, raw(alice), raw(collateral), five, st)})
	}
	process("sync at every cap", bob, syncPayload(bob), placing)
	process("refusal at every cap", alice, commandPayload(alice, nonce, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: outside}), placing)
	deposit("deposit refused at every cap", placing)
	trusted("16 activations refused at every cap", placing)
	trusted("16 cancel_all activations at every cap", cancelling)
	process("withdrawal at every cap", alice, commandPayload(alice, nonce, engine.Command{Op: engine.RequestWithdrawal, Amount: 1, Destination: outside}), idle)
	deposit("deposit at every cap", idle)
	trusted("16 sweeps at every cap", idle)
	heavy, heavyTick := heaviest(t)
	calls = append(calls, soakCall{"7 resolutions, 16 cancel_all and 16 sweeps at the caps", "trusted", nil, nil, nil, heavyTick, heavy, TrustedRequest(testApp, heavyTick, heavy)})

	for _, c := range calls {
		r := result(t, c.Expect)
		paid := len(r.Withdrawals) == 1
		failed := c.Name == "largest payload" || c.Name == "deposit refused at every cap"
		if (r.Error != "") != failed || paid != (c.Name == "withdrawal at the size bound" || c.Name == "full withdrawal from the exit reserve" || c.Name == "withdrawal at every cap") || len(r.State) > MaxStateBytes {
			t.Fatalf("%s: error %q, %d withdrawals, %d-byte state", c.Name, r.Error, len(r.Withdrawals), len(r.State))
		}
	}
	fixture, _ := filepath.Abs("build/soak.json")
	if err = os.WriteFile(fixture, marshal(struct {
		Application string     `json:"application"`
		Bound       int        `json:"bound"`
		CeilingMiB  int        `json:"ceilingMiB"`
		Params      []byte     `json:"params"`
		Calls       []soakCall `json:"calls"`
	}{strconv.FormatUint(testApp, 10), MaxStateBytes, soakCeilingMiB, marshal(testParams()), calls}), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, "testdata/soak.mjs", wasmPath, fixture, os.Getenv("ZEDGE_SOAK_ROUNDS")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	t.Log(strings.TrimSpace(string(out)))
}

// busiest loads the states at the caps and applies the heaviest ticks: seven
// resolutions, sixteen cancel_all activations and sixteen sweeps on the full
// book; sixteen cancel_all activations and sixteen sweeps; sixteen sweeps.
func busiest(t testing.TB) []step {
	_, cancelling, idle, tick := capped(t)
	heavy, heavyTick := heaviest(t)
	return []step{
		{Name: "load the full book before seven rounds resolve, every account cancelling all", Call: "load", Payload: heavy},
		{Name: "7 resolutions, 16 cancel_all activations and 16 sweeps at the caps", Call: "trusted", Payload: heavyTick},
		{Name: "load the state at every cap, every account cancelling all", Call: "load", Payload: cancelling},
		{Name: "16 cancel_all activations at every cap", Call: "trusted", Payload: tick},
		{Name: "load the state at every cap, nothing staged", Call: "load", Payload: idle},
		{Name: "16 sweeps at every cap", Call: "trusted", Payload: tick},
	}
}

// soakCeilingMiB is twice the linear memory the bound was measured at.
const soakCeilingMiB = 192

// TestUpstreamConformance runs the built guest through upstream Vela's own
// host runtime at both pinned commits and requires every step of the script to
// return exactly what the native adapter returned: same state bytes, same
// engine state hash, same events and withdrawals, same error text. It ends
// with the two busiest ticks the caps allow, timed in each runtime.
func TestUpstreamConformance(t *testing.T) {
	wasm := builtGuest(t)
	sum := sha256.Sum256(wasm)
	t.Logf("guest wasm %d bytes, sha256 %s", len(wasm), hex.EncodeToString(sum[:]))
	fixture, err := filepath.Abs("build/conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(fixture, marshal(struct {
		Application uint64 `json:"application"`
		Salt        string `json:"salt"`
		Steps       []step `json:"steps"`
	}{testApp, hex.EncodeToString(testSalt), run(t, append(script(), busiest(t)...))}), 0o644); err != nil {
		t.Fatal(err)
	}
	host, err := os.ReadFile("testdata/host/conformance_test.go")
	if err != nil {
		t.Fatal(err)
	}
	guest, _ := filepath.Abs(wasmPath)
	for name, commit := range map[string]string{"v0.2.0": "335724c95ba7b58d64ec97bbb67d18640123278e", "dev": "25af7d627d1df1e515d27eda54ac58239a89c136"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join("build", "upstream", "vela-"+name)
			if pin, _ := os.ReadFile(filepath.Join(dir, ".zedge-pin")); strings.TrimSpace(string(pin)) != commit {
				t.Skipf("upstream Vela %s (%s) is absent from %s: run scripts/fetch-upstream.sh", name, commit, dir)
			}
			pkg := filepath.Join(dir, "app", "zedgeconformance")
			if err := os.MkdirAll(pkg, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(pkg, "conformance_test.go"), host, 0o644); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("go", "test", "-count=1", "-v", "./app/zedgeconformance/")
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "ZEDGE_GUEST_WASM="+guest, "ZEDGE_FIXTURE="+fixture)
			out, err := cmd.CombinedOutput()
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "conformance_test.go") || strings.HasPrefix(line, "ok") || strings.HasPrefix(line, "FAIL") || strings.HasPrefix(line, "---") {
					t.Log(line)
				}
			}
			if err != nil {
				t.Fatalf("guest does not match the native adapter on upstream %s:\n%s", commit, out)
			}
		})
	}
}
