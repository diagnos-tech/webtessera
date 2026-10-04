# ADR-0241: Parse witness URLs as Go's `net/url` does, and refuse only what fetch cannot use

- **Status:** proposed
- **Date:** 2026-10-04
- **Author:** Gustavo Simões
- **Upstream reference:** `witness.go` (`NewWitnessGroupFromPolicy`'s `"witness"` case, `NewWitness`); Go 1.25.5
  `net/url/url.go` (`Parse`, `(*URL).JoinPath`, `(*URL).String`), `net/netip/netip.go` (`ParseAddr`), `path/path.go`
  (`Join`, `Clean`)

## Context

`NewWitnessGroupFromPolicy` reads each witness URL with `url.Parse`, wraps its error as
`invalid witness URL %q: %w`, and hands the `*url.URL` to `NewWitness`, which keeps
`witnessRoot.JoinPath("/add-checkpoint").String()` as the witness's endpoint:

```go
witnessURL, err := url.Parse(witnessURLStr)
if err != nil {
	return WitnessGroup{}, fmt.Errorf("invalid witness URL %q: %w", witnessURLStr, err)
}
w, err := NewWitness(vkey, witnessURL)
```

ADR-0078 reproduced the join with a scoped `path.Join` stand-in, and its 2026-10-02 update kept the URL as written and
used the platform parser (`URL.canParse`) to require "an absolute URL with a `//` authority". The final fidelity audit
measured what that did, on 30,000 generated `https://` URLs against Go:

| Outcome | Count |
| --- | --- |
| identical | 10,140 |
| differ only by percent-escaping (ADR-0216 `witness-url-escaping`) | 4,556 |
| Go accepts, the port rejected | 5,400 |
| both reject, different text | 7,019 |
| Go rejects, the port accepted (`%zz`, `https://ü@example.com/`) | 2,414 |
| both reject, same text | 471 |

The 5,400 were ports above 65535, IPv4-like numeric hosts, IPv6 zones, `[v1.x]`, empty hosts and hosts holding `<` or
`>`, all of which the WHATWG parser rejects and `url.Parse` accepts; and where both rejected, the port's single message
(`not an absolute URL with a "//" authority`) replaced `url.Parse`'s (`invalid port ":abc" after host`, `missing ']' in
host`, `net/url: invalid userinfo`, `invalid URL escape "%zz"`). None of this was recorded accurately.

The WHATWG parser cannot be made to agree with `url.Parse`: the two specify different grammars, normalisations and
escaping rules. Matching Go means transcribing `url.Parse`.

## Decision

1. **`src/internal/gostd/url.ts` transcribes the part of Go 1.25.5's `net/url` that witness.go uses**: `Parse` (with
   `getScheme`, `parseAuthority`, `parseHost`, `validOptionalPort`, `validUserinfo`, `unescape` and the control-character
   check), `(*URL).JoinPath` and `(*URL).String` (with `escape`, `shouldEscape`, `setPath`, `EscapedPath`,
   `validEncoded`, `setFragment`, `EscapedFragment`), the validation half of `netip.ParseAddr` that `parseHost` calls
   for a bracketed host, and `path.Join`/`path.Clean`. It works on byte strings, so every index, length and error slice
   is Go's, and errors quote bytes exactly as `%q` does (`strconv.quoteBytes`): `invalid URL escape "%z\xc3"` for a
   malformed escape cut inside `é`. `url.Error` is `URLError`, because `Error` is JavaScript's own class.
2. **Go 1.25.5's `parseHost` is the one transcribed**, including the fix for CVE-2025-47912 (Go 1.24.8 and 1.25.2):
   brackets are accepted only around an IPv6 address, and `[1.2.3.4]`, `[v1.x]` and `a[b]` are rejected
   (`invalid IP-literal`, `invalid host: ParseAddr("v1.x"): unexpected character (at "v1.x")`). Every other function
   transcribed is byte-identical between Go 1.24.7 and 1.25.5. CI generates the fixtures with the latest Go 1.24
   release, which has the fix; a local Go 1.24.7 does not, so the corpora contain no bracketed host whose verdict the
   fix changed, and `url_test.ts`'s cases for them carry Go 1.25.5's results.
3. **`newWitnessGroupFromPolicy` and `newWitness` use it.** A policy URL gets `url.Parse`'s verdict and error text, and
   an accepted one gets Go's endpoint, byte for byte, escaping included. `newWitness`, whose signature takes the
   platform `URL` type, reads `witnessRoot.href` with `url.parse`; an `href` Go's parser rejects (one holding a
   malformed percent-escape, which WHATWG keeps) throws Go's error.
4. **The endpoint is then refused only where fetch cannot use it as Go's HTTP client would.** These checks run in
   `newWitness`, after the join, and are wrapped by the policy parser as `invalid witness config "<line>": ...`, where Go
   wraps `NewWitness`'s errors:
   - **Scheme (ADR-0185).** Unless Go's scheme is `https`, or `http` with a loopback host as the platform parser reads
     it: `witness URL "<endpoint>" must use https (http is accepted only for a loopback host)`. A relative reference
     such as `not-a-url`, which Go accepts and whose endpoint is `not-a-url/add-checkpoint`, now gets this message
     instead of ADR-0078's.
   - **No host.** An `https` or `http` URL without a host in Go's reading (`https:///x`, the opaque `https:example.com`):
     `witness URL "<endpoint>" has no host`. Go's HTTP client refuses to send such a request ("http: no Host in request
     URL"); the platform parser reads `https:///x/add-checkpoint` as host `x` and `https:example.com` as
     `https://example.com/`, so fetch would send it somewhere Go never would.
   - **Rejected by the platform parser.** An endpoint `URL.canParse` rejects (a port above 65535, an IPv6 zone such as
     `[fe80::1%25eth0]`, an IPv4-like host such as `256.1.1.1` or `999999999999`, a host holding `<`, `>` or an empty
     name before its port): `witness URL "<endpoint>" is rejected by the platform URL parser, which fetch uses`. fetch
     cannot send these at all; refusing them when the policy is loaded follows ADR-0185's reasoning that a
     misconfiguration should fail then, not on every publication. The message names no platform error, so it is the
     same in Node, Chromium and workerd.
