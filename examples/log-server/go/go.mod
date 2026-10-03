module github.com/diagnos-tech/webtessera/examples/log-server/go

go 1.24.0

require (
	github.com/transparency-dev/merkle v0.0.2
	github.com/transparency-dev/tessera v0.0.0
	golang.org/x/mod v0.31.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/transparency-dev/formats v0.0.0-20251017110053-404c0d5b696c // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel v1.39.0 // indirect
	go.opentelemetry.io/otel/metric v1.39.0 // indirect
	go.opentelemetry.io/otel/trace v1.39.0 // indirect
	k8s.io/klog/v2 v2.130.1 // indirect
)

// Verify with the exact upstream Tessera this port is pinned to (scripts/upstream.json), as
// the repository's interop tools do. `node scripts/fetch-upstream.mjs`, run at the repository
// root, creates the checkout.
replace github.com/transparency-dev/tessera => ../../../.upstream/tessera
