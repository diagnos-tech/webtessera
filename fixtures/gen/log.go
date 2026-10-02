// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/api"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/storage/posix"
)

// logFixtureSizes are the log sizes built end to end. They straddle every
// boundary the tlog-tiles layout has below ~5000 entries: the empty log, the
// single-entry log, the last size before a full bottom tile, the first full
// tile, the first size that needs a second tile and a level-1 tile, and two
// sizes deep into multi-tile territory.
var logFixtureSizes = []uint64{0, 1, 2, 255, 256, 257, 1000, 5000}

type resourceFile struct {
	// Path is the tlog-tiles path relative to the log root, which is also the
	// URL path a client would fetch.
	Path string `json:"path"`
	// Raw is the file's exact bytes.
	Raw Hex `json:"raw"`
}

type tileFile struct {
	resourceFile
	Level U64 `json:"level"`
	Index U64 `json:"index"`
	// Partial is the width suffix parsed back out of the path, 0 for a full tile.
	Partial int `json:"partial"`
	// Nodes is the number of 32-byte hashes in the tile.
	Nodes int `json:"nodes"`
}

type bundleFile struct {
	resourceFile
	Index   U64 `json:"index"`
	Partial int `json:"partial"`
	// Entries is the number of entries the bundle decodes to.
	Entries int `json:"entries"`
}

type logFixture struct {
	header
	// Origin is the checkpoint origin, which is the signer's name.
	Origin string `json:"origin"`
	// LogVKey is the note verifier key the checkpoint is signed with. The
	// private half is in fixtures/gen/note.go.
	LogVKey string `json:"logVkey"`
	// EntryScheme documents the log's contents.
	EntryScheme string `json:"entryScheme"`
	Size        U64    `json:"size"`
	// Checkpoint is the published, signed checkpoint, exactly as it sits on
	// disk at the "checkpoint" path.
	Checkpoint     Hex    `json:"checkpoint"`
	CheckpointText string `json:"checkpointText"`
	// CheckpointBody is the parsed checkpoint: what a client gets after
	// verifying the signature.
	CheckpointOrigin string `json:"checkpointOrigin"`
	CheckpointSize   U64    `json:"checkpointSize"`
	CheckpointHash   Hex    `json:"checkpointHash"`
	// Tiles and EntryBundles are every file the log wrote, keyed by path and
	// sorted by path.
	Tiles        []tileFile   `json:"tiles"`
	EntryBundles []bundleFile `json:"entryBundles"`
	// State is every file the driver keeps in its private .state directory
	// (version and treeState; gcState too, were garbage collection enabled),
	// keyed by path relative to the log root and sorted by path. These are not
	// part of the tlog-tiles surface, but a port whose storage is meant to be
	// interchangeable with a POSIX log directory must read and write them in
	// exactly this format, and recording the bytes Go wrote is the only honest
	// evidence of what that format is. The *.lock files are left out: they are
	// empty flock(2) targets, which carry no state.
	State []resourceFile `json:"state"`
}

// genLogs builds a real Tessera log for each size in logFixtureSizes using the
// POSIX driver, then dumps every resource it wrote. This is the fixture that
// proves the port builds byte-identical logs, so nothing here is synthesised:
// the tiles, the bundles, and the checkpoint are read back off disk.
func genLogs(outDir string) ([]string, error) {
	names := make([]string, 0, len(logFixtureSizes))
	for _, size := range logFixtureSizes {
		f, err := buildLog(size)
		if err != nil {
			return nil, fmt.Errorf("size %d: %w", size, err)
		}
		name := fmt.Sprintf("log_%d", size)
		if err := writeFixture(outDir, name, f); err != nil {
			return nil, err
		}
		names = append(names, name+".json")
	}
	return names, nil
}

func buildLog(size uint64) (*logFixture, error) {
	dir, err := os.MkdirTemp("", "webtessera-fixture-log-")
	if err != nil {
		return nil, err
	}
	defer func() {
		// The log directory is scratch space; only the JSON dump is kept.
		_ = os.RemoveAll(dir)
	}()

	if err := runLog(dir, size); err != nil {
		return nil, err
	}
	return dumpLog(dir, size)
}

// runLog drives a POSIX-backed Tessera appender to add `size` entries and
// publish a checkpoint covering all of them.
//
// The options here are chosen for reproducibility rather than for throughput:
//   - one batch holding every entry, with a max age long enough that the batch
//     can only be flushed by reaching its size, so integration happens exactly
//     once and no intermediate partial tiles are left behind;
//   - garbage collection disabled, so the set of files on disk is a pure
//     function of the tree size;
//   - checkpoint republication disabled, since a republished checkpoint has
//     identical bytes and only adds timing sensitivity.
func runLog(dir string, size uint64) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	driver, err := posix.New(ctx, posix.Config{Path: dir})
	if err != nil {
		return fmt.Errorf("posix.New: %w", err)
	}

	batchSize := uint(size)
	if batchSize == 0 {
		// The queue rejects a zero-sized batch, and an empty log never fills
		// one anyway.
		batchSize = 1
	}

	opts := tessera.NewAppendOptions().
		WithCheckpointSigner(mustSigner(logSKey)).
		WithBatching(batchSize, time.Hour).
		WithCheckpointInterval(100 * time.Millisecond).
		WithCheckpointRepublishInterval(0).
		WithGarbageCollectionInterval(0)

	appender, shutdown, r, err := tessera.NewAppender(ctx, driver, opts)
	if err != nil {
		return fmt.Errorf("NewAppender: %w", err)
	}

	await := tessera.NewPublicationAwaiter(ctx, r.ReadCheckpoint, 10*time.Millisecond)

	futures := make([]tessera.IndexFuture, 0, size)
	for i := uint64(0); i < size; i++ {
		futures = append(futures, appender.Add(ctx, tessera.NewEntry(entryData(i))))
	}
	for i, fut := range futures {
		idx, _, err := await.Await(ctx, fut)
		if err != nil {
			return fmt.Errorf("await entry %d: %w", i, err)
		}
		if idx.Index != uint64(i) {
			return fmt.Errorf("entry %d was assigned index %d; entries must be sequenced in order for the fixture to be reproducible", i, idx.Index)
		}
	}

	if err := shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// dumpLog reads back everything the log wrote under dir.
