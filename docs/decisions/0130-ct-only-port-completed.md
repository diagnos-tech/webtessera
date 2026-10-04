# ADR-0130: `ct_only.ts` is complete; `withCTLayout` serves both option types and closes ADR-0044

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `ct_only.go:20-72` (`NewCertificateTransparencyAppender`, both `WithCTLayout` methods), `append_lifecycle.go` (`AppendOptions`, `Appender`), `migrate_lifecycle.go` (`MigrationOptions`)

## Context

[ADR-0044](0044-ct-only-partial-port.md) ported `ct_only.go` in two halves, because four of its
declarations depended on files that did not exist yet, and left each as a marked placeholder:

| Declaration | Needed | Closed by |
| --- | --- | --- |
| `identityHash` (duplicated temporarily) | `lifecycle.go` | [ADR-0055](0055-identityhash-relocated-closes-adr-0044.md) |
| `convertCTEntry` | `entry.go` | [ADR-0059](0059-convertctentry-ported-closes-second-adr-0044-item.md) |
| `(*MigrationOptions).WithCTLayout` | `migrate_lifecycle.go` | [ADR-0079](0079-migrationoptions-withctlayout-is-a-function.md) |
| `NewCertificateTransparencyAppender` | `Appender`, `IndexFuture` | open |
| `(*AppendOptions).WithCTLayout` | `AppendOptions` | open |

`src/append_lifecycle.ts` is now complete, so both open items are unblocked. The upstream code is
small:

```go
func NewCertificateTransparencyAppender(a *Appender) func(context.Context, *ctonly.Entry) IndexFuture {
	return func(ctx context.Context, e *ctonly.Entry) IndexFuture {
		return a.Add(ctx, convertCTEntry(e))
	}
}

func (o *AppendOptions) WithCTLayout() *AppendOptions {
	o.entriesPath = ctEntriesPath
	o.bundleIDHasher = ctBundleIDHasher
	return o
}

func (o *MigrationOptions) WithCTLayout() *MigrationOptions {
	o.entriesPath = ctEntriesPath
	o.bundleIDHasher = ctBundleIDHasher
	o.bundleLeafHasher = ctMerkleLeafHasher
	return o
}
```

The one real design problem is the one ADR-0079's reviewer flagged and left open: Go declares two
methods called `WithCTLayout`, distinguished only by receiver. ADR-0079 made the migration one a free
function `withCTLayout(o: MigrationOptions)`. A second free function cannot take the same name in the
same module, so the `AppendOptions` half either takes a different name, breaking the mechanical
identifier mapping of [ADR-0002](0002-file-and-identifier-naming.md), or both halves share one function.

## Decision

**`newCertificateTransparencyAppender(a: Appender)`** is ported as a function returning
`(e: ctonly.Entry, signal?: AbortSignal) => IndexFuture`. The context moves to the trailing optional
`signal`, as everywhere ([ADR-0004](0004-errors-context-and-concurrency.md)). It reads `a.add` on each
call rather than capturing it, because Go's `a.Add` is a field and `newAppender` replaces it with its
decorated chain after the `Appender` is constructed; a function that captured the field early would
bypass the antispam and termination wrappers.

