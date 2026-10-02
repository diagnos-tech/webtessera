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
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/tessera/api/layout"
)

// clientTestLogDir is the small (15-entry) tlog-tiles log that
// client/client_test.go reads via the relative path "../testdata/log". It is
// real output from cmd/examples/posix-oneshot, built once by
// testdata/build_log.sh and committed to the upstream repository at the
// pinned commit -- this generator only reads it back, it does not build or
// invent anything, matching the fixtures rule in AGENTS.md §5. The absolute
// path mirrors the one already baked into go.mod's `replace` directive for
// the same pinned checkout.
const clientTestLogDir = "/home/gg/dev/Maravi/_future/tessera/testdata/log"

// clientTestOrigin and clientTestVKey are the checkpoint origin and note
// verifier key client_test.go hard-codes for this log (see its
// testOrigin/testLogVerifier package vars). clientTestSKey is the matching
// private key, copied verbatim from testdata/build_log.sh's LOG_PRIVATE_KEY --
// it protects nothing (it is a throwaway key committed in the clear upstream
// specifically so this log could be rebuilt), and exposing it in the fixture
// lets a port's own tests forge a validly-signed-but-inconsistent checkpoint
// to exercise LogStateTracker's rejection path, which upstream's own
// TestCheckLogStateTracker never does (every case there feeds it checkpoints
// from the real, honestly-grown log).
const (
	clientTestOrigin = "example.com/log/testdata"
	clientTestVKey   = "example.com/log/testdata+33d7b496+AeHTu4Q3hEIMHNqc6fASMsq3rKNx280NI+oO5xCFkkSx"
	clientTestSKey   = "PRIVATE+KEY+example.com/log/testdata+33d7b496+AeymY/SZAX0jZcJ8enZ5FY1Dz+wTML2yWSkK+9DSF3eg"
)

// checkpointSnapshot is one "checkpoint.N" file: the checkpoint the log
// published once it held exactly N entries. client_test.go replays these in
// order to exercise LogStateTracker.Update's growth and consistency checks.
type checkpointSnapshot struct {
	// N is the checkpoint.N file suffix.
	N U64 `json:"n"`
	// Raw is the exact bytes of checkpoint.N, as published.
	Raw Hex `json:"raw"`
	// Size and Hash are the parsed checkpoint body, recorded so a port can
	// sanity-check its parser against this fixture without re-deriving it.
	Size U64 `json:"size"`
	Hash Hex `json:"hash"`
}

// clientLogFixture is the full checked-in "../testdata/log" test log used by
// client/client_test.go: every checkpoint snapshot it ever published, plus
// every tile and entry bundle currently on disk.
type clientLogFixture struct {
	header
	Origin  string `json:"origin"`
	LogVKey string `json:"logVkey"`
	// LogSKey is clientTestSKey; see its doc comment for why it is safe to publish.
	LogSKey string `json:"logSkey"`
	// Latest is the "checkpoint" file: the newest snapshot, same bytes as the
	// last element of Checkpoints. Kept separate because it is the resource
	// path a CheckpointFetcherFunc actually reads.
	Latest Hex `json:"latest"`
	// Checkpoints holds every checkpoint.N snapshot, sorted by N ascending.
	Checkpoints []checkpointSnapshot `json:"checkpoints"`
	// Tiles and EntryBundles are every resource file present in the log
	// directory, keyed by path and sorted by path -- the same shape genLogs
	// uses for the from-scratch logs in log.go.
	Tiles        []tileFile   `json:"tiles"`
	EntryBundles []bundleFile `json:"entryBundles"`
}

// genClientLog reads back the static test log under clientTestLogDir and
// dumps every checkpoint snapshot, tile and entry bundle it finds.
func genClientLog() any {
	f, err := dumpClientLog(clientTestLogDir)
	if err != nil {
		panic(fmt.Errorf("dumpClientLog: %w", err))
	}
	return f
}

func dumpClientLog(dir string) (*clientLogFixture, error) {
	logV := mustVerifier(clientTestVKey)
	if logV.Name() != clientTestOrigin {
		return nil, fmt.Errorf("verifier name %q does not match clientTestOrigin %q", logV.Name(), clientTestOrigin)
	}
	logS := mustSigner(clientTestSKey)
	if logS.Name() != logV.Name() || logS.KeyHash() != logV.KeyHash() {
		return nil, fmt.Errorf("clientTestSKey does not match clientTestVKey")
	}

	f := &clientLogFixture{
		header: hdr("The static 15-entry tlog-tiles log checked in upstream at testdata/log, "+
			"read back by client_test.go via a relative \"../testdata/log\" path.",
			"github.com/transparency-dev/tessera/client (testdata/log)"),
		Origin:       clientTestOrigin,
		LogVKey:      clientTestVKey,
		LogSKey:      clientTestSKey,
		Checkpoints:  []checkpointSnapshot{},
		Tiles:        []tileFile{},
		EntryBundles: []bundleFile{},
	}

	latestRaw, err := os.ReadFile(filepath.Join(dir, layout.CheckpointPath))
	if err != nil {
		return nil, fmt.Errorf("read checkpoint: %w", err)
	}
	f.Latest = Hex(latestRaw)

	var paths []string
	if err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// .state holds the POSIX driver's private bookkeeping, not part of
			// the tlog-tiles surface a client sees.
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
	}); err != nil {
		return nil, err
	}
	sort.Strings(paths)

	for _, rel := range paths {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		switch {
		case rel == layout.CheckpointPath:
			// Already captured as f.Latest above.
			continue
		case strings.HasPrefix(rel, layout.CheckpointPath+"."):
			n, err := strconv.ParseUint(strings.TrimPrefix(rel, layout.CheckpointPath+"."), 10, 64)
			if err != nil {
				return nil, fmt.Errorf("%s: unexpected checkpoint snapshot name: %w", rel, err)
			}
			cp, _, _, err := f_log.ParseCheckpoint(raw, clientTestOrigin, logV)
			if err != nil {
				return nil, fmt.Errorf("%s: ParseCheckpoint: %w", rel, err)
			}
			if cp.Size != n {
				return nil, fmt.Errorf("%s: checkpoint covers %d entries, filename says %d", rel, cp.Size, n)
			}
			f.Checkpoints = append(f.Checkpoints, checkpointSnapshot{
				N: U64(n), Raw: Hex(raw), Size: U64(cp.Size), Hash: Hex(cp.Hash),
			})
		case strings.HasPrefix(rel, "tile/entries/"):
			idx, p, err := layout.ParseTileIndexPartial(strings.TrimPrefix(rel, "tile/entries/"))
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
			return nil, fmt.Errorf("unexpected file %q in client test log directory", rel)
		}
	}

	sort.Slice(f.Checkpoints, func(i, j int) bool { return f.Checkpoints[i].N < f.Checkpoints[j].N })

	if len(f.Checkpoints) == 0 {
		return nil, fmt.Errorf("no checkpoint.N snapshots found under %s", dir)
	}
	if last := f.Checkpoints[len(f.Checkpoints)-1]; string(last.Raw) != string(f.Latest) {
		return nil, fmt.Errorf("checkpoint.%d does not match the \"checkpoint\" file bytes", last.N)
	}

	return f, nil
}
