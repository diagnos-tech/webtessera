# ADR-0200: Big-endian appenders reject values their Go parameter type cannot hold

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** Go's `encoding/binary` (`BigEndian.AppendUint16/32/64`); `tessera/entry.go` (`Entry.LeafData`'s length prefix); C2SP tlog-tiles (entry bundles)

## Context

tlog-tiles frames every entry in an entry bundle with a big-endian `uint16` length. Tessera builds that
prefix with `binary.BigEndian.AppendUint16(nil, uint16(len(e.data)))`. In Go the conversion is visible at
the call site and the function's parameter type is `uint16`: nothing wider can reach the encoder, and a
caller that wants truncation has to write it.

`src/internal/gostd/bytes.ts` stands in for `encoding/binary` with `appendUint16BE(b, v: number)`,
`appendUint32BE(b, v: number)` and `appendUint64BE(b, v: bigint)`. They accepted any value and kept the low
bits (`(v >> 8) & 0xff`, `v & 0xff`, …). A JavaScript `number` carries no width, so the truncation that Go
makes explicit happened silently: a length of 65,536 + n was encoded as n. A length prefix that disagrees
with the bytes that follow misframes every later entry of the bundle, and the resulting bundle no longer
verifies against the tree built from the original entries.

## Decision

Each appender throws a `RangeError` unless its argument is an integer within its Go parameter type:

| Function | Accepted | Error |
| --- | --- | --- |
| `appendUint16BE` | integers in [0, 0xffff] | `binary: <v> is out of range for uint16` |
| `appendUint32BE` | integers in [0, 0xffffffff] | `binary: <v> is out of range for uint32` |
| `appendUint64BE` | bigints in [0, 2^64−1] | `binary: <v> is out of range for uint64` |

Non-integers (`1.5`, `NaN`, `Infinity`) are rejected too. Every in-range value encodes exactly as before.

Rejecting an oversized entry at submission time (`newEntry`) is a separate, caller-facing check owned by the
root package; this ADR fixes the primitive so that no caller can produce a wrapped prefix by accident.

## Consequences

- An oversized entry now fails loudly where it is framed instead of producing a corrupt bundle.
- The three functions do slightly more work per call (a type and range check). They are not on a hot path
  relative to hashing.
- Go's own `AppendUint16` cannot fail; the port's can. Callers that rely on the old wrapping behaviour (there
  are none in the tree) would now throw.

## Alternatives considered

- **Keep the wrapping and validate only in `newEntry`.** Rejected: it leaves a primitive whose silent failure
  mode is exactly the bug, for the next caller to rediscover.
- **Clamp to the maximum.** Rejected: a clamped length prefix is as wrong as a wrapped one.
- **Take a branded `Uint16` type.** Rejected for the reasons ADR-0003 rejects wrapper types; a run-time
  check at the boundary is simpler and catches values computed at run time, which a type cannot.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**

## Update (2026-10-04): cryptobyte's `addUint` methods

`src/internal/gostd/cryptobyte.ts`'s `Builder.addUint8`, `addUint16`, `addUint24`, `addUint32`, `addUint48` and
`addUint64` wrote the low bits of whatever number or bigint they were given, the same silent truncation this ADR removes
from the `encoding/binary` appenders; `ctonly`'s `TimestampedEntry` encoder reaches `addUint64` with the entry's
timestamp. They now throw `RangeError("cryptobyte: <v> is out of range for uint<N>")` for a value outside their Go
parameter type: `uint8`, `uint16`, `uint32` (for `addUint24` and `addUint32`) and `uint64` (for `addUint48` and
`addUint64`). Within those types nothing changes: `AddUint24` still drops the top byte of its `uint32` and `AddUint48`
the top 16 bits of its `uint64`, as Go documents and does. The audit's 360,000 random builder programs against
`x/crypto/cryptobyte` v0.46.0 still match with no mismatch; `cryptobyte_test.ts` pins the boundaries.
