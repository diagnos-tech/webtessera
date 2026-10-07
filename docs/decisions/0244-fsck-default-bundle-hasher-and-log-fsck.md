# ADR-0244: Default fsck's bundle hasher, export it from webtessera/fsck, and add `log.fsck()` to the safe API

- **Status:** accepted
- **Date:** 2026-10-07
- **Author:** Gustavo Simões (DX audit fixes)
- **Upstream reference:** tessera `fsck/fsck.go` (`New`), `lifecycle.go` (`defaultMerkleLeafHasher`),
  `integration/fault/posix/fault_test.go` and `storage/gcp/gcp_test.go` (their copies of
  `defaultMerkleLeafHasher`, passed to `fsck.New`)

## Context

Every safe-API error about damaged storage ended "check it with fsck from webtessera/fsck". The audit followed
that advice and found a dead end: `newFsck(origin, verifier, fetcher, bundleHasher, opts)` needs a bundle hasher,
and the one that suits every tlog-tiles log, `defaultMerkleLeafHasher`, was exported by no entry point (it is
unexported in Go's root package, and ADR-0133 keeps the root barrel to Go's exports). It took the auditor five
minutes, three declaration files and a hand-written hasher to run fsck.

Upstream has the same shape, and copes by copying: `lifecycle.go` defines `defaultMerkleLeafHasher` for the
migration target, and `fault_test.go` and `gcp_test.go` each define an identical copy to pass to `fsck.New`, whose
`bundleHasher` has no default:

```go
// defaultMerkleLeafHasher parses a C2SP tlog-tile bundle and returns the Merkle leaf hashes of each entry it contains.
func defaultMerkleLeafHasher(bundle []byte) ([][]byte, error) {
```

## Decision

**In the port (additions, behaviour unchanged for every call Go could make):**

- `newFsck`'s `bundleHasher` defaults to `defaultMerkleLeafHasher`, and its `opts` to `{}` (one worker, Go's
  zero-value meaning). A call that passes both is Go's call and behaves as Go's. A `Port note:` on `newFsck` says so.
- `webtessera/fsck` exports `defaultMerkleLeafHasher`, the root package's (`src/lifecycle.ts`), so a caller can
  pass it explicitly, or wrap it. It stays off the root barrel, as Go keeps it unexported there; the fsck barrel's
  header says why it is the one addition.

**In the safe API:** `log.fsck({ signal?, workers? })` on every `TransparencyLog`. It reads the latest checkpoint
once and verifies it with the log's key and witnesses, then runs the ported fsck against exactly that checkpoint
(through a fetcher that serves it), with `defaultMerkleLeafHasher` and `DefaultFsckWorkers` (4) workers. It
resolves to `{ checkpoint, resourcesFetched, bytesFetched }` once every entry bundle, every tile and the root hash
verify, and otherwise throws a `WebtesseraError` with the code `STORAGE_DAMAGED` (ADR-0243) whose cause is the
fsck error: "fsck: the log's storage does not verify against its checkpoint at size N: <fsck's message>. Restore
the storage from a backup or a mirror; …". An aborted signal rejects with its reason.

Every hint that sent users to webtessera/fsck now says "check it with log.fsck()".

## Consequences

- A user who meets a "storage may be damaged" error has one call to make, on the object they already hold.
- `newFsck`'s signature differs from Go's `New` by two default values; a reviewer comparing the two sees them in
  the declaration and the port note.
- `log.fsck()` reads the whole log: it is for incidents, restores, migrations and scheduled audits, as its TSDoc
  says, not for request paths. It checks against the checkpoint it read first, so it is safe on a log that keeps
  growing; resources the log has since replaced (a partial tile grown full) are handled by fsck as upstream does.
- Run `log.fsck()` in the process that writes the log. Opening a log starts an appender, so a second process that
  opens it only to check it is a second writer; under `locking: "single-writer"` the tripwire then stops the first
  (ADR-0210's update). To check a log from another process, give `newFsck` an `HTTPFetcher` for its read API
  (`newHTTPFetcher` from `webtessera/client`), which writes nothing. The TSDoc and the guides say so.
- `src/safe/log.ts` now imports `src/fsck/fsck.ts`; a browser bundle that uses `openBrowserLog` carries fsck's
  code. A verify-only bundle (`verifyReceipt`) does not import `log.ts` and is unaffected.

## Alternatives considered

- **Export `defaultMerkleLeafHasher` from the root barrel.** That is where it lives in Go, but unexported; ADR-0133
  keeps the root to Go's exported names, and fsck is the package whose callers need it.
- **Only fix the hint** (show the four lines of wiring in the error). Every user would copy them, as upstream's
  tests copy the hasher; a default is the copy made once.
- **A separate `fsckLog(log)` function** instead of a method. The log already owns the reader, verifier, witness
  policy and origin fsck needs; a method needs no arguments to get them right.

Tests: `src/fsck/fsck_test.ts` ("newFsck defaults its bundleHasher …": a good log verifies with the defaults and
with `{ n: 3 }`, a corrupted tile is caught by the default hasher, and the barrel exports the root's hasher);
`src/server/server_test.ts` ("verifies the whole log with fsck …": 300 entries verify; a flipped bit in a tile is
`STORAGE_DAMAGED` naming the tile; invalid `workers`), and the two-process test, which runs `log.fsck()` on the
file both processes wrote.

## Review

- **Reviewer:** DX review agent (independent), 2026-10-07
- **Verdict:** approved
- **Notes:**
  - Compared `newFsck` with Go's `fsck.New` @ 4a6d9f9: the only difference is the two default values; a call passing both is unchanged, and no error text changed. `fsck.ts` now imports `src/lifecycle.ts` (whose imports are `api/state`, `rfc6962` and a type), with no cycle. `defaultMerkleLeafHasher` loses `@internal` and is exported from `webtessera/fsck` only; the root barrel is unchanged (`index_test.ts`). The PORTING-MAP row records the addition. `fsck_test.ts` and the fsck cases of `server_test.ts` pass.
  - `log.fsck()` reads and verifies the checkpoint once (key and witnesses, through `#parse`), runs fsck against a fetcher pinned to it, rethrows an abort, and otherwise answers `STORAGE_DAMAGED` with the fsck error as cause, as written.
  - Required note. The Context and the TSDoc recommend running `log.fsck()` from a scheduled job. A job that opens the log with `openServerLog` is a writer (its appender locks on open and publishes), so on a database opened with `locking: "single-writer"` it takes the claim and stops the server's writes for good. Probe: one process appending every 200 ms under `"single-writer"`, a second opening the same file the same way and running `log.fsck()`. The fsck verified 5 entries, and the server's next 15 appends all failed with `WRITER_CONFLICT`. With lease locking all 20 succeeded. Say this in `log.fsck`'s TSDoc, in `safe-api.md` and here: run fsck in the writing process, or use lease locking everywhere. A read-only open (no appender) would remove the trap.
  - Not verified: the audit anecdote in the Context.
  - Re-review of a2bd7a2. The required warning is now in the `fsck` TSDoc, `safe-api.md`, `choosing-storage.md` and a Consequences bullet. The read-only route those texts name works. Probe: a 300-entry log, checked by `newFsck(origin, verifier, newHTTPFetcher(url, (input, init) => log.fetch(new Request(input, init))))`, passes without opening the log a second time. Documentation is enough for now. A read-only open would remove the trap, but that is new API for a later ADR.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