5. **What is accepted and fails later, or reads differently.**
   - A URL with userinfo (`https://user:pw@example.com/`) is accepted, as in Go, with Go's endpoint. Node's and
     browsers' fetch refuse to send a request to such a URL, so each post fails with
     `failed to post to witness at "<endpoint>": <the runtime's TypeError>` (Node: "Request cannot be constructed from
     a URL that includes credentials"); Go's client sends the userinfo as HTTP Basic authentication.
   - An IPv4 address in a form the platform parser normalises (`0x7f.1`, `127.1`) is accepted, as in Go, and fetch
     connects to the address the platform reads (`127.0.0.1`), where Go hands the name to its resolver. The loopback
     test of ADR-0185 reads the platform's form too, so `http://127.1/` counts as loopback.
6. **ADR-0216's allow-list:** `witness-url-absolute` and `witness-url-escaping` are retired, because the port no longer
   shows either behaviour; `witness-url-https` now cites this ADR as well; `witness-url-fetchable` is added for the two
   refusals of item 4 that are not about the scheme.

## Consequences

- On the audit's 30,000 URLs, against Go 1.25.5: 14,667 accepted with identical endpoints, 10,425 rejected with
  identical text, 4,774 refused by the platform-parser check and 134 by the no-host check; nothing else differs. On
  the audit's 100,000 structured policies, every verdict, tree and endpoint is identical. `newWitness` equals
  `NewWitness(url.Parse(href))` on all 20,000 hrefs of the audit. `url.ts` itself equals Go 1.25.5's `Parse`, `String`,
  `JoinPath` and `Host` on 60,000 generated URLs, bracketed hosts included.
- `fixtures/data/differential_gostd.json` gains a `url` section (url.Parse, String, JoinPath, Host and Scheme over
  3,000 generated URLs and the stable bracketed forms), replayed in Node, Chromium and workerd; the witness-policy
  corpus gains the URL classes above. The differential harness applies `witness-url-fetchable` only to those messages.
- `url.ts` is about 1,300 lines, most of them Go's own comments, to keep in step with Go. It has one caller, the policy parser; nothing
  else in the port parses URLs Go's way, and nothing should start to without reading this ADR.
- The endpoint a policy produces is now Go's to the byte, so a log configured from the same policy file as a Go log
  posts to the same URLs, percent-encoding included.

## Alternatives considered

- **Keep the platform parser and record its verdicts in ADR-0078.** Rejected: it would leave 5,400 of 30,000 URLs with a
  different verdict, 7,019 with a different error, and every non-ASCII URL with a different endpoint, all for a parser
  that is not the specification of this code.
- **Accept everything `url.Parse` accepts and let fetch fail at publication.** Rejected for the no-host case, where
  fetch does not fail but posts to a different host, and for the platform-parser case, where every publication would
  fail with a runtime-specific message that ADR-0185 already decided should be a load-time error. Kept for userinfo,
  whose URL is valid to every parser and whose failure is a fetch policy, so Go's verdict is kept.
- **Transcribe Go 1.24.7's `parseHost`** (the fixture generator's local toolchain), which accepts any bracketed host.
  Rejected: CI's Go 1.24 release and every Go 1.25 release have the security fix, and accepting `[1.2.3.4]` only to have
  the platform parser refuse it later gains nothing.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
