module github.com/diagnos-tech/webtessera/interop

go 1.24.0

require (
	github.com/transparency-dev/formats v0.0.0-20251017110053-404c0d5b696c
	github.com/transparency-dev/merkle v0.0.2
	github.com/transparency-dev/tessera v0.0.0
	golang.org/x/mod v0.31.0
	k8s.io/klog/v2 v2.130.1
)

require (
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.39.0 // indirect
	go.opentelemetry.io/otel/metric v1.39.0 // indirect
	go.opentelemetry.io/otel/trace v1.39.0 // indirect
	golang.org/x/crypto v0.46.0 // indirect
	golang.org/x/exp v0.0.0-20240325151524-a685a6edb6d8 // indirect
	golang.org/x/sync v0.19.0 // indirect
)

// The interop tools must run the exact upstream checkout the port is pinned to
// (see scripts/upstream.json), not whatever is on the module proxy, and the
// dependency versions above are the ones that checkout's go.mod requires: these
// tools are the Go half of a compatibility proof. `bun run upstream` creates the
// checkout at .upstream/tessera; `bun run interop` does that first and then builds
// these tools.
replace github.com/transparency-dev/tessera => ../.upstream/tessera
