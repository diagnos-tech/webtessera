# ADR-0248: Publish into R2 through a Worker's binding, with a checkpoint that only grows

- **Status:** proposed
- **Date:** 2026-10-25
- **Author:** mirror contributor
- **Upstream reference:** `storage/aws/aws.go`, `storage/gcp/gcp.go` (object-storage publication with SDKs); `cmd/experimental/mirror/internal/mirror.go` (`Mirror`, ported in `src/mirror/mirror.ts`)

## Context

A log a Cloudflare Worker writes (on D1, or in a Durable Object) is usually published from the same
Worker into an R2 bucket that a custom domain serves, so that clients and witnesses read the
tlog-tiles API from the edge cache and never invoke the Worker. ADR-0175 made a bare R2 binding a
`Sink`, and `newS3Sink` reaches R2 over its S3 API. Neither fits a Worker publishing its own log:

- A bare binding stores objects with no `Content-Type` or `Cache-Control`, so a custom domain serves
  tiles uncached and the checkpoint without the `text/plain` the spec gives it; and its `put`
  overwrites, so nothing checks that a tile already published is the tile being written.
- `newS3Sink` needs an access key in the Worker and signs every request, when the Worker already
  holds a binding that needs neither.
- Both overwrite the checkpoint unconditionally. A Worker publishes from several places at once (a
  queue consumer whose message is retried, a cron that catches up, two isolates), and `Mirror.run`
  reads the source checkpoint at its start and writes it at its end. Two overlapping runs can
  therefore finish in the wrong order and leave the checkpoint of the smaller tree in place. Every
  client and witness then sees the log go back in time; a witness refuses it, and a monitor reports
  it as an incident, although nothing is wrong with the log.

Upstream has no counterpart: its AWS and GCP drivers write the checkpoint from inside the
integration's own coordination (a database row lock), not from a separate copier.

## Decision

`newR2Sink(bucket, { prefix?, cacheControl?, conditionalWrites?, checkpointAttempts?,
maxObjectBytes? })` in `webtessera/mirror`, over a structural `R2BucketLike` (`get`, `put` with
`onlyIf` and `httpMetadata`), so that the package does not depend on `@cloudflare/workers-types`:

- Every object is stored with `resourceHeaders`' `Content-Type` and `Cache-Control`, as `newS3Sink`
  stores them, through R2's `httpMetadata`, which R2 serves back as response headers.
- Tiles and entry bundles are written with `onlyIf: { etagDoesNotMatch: "*" }`. When R2 refuses
  (the binding resolves to `null`), the sink reads the stored object back, capped at the size of
  what it is writing, and accepts only identical bytes; anything else is an `unrecoverable` error
  naming the key, as ADR-0175's update decided for the S3 sink. Keys that are no tlog-tiles resource
  are written as they are; `conditionalWrites: false` writes immutable resources unconditionally.
- The checkpoint is written by compare-and-swap: the sink reads the stored checkpoint, writes
  nothing if it holds the same bytes or a tree larger than the new one, and otherwise writes with
  `onlyIf: { etagMatches: <the etag it read> }` (or `etagDoesNotMatch: "*"` when there is none). A
  swap that R2 refuses means another writer got in between; the sink reads again and decides again,
  up to `checkpointAttempts` (5) times, and then fails recoverably. At the same size the newer write
  wins, so that a checkpoint republished with fresh cosignatures replaces the old one. The bytes to
  write must parse as a checkpoint (`checkpointUnsafe`); a stored object that does not parse is
  replaced.
- `newSinkTarget(r2Sink, { prefix })` hands the prefix to the sink (`_withPrefix`), as it does for
  `S3Sink`, so that the sink still sees log-relative keys.
- Keys with `.` or `..` segments are refused: R2 stores them, but no HTTP client can read them back.

## Consequences

- A Worker publishes its log with one line and no credentials, and the bucket is correct to serve
  publicly as it is.
- The checkpoint costs one read (Class B) before each write, and a retry per lost race.
- "Never smaller" holds per bucket key, not per log: a log that was truncated or replaced under the
  same origin is never published over the old one. That is the intent (a smaller tree cannot be
  consistent with what clients saw), and the conflicting tiles fail the run before its checkpoint in
  any case.
- `get` needs the object's `size`, which R2 returns; a custom `R2BucketLike` must provide it.

## Alternatives considered

- **Make `Mirror` serialise its own runs.** Rejected: runs in different isolates share no memory,
  and a lock would need a store of its own; the bucket's entity tags already give a correct
  compare-and-swap where the checkpoint is written.
- **Add the compare-and-swap to `newS3Sink` too.** Deferred: S3's conditional writes on `If-Match`
  are recent and not universal among S3-compatible services, which ADR-0175 targets; a sink of its
  own can choose without breaking those.
- **Document a wrapper instead of shipping a sink.** Rejected: the metadata, the immutability check
  and the ordering are each easy to get subtly wrong, which is what the S3 sink's review found.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** Tested in `src/mirror/r2_test.ts` (an in-memory binding with R2's conditional semantics,
  interleaving writers deterministically) and `src/mirror/r2_workers_test.ts` (workerd's own R2
  binding: metadata as stored, creation and swap conditions, a mirrored log that `fsck` verifies).
