# ADR-0170: Serve the tlog-tiles read API from any LogReader as a fetch-style handler

- **Status:** accepted
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

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - No Go original; compared with `cmd/conformance/mysql/main.go` (`configureTilesReadAPI`, whose comment the ADR quotes, answering parse failures with 400 "Malformed URL: ..."), the POSIX/GCP/AWS `POST /add` handlers (bare decimal index; `ErrPushback` gives 503 and `Retry-After: 1`; other errors 500 with the error text), and C2SP tlog-tiles (the editor's copy and what I fetched of it): checkpoint `text/plain; charset=utf-8` and short caching, tiles `application/octet-stream` and long-lived caching, canonical paths (`<L>` 0 to 63 and `<W>` 1 to 255 without extra leading zeroes, `<N>` as `x`-prefixed three-digit elements), no redirects.
  - Verified in code and tests: upstream's `ParseTileIndexPartial` really accepts `x000/001` (index 1) and `.p/08` (width 8), which `parseLogPath` rejects by re-formatting; the 96-character cap (the longest legal path is the 52-character entries path, so the cap is safe); storage is reached only with parsed numbers; 404 for `ErrNotExist`, 500 with no detail reported to `onError`, 405 with `Allow`, ETag as the first 16 bytes of SHA-256, weak `If-None-Match`, CORS opt-in, `trimToWidth` serving exactly W hashes or entries for a substituted full resource (`internal/fetcher/fallback.go` does substitute). `addResponse`, `addErrorResponse` and `readEntryBody` match the personalities' behaviour except for the 500 text, which ADR-0212 changes. A real log served through the handler and read back through the client and fsck passes in `log_handler_test.ts` and in Chromium.
  - Two inaccuracies in a code comment and an ADR header, neither a defect in the decision: (1) the Upstream reference cites `logCacheControl` from `storage/gcp` and `storage/aws`, whose value is `max-age=604800,immutable`; the handler's full-tile policy is `public, max-age=31536000, immutable` (the POSIX conformance server's value), and the ADR never says why a year rather than a week, nor that upstream's own drivers differ. It is a free choice allowed by the spec ("SHOULD be long-lived") and `DefaultCacheControl`'s comment "upstream's servers use" is only true of the POSIX one. (2) `resources.ts` says the longest resource path is the 47-character level-63 tile path and `resources_test.ts` asserts that as "the longest"; the entries path at the same index is 52. Neither affects behaviour.
  - Alternatives hold (a documented snippet, 404 for non-log paths, a framework dependency). Not verified: Deno behaviour (not installed), and gzip, which the ADR leaves to the runtime or CDN although tlog-tiles says entry bundles SHOULD be compressed at the HTTP layer; the ADR states that omission.
  - Status: proposed becomes accepted.

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

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. Verified against ADR-0212's code: `toNodeListener` takes origin-form targets as path and query (`//x/checkpoint` stays `//x/checkpoint`), answers 400 for other forms and for a `Host` that is not a bare authority, 204 for `OPTIONS *`; `positiveInteger` guards `maxBytes`, `maxBodyBytes` and CORS `maxAgeSeconds` (non-negative); `addErrorResponse` is generic unless `{ detail: true }`; the documentation warns about proxying a remote log. `node_test.ts` asserts each.*

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

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. The code never reads `request.signal` (`log_handler.ts`; the reader receives no signal; behind `toNodeListener` the `Request` is built without one). `log_handler_test.ts` serves every resource kind, a 404, a 400 and a preflight from requests whose `signal` getter throws and asserts the reader got `undefined` four times. I could not check the Deno 2.9.7 warning (Deno not installed); the reasoning about per-runtime semantics is plausible and the decision does not depend on it.*

## Update (2026-10-04)

- **Why one year.** The Upstream reference cites `logCacheControl` from `storage/gcp` and `storage/aws`, whose value
  is one week (`max-age=604800,immutable`). The handler's full-tile and bundle policy is one year
  (`public, max-age=31536000, immutable`), the value Tessera's POSIX conformance server sends. The spec asks only
  that the headers "SHOULD be long-lived". A full tile or bundle never changes, so the longer lifetime costs nothing
  and saves revalidations. The `DefaultCacheControl` comment in `resources.ts` no longer says that upstream's servers
  all use it, and it names both values.
- **The longest path.** The longest resource path is the 52-character partial entry bundle at the largest uint64
  index, `tile/entries/x018/…/615.p/255`. The 47-character level-63 tile path is shorter. The comment in
  `resources.ts` and the test, now "accepts the longest resource paths", say so. `MaxResourcePathLength` (96) covers
  both.
