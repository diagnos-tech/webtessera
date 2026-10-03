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
