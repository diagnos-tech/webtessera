# ADR-0060: Fetcher-shaped function types take `AbortSignal` as a trailing parameter

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** client agent
- **Upstream reference:** `client/client.go`, `client/fetcher.go`, `client/stream.go`, `internal/fetcher/fallback.go`

## Context

This work package is the first to actually write async I/O functions in this port. Every
prior landed package (Merkle, Note, Layout) is pure and synchronous, so
`docs/decisions/0004-errors-context-and-concurrency.md`'s rule — "`context.Context`
becomes `AbortSignal`, passed as an optional last parameter" — has never yet been applied
to a concrete function signature. `client/client.go` and `client/fetcher.go` define
several `func(ctx context.Context, ...) (..., error)` types and functions that this
package is the first to render as TypeScript, and one of them (`fetcher.go`'s callback
parameter, `func(context.Context, uint8) ([]byte, error)`) is itself a function *type*,
not just a top-level declaration, so the parameter-order convention has to apply
consistently to nested function values too, not only to exported functions.

The Go signatures in scope:

```go
type CheckpointFetcherFunc func(ctx context.Context) ([]byte, error)
type TileFetcherFunc func(ctx context.Context, level, index uint64, p uint8) ([]byte, error)
type EntryBundleFetcherFunc func(ctx context.Context, bundleIndex uint64, p uint8) ([]byte, error)
type ConsensusCheckpointFunc func(ctx context.Context, logSigV note.Verifier, origin string) (*log.Checkpoint, []byte, *note.Note, error)
type TreeSizeFunc func(ctx context.Context) (uint64, error)
func PartialOrFullResource(ctx context.Context, p uint8, f func(context.Context, uint8) ([]byte, error)) ([]byte, error)
```

## Decision

`ctx context.Context`, wherever it appears as the first parameter of one of these
fetcher-shaped Go function types, moves to become the **last, optional** TypeScript
parameter (`signal?: AbortSignal`), and every other parameter keeps its relative order:

| Go | TypeScript |
| --- | --- |
| `func(ctx) ([]byte, error)` | `(signal?: AbortSignal) => Promise<Uint8Array>` |
| `func(ctx, level, index uint64, p uint8) ([]byte, error)` | `(level: bigint, index: bigint, p: number, signal?: AbortSignal) => Promise<Uint8Array>` |
| `func(ctx, bundleIndex uint64, p uint8) ([]byte, error)` | `(bundleIndex: bigint, p: number, signal?: AbortSignal) => Promise<Uint8Array>` |
| `func(ctx, logSigV, origin) (*Checkpoint, []byte, *Note, error)` | `(logSigV: Verifier, origin: string, signal?: AbortSignal) => Promise<FetchedCheckpoint>` |
| `func(ctx) (uint64, error)` | `(signal?: AbortSignal) => Promise<bigint>` |
| `func(ctx, p uint8, f func(ctx, uint8)([]byte,error)) ([]byte, error)` | `(p: number, f: (p: number, signal?: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal) => Promise<Uint8Array>` |

The 4-value Go returns (`ConsensusCheckpointFunc`, and `FetchCheckpoint` which shares its
shape) become a single named `FetchedCheckpoint` object per
`docs/decisions/0031-multi-value-returns.md`, with the trailing `error` dropped in favour
of a throw per `docs/decisions/0004-errors-context-and-concurrency.md`.

## Consequences

- Every fetcher implementation (`HTTPFetcher`, and any adapter or test double) has the
  same parameter shape: business parameters first, in Go's order, `signal` always last
  and always optional. A reviewer who has read one such function has read them all.
- `client/otel.go`'s `context.Context`-derived span attributes are irrelevant here since
  that file is not ported at all; see `docs/decisions/0061-otel-tracing-dropped.md`.
- This sets the convention every later work package that defines a fetcher-shaped
  callback (storage drivers, adapters) should follow for consistency, though this ADR
  only binds the five files in this work package.

## Alternatives considered

- **`ctx` stays first, as an `AbortSignal` in first position.** Rejected: ADR-0004 already
  settled "optional last parameter" as the general rule; putting it first here for no
  reason but proximity to the Go source would silently create two conventions in the same
  codebase.
- **A `{ signal }`-shaped options object instead of a positional parameter.** More
  idiomatic in some TypeScript style guides, and leaves room to add more options later
  without another breaking signature change. Rejected: it breaks the direct
  parameter-for-parameter correspondence with the Go source that ADR-0002 identifies as
  this port's main reviewability asset, for a flexibility this package does not need.

## Review

- **Reviewer:** Client Reviewer (Opus 4.8)
- **Verdict:** approved
- **Notes:** Checked every fetcher-shaped signature in the table against its Go original in
  `client/client.go`, `client/fetcher.go`, `client/stream.go`, and `internal/fetcher/fallback.go`.
  In each, `signal?: AbortSignal` is the last, optional parameter and every business parameter
  keeps Go's relative order; the nested callback in `partialOrFullResource` follows the same rule
  (`(p: number, signal?: AbortSignal)`). Confirmed the signal actually threads through to the fetch
  call in every case, not just the type: `getNode` → `getTile(..., signal)`, `getEntryBundle` →
  `f(i, p, signal)`, `HTTPFetcher.#fetch` sets `init.signal`, and `partialOrFullResource` forwards
  `signal` to both the primary and fallback `f` calls. The convention is applied consistently and
  matches ADR-0004's "optional last parameter" rule.
