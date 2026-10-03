# ADR-0175: Mirror into any `put`-able store, and into S3-compatible buckets with our own SigV4

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** `cmd/experimental/mirror/posix/main.go` (`posixTarget`); `storage/aws/aws.go`, `storage/gcp/gcp.go` (SDK-based object storage)

## Context

Upstream's only mirror `Target` writes files. Its object-storage drivers use the AWS and GCP SDKs,
which cannot run in browsers or Workers and are excluded by PORTING.md §7. Users want to mirror a log
into the object storage they already have, vendor-neutrally.

## Decision

- `Sink = { put(key, data): Promise<unknown>; get?(key): Promise<Uint8Array | ArrayBuffer |
  { arrayBuffer() } | null | undefined> }`. Every `ObjectStore` satisfies it, and so does a Cloudflare
  Workers R2 binding (checked at compile time against `@cloudflare/workers-types` in `sink_test.ts`);
  other SDKs need a two-line wrapper. `newSinkTarget(sink, { prefix? })` is the `Target` writing each
  resource at its tlog-tiles path (as `posixTarget` does), and also a `Source`/fsck `Fetcher` reading it
  back. Without `get`, every run copies everything again, correctly.
- `newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken?, prefix?,
  addressing?, fetch?, attempts?, conditionalWrites?, cacheControl?, maxObjectBytes?, now? })` speaks
  PutObject/GetObject over fetch, for AWS S3, Cloudflare R2, Google Cloud Storage (XML API), Backblaze
  B2, MinIO, Ceph and others:
  - signed with `src/mirror/sigv4.ts`, a synchronous AWS Signature V4 implementation on
    `@noble/hashes` (hmac + sha256): S3's single path encoding without normalisation, sorted canonical
    query, all sent headers signed, payload hash signed and sent as `x-amz-content-sha256`, one clock
    reading per request for `x-amz-date` and the scope, the secret never in any returned value or error;
  - `redirect: "manual"`, with 3xx refused, so signed requests are never replayed elsewhere;
  - each object stored with `resourceHeaders`' `Content-Type`/`Cache-Control`;
  - `If-None-Match: *` on tiles and bundles (immutable), 412 treated as already written; checkpoint
    always overwritten; opt-out for services that reject the header;
  - retries for network errors, 429, 409 (racing conditional writes), 5xx; errors carry the status and
    the S3 `<Code>` only, never the rest of the error document (which echoes the string to sign);
  - keys with `.`/`..` segments refused (fetch would resolve them to another key); GET bodies capped.
- Tests: the AWS SigV4 test suite (aws-c-auth, 27 applicable header-signing cases; the 11 cases that
  normalise paths, carry dot segments fetch cannot send, or leave the token unsigned are listed with
  reasons), `aws4fetch` as an oracle for S3 requests, a fake S3 that validates every request with
  `aws4fetch`, and a `*_services_test.ts` against a real endpoint (MinIO locally: 3/3 passing, and
  MinIO answered 412 to the conditional write).

## Consequences

- No SDK dependency; the signer is ~200 lines under test against published vectors.
- The vectors are Apache-2.0 test material, attributed in NOTICE, under `src/mirror/testing/` (excluded
  from the build).
- Virtual-hosted addressing needs DNS for `<bucket>.<host>`; the default is path-style, which every
  S3-compatible service accepts.

## Alternatives considered

- **Use `aws4fetch` at runtime.** Rejected: a runtime dependency (PORTING.md §7), async WebCrypto, and it
  excludes `content-type` from signing by default.
- **R2-specific `httpMetadata` in the Sink interface.** Rejected: vendor-specific; metadata is derived
  from the key instead, and `resourceHeaders(key)` is a valid R2 `httpMetadata` for users who wrap R2.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

## Update (2026-10-03)

- **A 412 is checked, not trusted.** The S3 sink treated `412 Precondition Failed` on an immutable key as
  "already written". After a run interrupted before its checkpoint, against a source that then served a
  different history signed by the same key, the next run kept the old objects and published the new
  checkpoint over them: the review's proof of concept ended with a checkpoint from history B over
  `tile/0/000` from history A, which `fsck` rejected. On 412 the sink now reads the stored object back,
  capped at the size of what it is writing, and accepts only identical bytes; anything else fails the put
  with an error marked `unrecoverable` that names the key (`S3 PUT b/tile/0/001.p/44: a different object is
  already stored there, ...`), so the mirror stops at once and never writes its checkpoint. An object
  deleted between the two requests fails the attempt recoverably, and the next attempt writes it afresh.
- **Sinks that keep objects.** `Sink.put`'s documentation now requires replacing what is stored, as every
  `ObjectStore` and R2 binding does, or checking that what is kept is identical. The `ObjectStore` path of
  `SinkTarget` has no "exists means done" step: `put` overwrites, so a re-run against another history
  replaces every object it writes before its checkpoint.
- **Prefixes keep metadata and conditional writes.** `newSinkTarget(s3, { prefix })` prepended the prefix
  before the sink saw the key, so `resourceHeaders` no longer recognised it as a tlog-tiles path: objects
  were stored as `application/octet-stream` without `Cache-Control`, and without `If-None-Match`.
  `newSinkTarget` now hands an `S3Sink` the prefix itself (an internal `_withPrefix`), so the sink derives
  each object's headers from the log-relative path; the option's documentation tells authors of other sinks
  that derive anything from the key to take the prefix the same way.
- Requests also omit ambient credentials
  ([ADR-0213](0213-rqlite-and-s3-requests-omit-credentials-and-refuse-redirects.md)), and `attempts` and
  `maxObjectBytes` must be positive safe integers
  ([ADR-0212](0212-http-request-targets-limits-and-error-bodies.md)).
