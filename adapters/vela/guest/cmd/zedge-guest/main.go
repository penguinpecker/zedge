//go:build tinygo.wasm

// Command zedge-guest is the Vela guest: the seven exports of the v0.2.0 ABI
// over package guest. It holds no state between calls. Build with ../../build.sh
// only: TinyGo 0.39.0, -target=wasi -scheduler=none.
package main

import (
	"encoding/binary"
	"unsafe"

	guest "github.com/penguinpecker/zedge/adapters/vela/guest"
)

// The Vela host instantiates the module and calls exports directly. It never
// calls _start or _initialize, so TinyGo's heap, rand and package initialisers
// would never run. boot runs them once, before the first allocation, from
// whichever export is called first. The symbol is a TinyGo runtime internal:
// the conformance test is the tripwire if an upgrade moves it.
//
//go:linkname reactorInit runtime.wasmEntryReactor
func reactorInit()

var booted bool

func boot() {
	if !booted {
		booted = true
		reactorInit()
	}
}

// Buffers the host knows only by offset. Holding them here keeps them alive
// across the collector, and makes this map the only source of input bytes: a
// pointer this module did not hand out is refused, never dereferenced.
var pinned = map[uintptr][]byte{}

// The largest input the guest accepts is a state. A larger buffer would never
// be freed: TinyGo's collector takes constants in the data section for
// pointers, and a dead buffer one of them points into stays, so linear memory
// only grows. Refusing it here makes the host fail the request before
// anything is allocated.
const maxAllocation = guest.MaxStateBytes

// The deployment's salt comes straight from the host's random source.
//
//go:wasmimport wasi_snapshot_preview1 random_get
func randomGet(buf unsafe.Pointer, n uint32) uint32

func pin(b []byte) int32 {
	p := uintptr(unsafe.Pointer(&b[0]))
	pinned[p] = b
	return int32(p)
}

//export allocate
func allocate(n int32) int32 {
	boot()
	if n <= 0 || n > maxAllocation {
		return 0 // the ABI's "cannot allocate"; the host fails the request
	}
	return pin(make([]byte, n))
}

//export deallocate
func deallocate(p, n int32) {
	boot()
	delete(pinned, uintptr(uint32(p)))
}

func in(p, n int32) ([]byte, bool) {
	if p == 0 && n == 0 {
		return nil, true // how the host passes empty input
	}
	b, ok := pinned[uintptr(uint32(p))]
	if !ok || n < 0 || int(n) > len(b) {
		return nil, false
	}
	return b[:n], true
}

// out writes [uint32 little-endian length][JSON] and returns its offset. The
// host frees it with deallocate once it has copied the body.
func out(body []byte) int32 {
	b := make([]byte, 4+len(body))
	binary.LittleEndian.PutUint32(b, uint32(len(body)))
	copy(b[4:], body)
	return pin(b)
}

//export deploy
func deploy(appID int64, paramsPtr, paramsLen int32) int32 {
	boot()
	params, ok := in(paramsPtr, paramsLen)
	if !ok {
		return out(guest.BadBuffer())
	}
	salt := make([]byte, 32)
	if randomGet(unsafe.Pointer(&salt[0]), 32) != 0 {
		salt = nil // Deploy refuses to start without one
	}
	return out(guest.Deploy(uint64(appID), params, salt))
}

//export load_module
func load_module(appID int64) int32 {
	boot()
	return out(guest.LoadModule(uint64(appID)))
}

//export deposit
func deposit(appID int64, senderPtr, senderLen, tokenPtr, tokenLen, valuePtr, valueLen, statePtr, stateLen int32) int32 {
	boot()
	sender, a := in(senderPtr, senderLen)
	token, b := in(tokenPtr, tokenLen)
	value, c := in(valuePtr, valueLen)
	state, d := in(statePtr, stateLen)
	if !(a && b && c && d) {
		return out(guest.BadBuffer())
	}
	return out(guest.Deposit(uint64(appID), sender, token, value, state))
}

//export process_request
func process_request(appID int64, senderPtr, senderLen, requestType, payloadPtr, payloadLen, statePtr, stateLen int32) int32 {
	boot()
	sender, a := in(senderPtr, senderLen)
	payload, b := in(payloadPtr, payloadLen)
	state, c := in(statePtr, stateLen)
	if !(a && b && c) {
		return out(guest.BadBuffer())
	}
	return out(guest.ProcessRequest(uint64(appID), sender, requestType, payload, state))
}

//export trusted_request
func trusted_request(appID int64, payloadPtr, payloadLen, statePtr, stateLen int32) int32 {
	boot()
	payload, a := in(payloadPtr, payloadLen)
	state, b := in(statePtr, stateLen)
	if !(a && b) {
		return out(guest.BadBuffer())
	}
	return out(guest.TrustedRequest(uint64(appID), payload, state))
}

func main() {}
