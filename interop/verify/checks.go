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

package main

import (
	"bytes"
	"context"
	"fmt"
	"math/rand/v2"
	"slices"

	"github.com/diagnos-tech/webtessera/interop/internal/entries"
	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/api"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/client"
	"github.com/transparency-dev/tessera/fsck"
	"golang.org/x/mod/sumdb/note"
)

// checkTree runs tessera/fsck over the whole log, exactly as cmd/fsck does for
// a file:// storage URL.
func checkTree(ctx context.Context, f client.FileFetcher, v note.Verifier) error {
	return fsck.New(v.Name(), v, f, merkleLeafHasher, fsck.Opts{N: *workers}).Check(ctx)
}

// merkleLeafHasher is cmd/fsck's defaultMerkleLeafHasher, repeated here because
// a main package cannot be imported. It parses a C2SP tlog-tile bundle and
// returns the Merkle leaf hashes of each entry it contains.
func merkleLeafHasher(bundle []byte) ([][]byte, error) {
	eb := &api.EntryBundle{}
	if err := eb.UnmarshalText(bundle); err != nil {
		return nil, fmt.Errorf("unmarshal: %v", err)
	}
	r := make([][]byte, 0, len(eb.Entries))
	for _, e := range eb.Entries {
		h := rfc6962.DefaultHasher.HashLeaf(e)
		r = append(r, h[:])
	}
	return r, nil
}

// checkEntries streams every entry bundle of a tree of the given size and
// checks that each holds exactly the entries the tree size implies, and that
// entry i is entry i of the interop corpus.
//
// The entry count matters: fsck hashes only the entries a bundle's range covers,
// so a partial bundle carrying extra entries past its width would pass fsck, but
// it is not what Tessera writes, and a client reading it would disagree with one
// reading Tessera's.
func checkEntries(ctx context.Context, f client.FileFetcher, size, seed uint64) error {
	getSize := func(context.Context) (uint64, error) { return size, nil }
	next := uint64(0)
	for b, err := range client.EntryBundles(ctx, *workers, getSize, f.ReadEntryBundle, 0, size) {
		if err != nil {
			return err
		}
		ri := b.RangeInfo
		eb := api.EntryBundle{}
		if err := eb.UnmarshalText(b.Data); err != nil {
			return fmt.Errorf("bundle %d: %v", ri.Index, err)
		}
		if want := int(layout.PartialTileSize(0, ri.Index, size)); len(eb.Entries) != want && !(want == 0 && len(eb.Entries) == layout.EntryBundleWidth) {
			return fmt.Errorf("bundle %d holds %d entries, but a tree of size %d implies %d", ri.Index, len(eb.Entries), size, want)
		}
		for i := ri.First; i < ri.First+ri.N; i++ {
			idx := ri.Index*layout.EntryBundleWidth + uint64(i)
			if idx != next {
				return fmt.Errorf("bundle %d: entry %d arrived where entry %d was expected", ri.Index, idx, next)
			}
			if got, want := eb.Entries[i], entries.Data(seed, idx); !bytes.Equal(got, want) {
				return fmt.Errorf("entry %d is %d bytes (%x...), but the corpus has %d bytes (%x...)", idx, len(got), head(got), len(want), head(want))
			}
			next++
		}
	}
	if next != size {
		return fmt.Errorf("streamed %d entries, the checkpoint commits to %d", next, size)
	}
	return nil
}

// checkInclusion proves the inclusion of a sample of entries in the final tree,
// and of the first and last entry of every historical tree in that tree, and
// returns how many proofs it verified.
func checkInclusion(ctx context.Context, f client.FileFetcher, cp *f_log.Checkpoint, hist []*f_log.Checkpoint, samples int) (int, error) {
	n := 0
	pb, err := client.NewProofBuilder(ctx, cp.Size, f.ReadTile)
	if err != nil {
		return n, err
	}
	for _, i := range sampleIndices(cp.Size, samples) {
		if err := proveInclusion(ctx, f, pb, cp, i); err != nil {
			return n, err
		}
		n++
	}
	for _, h := range hist {
		if h.Size == 0 {
			continue
		}
		hpb, err := client.NewProofBuilder(ctx, h.Size, f.ReadTile)
		if err != nil {
			return n, err
		}
		for _, i := range []uint64{0, h.Size - 1} {
			if err := proveInclusion(ctx, f, hpb, h, i); err != nil {
				return n, fmt.Errorf("in the tree of size %d: %v", h.Size, err)
			}
			n++
		}
	}
	return n, nil
}

// proveInclusion reads entry i from its bundle, builds its inclusion proof from
// the log's tiles, and verifies it against cp.
func proveInclusion(ctx context.Context, f client.FileFetcher, pb *client.ProofBuilder, cp *f_log.Checkpoint, i uint64) error {
	b, err := client.GetEntryBundle(ctx, f.ReadEntryBundle, i/layout.EntryBundleWidth, cp.Size)
	if err != nil {
		return err
	}
	j := i % layout.EntryBundleWidth
	if j >= uint64(len(b.Entries)) {
		return fmt.Errorf("entry %d: its bundle holds only %d entries", i, len(b.Entries))
	}
	p, err := pb.InclusionProof(ctx, i)
	if err != nil {
		return fmt.Errorf("entry %d: building the proof: %v", i, err)
	}
	if err := proof.VerifyInclusion(rfc6962.DefaultHasher, i, cp.Size, rfc6962.DefaultHasher.HashLeaf(b.Entries[j]), p, cp.Hash); err != nil {
		return fmt.Errorf("entry %d: %v", i, err)
	}
	return nil
}

// checkConsistency proves the final tree consistent with every historical one.
func checkConsistency(ctx context.Context, f client.FileFetcher, cp *f_log.Checkpoint, hist []*f_log.Checkpoint) error {
	pb, err := client.NewProofBuilder(ctx, cp.Size, f.ReadTile)
	if err != nil {
		return err
	}
	for _, h := range hist {
		if h.Size > cp.Size {
			return fmt.Errorf("a historical checkpoint commits to %d entries, more than the final %d", h.Size, cp.Size)
		}
		p, err := pb.ConsistencyProof(ctx, h.Size, cp.Size)
		if err != nil {
			return fmt.Errorf("from size %d: building the proof: %v", h.Size, err)
		}
		if err := proof.VerifyConsistency(rfc6962.DefaultHasher, h.Size, cp.Size, p, h.Hash, cp.Hash); err != nil {
			return fmt.Errorf("from size %d: %v", h.Size, err)
		}
	}
	return nil
}

// sampleIndices returns, in ascending order and without repeats, the entries
// either side of every bundle and tile boundary the tree reaches, the last few
// entries, and n more chosen by a fixed-seed generator so that runs repeat.
func sampleIndices(size uint64, n int) []uint64 {
	if size == 0 {
		return nil
	}
	var r []uint64
	add := func(i uint64) {
		if i < size {
			r = append(r, i)
		}
	}
	for _, b := range []uint64{0, 256, 512, 65536} {
		for _, d := range []uint64{0, 1, 2} {
			add(b + d)
			if b >= d && b > 0 {
				add(b - d)
			}
		}
	}
	for d := uint64(1); d <= 3 && d <= size; d++ {
		add(size - d)
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range n {
		add(rng.Uint64N(size))
	}
	slices.Sort(r)
	return slices.Compact(r)
}

// head returns the first few bytes of b, for error messages.
func head(b []byte) []byte {
	return b[:min(len(b), 8)]
}
