module github.com/penguinpecker/zedge/adapters/vela/guest

go 1.25.0

require github.com/penguinpecker/zedge/engine v0.0.0

require (
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
)

replace github.com/penguinpecker/zedge/engine => ../../../engine
