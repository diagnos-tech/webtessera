# ADR-0101: Leave superseded partial tiles in place instead of relinking them

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`writeTile`, `garbageCollect`), `internal/fetcher/fallback.go`

## Context

When the POSIX driver writes a full tile, it replaces every partial version of that tile with a symlink to
the full one:

```go
if partial == 0 {
	partials, err := filepath.Glob(fmt.Sprintf("%s.p/*", tPath))
	...
	// Clean up old partial tiles by symlinking them to the new full tile.
	for _, p := range partials {
		// We have to do a little dance here to get POSIX atomicity:
		// 1. Create a new temporary symlink to the full tile
		// 2. Rename the temporary symlink over the top of the old partial tile
		tmp := fmt.Sprintf("%s.link", tPath)
		...
		if err := os.Symlink(tPath, tmp); err != nil { ... }
		if err := os.Rename(tmp, p); err != nil { ... }
	}
}
```

After this, a request for `tile/0/000.p/7` is answered with the full tile: 256 hashes where 7 were asked for.
Entry bundles are not relinked; their superseded partials stay until garbage collection. Garbage collection
later removes the whole `<resource>.p/` directory, symlinks and all, for every full bundle and tile below the
published tree size.

An `ObjectStore` has no symlinks. It also has no listing operation, so the driver cannot even find out which
partial versions of a tile exist (there can be up to 255) without probing each possible key.

## Decision

`writeTile` writes the tile and does nothing else. Superseded partial tiles are left as they are, exactly as
the POSIX driver already leaves superseded partial bundles, until `garbageCollect` removes their `.p/` prefix.
The port note on `writeTile` says so.

This is correct because:

- A partial tile is immutable: the partial tile of width `w` at a position is the same bytes for every tree
  size that implies it, and is a prefix of the full tile. The old partial is therefore still a correct
  response for every request that names it, as `tlog-tiles` requires.
- `LogReader.ReadTile`'s contract explicitly allows either answer for a partial width that the published tree
  size does not imply: "some may return a tile with 1 leaf, and some may return a tile with more leaves".
- Once garbage collection has removed a partial, a reader that still asks for it falls back to the full tile
  (`partialOrFullResource`), as it does against the POSIX driver after GC.
- `garbageCollect` removes the same `.p/` prefixes it removes in POSIX, so after GC the two drivers hold the
  same set of resources. `driver_fixtures_test.ts` checks this exactly: a log built in many small batches and
  then garbage collected holds the fixture's resources plus only the superseded partials in the partial
  directories of the final tree, which POSIX's GC keeps too.

## Consequences

- With garbage collection disabled, a store holds superseded partial tiles where a POSIX directory holds
  symlinks: at most 255 partial versions of each tile position, each under 8 KiB. Superseded partial bundles,
  which can be much larger, accumulate identically in both drivers. Garbage collection is on by default
  (`DefaultGarbageCollectionInterval`).
- A client asking for an old partial tile gets the partial tile rather than the full one. Both are valid; a
  client cannot distinguish the drivers except by response size.
- Relinking was the only place `files.go` needed to enumerate a directory, so dropping it keeps the
  `ObjectStore` contract free of a listing operation.

## Alternatives considered

- **Overwrite each partial with the full tile's bytes**, emulating the symlink's content. Rejected: without a
  listing operation it needs up to 255 `stat` calls per full tile, it multiplies storage instead of saving it,
  and it buys nothing a client can rely on.
- **Delete the partials as soon as the full tile is written.** Rejected: readers holding the still-published
  checkpoint, or HTTP clients that do not fall back to the full tile, would get 404s for resources that
  checkpoint implies. That is precisely what `garbageCollect`'s use of the *published* size protects against.
- **Add `list(prefix)` to the contract** to find partials to overwrite or delete. Rejected for the reasons
  above, and because every backend would have to implement it for this one call site.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - The decision checks out. `writeTile` in `driver.ts` only calls `createOverwrite`; `garbageCollect` removes the same
    `.p/` prefixes as `files.go`; the quoted `LogReader.ReadTile` text is verbatim at `lifecycle.go:41-43`;
    `partialOrFullResource` matches `internal/fetcher/fallback.go`; `testing/golden_fixtures.ts` derives its expected
    key set from the fixtures and the layout rules, not from the driver, and the golden suite passes with exactly the
    superseded partials the ADR describes, before and after GC.
  - **Factual error about upstream, which must be corrected.** The Context says that when POSIX writes a full tile it
    "replaces every partial version ... with a symlink", so that "a request for `tile/0/000.p/7` is answered with the full
    tile". At 4a6d9f9 that only happens when the process's working directory is the log root: `writeTile` builds
    `tPath := layout.TilePath(...)`, which is relative to the log root, and passes it unjoined to
    `filepath.Glob(tPath + ".p/*")` and `os.Symlink(tPath, tmp)` (only `createOverwrite` joins `cfg.Path`). I ran the real
    POSIX driver (a probe module replacing tessera with `.upstream/tessera`) for batches ending at 1, 255, 256 and 300
    entries. With the working directory outside the log: `tile/0/000.p/1` (32 bytes) and `tile/0/000.p/255` (8160 bytes)
    stay regular files with their partial contents, the same set of files this driver leaves. With the working directory
    equal to the log root: they become symlinks to `tile/0/000`, resolved relative to the link's own directory, so they
    dangle and readers fall back to the full tile. ADR-0162 records the same finding ("ADR-0101's description of what
    POSIX does on disk should be read with it").
  - What must change: add an Update, or amend the Context and Consequences, saying so. Specifically the Context sentence
    quoted above, the first two Consequences bullets ("where a POSIX directory holds symlinks"; "a client cannot
    distinguish the drivers except by response size"), and the premise of the first alternative ("emulating the symlink's
    content"). In a normal deployment both drivers hold identical partial files, which strengthens the decision. I would
    approve once the record says what POSIX actually does.

## Update (2026-10-04): what POSIX actually leaves on disk

This answers the Review above. The decision stands, on firmer ground.

- **Context.** At 4a6d9f9, `writeTile` passes the log-root-relative `tPath` (`layout.TilePath(...)`) unjoined to
  `filepath.Glob(tPath + ".p/*")` and to `os.Symlink(tPath, tmp)`. Only `createOverwrite` joins it with
  `cfg.Path`. So the relinking described above happens only when the process's working directory is the log root.
  Both the reviewer and ADR-0162's interop harness reproduced it with the real POSIX driver, for batches ending at
  1, 255, 256 and 300 entries.
  - In a normal deployment, with the working directory outside the log, the glob finds nothing. `tile/0/000.p/1`
    (32 bytes) and `tile/0/000.p/255` (8160 bytes) stay regular files with their partial contents.
  - With the working directory at the log root, they become symlinks to `tile/0/000`. That target resolves
    relative to the link's own directory, so the links dangle, and readers fall back to the full tile.

  So the sentence "a request for `tile/0/000.p/7` is answered with the full tile" holds only in that second case.
- **Consequences.**
  - The first bullet's "where a POSIX directory holds symlinks" should read: where a POSIX directory holds the same
    superseded partial files, in a normal deployment. With garbage collection off, both drivers then keep the same
    files.
  - The second bullet's "a client cannot distinguish the drivers except by response size" applies only against a
    POSIX log run from its own root. Otherwise the responses are identical.
- **First alternative.** Its premise, "emulating the symlink's content", describes the rare case. In the normal
  case there is no symlink content to emulate, which is one more reason to reject it.

ADR-0162 records the same finding from the interop side.
