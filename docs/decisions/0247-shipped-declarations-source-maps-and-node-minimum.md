# ADR-0247: Ship declarations whose hovers explain and link, no source maps, and one Node.js minimum

- **Status:** accepted
- **Date:** 2026-10-07
- **Author:** Gustavo Simões (DX audit fixes)
- **Upstream reference:** tessera `api/layout/paths.go`, `api/layout/tile.go`, `fsck/status.go`,
  transparency-dev/merkle `rfc6962/rfc6962.go` (the doc comments converted below)

## Context

The fresh-eyes audit of the 0.1.0 tarball read the package as an editor shows it, and found:

- **23 of 220 exported values had no hover documentation:** `api/layout`'s paths and tile constants, fsck's status
  constants and the RFC 6962 prefixes. Their upstream doc comments had been ported verbatim, but as `//` comments,
  which TypeScript does not attach to a declaration.
- **28 hovers cited `docs/decisions/*.md` paths,** which do not exist in a consumer's project, and
  `server/index.d.ts` had lost its module documentation, which `browser/index.d.ts` kept.
- **258 source maps** (about 720 KB of the 2.28 MB unpacked) pointing at `../../src/*.ts`, which is not shipped,
  with no `sourcesContent`.
- **Three Node.js minimums** in different places: 22 (`engines`, the key-custody errors), 22.13 (node:sqlite
  without a flag) and 22.18 (the examples, which run `.ts` files directly).
- **The conformance suites were out of reach:** the README sends custom-store authors to
  `src/storage/objectstore/testing/`, which is neither shipped nor exported.

## Decision

**Doc comments.** The upstream comment above each of those 23 declarations is now a `/** … */` block with the
same text, line for line (a group comment, RFC 6962's "Domain separation prefixes", on each of its two constants).
Changing a comment's syntax and not its words is faithful (PORTING.md §3.4). A scan of every entry point's exported
values (the audit's, `ts.Symbol.getDocumentationComment` over `dist/`) now finds none undocumented, of 227.

**Links.** `scripts/link-decisions.mjs`, run by `bun run build` after `tsc`, rewrites each ADR path in
`dist/**/*.d.ts` (`docs/decisions/0003-uint64-as-bigint.md`, a bare `docs/decisions/0004`, which it resolves to its
file, and the directory) into its URL, `https://github.com/diagnos-tech/webtessera/blob/main/docs/decisions/…`. The
sources keep repository paths, as PORTING.md §3.4 asks; only shipped declarations change, and only comments. After
it, no hover cites a path without a URL (147 links in 52 files). `src/server/index.ts` now puts its runtime check
after its exports, so that its module documentation is attached to a statement that survives into `index.d.ts`;
evaluation order is unchanged, since every imported module is evaluated before the module body runs.

**No source maps.** `tsconfig.build.json` sets `sourceMap` and `declarationMap` to false. A map without its
sources can only point at files that are not there (debuggers show nothing, and Vite warns about each); carrying
the sources (`inlineSources`) would add the 1.2 MB of `src/` to every install to restore what the JavaScript
already shows: it is the TypeScript with its types erased (`erasableSyntaxOnly`), comments and line structure
kept, so a stack trace into `dist/` reads as the source does. The tarball goes from 523 files and 2.28 MB unpacked to
275 files and 1.63 MB (472 KB packed, by `npm pack`).

**Node.js 22.18.** `engines.node` is `>=22.18`, as the examples' already were, and the error that names the
runtimes WebCrypto Ed25519 needs says 22.18. It is the first 22.x that runs everything the documentation shows
without a flag: node:sqlite (22.13) and TypeScript files (`node app.ts`, 22.18). CI's Node 22 job runs the latest
22.x. `README.md` and the guides, being rewritten as this lands, need the same number (the lead has the text).

**Conformance suites stay in the repository.** They need Vitest and, for the golden suite, the generated fixtures
(megabytes of JSON); PORTING.md §7 keeps test tooling out of the published build and the exports map. A
`webtessera/testing` entry point would ship both and make Vitest a peer of every install. The documentation instead
tells custom-store authors to run them from a checkout (the lead has the text).

## Consequences

- Hovers in a consumer's editor explain every exported value, and every ADR they cite is a click away.
- `bun run build` needs Node on `PATH` for its second step, which PORTING.md §3.9 already requires.
- Debugging into the library steps through `dist/*.js`. Anyone who wants the TypeScript has the repository.
- Users of Node 22.0 to 22.17 get npm's engine warning (an error only with `engine-strict`). The library does not
  use anything newer than 22.0 itself; the minimum is what the documentation's examples need.

## Alternatives considered

- **Rewrite the citations in the sources to URLs.** Hundreds of `Port note:` comments, against PORTING.md §3.4's
  convention, and the path is the better reference inside the repository.
- **Ship `src/`, so maps and declaration maps resolve.** 1.2 MB more per install for "go to definition" into
  sources a reader can open on GitHub.
- **Keep `engines` at `>=22`** and say 22.18 for the examples only. That is the inconsistency the audit found.
- **Ship `webtessera/testing`.** See above.

Tests: the hover scan (the audit's `docscan.mjs`, run on `dist/`: 227 exported values, 0 undocumented, 0 ADR
paths without a URL); `bun run build` twice gives the same declarations; `scripts/smoke-pack.mjs` on the packed
tarball.

## Review

- **Reviewer:** DX reviewer (independent), 2026-10-07
- **Verdict:** approved
- **Notes:**
  - Compared the converted comments mechanically, removed `//` text against added `/** */` text per file. They are identical in `api/layout/paths.ts`, `api/layout/tile.ts` and `fsck/status.ts`. `rfc6962.ts` repeats Go's single group comment ("Domain separation prefixes", over the const block in merkle@v0.0.2 `rfc6962.go`) on both constants. The ADR says so, which makes it acceptable, but keeping it once, on the first constant, is closer to Go. The JSDoc still attaches across the `biome-ignore` line (checked `nWithSuffix` in `paths.d.ts`).
  - Built this tree into a scratch directory and ran `link-decisions.mjs` twice: 52 files, then 0, so the step is idempotent. No `docs/decisions` path is left without a URL, and every linked file exists. Pack: 275 files, 1.63 MB unpacked, no `.map` and no `*_test` files, as stated. The packed size is 471,798 bytes with `npm pack`, not 380 KB: name the tool behind the figure, or correct it.
  - Moving `assertServerRuntime()` to the end of `server/index.ts` keeps evaluation order. `>=22.18` is consistent across `engines`, README, the guides, `compatibility.md` and the `unsupported()` message.
  - Not verified: the `docscan.mjs` counts (227 values, none undocumented), since the script is not in the repository.
  - Re-review of a2bd7a2. The packed size is corrected to 472 KB by `npm pack`. The duplicated RFC 6962 group comment stays, as disclosed. No other change was needed.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
