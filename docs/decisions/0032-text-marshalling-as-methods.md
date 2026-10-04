# ADR-0032: Port `encoding.TextMarshaler` / `TextUnmarshaler` as plain methods on classes

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** layout agent
- **Upstream reference:** `api/state.go`

## Context

`api/state.go` declares `HashTile` and `EntryBundle` as structs that implement two Go stdlib
interfaces:

```go
func (t HashTile) MarshalText() ([]byte, error)
func (t *HashTile) UnmarshalText(raw []byte) error
func (t *EntryBundle) UnmarshalText(raw []byte) error
```

Two things about that shape are load-bearing and two are not.

Load-bearing: `UnmarshalText` has a **pointer receiver and mutates the receiver in place**, replacing
`t.Nodes` / `t.Entries` wholesale; and the wire format is the tlog-tiles one, so the byte output is a
compatibility surface.

Not load-bearing: the `encoding` interfaces themselves. TypeScript has no `encoding.TextMarshaler`,
nothing dispatches on it, and nothing in Tessera passes a `HashTile` to a generic marshalling
function — every call site in the repository calls the method directly.

There is also a dead error return. `HashTile.MarshalText` can only fail if `bytes.Buffer.Write`
fails, and `bytes.Buffer.Write` is documented never to return a non-nil error; it panics on OOM
instead. The `([]byte, error)` signature exists purely to satisfy `encoding.TextMarshaler`.

## Decision

`HashTile` and `EntryBundle` are **classes** with public mutable fields and methods named under the
ADR-0002 mapping:

```ts
export class HashTile {
	nodes: Uint8Array[];
	constructor(nodes: Uint8Array[] = []);
	marshalText(): Uint8Array;
	unmarshalText(raw: Uint8Array): void;
}

export class EntryBundle {
	entries: Uint8Array[];
	constructor(entries: Uint8Array[] = []);
	unmarshalText(raw: Uint8Array): void;
}
```

- `unmarshalText` **mutates in place and returns `void`**, mirroring the pointer receiver. It throws
  on malformed input, with the message text copied verbatim from the upstream `fmt.Errorf` format
  strings.
- `marshalText` returns `Uint8Array` and **declares no failure**, because the Go function has none to
  report. A `// Port note:` on the method says so.
- The constructors take an optional initial slice, standing in for Go's composite literal
  (`api.HashTile{Nodes: ...}` / `api.EntryBundle{}`).
- The decoded entries are `subarray` views into `raw`, not copies, because Go's `raw[i:i+n]` shares
  the backing array. `internal/parse`'s package comment ("quickly, if unsafely") shows this aliasing
  is deliberate throughout the decode path.

## Consequences

- The public API is a class, not a plain object, so `structuredClone`/`JSON.parse` output is not a
  `HashTile`. No upstream code round-trips these through JSON — the wire format is the tlog-tiles
  byte encoding, which is exactly what `marshalText` produces — so nothing depends on it. An adapter
  that wants to persist one should persist `marshalText()` output.
- Dropping the error from `marshalText` means a caller cannot write a `try` that would ever fire.
  If a future implementation *can* fail, adding a throw is a source-compatible change.
- The aliasing decision is a trap in the other direction: a caller that mutates a decoded entry
  mutates the source buffer. That is true of the Go too, so it is faithful, but it deserves the
  reviewer's attention (`REVIEW-PROTOCOL.md` §2.2 calls slice aliasing out explicitly).
- `EntryBundle.unmarshalText` drops upstream's `make([][]byte, 0, layout.EntryBundleWidth)` capacity
  hint, because a JavaScript array has no separate capacity. The dependency from `api` on
  `api/layout` goes with it — `api/state.ts` now imports nothing from `api/layout`.

## Alternatives considered

- **Free functions over a plain interface** (`marshalHashTile(t)`, `unmarshalHashTile(raw): HashTile`).
  More idiomatic TypeScript and avoids classes entirely. Rejected: `UnmarshalText`'s in-place mutation
  is visible in upstream call sites, and returning a fresh value instead would quietly change the
  aliasing behaviour of every caller. Methods keep the receiver semantics honest.
- **Keeping the error return as `[Uint8Array, Error | undefined]`.** Rejected: ADR-0004 settled that
  errors are thrown, and this particular error is unreachable — encoding an impossible failure into
  the type is noise a reviewer has to re-derive.
- **Copying rather than aliasing on decode.** Safer in isolation. Rejected: it diverges from Go on
  the hottest decode path in the library, and the package it feeds explicitly advertises itself as
  fast-and-unsafe.
- **Implementing a `TextMarshaler`-shaped TypeScript interface for symmetry.** Rejected as invention:
  nothing would consume it.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** Diffed state.go/state.ts line by line. `unmarshalText` mutates `this.nodes`/`this.entries`
  in place and returns `void`, mirroring Go's pointer receiver; `marshalText` returns `Uint8Array`
  with no error, which is correct — Go's only error source is `bytes.Buffer.Write`, documented never
  to fail. The three `fmt.Errorf` format strings port character-for-character (`"%d is not a multiple
  of %d"`, `"dangling bytes at byte index %d in data of %d bytes"`, `"require %d bytes from byte index
  %d, but size is %d"`); state_test.ts's clearly-labelled "Port addition" block pins all three, and
  the `api_hash_tile`/`api_entry_bundle` fixtures assert them against Go-produced bytes. Verified the
  aliasing decision (REVIEW-PROTOCOL §2.2): Go's `raw[i:i+n]` shares its backing array, and the port
  uses `raw.subarray(...)`, which also aliases — faithful in the direction the fast-and-unsafe decode
  path relies on. The dropped `layout.EntryBundleWidth` capacity hint correctly removes `api`'s only
  dependency on `api/layout`.
