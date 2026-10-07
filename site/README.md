# webtessera-site

The website of webtessera, published to GitHub Pages at <https://diagnos-tech.github.io/webtessera/>.
It is a static [Astro](https://astro.build/) site generated from this repository while it builds, so
it cannot drift from the code: the guides and the examples' READMEs are rendered from their Markdown,
the API reference from the sources' doc comments, the compatibility evidence from the fixtures, tests
and workflows, and every checkpoint, tile, proof and receipt it shows is one the library produced during
the build. The only script is the home page's: it copies the install command, and loads the live demo
when the demo nears the viewport. Every page reads completely without it.

## Commands

From the repository root:

```sh
bun install
bun run --cwd site dev        # dev server at http://localhost:4321/webtessera/
bun run --cwd site build      # builds the library, then the site into site/dist
bun run --cwd site preview    # serves site/dist at http://localhost:4173/webtessera/, as GitHub Pages does
bun run --cwd site typecheck  # astro check: the pages, the extractors, the demo and the scripts
bun run --cwd site smoke      # smoke-tests site/dist in Chromium (build first)
bun run --cwd site ci         # build + typecheck + smoke, as CI runs it
```

Astro runs on Node.js 22.12 or later. The smoke test drives Chromium through Playwright, a development
dependency of the workspace root; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a Chromium installed
elsewhere. It visits every page in the sitemap and every page a link reaches, and fails on a console
error, a failed or third-party request, a missing or duplicate title, description, canonical URL or
social image, invalid structured data, a skipped heading level, horizontal scrolling at 390 px, a broken
internal link or `#fragment`, or a link to a repository file that does not exist. It also holds the home
page to its length budget (a hero, the live demo and one section of code), checks the facts the pages
show against the repository, checks that the home page reads without JavaScript, and runs the live demo:
it appends an entry and verifies it, changes an entry and sees the change detected, undoes it, fills a
tile and starts over.

## Publishing

`.github/workflows/pages.yml` builds the site on every push to `main` (and on demand), runs the same
`ci` script, and deploys `site/dist` with GitHub's Pages actions. Pull requests run the `ci` script
through `ci.yml`, so a change that breaks the site fails its pull request.

**One-time setup**, by a repository admin: open **Settings → Pages**, and under **Build and deployment**
set **Source** to **GitHub Actions**. After the first deployment, submit
`https://diagnos-tech.github.io/webtessera/sitemap-index.xml` in Google Search Console: a project site's
`robots.txt` is not at the root of its host, where crawlers look for it.

The public URL defaults to the repository's Pages URL, derived from `repository` in the root
`package.json`. In CI it comes from `actions/configure-pages`, so a custom domain is picked up. To build
for another address, set `SITE_URL` (`SITE_URL=https://example.org/ bun run --cwd site build`): the base
path, canonical URLs, sitemap, `robots.txt`, social images and structured data follow it.

## Pages, and where they come from

| Page | Generated from |
| --- | --- |
| `/` | `package.json` (the description, the version and the licence), `README.md` (the install command, the runtimes sentence and the tested regions it embeds, read from `src/README_test.ts`), and a log created while the site builds (`src/data/sample-log.ts`), which the demo shows until the live log takes over: its newest entries with their leaf hashes, the checkpoint, the tile and the newest entry's inclusion proof; the links onward count the guides, the entry points, the examples, the fixtures, the backends and the differential records |
| `/docs/` | the safe API's environment table in `docs/guides/safe-api.md`, the tested regions, and the guides' order and descriptions in `docs/guides/README.md` |
| `/docs/<guide>/` | each `docs/guides/*.md`, rendered, with links to guides and examples turned into site links and links to other files into GitHub links at the build's commit |
| `/docs/concepts/` | hand-written, beside artefacts of two logs created while the site builds (`src/data/sample-log.ts`, `src/data/receipt-log.ts`): a leaf hash, the tile, the checkpoint, the public key, an inclusion proof and a receipt returned by `webtessera/server` and checked with `verifyReceipt`; and a Merkle tree hashed by the library |
| `/docs/reference/` and `/docs/reference/<entry>/` | the `exports` map, the package table in `docs/guides/ported-api.md`, and the TypeScript compiler's view of each entry point: its exports, their kinds and the first sentence of their doc comments, and the `Ported from` headers |
| `/examples/` and `/examples/<name>/` | each `examples/*/README.md` and `package.json` (description, and runtimes from the scripts), in the order of `docs/guides/README.md` |
| `/compatibility/` | `fixtures/data`, the test files that run the golden suite, `scripts/interop/backends.mjs`, `scripts/test-parity-allowlist.json`, `docs/PORTING-MAP.md`, `docs/decisions/`, `.github/workflows/*.yml`, and two sections of `docs/compatibility.md` |
| `/security/` | the "What it will not let you do" lists of `src/server/index.ts` and `src/browser/index.ts`, the decision records that cite a security review, `CHANGELOG.md`'s security list and `SECURITY.md`'s reporting section |
| `/og/*.png` | every page's title and description, drawn over the mark, the wordmark and the build's checkpoint |

Hand-written: the headline and the sentences around the generated facts, the demo's explanations, the
concepts page's prose, the docs front page's linking sentences, and the page titles and descriptions in
`src/lib/pages.ts`. An extractor that finds a heading, table or region missing fails the build with a
message naming the file, instead of leaving part of a page empty.

## The live demo

The demo on the home page is a real log: a webtessera appender on the memory driver, signed by a key
generated in the tab, and read back the way a client reads a log. Nothing is stored, and Reset starts a
new log under a new key. A visitor can append entries, and can change any listed entry. Changing one
does not touch the log, which is append-only: it changes what the page claims the entry is, as someone
who altered a stored entry would, and the claim is verified at once with the entry's real inclusion
proof against the signed checkpoint. The demo says "tampering detected" only when `verifyInclusion` has
thrown.

## How it is built

```
site/
├── astro.config.ts        site and base from SITE_URL or package.json, sitemap, trailing slashes
├── public/                favicon.svg, fonts/
├── scripts/serve.ts       serves dist/ under its base path, as GitHub Pages does
├── scripts/smoke.ts       the smoke test and the home page's length budget
└── src/
    ├── content.config.ts  the repository Markdown the site renders
    ├── data/              one extractor per source in the repository
    ├── lib/               getSiteData() (the extractors, run once per build), URLs and links,
    │                      the Markdown loader, page titles and section navigation, the code theme,
    │                      the social image background
    ├── shared/            renderers of a checkpoint, a tile, a proof and the demo's panels, used by
    │                      the build and the demo
    ├── demo/              the live demo, plain TypeScript
    ├── layouts/           Base.astro (head, header, footer) and Doc.astro (every page but the home page)
    ├── components/        Seo, Mark, GitHubMark, Figure, CodeSample, Demo
    ├── pages/             one file per route, robots.txt and the social images
    └── styles/            tokens.css (fonts, colours, sizes), base.css (type, layout, documents),
                           artefacts.css (tiles and proofs), demo.css, home.css
```

## Design

The page is a centred column under a header and above a footer that span the window; the root font size
grows a little with the window, so a wide screen gets a larger page rather than a wider margin. A
document has its section's pages on the left and its own contents on the right where there is room, and
after and inside the text where there is not. Colours are defined once, in `styles/tokens.css`: a light
and a dark set, chosen by the reader's system, and the Dracula palette for machine text (code blocks,
figures and the live demo), which keeps its dark surface in both schemes. Code is highlighted by Shiki's
Dracula theme, with the comment colour lifted to pass WCAG AA (`src/lib/code.ts`). Three colours carry
meaning: what verified, proof material, and tampering.

The fonts are self-hosted, and the site makes no third-party request. Inter and JetBrains Mono are
Google Fonts' Latin subsets, as packaged by `@fontsource-variable/inter` 5.3.0 and
`@fontsource-variable/jetbrains-mono` 5.3.0, unmodified. Go Mono draws the arrows, mathematical signs and
box drawing that the Latin subset of JetBrains Mono lacks (both are 0.6 em wide, so the examples' diagrams
keep their columns); it is `Go-Mono.ttf` from `golang.org/x/image` v0.46.0, subset and converted to WOFF2
with fontTools:

```sh
pyftsubset Go-Mono.ttf --flavor=woff2 --layout-features='*' --output-file=go-mono-latin.woff2 \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2010-2027,U+2030-203A,U+2190-2195,U+2212,U+2248,U+2260,U+2264-2265,U+2500-257F,U+25A0-25FF"
```

Their licences are in [`LICENSES/`](../LICENSES), and [`NOTICE`](../NOTICE) attributes them.
