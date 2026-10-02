# ADR-0059: `convertCTEntry` ported, closing a second `ct_only.ts` TODO left by ADR-0044

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `ct_only.go:47-56`, `docs/decisions/0044-ct-only-partial-port.md`

## Context

`docs/decisions/0044-ct-only-partial-port.md` deferred four declarations in `ct_only.go` as
`TODO(<owner>):` comments because each needed a file that did not exist yet. Its Consequences
section named the hand-off: "The Wave 3 append-lifecycle agent inherits four jobs: port the three
deferred declarations, export `identityHash` from `src/lifecycle.ts`, …". The mission brief for
this work package explicitly asked for one of those four — `identityHash` — closed out now
(`docs/decisions/0055-identityhash-relocated-closes-adr-0044.md`).

Re-reading the other three while doing that work turned up that one of them is *also* now
unblocked, not by anything this ADR's author was asked to port, but as a side effect of porting
`entry.go` (this work package's own mission):

```go
func convertCTEntry(e *ctonly.Entry) *Entry {
	r := &Entry{}
	r.internal.Identity = e.Identity()
	r.marshalForBundle = func(idx uint64) []byte {
		r.internal.LeafHash = e.MerkleLeafHash(idx)
		r.internal.Data = e.LeafData(idx)
		return r.internal.Data
	}
	return r
}
```

ADR-0044's own text is precise about what this function needs: "the root `Entry` type from
`tessera/entry.go` — specifically its unexported `internal.Identity`, `internal.LeafHash`,
`internal.Data` fields and its `marshalForBundle` hook". It does **not** name `Appender` or
`IndexFuture` as a dependency of `convertCTEntry` itself — those belong to its sibling
`NewCertificateTransparencyAppender`, a different function three lines above it in the Go file:

```go
func NewCertificateTransparencyAppender(a *Appender) func(context.Context, *ctonly.Entry) IndexFuture {
	return func(ctx context.Context, e *ctonly.Entry) IndexFuture {
		return a.Add(ctx, convertCTEntry(e))
	}
}
```

`src/entry.ts` (this work package, `docs/PORTING-MAP.md`'s `entry.go` row) now exists with exactly
the shape ADR-0044 anticipated: `Entry.internal` groups `data`/`identity`/`leafHash`/`index`
fields, reachable from outside the class (the same cross-file reachability problem ADR-0010
solves, applied to a genuine Go same-package dependency rather than a test). `src/ctonly/ct.ts`'s
`Entry` (`.identity()`, `.merkleLeafHash()`, `.leafData()`) was already done before this work
package started (`docs/decisions/0043-ctonly-entry-port.md`). Every dependency `convertCTEntry`
actually has is therefore already in the tree.

## Decision

`convertCTEntry` is ported into `src/ct_only.ts`, in its Go declaration position (immediately
after the `NewCertificateTransparencyAppender` TODO, before the `WithCTLayout` TODOs), field- and
behaviour-identical to the Go original:

```ts
export function convertCTEntry(e: ctonly.Entry): Entry {
	const r = new Entry();
	r.internal.identity = e.identity();
	r.marshalForBundle = (idx: bigint): Uint8Array => {
		r.internal.leafHash = e.merkleLeafHash(idx);
		r.internal.data = e.leafData(idx);
		return r.internal.data;
	};
	return r;
}
```

`e`'s type is `ctonly.Entry` and the return type is the root `Entry`; both are named `Entry` in
their own modules, so `ct_only.ts` imports the `ctonly` one via a namespace import (`import *
as ctonly from "./ctonly/ct"`, referenced as `ctonly.Entry`) and the root one directly — the same
resolution Go doesn't need (its `ctonly.Entry` is already qualified by the package name at every
use) but TypeScript's flat module namespace does.

`ct_only.go` has no `TestConvertCTEntry`, so `ct_only_test.ts` gains a new `describe`, pinning:
identity is set eagerly at construction, `leafHash`/`data` stay at their zero value until
`marshalForBundle` actually runs (mirroring `Entry`'s own two-phase construction, which
`entry_test.ts`'s port additions pin for the base type), `marshalForBundle`'s return value equals
`internal.data`, `marshalBundleData` both assigns the index and returns the bundle data for a
precert entry, and calling `marshalForBundle` twice with different indices recomputes both fields
(exercising the exact "may be called multiple times" case `Entry.marshalBundleData`'s own doc
comment describes).

The file's top-of-file comment and the `NewCertificateTransparencyAppender` TODO are updated to
say only one declaration in this file remains genuinely blocked (`NewCertificateTransparencyAppender`
itself, which needs `Appender`), plus the two `WithCTLayout` methods (which belong to
`AppendOptions`/`MigrationOptions`, not `ct_only.go`, and install functions already present in
this file).

## Consequences

- `docs/PORTING-MAP.md`'s `ct_only.go` row is updated to reflect that three of four originally
  deferred declarations are now done (`identityHash`'s duplicate resolved, `convertCTEntry`
  ported); only `NewCertificateTransparencyAppender` and the two `WithCTLayout` methods remain,
  all still genuinely blocked on `append_lifecycle.go`'s `Appender`/`AppendOptions` and
  `migrate.go`'s `MigrationOptions`. The row stays `in progress`, not `done`.
- The Wave 3 append-lifecycle agent's inherited work shrinks by one item: they no longer need to
  port `convertCTEntry`, only wire `NewCertificateTransparencyAppender` (which now has a real
  `convertCTEntry` to call) and the two `WithCTLayout` methods.
- This is now the second time a `ct_only.go` deferral has been closed by a *different* work
  package landing its own, unrelated mission file (first `lifecycle.ts`, now `entry.ts`) — worth
  flagging for whoever plans future waves: `ct_only.go`'s dependency footprint outside the append
  lifecycle proper is smaller than its four-TODO count first suggested.

## Alternatives considered

- **Leave it deferred since only `identityHash` was explicitly requested.** Rejected: the mission
  brief's own instruction to close the `identityHash` TODO "since it's now unblocked" applies with
  equal force here — `convertCTEntry` is unblocked by the same file landing, for the same
  structural reason, and leaving a now-portable function marked as blocked would be a stale
  TODO the next reader has to re-diagnose from scratch.

## Review

- **Reviewer:** Storage-Internal Reviewer (claude-opus-4-8)
- **Verdict:** approved
- **Notes:** Diffed `convertCTEntry` against `ct_only.go:47-56` field by field: `r.internal.identity
  = e.identity()` set eagerly; `marshalForBundle` closes over `r`, sets `leafHash =
  e.merkleLeafHash(idx)` then `data = e.leafData(idx)` and returns `data` — identical wiring
  and identical evaluation order to Go. Correctly imports `ctonly.Entry` (namespace) vs the
  root `Entry`. Confirmed via ADR-0044's own text that this function's only dependency is the
  root `Entry`'s `internal.*` fields + `marshalForBundle` hook (now present in `entry.ts`),
  not `Appender`/`IndexFuture` — those belong to the still-deferred
  `NewCertificateTransparencyAppender`. The new `ct_only_test.ts` cases (two-phase
  construction, recompute-on-second-call) are non-vacuous. Note the minor chronological
  inconsistency that ADR-0055 still lists `convertCTEntry` as "blocked"; that is superseded
  here and both ADRs' Consequences sections make the ordering clear, so no action needed.
