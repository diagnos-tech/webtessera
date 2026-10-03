# ADR-0212: Take only origin-form request-targets, validate every numeric limit, and keep 500 bodies generic

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Gustavo Simões (security-review fixes)
- **Upstream reference:** `cmd/conformance/{posix,gcp,aws}/main.go` (`POST /add`: `http.Error(w, err.Error(),
  http.StatusInternalServerError)`); amends ADR-0170, ADR-0171 and ADR-0175

## Context

The security review found three ways in which the HTTP surface of `webtessera/http`, the witness and the
mirror trusted input it should have checked:

1. `toNodeListener` built each Request with `new URL(req.url, origin)`. A request-target is not a URL
   reference: `GET //admin/witness/add-checkpoint` resolves to host `admin` and path
   `/witness/add-checkpoint`, so the handler routed a request for one path as another. The default origin
   also embedded the `Host` header unchecked, so a `Host` of `log.example/admin` moved every path under
   `/admin`.
2. Size caps and counts given as options were used as they came. `Number(process.env.UNSET)` is NaN, and
   `n > NaN` is false: `readEntryBody(request, NaN)` buffered a 5 MiB body although an entry can hold
   65,535 bytes; a NaN cap in `toNodeListener`, the witness or `newSourceFetch` capped nothing either, and
   a NaN `attempts` would have retried forever.
3. `addErrorResponse` answered 500 with the error's text, as upstream's personalities do. Storage and
   network errors name files, tables, keys and hosts (`sqlite: put "tile/0/000": disk I/O error at
   /var/lib/log.db`), which a public endpoint should not tell its clients.

## Decision

**Request-targets.** `toNodeListener` passes a request to the handler only when its request-target is in
origin form (RFC 9112 §3.2.1: it starts with `/`), and sets it as the URL's path and query rather than
resolving it: `//x/checkpoint` is the path `//x/checkpoint`. Absolute-form and authority-form targets, and
anything else, are answered with 400 without reaching the handler. `OPTIONS *`, the asterisk form RFC 9110
§9.3.7 defines for the server as a whole, is answered with 204 and no body, since no handler routes `*`.
The default origin is built from the `Host` header only if it is a bare authority (no path, query,
fragment or user information), and a request with any other `Host` gets 400; an `origin` option that is not
a bare scheme and authority throws a `TypeError` at construction.

**Numeric limits.** Every cap, limit and count an option sets is checked once, where it is given, and must
be a positive safe integer; anything else throws a `RangeError` naming the option:

| Where | Options |
| --- | --- |
| `webtessera/http` | `readEntryBody(request, maxBytes)` (rejects), `toNodeListener`'s `maxBodyBytes`, the internal `readBodyCapped` |
| `webtessera/witness` | `maxBodyBytes`, in `newWitnessServer` and its handler |
| `webtessera/mirror` | `newS3Sink`'s `attempts` and `maxObjectBytes`, `newSourceFetch`'s `maxBytes`, `newVerifiedMirror`'s `numWorkers`, and the internal `retry`'s `attempts` (its delays must be finite and non-negative) |
| `webtessera/storage/sqlite` | `maxChunkBytes` (already checked), and the lease's `ttlMs`, `renewIntervalMs` and `maxPollIntervalMs`, now whole milliseconds (`renewIntervalMs` defaults to `floor(ttlMs / 3)`) |

CORS's `maxAgeSeconds` must be a non-negative safe integer: zero is meaningful there, asking browsers not
to cache preflights. The shared check is `positiveInteger` in `src/http/handler.ts`, internal like the
other helpers the three modules share.

**500 bodies.** `addErrorResponse(err, options?)` answers 500 with `internal server error` by default, and
with the error's text only when `options.detail` is true (the new, exported `AddErrorResponseOptions`).
The 503 for `ErrPushback` is unchanged. The function's documentation shows logging the error on the
server. The documentation of `newLogHandler`, `LogResourceReader` and the module now says that the
handler trusts its reader: over an `HTTPFetcher` it re-serves a remote log unverified, full tiles and
bundles cached as immutable for a year, and the way to re-serve a log one does not operate is to copy it
with `newVerifiedMirror` and serve the copy.

## Consequences

- A client that sends absolute-form requests to an origin server (RFC 9112 §3.2.2 says servers MUST accept
  them, though clients send them only to proxies) gets 400 from `toNodeListener`. Behind a reverse proxy,
  or from any ordinary client, requests are in origin form.
- Code that passed a NaN, zero, fractional or infinite limit now fails at construction instead of running
  without a limit; code that passed `Number(undefinedEnvVar)` learns about it.
- `POST /add` answers no longer match upstream's byte for byte on 500; the status is the same, and
  `{ detail: true }` restores the text. Upstream's hammer treats every 5xx alike.
- `AddErrorResponseOptions` is added API.

## Alternatives considered

- **Accept absolute-form by taking its path and query.** RFC-conformant, but the review asked for 400, and
  no handler needs it; it can be added later without breaking anyone.
- **Clamp bad limits to the default instead of throwing.** Hides the misconfiguration that produced them.
- **Validate on every use instead of at construction.** Reports the mistake on the first request instead of
  at start-up; `readEntryBody` and `readBodyCapped`, which take the cap per call, are the exceptions.
- **Keep upstream's 500 text by default and offer an opt-out.** Fidelity to the personalities' answer is not
  worth leaking server internals by default; `addErrorResponse` is a convenience, not a port.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
