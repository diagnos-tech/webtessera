# ADR-0185: Witness URLs must use https, or http to a loopback host

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `witness.go` (`NewWitness`, `NewWitnessGroupFromPolicy`), `internal/witness/witness.go` (`witness.update`)

## Context

`NewWitness` accepts any URL as a witness root and the witness gateway posts checkpoints to
`<root>/add-checkpoint`. Upstream puts no constraint on the scheme, so a policy file or a caller
can name a plain-http witness on another host, or a scheme that `fetch` interprets in its own way.
The cosignature that comes back is verified, but the request itself, the checkpoint it carries,
and the response's status and headers travel unauthenticated.

## Decision

As hardening, `newWitness` (and so `newWitnessGroupFromPolicy`, which calls it) throws unless the
witness URL, as the platform URL parser reads it, is

- `https:`, or
- `http:` with a loopback host: `localhost`, an address in `127.0.0.0/8`, or `[::1]`.

The check reads the final `.../add-checkpoint` URL with the platform `URL` parser, because that is
the parser `fetch` uses: what is checked is where requests go, not an independent reading of the
string. The error is
`witness URL "<url>" must use https (http is accepted only for a loopback host)`, wrapped by
`newWitnessGroupFromPolicy` as `invalid witness config "<line>": ...`, where Go wraps errors from
`NewWitness`.

## Consequences

- Witnesses reachable only over plain http on a non-loopback host cannot be configured. Go accepts
  them; this is a deliberate divergence.
- Local development and tests keep working against `http://localhost`, `http://127.0.0.1` and
  `http://[::1]`.
- Hosts that resolve to loopback by name, other than `localhost` itself, are not treated as
  loopback; the check never resolves names.

## Alternatives considered

- **Keep Go's behaviour.** Rejected for the reasons above.
- **Allow http for private address ranges as well.** Rejected: whether a private range is trusted
  is a property of a deployment's network, which this library cannot see.
- **Check the scheme in the witness gateway, at request time.** Rejected: a misconfiguration
  should fail when the policy is loaded, not on every publication.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `NewWitness`/`NewWitnessGroupFromPolicy` (`witness.go`) and `witness.update` put no constraint on the scheme.
  - TS side: `checkWitnessURL` (`witness.ts`) rejects anything but `https`, or `http` whose host the platform parser reads as `localhost`, `127.0.0.0/8` or `[::1]`, with `witness URL "<url>" must use https (http is accepted only for a loopback host)`, wrapped as `invalid witness config "<line>": ...` by the policy parser. Probed: userinfo tricks (`http://127.0.0.1@evil.example/`), `127.0.0.1.evil.example`, `localhost.` and an IPv4-mapped IPv6 literal are rejected; `127.1`, `0x7f.1`, `LOCALHOST` and `[0:0:0:0:0:0:0:1]` are accepted because the platform parser normalises them to loopback, which is the stated rule ('where requests go').
  - Tests: `witness_policy_test.ts` and `witness_test.ts` cover the accepted and rejected forms and the message.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.

## Update (2026-10-04)

[ADR-0241](0241-witness-policy-urls-parsed-as-go-parses-them.md) now parses witness URLs with a transcription of Go's
`url.Parse`, so the endpoint this check sees is Go's. The scheme is read from Go's parse (`https`, or `http` with a
loopback host as the platform parser reads it); the rule and its message are unchanged. A relative reference, which Go
accepts and ADR-0078 used to reject with its own message, now gets this ADR's message, since its endpoint has no
scheme. ADR-0241 adds two refusals beside this one, with their own messages: an endpoint with no host in Go's reading,
and one the platform URL parser rejects. The previous fallback, `witness URL "<url>" is not a valid URL: <platform
message>`, whose text differed between runtimes, is gone.

**Review of this update** — Reviewer: ADR review agent (independent), 2026-10-04. Verdict: approved.

- Checked against the code after ADR-0241: a relative reference (`//example.com`, `example.com/x`) now gets this ADR's message; `has no host` and `rejected by the platform URL parser` are separate refusals with their own messages; the old `is not a valid URL: <platform message>` fallback is gone from `witness.ts`. The rule and the message are unchanged, as the Update says.
