# ADR-0131: `HTTPFetcher` accommodates how `fetch` differs from `net/http`

- **Status:** proposed; superseded in part by [ADR-0195](0195-response-size-caps.md) (reading the body)
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `client/fetcher.go` (`NewHTTPFetcher`, `HTTPFetcher.fetch`, `ReadCheckpoint`, `ReadTile`, `ReadEntryBundle`)

## Context

`src/client/fetcher.ts` was marked "in progress". Diffing it against `client/fetcher.go`
(`HTTPFetcher` only; `FileFetcher` is intentionally absent, [ADR-0064](0064-filefetcher-not-ported.md))
shows the port was already faithful in structure. Every behaviour the Go code has on its own account is
present, with Go's message text:

| Go | TypeScript |
| --- | --- |
| `NewHTTPFetcher`: append `/` to the root path, nil client means `http.DefaultClient` | `newHTTPFetcher`: same, `fetch` is the default |
| `SetAuthorizationHeader`, sent as `Authorization` on every request | same; no header at all when unset |
| `rootURL.Parse(p)`: resolve the resource path against the root | `new URL(p, rootURL)` |
| `get(%q): %v` on a transport failure | same |
| `200` continues; `404` wraps `os.ErrNotExist` as `get(%q): %w`; anything else is `get(%q): %v` with the status | same, with `ErrNotExist` |
| `io.ReadAll(r.Body)` | `arrayBuffer()` |
| `ReadTile`/`ReadEntryBundle` go through `PartialOrFullResource`, `ReadCheckpoint` does not | same |

What the port does not reproduce, deliberately:

- `fmt.Errorf("invalid URL: %v")` and `NewRequestWithContext(%q)` failures. Every path comes from
  `api/layout`, whose output is always a valid relative reference, so neither can occur; `fetch` constructs
  its request inside the call, where a failure surfaces as the `get(%q)` transport error.
- The `User-Agent` that `net/http` adds. Browsers forbid scripts from setting it and fill in their own, so
  there is nothing to port.
- The `klog.Errorf` on a failing `Body.Close()`; there is no manual close step, and `klog` has no port
  ([ADR-0051](0051-storage-internal-drops-otel-and-klog.md)).

The diff also found two places where a literal translation misbehaves on the runtimes this package targets,
and neither shows up in Node, where the tests run.

**The receiver `fetch` is called with.** The port stored the function in a private field and called
`this.#c(url, init)`. A member call passes its object as `this`, so the global `fetch` was invoked with the
`HTTPFetcher` as its receiver. Browsers and workerd both throw `TypeError: Illegal invocation` when the
global `fetch` is called with any receiver other than the global object. Go's `h.c.Do(req)` has no such
constraint. Node's `fetch` ignores its receiver, which is why this was invisible: the default path
(`newHTTPFetcher(url)`) and any caller passing `fetch` itself would have failed in a browser or Worker on
the first request.

**The response body of a non-200 response.** In Go, `defer r.Body.Close()` is registered *after* the status
`switch`, so the `404` and unexpected-status paths return without closing the body. Go tolerates this
poorly but survives it. The Fetch API has no `Close`, and a response body that is neither read nor cancelled
keeps its connection occupied until it is garbage collected. workerd allows only a small, fixed number of
simultaneous open connections, and a `404` is the *normal* outcome of the partial-tile and partial-bundle
fallback in `partialOrFullResource`, so the leak is on the hot path.

## Decision

`HTTPFetcher.#fetch` calls the fetch function through a local, `const c = this.#c; await c(...)`, so it has
no receiver. This works for the global `fetch` and for any function a caller supplies.

On a `404` or any other non-200 status, the response body is cancelled before the error is thrown, by a small
module-private `discardBody`. The cancellation is not awaited and its failure is ignored: the status error
the caller is about to receive is the one that matters, and a slow or failing cancel must not delay it. A `200`
is unaffected, since `arrayBuffer()` consumes and releases the body.

`fetcher_test.ts` stays all port additions, since upstream has no `fetcher_test.go`. It gains cases for both
fixes (the receiver is `undefined`, the global `fetch` is used when none is given, error bodies are cancelled
and success bodies are read), for the signal reaching `fetch` and aborting a request in flight, for Go's exact
`get(%q)` message in each failure mode, and for the root URL being mutated as Go does: 14 new cases, taking
the file from 15 to 29 tests.

The file's header comment no longer cites `src/adapters/`: the rule is simply that library code must run
unmodified in browsers and edge runtimes.

## Consequences

- `client/fetcher.go` can be marked `done` in `docs/PORTING-MAP.md`: nothing in `HTTPFetcher` is missing,
  and the two divergences above are recorded here.
- These are divergences from Go's *incidental* behaviour, not from its contract. Callers observe the same
  results and the same error text; only resource handling differs, and only in the direction Go's own code
  clearly intended (the body is meant to be closed on every path).
- The `Illegal invocation` failure cannot be reproduced by a Node test with the real `fetch`, which ignores
  its receiver. It is pinned instead by a test asserting that the receiver is `undefined`, which is the
  property that matters. It has not been run in a real browser or workerd.

## Alternatives considered

- **Bind the default at construction, `fetch.bind(globalThis)`.** Rejected: it fixes only the default.
  A caller passing `fetch` directly, or any function with its own `this` expectations, would still hit
  the same failure, whereas calling through a local removes the receiver for all of them.
- **Await `r.body.cancel()`.** Rejected: it adds latency to every miss, and could hold the error back if a
  response's cancel were slow, to guard against a failure nobody can act on.
- **Drain the body with `await r.arrayBuffer()` instead of cancelling.** Rejected: it downloads whatever the
  server chose to send with an error, which can be large, only to throw it away.
- **Keep Go's behaviour exactly and leave the body unread.** Rejected: it is a defect on the hot path
  of the runtimes this package exists for, and Go's own code shows the intent to close on every path.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.

## Update (2026-10-04)

Three statements of the Context table needed correcting, found by the final fidelity audit against Go's `HTTPFetcher`
on the same requests:

- **`io.ReadAll(r.Body)` → `arrayBuffer()`** no longer holds: ADR-0195 replaced it with `readAllLimited`, which caps
  the body. This ADR is superseded in that part.
- **"`get(%q): %v` on a transport failure: same"** holds for the prefix only. `net/http` returns a `*url.Error`, whose
  text adds the method and URL before the cause, and `fetch` rejects with the cause alone:
  Go `get("http://logs.example/root/checkpoint"): Get "http://logs.example/root/checkpoint": net boom`, port
  `get("http://logs.example/root/checkpoint"): net boom`. The witness gateway's POST differs the same way
  (`... at "<url>": Post "<url>": ...` in Go). This is inherent to `fetch` and is not reproduced: the cause the port
  prints is the runtime's own, and its wording differs between runtimes anyway.
- **The root URL's path.** Go's `rootURL.Path += "/"` appends to the decoded path, and writing it back re-escapes it,
  which loses an escaped slash: a root `http://h/a%2Fb` requests `/a/b/checkpoint`, while the port, which appends to the
  URL as written, requests `/a%2Fb/checkpoint`. That is the one root form for which the two request different paths.
  Two others are spelled differently but request the same resources: `%7Efoo` is normalised to `~foo` only by Go, and
  `/./dot/../x` is resolved when the fetcher is built only by the port.
