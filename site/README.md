# webtessera-site

The website of webtessera, published to GitHub Pages at <https://diagnos-tech.github.io/webtessera/>.
It is a static [Astro](https://astro.build/) site generated from this repository while it builds, so
it cannot drift from the code: the guides and the examples' READMEs are rendered from their Markdown,
the API reference from the sources' doc comments, the compatibility evidence from the fixtures, tests
and workflows, and every checkpoint, tile, proof and receipt on the home page is one the library
produced during the build. The only script is the live demo's, loaded when it nears the viewport; every
page reads completely without it.

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
page to the length budget of the design brief, checks the facts it shows against the repository, and
runs the live demo.

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
| `/` | `package.json` (the description), `README.md` (the install command, the runtimes sentence and the tested regions it embeds, read from `src/README_test.ts`), and two logs created while the site builds (`src/data/sample-log.ts`, `src/data/receipt-log.ts`): the checkpoint, the leaf hashes, the tile, the inclusion proof, the public key and a receipt returned by `webtessera/server` and checked with `verifyReceipt`; the evidence paragraph counts the fixtures, backends and differential records |
| `/docs/` | the safe API's environment table in `docs/guides/safe-api.md`, the tested regions, and the guides' order and descriptions in `docs/guides/README.md` |
| `/docs/<guide>/` | each `docs/guides/*.md`, rendered, with links to guides and examples turned into site links and links to other files into GitHub links at the build's commit |
| `/docs/concepts/` | hand-written, with a Merkle tree hashed by the library while the site builds |
| `/docs/reference/` and `/docs/reference/<entry>/` | the `exports` map, the package table in `docs/guides/ported-api.md`, and the TypeScript compiler's view of each entry point: its exports, their kinds and the first sentence of their doc comments, and the `Ported from` headers |
| `/examples/` and `/examples/<name>/` | each `examples/*/README.md` and `package.json` (description, and runtimes from the scripts), in the order of `docs/guides/README.md` |
| `/compatibility/` | `fixtures/data`, the test files that run the golden suite, `scripts/interop/backends.mjs`, `scripts/test-parity-allowlist.json`, `docs/PORTING-MAP.md`, `docs/decisions/`, `.github/workflows/*.yml`, and two sections of `docs/compatibility.md` |
| `/security/` | the "What it will not let you do" lists of `src/server/index.ts` and `src/browser/index.ts`, the decision records that cite a security review, `CHANGELOG.md`'s security list and `SECURITY.md`'s reporting section |
| `/og/*.png` | every page's title and description, drawn over the wordmark and the build's checkpoint |

Hand-written: the headline and the sentences around the generated facts, the five steps, the concepts
page, the docs front page's linking sentences, and the page titles and descriptions in
`src/lib/pages.ts`. An extractor that finds a heading, table or region missing fails the build with a
message naming the file, instead of leaving part of a page empty.

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
    │                      the Markdown loader, page titles, the social image background
    ├── shared/            renderers of a checkpoint, a tile and a proof, used by the build and the demo
    ├── demo/              the live demo, plain TypeScript
    ├── layouts/           Base.astro (head, header, footer) and Doc.astro (every page but the home page)
    ├── components/        Seo, Figure, CodeSample, Demo
    ├── pages/             one file per route, robots.txt and the social images
    └── styles/            tokens.css, base.css, demo.css
```

The fonts are self-hosted, and the site makes no third-party request. Source Serif 4 is Google Fonts'
Latin subset, as packaged by `@fontsource-variable/source-serif-4` 5.3.0, unmodified. Go Mono is
`Go-Mono.ttf` from `golang.org/x/image` v0.46.0, subset and converted to WOFF2 with fontTools:

```sh
pyftsubset Go-Mono.ttf --flavor=woff2 --layout-features='*' --output-file=go-mono-latin.woff2 \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2010-2027,U+2030-203A,U+2190-2195,U+2212,U+2248,U+2260,U+2264-2265,U+2500-257F,U+25A0-25FF"
```

Their licences are in [`LICENSES/`](../LICENSES), and [`NOTICE`](../NOTICE) attributes them.
