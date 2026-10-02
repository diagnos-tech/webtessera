# ADR-0079: `(*MigrationOptions).WithCTLayout` ports as a free function in `ct_only.ts`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `ct_only.go:66-72`, `migrate_lifecycle.go`'s `MigrationOptions`

## Context

`docs/decisions/0044-ct-only-partial-port.md` left two declarations in `ct_only.go` as
`TODO(<owner>):` blocks, waiting on dependencies that did not exist yet:

```go
// WithCTLayout instructs the underlying storage to use a Static CT API compatible scheme for layout.
func (o *MigrationOptions) WithCTLayout() *MigrationOptions {
    o.entriesPath = ctEntriesPath
    o.bundleIDHasher = ctBundleIDHasher
    o.bundleLeafHasher = ctMerkleLeafHasher
    return o
}
```

is a **method** on `MigrationOptions`, a type `migrate_lifecycle.go` declares — same Go package,
different file, reaching three of that type's unexported fields directly (Go's ordinary same-package
visibility; see `docs/decisions/0059-convertctentry-ported-closes-second-adr-0044-item.md` for the
same shape of problem already solved once for `convertCTEntry` reaching `Entry.internal`). Now that
this work package has ported `migrate_lifecycle.ts`'s `MigrationOptions` (with its three settable
fields grouped under a public `internal` object, exactly as `Entry.internal` groups `Entry`'s), this
TODO's blocking dependency exists and the second of `ct_only.go`'s two deferred declarations can be
closed. (`(*AppendOptions).WithCTLayout`, the other `WithCTLayout` method in the same Go file, still
awaits Wave 3's `AppendOptions` and remains a `TODO(<owner>):`.)

## Decision

`src/ct_only.ts` gains `export function withCTLayout(o: MigrationOptions): MigrationOptions`, a
**free function** taking the options object as its argument rather than a class method:

```ts
export function withCTLayout(o: MigrationOptions): MigrationOptions {
    o.internal.entriesPath = ctEntriesPath;
    o.internal.bundleIDHasher = ctBundleIDHasher;
    o.internal.bundleLeafHasher = ctMerkleLeafHasher;
    return o;
}
```

TypeScript has no way to add a method to a class from a different module without subclassing — and
subclassing would change `MigrationOptions`'s runtime identity (`instanceof` checks, and any future
`Driver` lifecycle method typed in terms of the base class specifically), which nothing about this
port's design calls for. A free function taking the receiver as its first argument is the direct
translation: call-site fidelity is `withCTLayout(o)` in place of Go's `o.WithCTLayout()`, and the
mutate-and-return-`this` chaining shape (`NewAppendOptions().WithCheckpointSigner(...).WithCTLayout()`
in Go) survives as `withCTLayout(someOtherOption(o))`-style composition instead of dot-chaining.

The function lives in `ct_only.ts` — where Go physically puts it — not in `migrate_lifecycle.ts`,
preserving `AGENTS.md` §3.1's file-name fidelity (a reviewer who knows `WithCTLayout` is defined in
`ct_only.go` finds its port in `ct_only.ts`). This required `ct_only.ts` to import `MigrationOptions`
from `migrate_lifecycle.ts`; the reverse import does not exist, so no cycle is introduced.

## Consequences

- `docs/PORTING-MAP.md`'s row for `ct_only.go` records that only `(*AppendOptions).WithCTLayout` is
  still outstanding, naming this ADR for the `MigrationOptions` half and ADR-0044/ADR-0054 for the
  remaining `AppendOptions` half (Wave 3's job).
- `ct_only_test.ts` gains a `describe("withCTLayout", ...)` case (31 tests total, up from 30) proving
  the three fields are wired and the same options object is returned for chaining.
- A caller wanting Go's exact `opts.WithCTLayout()` call-site shape does not get it; this is a
  necessary, not stylistic, divergence — flagged here per `AGENTS.md` §6 rather than left implicit.

## Alternatives considered

- **Add `withCTLayout` as a genuine method directly on the `MigrationOptions` class in
  `migrate_lifecycle.ts`**, importing `ctEntriesPath`/`ctBundleIDHasher`/`ctMerkleLeafHasher` from
  `ct_only.ts` there instead. Rejected: it inverts `AGENTS.md` §3.1's file-name fidelity (Go puts this
  method in `ct_only.go`, not `migrate_lifecycle.go`), and it is the CT-specific concern reaching into
  the general-purpose migration type rather than the other way around, which is backwards from how
  Go's own package boundary reads (any file in package `tessera` may define a method on any type in
  the same package, but *this* method is unambiguously CT-flavoured content that belongs with its
  sibling `ctEntriesPath`/`ctBundleIDHasher`/`ctMerkleLeafHasher`).
- **A mixin/composition helper simulating cross-file method declarations generally.** Rejected as
  invented machinery (`AGENTS.md` §6) solving a problem that has exactly two instances in this
  codebase (`AppendOptions`/`MigrationOptions`'s `WithCTLayout`) and a straightforward one-line
  function-per-instance solution already.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved (with a precedent note for whoever ports `AppendOptions`)
- **Notes:** Checked `withCTLayout` against `ct_only.go:66-72`'s `(*MigrationOptions).WithCTLayout`:
  all three fields set (`entriesPath`=`ctEntriesPath`, `bundleIDHasher`=`ctBundleIDHasher`,
  `bundleLeafHasher`=`ctMerkleLeafHasher`) and `return o` for chaining — faithful, reaching
  `o.internal.*` exactly as Go reaches the unexported fields (same-package visibility → the
  `internal`-grouping pattern of `Entry.internal`/`MigrationOptions.internal`). Free-function-over-method
  is a real TS language constraint, not a stylistic choice — subclassing would break `instanceof`.
  `ct_only_test.ts`'s `describe("withCTLayout")` genuinely exercises it (asserts the three fields wire
  to the CT hashers and the same object returns). No import cycle (`ct_only.ts` → `migrate_lifecycle.ts`
  only). **Precedent concern to record, not a blocker:** Go has *two* `WithCTLayout` methods in
  `ct_only.go`, distinguished by receiver (`*MigrationOptions` and `*AppendOptions`). Free functions
  in one TS module cannot share the name `withCTLayout`, so when Wave 3 ports
  `(*AppendOptions).WithCTLayout` it cannot land as a second plain `withCTLayout` in `ct_only.ts` — it
  will need either a distinct name (breaking the 1:1 identifier mapping) or a runtime-dispatching
  overload that *refactors this already-landed function*. The ADR resolves the `MigrationOptions` half
  cleanly but does not flag that its own choice constrains the `AppendOptions` half; whoever finishes
  that side should decide the naming up front rather than discovering the collision.
