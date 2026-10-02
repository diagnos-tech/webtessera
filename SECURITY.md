# Security policy

webtessera verifies and produces the data structures that transparency logs rely on: signed
checkpoints, Merkle proofs and tiles. A bug here can make a client trust a log that it should not,
so security reports are taken seriously and handled privately.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub Security Advisories:

1. Go to <https://github.com/diagnos-tech/webtessera/security/advisories/new> (the repository's
   **Security** tab, then **Report a vulnerability**).
2. Describe the problem and how to reproduce it. A failing test or a minimal script is the most
   useful thing you can attach. For a divergence from Tessera, include the Go behaviour and the
   pinned upstream commit you compared against (`scripts/upstream.json`).
3. Say whether you intend to disclose publicly, and by when.

We aim to acknowledge a report within five working days, to tell you whether we consider it a
vulnerability within ten, and to keep you informed until a fix is released. Fixes are developed in a
private advisory fork where possible, released with an advisory and a `CHANGELOG.md` entry, and
credited to the reporter unless you ask us not to.

## Supported versions

webtessera is pre-1.0. Security fixes are made on the latest released version and on `main`; older
0.x releases are not patched, so please upgrade.

## Scope

In scope: the code published as the `webtessera` npm package, i.e. everything under `src/` that is
not test-only, including the storage drivers.

A **behavioural divergence from Tessera that changes a verification outcome is a security bug**, even
if nothing is exploitable yet: accepting a note, proof, checkpoint or path that upstream rejects (or
the reverse) is exactly the class of defect this port exists to prevent.

The areas where a defect is most serious:

| Area | Where | Why it matters |
| --- | --- | --- |
| Note signatures | `src/vendor/note/`, `src/vendor/formats/note/` | Signature verification (Ed25519, RFC 8032 and cofactorless, as Go does: ADR-0025), key hashing, and rejection of malformed or ambiguous notes decide who a client trusts |
| Merkle proofs | `src/vendor/merkle/{rfc6962,compact,proof}/` | Inclusion and consistency verification, root computation, and the leaf/node hashing domain separation are what make a log append-only |
| Checkpoint parsing | `src/vendor/formats/log/`, `src/internal/parse/` | A lenient parser can accept a checkpoint that two verifiers read differently |
| Log-state tracking | `src/client/` | Enforces consistency between the checkpoints a client has seen |
| Witnessing | `src/witness.ts`, `src/internal/witness/` | Cosignature verification and policy satisfaction |
| Tile and path parsing | `src/api/`, `src/api/layout/` | Mis-parsed paths or tiles map one resource to another |
| Length-prefixed encoding | `src/internal/gostd/cryptobyte.ts`, `src/ctonly/` | Used to build and parse CT leaf data and signed material |
| Storage drivers | `src/storage/` | A lost write, a broken `create`-if-absent or a lock that does not exclude can corrupt or fork a log |
| 64-bit arithmetic | everywhere `uint64` appears (`bigint`) | Tree sizes and indices must never silently wrap or lose precision |

Out of scope:

- **Vulnerabilities in Tessera, `transparency-dev/merkle` or `transparency-dev/formats` themselves.**
  Report those to the upstream projects (see their security policies). If webtessera inherits the
  problem, tell us too.
- **Vulnerabilities in dependencies** (`@noble/hashes`, `@noble/curves`, build and test tooling).
  Report them to those projects. We update dependencies through Dependabot.
- **The examples** under `examples/`: they are demonstrations, not hardened applications.
- **The test keys** in `fixtures/` (hard-coded in `fixtures/gen/note.go` and the upstream `testdata/log`
  material). They are published on purpose and protect nothing.
- Problems that require a malicious dependency, a compromised build environment or a hostile
  JavaScript runtime.

If you are unsure whether something is in scope, report it privately anyway.

## For maintainers

Security fixes follow the same rules as any other change (see `PORTING.md`): a fix that departs from
Tessera's behaviour still needs an ADR, and a verification bug gets a regression test, with a golden
fixture where the behaviour is byte-level.
