# ADR-0185: Witness URLs must use https, or http to a loopback host

- **Status:** proposed
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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
