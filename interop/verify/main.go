// Copyright 2026 MedDeck LTDA. All Rights Reserved.
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

// Command verify checks a static tlog-tiles log with Tessera's own Go code: the
// half of the interop harness that judges, independently of webtessera, whether
// a log webtessera wrote is a valid Tessera log.
//
// The log is a directory holding what a store holds (checkpoint, tile/...), read
// through client.FileFetcher exactly as upstream's cmd/fsck reads a file:// log.
// verify checks, in order:
//
//  1. the checkpoint: its signature, by the log's verifier key, and its origin;
//  2. the whole tree, with tessera/fsck: every entry bundle is re-hashed, every
//     tile re-derived from the leaves and compared with the one in the log, and
//     the root compared with the checkpoint's;
//  3. with -seed, the contents: every entry of every bundle is entry i of the
//     interop corpus, so the log holds exactly the entries that were appended;
//  4. inclusion proofs, built by client.ProofBuilder from the log's tiles, for a
//     sample of entries against the final checkpoint, and for the first and last
//     entry of every historical checkpoint against that checkpoint's tree (which
//     reads the partial tiles and bundles of older tree sizes);
//  5. consistency proofs from every historical checkpoint to the final one.
//
// Historical checkpoints are read from the -history directories (see
// internal/history); each must verify with the same key.
//
// Usage:
//
//	verify -dir DIR -vkey VKEY [-size N] [-seed 1] [-history H1,H2] [-samples 64]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/diagnos-tech/webtessera/interop/internal/history"
	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
	"k8s.io/klog/v2"
)

var (
	dir        = flag.String("dir", "", "Directory holding the static tlog-tiles log.")
	vkey       = flag.String("vkey", "", "Note verifier key of the log; its name is the checkpoint origin.")
	size       = flag.Int64("size", -1, "If not negative, the tree size the checkpoint must commit to.")
	seed       = flag.Int64("seed", -1, "If not negative, check every entry against the interop corpus with this seed.")
	historyArg = flag.String("history", "", "Comma-separated directories of checkpoint.<size> files to prove consistency from.")
	samples    = flag.Int("samples", 64, "Number of seeded random entries to prove inclusion of, besides the boundary entries.")
	workers    = flag.Uint("workers", 4, "Number of fsck workers.")
)

func main() {
	klog.InitFlags(nil)
	flag.Parse()
	if err := run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "verify: FAIL: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("verify: OK")
}

func run(ctx context.Context) error {
	if *dir == "" || *vkey == "" {
		return errors.New("-dir and -vkey are required")
	}
	v, err := note.NewVerifier(*vkey)
	if err != nil {
		return fmt.Errorf("invalid -vkey: %v", err)
	}
	f := client.FileFetcher{Root: *dir}

	cp, _, _, err := client.FetchCheckpoint(ctx, f.ReadCheckpoint, v, v.Name())
	if err != nil {
		return fmt.Errorf("checkpoint: %v", err)
	}
	if *size >= 0 && cp.Size != uint64(*size) {
		return fmt.Errorf("checkpoint: commits to %d entries, want %d", cp.Size, *size)
	}
	fmt.Printf("verify: checkpoint signed by %s, size %d, root %x\n", v.Name(), cp.Size, cp.Hash)

	if err := checkTree(ctx, f, v); err != nil {
		return fmt.Errorf("fsck: %v", err)
	}
	fmt.Printf("verify: fsck: every bundle, tile and the root re-derived and identical\n")

	if *seed >= 0 {
		if err := checkEntries(ctx, f, cp.Size, uint64(*seed)); err != nil {
			return fmt.Errorf("entries: %v", err)
		}
		fmt.Printf("verify: entries: all %d are the interop corpus with seed %d, in order\n", cp.Size, *seed)
	}

	hist, err := readHistory(v)
	if err != nil {
		return fmt.Errorf("history: %v", err)
	}

	n, err := checkInclusion(ctx, f, cp, hist, *samples)
	if err != nil {
		return fmt.Errorf("inclusion: %v", err)
	}
	fmt.Printf("verify: inclusion: %d proofs verified (final tree and %d historical trees)\n", n, len(hist))

	if err := checkConsistency(ctx, f, cp, hist); err != nil {
		return fmt.Errorf("consistency: %v", err)
	}
	fmt.Printf("verify: consistency: %d historical checkpoints proven consistent with the final one\n", len(hist))
	return nil
}

// readHistory reads and verifies every checkpoint in the -history directories.
func readHistory(v note.Verifier) ([]*f_log.Checkpoint, error) {
	if *historyArg == "" {
		return nil, nil
	}
	recorded, err := history.Read(strings.Split(*historyArg, ",")...)
	if err != nil {
		return nil, err
	}
	r := make([]*f_log.Checkpoint, 0, len(recorded))
	for _, c := range recorded {
		cp, _, _, err := f_log.ParseCheckpoint(c.Raw, v.Name(), v)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", c.From, err)
		}
		if cp.Size != c.Size {
			return nil, fmt.Errorf("%s commits to %d entries", c.From, cp.Size)
		}
		r = append(r, cp)
	}
	return r, nil
}