func dumpLog(dir string, size uint64) (*logFixture, error) {
	logV := mustVerifier(logVKey)

	f := &logFixture{
		header: hdr(fmt.Sprintf("A complete tlog-tiles log of %d entries, built by the real Tessera POSIX driver.", size),
			"github.com/transparency-dev/tessera/storage/posix"),
		Origin:       logV.Name(),
		LogVKey:      logVKey,
		EntryScheme:  `entry i is the UTF-8 bytes of "entry-<i>"`,
		Size:         U64(size),
		Tiles:        []tileFile{},
		EntryBundles: []bundleFile{},
	}

	state, err := dumpState(dir)
	if err != nil {
		return nil, err
	}
	f.State = state

	cpRaw, err := os.ReadFile(filepath.Join(dir, layout.CheckpointPath))
	if err != nil {
		return nil, fmt.Errorf("read checkpoint: %w", err)
	}
	f.Checkpoint = Hex(cpRaw)
	f.CheckpointText = string(cpRaw)

	cp, _, _, err := f_log.ParseCheckpoint(cpRaw, logV.Name(), logV)
	if err != nil {
		return nil, fmt.Errorf("parse checkpoint: %w", err)
	}
	if cp.Size != size {
		return nil, fmt.Errorf("published checkpoint covers %d entries, want %d", cp.Size, size)
	}
	f.CheckpointOrigin, f.CheckpointSize, f.CheckpointHash = cp.Origin, U64(cp.Size), Hex(cp.Hash)

	var paths []string
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// .state holds the driver's private bookkeeping, which is not part
			// of the tlog-tiles surface a client sees; dumpState records it
			// separately.
			if d.Name() == ".state" {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)

	for _, rel := range paths {
		if rel == layout.CheckpointPath {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		switch {
		case strings.HasPrefix(rel, "tile/entries/"):
			idx, p, err := parseResourcePath(strings.TrimPrefix(rel, "tile/entries/"))
			if err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			n, err := countBundleEntries(raw)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			f.EntryBundles = append(f.EntryBundles, bundleFile{
				resourceFile: resourceFile{Path: rel, Raw: Hex(raw)},
				Index:        U64(idx), Partial: int(p), Entries: n,
			})
		case strings.HasPrefix(rel, "tile/"):
			rest := strings.TrimPrefix(rel, "tile/")
			slash := strings.Index(rest, "/")
			if slash < 0 {
				return nil, fmt.Errorf("unexpected resource path %q", rel)
			}
			level, idx, p, err := layout.ParseTileLevelIndexPartial(rest[:slash], rest[slash+1:])
			if err != nil {
				return nil, fmt.Errorf("%s: %w", rel, err)
			}
			if len(raw)%32 != 0 {
				return nil, fmt.Errorf("%s: %d bytes is not a multiple of the hash size", rel, len(raw))
			}
			f.Tiles = append(f.Tiles, tileFile{
				resourceFile: resourceFile{Path: rel, Raw: Hex(raw)},
				Level:        U64(level), Index: U64(idx), Partial: int(p), Nodes: len(raw) / 32,
			})
		default:
			return nil, fmt.Errorf("unexpected file %q in log directory", rel)
		}
	}

	return f, nil
}

// dumpState reads back the files the driver left in the log's .state
// directory, apart from its lock files.
func dumpState(dir string) ([]resourceFile, error) {
	const stateDir = ".state"
	des, err := os.ReadDir(filepath.Join(dir, stateDir))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", stateDir, err)
	}
	state := []resourceFile{}
	// os.ReadDir returns entries sorted by name, so the output order is stable.
	for _, de := range des {
		if !de.Type().IsRegular() {
			return nil, fmt.Errorf("unexpected non-regular file %s/%s", stateDir, de.Name())
		}
		if strings.HasSuffix(de.Name(), ".lock") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, stateDir, de.Name()))
		if err != nil {
			return nil, err
		}
		state = append(state, resourceFile{Path: stateDir + "/" + de.Name(), Raw: Hex(raw)})
	}
	return state, nil
}

// parseResourcePath splits an entry-bundle path suffix into its index and
// partial width using upstream's parser.
func parseResourcePath(suffix string) (uint64, uint8, error) {
	return layout.ParseTileIndexPartial(suffix)
}

// countBundleEntries decodes a bundle with upstream's parser and returns how
// many entries it holds.
func countBundleEntries(raw []byte) (int, error) {
	b := api.EntryBundle{}
	if err := b.UnmarshalText(raw); err != nil {
		return 0, err
	}
	return len(b.Entries), nil
}
