# ADR-0245: Generate log keys for a secret store with `generateLogKeyPair`, and a `webtessera keygen` command

- **Status:** accepted
- **Date:** 2026-10-07
- **Author:** Gustavo Simões (DX audit fixes)
- **Upstream reference:** golang.org/x/mod `sumdb/note/note.go` (`GenerateKey`), as ported in
  `src/vendor/note/note.ts`

## Context

A server log's key lives in a secret store as a note signer key string, and `importLogKey(env.LOG_SKEY)` opens
it (ADR-0222). Making that string took the ported API: `generateKey(undefined, "example.com/log")` from
`webtessera/note`, whose `undefined` is Go's `rand io.Reader`. The safe API's `generateLogKey` makes a key that
never leaves the process, which is right for an ephemeral log and wrong for this. Every example therefore shipped
its own `scripts/keygen.ts`, and the audit called key generation "Go-shaped".

## Decision

**`generateLogKeyPair(origin)`** in `webtessera/server` returns `{ skey, vkey }`, the note-format signer and
verifier keys, made by the ported `generateKey` exactly as Go's `note.GenerateKey` makes them, from the runtime's
cryptographic random source. It checks the origin as every safe-API factory does (a signer key in its place is
`SIGNER_KEY_MISUSE`, ADR-0243), and refuses to run in a browser (`WRONG_ENVIRONMENT`, ADR-0221). Its TSDoc says
where it belongs: a deploy script or a one-off command, never request handling.

**`webtessera keygen <origin> [--prefix NAME] [--json]`**, an executable named by `package.json`'s `bin`:

```sh
npx webtessera keygen example.com/log >> .env     # npm
bunx webtessera keygen example.com/log            # Bun
deno run npm:webtessera keygen example.com/log    # Deno
```

It prints `LOG_SKEY=…` and `LOG_VKEY=…` on stdout (`NAME_SKEY`/`NAME_VKEY` with `--prefix`, or one JSON object
with `--json`), and what to do with them on stderr, so that redirecting stdout captures the key and nothing else.
A mistake in the arguments exits 2 with the usage; no output ever repeats a signer key given as the origin.

The command is two modules: `src/cli/cli.ts`, `run(args) → { code, stdout, stderr }`, which does everything and
is tested as a function; and `src/cli/webtessera.ts`, the executable (`#!/usr/bin/env node`), which passes it
`process.argv` and writes its result. The executable is the one shipped module that uses `process`, which Node,
Bun and Deno all give npm packages; it imports no Node built-in, and nothing imports it, so no browser or edge
bundle can contain it. It declares the part of `process` it uses (`declare const process`), so the shipped-code
lint passes with no exception in `biome.jsonc`; PORTING.md §7 names this file as the one exception to its rule.

The examples' `scripts/keygen.ts` (log-server, notary, edge) call `generateLogKeyPair`. The session-receipts
example's makes a witness key, which is not a log key, and keeps the ported calls.

## Consequences

- Getting started on a server is `npx webtessera keygen <origin> >> .env`, then `importLogKey(env.LOG_SKEY)`.
- PORTING.md §7's "no `process` in code under `src/` that ships" has one recorded exception, a file that only a
  server runtime ever runs. A maintainer who adds a second command adds it to `cli.ts`, not another executable.
- `package.json` gains `bin`. npm, Bun and Deno make the file executable when they install it; the tarball's file
  mode does not matter.

## Alternatives considered

- **Only `generateLogKeyPair`, no command.** Every example would still need a script to call it; a key is made
  from a terminal far more often than from code.
- **A `bin/webtessera.mjs` outside `src/`, hand-written.** It would escape the shipped-code lint rules by location
  rather than by a recorded exception, and would not be type-checked.
- **Make `generateLogKey` return the strings too.** It would make an exportable copy of a key whose point is that
  it has none.

Tests: `src/server/server_test.ts` ("generateLogKeyPair": the pair opens with `importLogKey` to the same vkey,
pairs differ, bad and signer-key origins refused); `src/cli/cli_test.ts` (output and prefixes, `--json`, every
usage error with status 2, a signer key as origin not repeated, and the executable run by Node);
`scripts/smoke-runtimes.mjs` runs the command's `run` function from the build on Node, Bun and Deno.

## Review

- **Reviewer:** DX reviewer (independent), 2026-10-07
- **Verdict:** approved
- **Notes:**
  - `generateLogKeyPair` checks the runtime and the origin, then calls the ported `generateKey`. `server_test.ts` and `cli_test.ts` pass. Built this tree and packed it outside the repository with `npm pack`. `dist/cli/webtessera.js` starts with `#!/usr/bin/env node` and has mode 0644 in the tarball, 0755 after `npm install <tgz>` (npm 10.9.4). `npx webtessera keygen example.com/log` writes only the two lines to stdout and exits 0; with no origin it exits 2. Bun runs it too. No `exports` entry reaches `src/cli`.
  - The `biome.jsonc` exclusion of `src/cli/webtessera.ts` is unnecessary and too broad. The file's own `declare const process` already satisfies `noProcessGlobal`: linting the file alone with `noProcessGlobal` and `noNodejsModules` on is clean, while a bare `process.argv` is flagged. The exclusion also turns off `noNodejsModules` and the `Buffer` ban for the file, which the ADR does not say ("excludes that one file from `noProcessGlobal`"). Remove `"!src/cli/webtessera.ts"`. The same `declare const` would let any shipped file use `process` past the lint, which is worth a sentence in PORTING.md §7.
  - "`scripts/smoke-runtimes.mjs` runs the built executable on Node, Bun and Deno" is not so: the script imports `run` from `dist/cli/cli.js` and calls it in-process, so the shebang and `process` on Deno are not exercised. Correct the sentence, or spawn the executable.
  - The CLI repeats an unknown command or option verbatim (see ADR-0243's review): use `quoteInput`.
  - PORTING.md: §7 lets an ADR record any exception, so this ADR is formally enough. PORTING.md is still the contract readers start from: its §2 tree should list `src/cli/`, and §7's "No `process`" should name this exception. The maintainers should make that edit; I have not changed PORTING.md.
  - Not verified: Deno (not installed), and pnpm or yarn setting the bin's mode.
  - Re-review of a2bd7a2. The `biome.jsonc` exclusion is removed, and `biome check src/cli` is clean. PORTING.md §2 lists `src/cli/`, and §7 names the exception and the `declare const process` caveat. The ADR text now says the file declares `process`, and that `smoke-runtimes.mjs` calls `run`. The CLI quotes an unknown command or option (probe; `cli_test.ts` passes). Deno remains unverified.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
