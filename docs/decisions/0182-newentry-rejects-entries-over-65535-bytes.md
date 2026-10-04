# ADR-0182: `newEntry` rejects entry data longer than 65535 bytes

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `entry.go` (`NewEntry`)

## Context

A [tlog-tiles](https://c2sp.org/tlog-tiles) entry bundle stores each entry behind a big-endian
`uint16` length, so no entry in such a bundle can be longer than 65535 bytes. `NewEntry`'s
default marshalling writes that prefix with a plain conversion:

```go
e.marshalForBundle = func(_ uint64) []byte {
	r := make([]byte, 0, 2+len(e.internal.Data))
	r = binary.BigEndian.AppendUint16(r, uint16(len(e.internal.Data)))
	r = append(r, e.internal.Data...)
	return r
}
```

For longer data the conversion truncates, the prefix no longer matches the bytes that follow
it, and the bundle written for the entry does not parse back into the entries that were added.
Nothing upstream checks the length before that point. The port reproduced the truncation and
pinned it in a test.

## Decision

As hardening, `newEntry` throws when `data.length > 65535`, with the message
`entry data is <n> bytes, more than the 65535 a tlog-tiles entry bundle can hold`, before it
builds the entry. Data of exactly 65535 bytes is accepted and marshalled as before. The check
sits at construction so that the caller gets the error from the call that supplied the data,
rather than from the storage layer later.

`convertCTEntry` is unaffected: Static CT bundles have their own framing, which does not use this
prefix.

A separate range check in `gostd/bytes.ts`'s `appendUint16BE` (made by another change) keeps the
low-level helper from truncating either.

## Consequences

- A personality that adds an over-long entry gets an exception from `newEntry` instead of a log
  containing an unreadable bundle. Upstream Go silently produces the latter; this is a deliberate
  divergence.
- The port addition that pinned the truncation is replaced by two tests: 65535 bytes is accepted
  with prefix `0xffff`, and 65536 bytes is rejected.

## Alternatives considered

- **Keep Go's behaviour.** Rejected: it produces a log that clients cannot read back, and
  nothing downstream can repair it.
- **Reject later, in the storage driver.** Rejected: by then the entry may have been accepted by
  antispam and assigned an index; failing at construction keeps the error with its cause.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `entry.go` `NewEntry` marshals `binary.BigEndian.AppendUint16(r, uint16(len(Data)))`, which truncates; nothing upstream checks the length.
  - TS side: `src/entry.ts` `newEntry` throws `entry data is <n> bytes, more than the 65535 a tlog-tiles entry bundle can hold` when `data.length > 0xffff`, before building the entry; 65535 is accepted. `convertCTEntry` does not go through `newEntry` (`ct_only.ts:72` builds `new Entry()`, as `ct_only.go:50` builds its own), so the 'unaffected' claim holds.
  - Tests: `entry_test.ts` accepts exactly 65535 bytes (prefix `ff ff`, 2+65535 bytes marshalled) and rejects 65536 with the exact message. The differential allow-list row `entry-size-limit` (ADR-0216) names this ADR.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
