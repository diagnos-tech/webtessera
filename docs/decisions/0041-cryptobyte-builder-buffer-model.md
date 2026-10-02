# ADR-0041: Model `cryptobyte.Builder`'s `[]byte` result as an explicit buffer/length pair

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** ct agent
- **Upstream reference:** `golang.org/x/crypto@v0.46.0/cryptobyte/builder.go`

## Context

`Builder`'s deferred length prefix is the whole point of the type, and it is built directly on Go's
slice semantics. `addLengthPrefixed` reserves `lenLen` zero bytes, hands a *child* builder the same
slice, lets the continuation append to it, and then backfills the length:

```go
offset := len(b.result)
b.add(make([]byte, lenLen)...)
b.child = &Builder{
	result:        b.result,
	offset:        offset,
	pendingLenLen: lenLen,
	...
}
b.callContinuation(f, b.child)
b.flushChild()
```

```go
length := len(child.result) - child.pendingLenLen - child.offset
...
l := length
for i := child.pendingLenLen - 1; i >= 0; i-- {
	child.result[child.offset+i] = uint8(l)
	l >>= 8
}
if l != 0 {
	b.err = fmt.Errorf("cryptobyte: pending child length %d exceeds %d-byte length prefix", length, child.pendingLenLen)
	return
}
...
b.result = child.result
```

Three distinct Go facilities are load-bearing here:

1. A slice header is `{pointer, len, cap}` with **value** semantics for `len`. Parent and child share
   one backing array but each has its own `len`, which is why the parent's view stays at the
   placeholder until `b.result = child.result` runs.
2. `append` reallocates when `cap` is exhausted, so the child may end up on a *different* array —
   hence that final assignment being a real copy-back rather than a formality.
3. `cap` is separate from `len`, which is what `NewFixedBuilder` and `NewBuilder(buf[0:0])` exploit
   to write into a caller's array in place.

TypeScript has none of these. A `Uint8Array` has a fixed length, no capacity, and is a reference.

## Decision

Represent Go's `result []byte` as two private fields on `Builder`:

```ts
private buf: Uint8Array = emptyBytes;  // the backing array
private len = 0;                       // this builder's own len(b.result)
```

- The child is constructed with `child.buf = this.buf; child.len = this.len;` — the same array,
  its own length. That reproduces (1).
- `add` calls a private `grow(n)` that reallocates to double the capacity when the array is full,
  replacing **only that builder's** `buf`. That reproduces (2): a child that grows moves to a new
  array the parent cannot see.
- `flushChild` ends with `this.buf = child.buf; this.len = child.len;`, the direct rendering of
  `b.result = child.result`.
- `bytes()` returns `this.buf.slice(this.offset, this.len)`, a copy — the visible length always
  matches Go's `b.result[b.offset:]` even though the backing array is usually longer.

The length backfill loop uses `l % 256` and `Math.floor(l / 256)` rather than `l & 0xff` and
`l >>= 8`. JavaScript's bitwise operators truncate their operands to 32 bits, and a `uint32` length
prefix can legitimately describe more bytes than that; division is exact for every safe integer.

`grow` also replaces upstream's `add` overflow guard:

```go
if len(b.result)+len(bytes) < len(bytes) {
	b.err = errors.New("cryptobyte: length overflow")
}
```

That check detects Go's `int` wrapping around on a 32-bit platform. JavaScript numbers do not wrap;
an oversized allocation throws a `RangeError` from `new Uint8Array` instead. The guard is dropped
rather than kept as unreachable code.

Two behaviours therefore differ from Go, both only observable through a builder that has already
errored:

- **`NewBuilder(buffer)` never writes into `buffer` in place.** In Go, `NewBuilder(buf[0:0])`
  appends into `buf`'s spare capacity, which is what upstream's `TestPreallocatedBuffer` asserts. A
  `Uint8Array` has no spare capacity, so the port's `len` starts equal to `buf.length` and the first
  append copies. Tessera's only call is `cryptobyte.NewBuilder([]byte{})`, where the two are
  identical. `TestPreallocatedBuffer` is not ported, and the divergence is documented in a
  `// Port note:` on `newBuilder`.
- **After a length-prefix overflow, the port's buffer still contains the child's bytes.** Go's
  parent `len` was never advanced past the placeholder, so its slice is effectively truncated; the
  port's `len` was copied back only on the success path, so it is likewise not advanced — but the
  bytes physically remain in the shared array beyond `len`. Neither is observable: `bytes()` throws
  once `err` is set, `add` and `unwrite` return early, and nothing reads past `len`.

## Consequences

- The port keeps `b.result = child.result` visible as `this.buf = child.buf; this.len = child.len;`
  so a reviewer scrolling both files sees the copy-back at the same place. That was the main reason
  not to collapse the pair into a single shared mutable buffer object, which would have made the
  assignment a no-op and quietly changed the error-path semantics above.
- Amortised append cost matches Go's: `grow` doubles. `ctMerkleLeafHasher` rebuilds a preimage for
  every entry in a 256-entry bundle, so per-byte `Array.push` was not an acceptable alternative.
- `NewFixedBuilder` cannot be ported at all under this model, which is one of the reasons it is out
  of scope (ADR-0040).

## Alternatives considered

- **A shared mutable buffer object referenced by both parent and child.** Simplest to write and the
  common path is identical. Rejected: it erases the `len` value-semantics of a Go slice header, so
  the error path diverges in a way that is invisible in the code, and `flushChild`'s copy-back
  becomes a no-op line a future reader would delete as dead.
- **`number[]` with `push`.** A faithful stand-in for `append` and trivial to write. Rejected on
  cost: a full CT entry bundle is hundreds of kilobytes, and every byte would be an individual
  `push` plus a `Uint8Array.from` at the end.
- **Track `cap` explicitly to support `NewFixedBuilder`.** Rejected: it would mean carrying a third
  field and a capacity check through every method to support a constructor no caller uses, and the
  in-place aliasing it exists for still would not work, because `Uint8Array.slice` copies.

## Review

- **Reviewer:** gostd Reviewer (agent)
- **Verdict:** approved
- **Notes:** Verified the `buf`/`len` pair against Go's slice header semantics in `builder.go`.
  Child construction (`child.buf = this.buf; child.len = this.len`) reproduces the shared-array /
  independent-`len` behaviour of `&Builder{result: b.result, ...}`; `grow` reallocs only the calling
  builder's `buf`, mirroring `append`'s move to a new array; `flushChild` ends with
  `this.buf = child.buf; this.len = child.len`, the direct rendering of `b.result = child.result`.
  Hand-traced the deferred length backfill for single, sibling, nested and differing-width prefixes,
  the empty-child (writes a zero length) and both overflow paths — the error message
  `cryptobyte: pending child length N exceeds M-byte length prefix` matches Go verbatim and
  propagates from an inner child to the outermost builder, as the tests assert. The
  `l % 256` / `Math.floor(l / 256)` backfill (rather than `& 0xff`/`>>= 8`) is correct and
  necessary: a uint32 prefix can exceed JS's 32-bit bitwise range. Confirmed the two documented
  error-path divergences are unobservable — `bytes()` throws once `err` is set and nothing reads
  past `len`. The dropped `add` overflow guard is justified (JS numbers don't wrap; oversize
  allocation throws `RangeError`). `bytes()` returning a `slice` copy rather than an aliasing view
  is safe for every current caller and is the deliberate consequence recorded here and in ADR-0042.