**`withCTLayout` is one function with two overloads**, `(AppendOptions) => AppendOptions` and
`(MigrationOptions) => MigrationOptions`, dispatching on the receiver's class with `instanceof`. This is
the TypeScript counterpart of Go's dispatch on receiver type, keeps `WithCTLayout` mapping to the single
name `withCTLayout`, and leaves every existing call site (ADR-0079's tests included) valid and
unchanged. Per receiver it does exactly what Go does:

- `AppendOptions`: sets `_entriesPath` and `bundleIDHasher`, the two cross-module fields
  [ADR-0010](0010-package-private-members.md) already exposes for this purpose. It does **not** set a
  leaf hasher, because `AppendOptions` has none: an appender takes leaf hashes from the entries it is
  given.
- `MigrationOptions`: unchanged from ADR-0079, additionally setting `bundleLeafHasher`, because a migration
  has to recompute leaf hashes from the source log's bundles.

A third branch throws `withCTLayout: unsupported options type`. Go has no equivalent because the receiver
type is checked at compile time. In TypeScript the branch is unreachable for typed callers, but it is
reachable when two copies of the library are loaded and the receiver was built by the other copy: without
it the call would fail with an unrelated `TypeError` on a missing `internal` property.

As in Go, `withAntispam` hands the antispam follower the identity hasher *current at that moment*, so
`withCTLayout` must run first. `ct_only_test.ts` pins both orders, since getting this backwards silently
gives a CT log a tlog-tiles antispam index.

Two small additions accompany it: `ctEntriesPath` gains a doc comment (upstream has none), and the file
header is rewritten to describe the finished port instead of the deferred one.

**Tests.** Upstream has no test for any of the three declarations, so every case added here is a port
addition, driven through `newAppender` with a fake driver exactly as `append_lifecycle_test.ts` does
(a real driver is not part of this package's tests yet, see
[ADR-0074](0074-migrate-untestable-without-driver.md)). `ct_only_test.ts` goes from 31 to 40 tests:
both receivers of `withCTLayout`, the CT path produced through `entriesPath()`, the antispam ordering, the
guard branch, and for the appender: the converted entry reaching the driver, the signal being forwarded,
`a.add` being read per call, a failing future propagating, and an end-to-end run in which the CT layout set
on the options reaches the driver's `appender()` call.

## Consequences

- Every item ADR-0044 deferred is now done and `ct_only.ts` contains no placeholder. ADR-0044 itself is
  left as the historical record, as ADRs 0055, 0059 and 0079 already did. `docs/PORTING-MAP.md`'s row for
  `ct_only.go` can be marked `done`.
- `ct_only.ts` now imports `AppendOptions` and `MigrationOptions` as values, for `instanceof`, adding
  runtime edges to `append_lifecycle.ts` and `migrate_lifecycle.ts`. Neither imports `ct_only.ts`, so there is
  no cycle.
- `withCTLayout` mutates and returns its argument, so `withCTLayout(newAppendOptions())` is the call-site
  shape; Go's `opts.WithCTLayout()` dot-chaining is not available (ADR-0079 already records this).
- The package barrel exports `newCertificateTransparencyAppender` and `withCTLayout` and no other
  `ct_only.ts` symbol; the rest stay test-only exports ([ADR-0133](0133-package-root-barrel.md)).

## Alternatives considered

- **A second, differently named function, e.g. `withCTLayoutForAppend`.** Rejected: it breaks the
  mechanical identifier mapping that makes a side-by-side diff against `ct_only.go` trivial, and invents a
  name a reader of the Go source would not look for.
- **Methods on `AppendOptions` and `MigrationOptions` that delegate to `ct_only.ts`.** Rejected for the
  reason ADR-0079 gave: it moves the CT-specific concern into the general-purpose option types and inverts
  Go's file placement.
- **Duck-typing on `"internal" in o` instead of `instanceof`.** Rejected: it dispatches on a property name
  rather than on what the object is, so any object that happens to carry an `internal` field is silently
  configured as a `MigrationOptions`.
- **Leaving the `AppendOptions` half as a separate TODO.** Not an option: it is unblocked, and the
  placeholder was the last thing keeping the file `in progress`.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `ct_only.go` in full against `src/ct_only.ts`. Both `WithCTLayout` methods set what the ADR says: `AppendOptions`
    sets `entriesPath` and `bundleIDHasher` (the struct has no leaf hasher, checked in `append_lifecycle.go`),
    `MigrationOptions` additionally `bundleLeafHasher`. `NewCertificateTransparencyAppender` reads `a.Add` at call time,
    as the Go closure does. `ctBundleIDHasher`, `ctMerkleLeafHasher`, `copy*`, `ctEntriesPath` and `convertCTEntry`
    compared branch by branch, error texts included (`unknown entry type 0x%x`, the "trailing data" message). The
    overloaded `withCTLayout` with an `instanceof` third branch is the only way to keep the single identifier name
    (the problem ADR-0079's review flagged and left open, which I confirmed there). The ADR-0044 table is complete:
    `identityHash`, `convertCTEntry`, `MigrationOptions.WithCTLayout` closed by ADR-0055, 0059 and 0079, the other two here;
    `ct_only.ts` has no TODO or placeholder.
  - Tests: `ct_only_test.ts` has 40 tests, all passing, of which 12 are Go's (6 `TestCTEntriesPath`, 3 `TestCTIdentityHasher`,
    3 `TestCTMerkleLeafHasher`); upstream has no test for the other declarations, as the ADR says. The ordering case pins
    both orders of `withCTLayout` and `withAntispam`; the guard branch, the signal forwarding and the per-call read of
    `a.add` each have a case.
  - The barrel claim holds: `src/index.ts` exports `newCertificateTransparencyAppender` and `withCTLayout` from
    `ct_only.ts` and nothing else from it.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
