# ADR-0197: Requests omit credentials; witness requests do not follow redirects

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
- **Upstream reference:** `client/fetcher.go` (`HTTPFetcher.fetch`, `NewHTTPFetcher`), `internal/witness/witness.go` (`witness.update`)

## Context

Go's `http.Client` sends no ambient credentials and follows up to ten redirects. The Fetch API in a
browser attaches the page's cookies and HTTP authentication for the target's origin under the
default `credentials: "same-origin"` (and for any origin with `"include"`), and follows redirects.
A log fetcher or witness client running in a page should not carry the page's credentials, and a
server-side caller fetching from addresses it was given should be able to decide whether a
redirect may take a request somewhere else.

## Decision

As hardening:

- Every request the library makes sets `credentials: "omit"`. The `Authorization` header that
  `setAuthorizationHeader` configures is still sent.
- `HTTPFetcher` keeps following redirects by default — logs are commonly served through CDNs — and
  `newHTTPFetcher` takes an optional third argument, `{ redirect }`, passed to every request. Its
  documentation notes that a server-side caller fetching logs named by untrusted input should
  consider `"manual"`.
- Witness POSTs use `redirect: "manual"` and fail with
  `witness at "<url>" replied with a redirect, which is not followed: <status>` on a 3xx response,
  or on the `opaqueredirect` response a browser returns. `"manual"` rather than `"error"`, because
  workerd rejects `"error"` (verified against workerd 1.20260815.1).

## Consequences

- `newHTTPFetcher(url, fetch, opts)` and `HTTPFetcherOptions` are added API with no Go counterpart.
- A witness behind a redirect must be configured with its final URL. Go would follow the
  redirect.
- workerd ignores `credentials`; the option matters in browsers.

## Alternatives considered

- **Leave the Fetch defaults.** Rejected: they differ from Go's in exactly the way that matters in
  a page.
- **Refuse redirects in `HTTPFetcher` too.** Rejected: it would break logs served through a CDN,
  which is a common deployment.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
