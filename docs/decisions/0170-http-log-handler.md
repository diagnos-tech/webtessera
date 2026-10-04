# ADR-0170: Serve the tlog-tiles read API from any LogReader as a fetch-style handler

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** `cmd/conformance/mysql/main.go` (`configureTilesReadAPI`), `cmd/conformance/{posix,gcp,aws}/main.go` (`POST /add`), `storage/gcp/gcp.go` and `storage/aws/aws.go` (`logCacheControl`, `ckptCacheControl`)

## Context

Tessera serves nothing itself. Each conformance personality wires its own HTTP routes, and
`configureTilesReadAPI` in the MySQL one says why that is unfortunate: "This method could be moved
into the storage API as it's likely this will be the same for any implementation of a personality".
webtessera's users run logs in browsers (service workers), Node, Bun, Deno and Workers, and the
Cloudflare example already carried an ad-hoc copy of the same routing. Every copy is a chance to get
the path grammar, the caching or the status codes subtly wrong.

## Decision

New module `webtessera/http` (`src/http/`), with no upstream counterpart:

- `Handler = (request: Request) => Promise<Response | undefined>`; undefined means "not mine", so
  handlers compose. `combineHandlers(...)` turns them into the `(Request) => Promise<Response>` every
  runtime takes, answering 404 when none matches.
- `newLogHandler({ reader, prefix?, cors?, cacheControl?, etag?, onError? })` serves `GET`/`HEAD` on
  `checkpoint`, `tile/<L>/<N>[.p/<W>]`, `tile/entries/<N>[.p/<W>]` under a mount prefix, from any
  `Pick<LogReader, "readCheckpoint" | "readTile" | "readEntryBundle">` (an `HTTPFetcher` too).
  - Paths go through `api/layout`'s parsers and must then format back to themselves: upstream's parsers
    accept `x000/001` and `.p/08`, which the spec's grammar ("no additional leading zeroes", fixed `<N>`
    encoding) does not. Non-canonical or malformed paths under `tile/` get 400 naming the canonical
    spelling (upstream's MySQL server answers parse failures with 400 "Malformed URL: ..."). Paths over
    96 characters are refused before parsing, since the parsers' cost grows with input length. Storage is
    only ever reached with parsed numbers, so nothing outside the tlog-tiles namespace (`.state/**`) can
    be served.
  - `ErrNotExist` → 404; other reader failures → 500 with no detail, reported to `onError`; other
    methods → 405 with `Allow`. Never a redirect ("MUST NOT serve redirect responses").
  - Caching: checkpoint `no-cache` (upstream's conformance servers and object-store drivers), full tiles
    and bundles `public, max-age=31536000, immutable`, partials `public, max-age=60` (they may be
    garbage-collected, and a reader asked for an unpublished partial may answer differently).
  - `ETag` (first 16 bytes of the body's SHA-256) with `If-None-Match` → 304; opt-out.
  - CORS is opt-in (`Access-Control-Allow-Origin`, `Expose-Headers: ETag`, preflight for `OPTIONS`).
  - A partial resource is served exactly `W` hashes/entries wide even when the reader substitutes the
    full resource (Tessera's drivers fall back to it once the partial is collected): the prefix of the
    full resource is, by construction, the partial one.
- `resourceHeaders(path)` returns the spec's `Content-Type`/`Cache-Control` for a path, for other
  publishers (the S3 sink uses it; it is a valid R2 `httpMetadata`).
- `addResponse(index)` / `addErrorResponse(err)` reproduce upstream's `POST /add` answers (bare decimal
  index; 503 + `Retry-After: 1` on `ErrPushback`; 500 with the error text), and `readEntryBody(request)`
  reads the entry while streaming, refusing anything over 65535 bytes (the uint16 bundle length prefix).
  The endpoint itself stays the personality's.
- `toNodeListener(handler)` adapts a handler to `http.createServer` using structural types only, so the
  library imports nothing from Node.

## Consequences

- One reviewed implementation of the read API for every runtime and every reader. The Cloudflare
  example can be reduced to `newLogHandler` (left to the example's owner).
- Stricter than upstream servers on path spelling; Tessera's own clients build canonical paths and never
  notice.
- New public API (exports map entry `./http` was reserved by the lead).
- Compression of entry bundles is left to the runtime or CDN, and pruning (minimum index) is not
  implemented.

## Alternatives considered

- **Document a routing snippet instead of shipping a handler.** Rejected: the details above are exactly
  what copies get wrong, and the Cloudflare example had already diverged (no canonical check, no partial
  trimming).
- **Return 404 for every non-log path inside the handler.** Rejected: handlers would not compose.
- **Depend on a server framework or adapter package for Node.** Rejected by PORTING.md §7; the structural
  adapter is 100 lines.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

## Update (2026-10-03)

Three changes from the security review, recorded in
[ADR-0212](0212-http-request-targets-limits-and-error-bodies.md):

- `toNodeListener` passes only origin-form request-targets to the handler, set as the URL's path and query
  rather than resolved against the origin (`//x/checkpoint` used to become host `x`, path `/checkpoint`);
  other forms get 400, `OPTIONS *` gets 204, and a `Host` header that is not a bare authority gets 400.
- Every size cap is checked as a positive safe integer where it is given: `readEntryBody`'s `maxBytes` and
  `toNodeListener`'s `maxBodyBytes` (a NaN cap used to cap nothing), and CORS's `maxAgeSeconds` as a
  non-negative one.
- `addErrorResponse` answers 500 with a generic body unless `{ detail: true }` is passed, no longer with
  the error's text as upstream's personalities do. The handler's documentation now warns that over an
  `HTTPFetcher` it re-serves a remote log unverified, with immutable caching, and points to
  `newVerifiedMirror`.

## Update (2026-10-04): the handler never reads `request.signal`

`newLogHandler` used to pass `request.signal` to the reader. It no longer reads it at all. Deno 2 prints a
one-time warning on the first read of `request.signal` inside `Deno.serve` ("request.signal aborts on
successful responses (legacy behavior) … --unstable-no-legacy-abort"), checked on Deno 2.9.7: any access
to the getter triggers it, including `.aborted`. What the signal means differs by runtime anyway: behind
`toNodeListener` it never aborts (the adapter builds the `Request` without one), on Deno it aborts after
every response, and only on Bun and workerd does it abort when the client goes away. A tile, bundle or
checkpoint read is one bounded read; a client that leaves now costs at most the read in flight. Deferring
the read was considered and rejected: there is no way to pass a cancellable signal to the reader without
reading the request's at call time, and a timer-based "read it if the read is slow" adds machinery for
nothing correctness needs. The module documentation and the log-server example's README say so, for
applications whose own routes read the signal. Test: `log_handler_test.ts` serves every resource kind,
404, 400 and a preflight from requests whose `signal` getter throws, and checks that the reader is given
no signal.
