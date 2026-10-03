# ADR-0213: rqlite and S3 requests omit credentials and refuse redirects; rqlite reads only at linearizable or strong

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Claude (security-review fixes)
- **Upstream reference:** n/a (neither adapter has an upstream counterpart); extends ADR-0197 to the
  rqlite adapter (ADR-0150) and the S3 sink (ADR-0175)

## Context

ADR-0197 settled what requests the library makes: no ambient credentials (`credentials: "omit"`), and no
redirects followed where a redirect could carry the request somewhere the caller did not choose
(`redirect: "manual"`, with the 3xx refused, since workerd rejects `"error"`). Two request paths did not
follow it:

- `fromRqlite` sent its statements with the Fetch defaults: a page's cookies for the node's origin, and
  redirects followed, resending the caller's `Authorization` header (rqlite's basic auth) wherever a
  redirect pointed.
- `newS3Sink` refused redirects but sent ambient credentials.

`fromRqlite` also interpolated its `level` option into the query string unchecked. The type admits only
`"linearizable"` and `"strong"`, but a JavaScript caller, or a value read from configuration, could pass
`"none"` or `"weak"` (a stale read of the tree state during a leadership change assigns an index twice,
which is why the type excludes them), or a string that adds query parameters.

## Decision

- `fromRqlite` sends every request with `credentials: "omit"` and `redirect: "manual"`, and fails on a
  redirect (`rqlite: <url> replied with a redirect, which is not followed: <status>`, for a 3xx or a
  browser's `opaqueredirect`). rqlite forwards requests to its leader itself and redirects only when the
  client asks it to (`?redirect`), so a redirect means something between the client and the cluster is
  sending the request elsewhere. A new option, `followRedirects: true`, is the opt-in for a deployment that
  redirects on purpose; requests then use `redirect: "follow"`, still without ambient credentials.
- `fromRqlite` throws a `RangeError` at construction unless `level` is `"linearizable"` or `"strong"`, and
  URL-encodes it.
- `newS3Sink` adds `credentials: "omit"` to its requests, which already used `redirect: "manual"`.

Both were checked in workerd (compatibility date 2026-08-01): the tests route the adapters' requests
through the test Worker's own `fetch` handler, so workerd parses every request's options. workerd accepts
`credentials: "omit"` (it ignores the option, as ADR-0197 found) and `redirect: "manual"` and `"follow"`,
and refuses `"error"` (`Invalid redirect value, must be one of "follow" or "manual"`), which the test was
checked to catch.

## Consequences

- An rqlite cluster reached through a redirecting proxy must be given the final URL, or
  `followRedirects: true`.
- `RqliteOptions.followRedirects` is added API.
- A caller passing a weaker read level gets an error at construction instead of a silently unsafe store.

## Alternatives considered

- **Follow redirects by default, as `HTTPFetcher` does.** `HTTPFetcher` reads public, verifiable resources
  through CDNs; rqlite requests carry credentials and writes, and rqlite does not redirect unless asked.
- **Strip the `Authorization` header on redirect instead of refusing.** The Fetch API gives no hook for it,
  and the request body would still go to the new location.
- **Accept any level and document the risk.** The type already says the weaker levels are unsafe; a
  runtime check is what makes that true for JavaScript callers and configuration values.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
