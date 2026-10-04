# ADR-0195: Response bodies are read with a size cap

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
- **Upstream reference:** `client/fetcher.go` (`HTTPFetcher.fetch`), `internal/witness/witness.go` (`witness.update`)

## Context

Both upstream HTTP clients read a response with `io.ReadAll`, which accepts a body of any length.
Every resource they read has a known maximum size.

## Decision

As hardening, bodies are read by `readAllLimited` (`client/fetcher.ts`), which reads the stream
chunk by chunk and stops with `response body exceeds the limit of <n> bytes` — cancelling the rest
of the body — once more than the cap has arrived, or at once when a `Content-Length` header
announces more. The caps:

| Resource | Cap | Basis |
| --- | --- | --- |
| tile | 9216 bytes | 256 hashes × 32 bytes, plus 1 KiB of slack |
| entry bundle | 16 777 472 bytes | 256 entries × (2-byte length + 65 535 bytes) |
| checkpoint | 1 MiB | a signed note is a few hundred bytes; generous for many cosignatures |
| witness response | 16 KiB | a few signature lines, or a decimal tree size |

`HTTPFetcher` reports an oversized body as `get("<url>"): response body exceeds ...`; the witness
client as `failed to read body from witness at "<url>": response body exceeds ...`, the message Go
uses for a failed read.

## Consequences

- A resource larger than the specification allows fails instead of being read into memory.
- `readAllLimited` is exported `@internal` from `client/fetcher.ts` so that `internal/witness` can
  share it; it is not in the `client` barrel.

## Alternatives considered

- **Check only `Content-Length`.** Rejected: the header is optional and need not be honest.
- **Make the caps configurable.** Rejected for now: they follow from the specification, not from
  deployment choices.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `HTTPFetcher.fetch` and `witness.update` read with `io.ReadAll`.
  - TS: `readAllLimited` (`client/fetcher.ts`) checks `Content-Length` first, then counts chunks and cancels the stream past the cap, throwing `response body exceeds the limit of <n> bytes`. Caps match the table: tile `256*32+1024 = 9216`, bundle `256*(2+65535) = 16,777,472`, checkpoint `1<<20`, witness `16<<10`. `HTTPFetcher` reports `get("<url>"): ...`; the witness client reports `failed to read body from witness at "<url>": ...`. `readAllLimited` is not in the `client` barrel. Tests in `fetcher_test.ts` (tile at/over cap, checkpoint stream cancelled, bundle `Content-Length` over cap) and `witness_test.ts` (16384) exist and pass.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
