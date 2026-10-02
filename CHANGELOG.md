# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below
1.0.0, minor releases may contain breaking changes; they are called out here.

## [Unreleased]

Initial public release.

webtessera is a faithful TypeScript port of
[Tessera](https://github.com/transparency-dev/tessera) (pinned at commit `4a6d9f9`), the tile-based
transparency log framework, for browsers and Cloudflare Workers / Durable Objects. File names,
declaration order, comments and error messages follow the Go source; every divergence is recorded in
an ADR under `docs/decisions/`, and every upstream file has a row in `docs/PORTING-MAP.md`.

### Added

- **The Tessera port**: the `api` and `api/layout` packages (tlog-tiles paths, tiles and entry
  bundles), the integration engine and queue (`storage/internal`), the append lifecycle (`Appender`,
  await, antispam), witnessing, migration, and the root-package entry types.
- **Package root and subpaths**: `webtessera` re-exports the names Tessera's root package exports
  (`newAppender`, `newEntry`, `newPublicationAwaiter`, `newWitnessGroupFromPolicy`, `newMigrationTarget`,
  `newCertificateTransparencyAppender` and the rest), and each Go sub-package has a subpath:
  `webtessera/api`, `/api/layout`, `/client`, `/fsck`, `/ctonly`, `/storage/objectstore`, `/storage/memory`,
  `/storage/indexeddb`, `/storage/durableobject` and `/testonly`.
- **`client`**: log-state tracking with consistency verification, an HTTP fetcher, proof building and
  entry streaming.
- **`fsck`**: log verification against a fetcher, with progress reporting.
- **Certificate Transparency**: the `ctonly` entry types and the CT-only lifecycle (RFC 6962
  leaf encoding on top of `cryptobyte`): `newCertificateTransparencyAppender`, and `withCTLayout` for
  both append and migration options.
- **Ports of Tessera's dependencies**, importable as subpaths: `merkle/rfc6962`, `merkle/compact`,
  `merkle/proof` (from `transparency-dev/merkle`), `note` (from `golang.org/x/mod/sumdb/note`),
  and `formats/log` (from `transparency-dev/formats`).
- **Storage drivers for the web**: the `ObjectStore` contract (`webtessera/storage/objectstore`), a driver
  ported from Tessera's POSIX driver that runs on top of it (`newObjectStoreDriver`), and three backends:
  **memory** (`newMemoryDriver`), **IndexedDB** (`newIndexedDBDriver`: browser persistence with strict
  durability and cross-tab locking through Web Locks) and **Cloudflare Durable Objects**
  (`newDurableObjectDriver` and `DurableObjectObjectStore`, on KV- and SQLite-backed objects, with
  transparent chunking of objects larger than a storage value). One conformance suite holds every backend to
  the same behaviour, and `NamedLocks`, the in-process half of `ObjectStore.lock`, is exported so that a
  custom store can reuse it.
- **Test helpers**: `webtessera/testonly` provides `newTestLog`, a ready-made log on the memory driver with
  its own signing key, for testing code built on webtessera, as Tessera's `testonly` package does for Go.
- **Golden fixtures** (`fixtures/`): a Go generator that executes the real Tessera and records its
  output, and the committed JSON the TypeScript tests assert against byte for byte. `pnpm upstream`
  checks out the pinned Tessera source; `pnpm fixtures` regenerates the fixtures reproducibly.
- **Examples** (`examples/`): a browser demo (a log in IndexedDB, in a tab) and a deployable Cloudflare
  Worker that appends over HTTP and serves the tlog-tiles read API from a log in a Durable Object.
- **Documentation and project tooling**: contributor guide, `AGENTS.md` (the fidelity rules, also
  the guide for AI coding agents), ADRs, the porting map, a security policy, CI for Node 20/22/24,
  real Chromium and workerd. The README's code snippets run as tests, and a check fails if `README.md`
  drifts from them.

### Not included

These upstream parts are not part of the port. Where a decision is recorded, the ADR is cited.

- OpenTelemetry tracing and klog logging (ADR-0051, ADR-0061, ADR-0070, ADR-0080).
- `FileFetcher`, which reads a POSIX filesystem (ADR-0064).
- The `fsck` command-line tool and terminal UI (ADR-0093).
- Tessera's GCP, AWS and MySQL storage drivers, its filesystem-backed POSIX driver as such (the web
  driver reuses its engine over an `ObjectStore`), and its other `cmd/` binaries, load generator and
  integration suite. ADR-0001's register tracks the status of each, and ADR-0141 proposes a disposition for
  every one.
- Persistent antispam indexes (Badger, MySQL, Spanner). The in-memory antispam is included, and the
  `Antispam` interface accepts an implementation supplied from outside (ADR-0141, proposed).

### Licensing

The package is Apache-2.0. Files derived from Go sources (`sumdb/note`, `cryptobyte`,
`container/list`, the `base64` decoder) are BSD-3-Clause; their licence text is in `LICENSES/` and
the attributions are in `NOTICE`.

[Unreleased]: https://github.com/diagnos-tech/webtessera/commits/main
