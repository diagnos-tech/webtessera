## Summary

<!-- What changes, and why. One upstream file or one coherent change per pull request reads best. -->

Closes #

## Upstream reference

<!-- The Go files this ports or touches, at the pinned commit (see scripts/upstream.json),
     or "n/a" for web-only code (storage drivers, examples, tooling). -->

## Type of change

- [ ] Port of upstream code
- [ ] Bug fix
- [ ] Web storage driver / example
- [ ] Tooling, CI or documentation
- [ ] Breaking change to the public API

## Definition of done

<!-- Mirrors AGENTS.md §10. Tick what is true; leave the rest unticked and say why under "Not done". -->

- [ ] Every Go file in scope has a TS counterpart at the mirrored path, or an ADR says why not
- [ ] Every Go **test** file in scope has a TS counterpart with the same cases (ported first, seen failing, then made green)
- [ ] File names, identifier mapping and declaration order follow Go (AGENTS.md §3.1–§3.3); upstream comments are preserved
- [ ] Errors are thrown with Go's exact message text; `uint64` is `bigint`; Merkle code stays synchronous
- [ ] Golden fixtures cover everything byte-producing, and `bun run fixtures` leaves `git status --porcelain fixtures/data` empty
- [ ] `docs/PORTING-MAP.md` updated
- [ ] ADRs written for every divergence and every omission; none left unreviewed
- [ ] No `any`, `@ts-expect-error`, `.skip`, commented-out code or `console.log`
- [ ] No Node built-ins or `Buffer` in library code; no new runtime dependency without an ADR
- [ ] File headers follow AGENTS.md §9; `NOTICE` and `LICENSES/` updated if code from a new origin came in
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (user-visible changes only)

## Evidence

<!-- Paste the real output. Do not describe a test as passing unless you ran it. -->

```
bun run lint:
bun run typecheck:
bun run test:unit:
bun run test:browser / bun run test:workers (if src/storage/ or anything runtime-sensitive changed):
bun run fixtures (if the generator changed):
```

## Not done

<!-- State plainly what is incomplete, unverified or deferred. "Nothing" is fine if it is true. -->
