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
	"math"

	"github.com/transparency-dev/merkle/compact"
	"github.com/transparency-dev/merkle/rfc6962"
)

// entryName is the deterministic content of leaf i in every fixture that needs
// a corpus of entries. Keeping one definition means the compact-range roots,
// the proof fixtures and the full-log fixtures all describe the same tree.
func entryName(i uint64) string {
	return fmt.Sprintf("entry-%d", i)
}

// entryData returns the bytes of leaf i.
func entryData(i uint64) []byte {
	return []byte(entryName(i))
}

type nodeID struct {
	Level int `json:"level"`
	Index U64 `json:"index"`
}

type visitedNode struct {
	Level int `json:"level"`
	Index U64 `json:"index"`
	Hash  Hex `json:"hash"`
}

// appendStep records the state of a compact.Range after appending leaf i, plus
// everything the visitor was told during that append.
type appendStep struct {
	// Size is the range's End() after the append, i.e. the tree size.
	Size U64 `json:"size"`
	// Leaf is the raw entry appended at this step.
	Leaf Hex `json:"leaf"`
	// LeafHash is the RFC6962 leaf hash that was actually appended.
	LeafHash Hex `json:"leafHash"`
	// Hashes is Range.Hashes() after the append: the roots of the minimal set
	// of perfect subtrees covering [0, Size), left to right.
	Hashes []Hex `json:"hashes"`
	// Visited lists the nodes reported by the Append visitor, in call order.
	Visited []visitedNode `json:"visited"`
	// Root is Range.GetRootHash() after the append.
	Root Hex `json:"root"`
	// RootVisited lists the ephemeral nodes reported by the GetRootHash
	// visitor, in call order.
	RootVisited []visitedNode `json:"rootVisited"`
}

type mergeCase struct {
	Desc string `json:"desc"`
	// Begin/Mid/End describe the two ranges [Begin, Mid) and [Mid, End) that
	// are merged.
	Begin U64 `json:"begin"`
	Mid   U64 `json:"mid"`
	End   U64 `json:"end"`
	// LeftHashes and RightHashes are the two ranges' hashes before the merge.
	LeftHashes  []Hex `json:"leftHashes"`
	RightHashes []Hex `json:"rightHashes"`
	// Hashes is the merged range's hashes.
	Hashes []Hex `json:"hashes"`
	// Visited lists the nodes reported by the AppendRange visitor.
	Visited []visitedNode `json:"visited"`
	// Root is the merged range's root hash, present only when Begin is 0.
	Root Hex `json:"root"`
}

type rangeNodesCase struct {
	Begin U64      `json:"begin"`
	End   U64      `json:"end"`
	Size  int      `json:"size"`
	IDs   []nodeID `json:"ids"`
}

type decomposeCase struct {
	Begin U64 `json:"begin"`
	End   U64 `json:"end"`
	Left  U64 `json:"left"`
	Right U64 `json:"right"`
}

type nodeIDCase struct {
	Level         int `json:"level"`
	Index         U64 `json:"index"`
	ParentLevel   int `json:"parentLevel"`
	ParentIndex   U64 `json:"parentIndex"`
	SiblingLevel  int `json:"siblingLevel"`
	SiblingIndex  U64 `json:"siblingIndex"`
	CoverageBegin U64 `json:"coverageBegin"`
	CoverageEnd   U64 `json:"coverageEnd"`
}

// errorCase records one of compact's rejections. Which call is being made is
// identified by Op.
type errorCase struct {
	Op    string `json:"op"`
	Desc  string `json:"desc"`
	Begin U64    `json:"begin"`
	End   U64    `json:"end"`
	// Hashes is the hash list supplied to NewRange, or the right-hand range's
	// hashes for appendRange.
	Hashes     []Hex  `json:"hashes"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type compactRangeFixture struct {
	header
	// EmptyRoot is what an empty compact.Range reports: GetRootHash returns nil
	// for a range with no hashes, which is NOT the RFC6962 empty root. The
	// distinction has bitten implementers before, so it is recorded explicitly.
	EmptyRangeRootIsNil bool             `json:"emptyRangeRootIsNil"`
	Appends             []appendStep     `json:"appends"`
	LargeSizes          []appendStep     `json:"largeSizes"`
	Merges              []mergeCase      `json:"merges"`
	RangeNodes          []rangeNodesCase `json:"rangeNodes"`
	Decompose           []decomposeCase  `json:"decompose"`
	NodeIDs             []nodeIDCase     `json:"nodeIds"`
	Errors              []errorCase      `json:"errors"`
}

func genCompactRange() any {
	rf := &compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren}

	f := compactRangeFixture{
		header: hdr("compact.Range: incremental append, range merging, and the node-address helpers.",
			"github.com/transparency-dev/merkle/compact"),
	}

	empty := rf.NewEmptyRange(0)
	emptyRoot, err := empty.GetRootHash(nil)
	if err != nil {
		panic(err)
	}
	f.EmptyRangeRootIsNil = emptyRoot == nil

	// Size 0 is included as the first step so the TypeScript side can start
	// from the same state: an empty range with no hashes and a nil root.
	f.Appends = append(f.Appends, appendStep{
		Size: 0, Leaf: nil, LeafHash: nil,
		Hashes: hexes(empty.Hashes()), Visited: []visitedNode{},
		Root: Hex(emptyRoot), RootVisited: []visitedNode{},
	})

	// Append one leaf at a time up to 300, recording the full state at each
	// size. 256 and 257 are the tile boundary; 255 and 129 are the sizes with
	// the deepest ragged right border below it.
	const maxSmall = 300
	r := rf.NewEmptyRange(0)
	for i := uint64(0); i < maxSmall; i++ {
		f.Appends = append(f.Appends, appendAndRecord(r, i))
	}

	// Then jump to sizes large enough to exercise levels a 300-leaf tree never
	// reaches. Each is built from scratch so the fixture is self-contained.
	for _, size := range []uint64{512, 1000, 1024, 4096, 5000, 65536, 65537} {
		big := rf.NewEmptyRange(0)
		var last appendStep
		for i := uint64(0); i < size; i++ {
			last = appendAndRecord(big, i)
		}
		f.LargeSizes = append(f.LargeSizes, last)
	}

	// AppendRangeFrom: build [0, mid) and [mid, end) independently, then merge.
	for _, tc := range []struct{ mid, end uint64 }{
		{0, 0}, {0, 1}, {1, 1}, {1, 2}, {1, 3}, {2, 3}, {2, 4}, {3, 4}, {3, 7},
		{4, 8}, {5, 9}, {7, 8}, {8, 16}, {11, 23}, {16, 32}, {100, 200},
		{128, 256}, {255, 256}, {256, 257}, {256, 512}, {257, 513}, {300, 1000},
	} {
		f.Merges = append(f.Merges, mergeAndRecord(rf, 0, tc.mid, tc.end))
	}
	// Merges of ranges that do not start at zero, which is the case
	// storage/internal hits when integrating a batch into an existing tree.
	for _, tc := range []struct{ begin, mid, end uint64 }{
		{1, 2, 3}, {1, 3, 5}, {2, 4, 8}, {3, 5, 11}, {5, 8, 13},
		{256, 300, 512}, {255, 256, 257}, {1000, 1024, 2048},
	} {
		f.Merges = append(f.Merges, mergeAndRecord(rf, tc.begin, tc.mid, tc.end))
	}

	// compact.RangeNodes / RangeSize / Decompose are pure address arithmetic.
	// They drive every proof, so they get their own dense table.
	rnPairs := []struct{ begin, end uint64 }{}
	for _, end := range []uint64{0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 15, 16, 17, 31, 32, 100, 255, 256, 257, 1000, 1024, 65535, 65536, 65537} {
		for _, begin := range []uint64{0, 1, 2, 3, 5, 8, 16, 100, 255, 256, 1000} {
			if begin <= end {
				rnPairs = append(rnPairs, struct{ begin, end uint64 }{begin, end})
			}
		}
	}
	rnPairs = append(rnPairs,
		struct{ begin, end uint64 }{0, math.MaxUint64},
		struct{ begin, end uint64 }{1, math.MaxUint64},
		struct{ begin, end uint64 }{math.MaxUint64 - 1, math.MaxUint64},
		struct{ begin, end uint64 }{1 << 62, 1<<62 + 1},
		struct{ begin, end uint64 }{1 << 63, (1 << 63) + 1024},
	)
	for _, p := range rnPairs {
		ids := compact.RangeNodes(p.begin, p.end, nil)
		out := make([]nodeID, 0, len(ids))
		for _, id := range ids {
			out = append(out, nodeID{Level: int(id.Level), Index: U64(id.Index)})
		}
		f.RangeNodes = append(f.RangeNodes, rangeNodesCase{
			Begin: U64(p.begin), End: U64(p.end),
			Size: compact.RangeSize(p.begin, p.end), IDs: out,
		})
		left, right := compact.Decompose(p.begin, p.end)
		f.Decompose = append(f.Decompose, decomposeCase{
			Begin: U64(p.begin), End: U64(p.end), Left: U64(left), Right: U64(right),
		})
	}

	// Rejections. NewRange validates the range and the hash count; AppendRange
	// validates that the two ranges share a hasher and are adjacent.
	addNewRangeErr := func(desc string, begin, end uint64, hashes [][]byte) {
		_, err := rf.NewRange(begin, end, hashes)
		f.Errors = append(f.Errors, errorCase{
			Op: "newRange", Desc: desc, Begin: U64(begin), End: U64(end),
			Hashes: hexes(hashes), WantErr: err != nil, WantErrMsg: errString(err),
		})
	}
	h3 := rf.NewEmptyRange(0)
	for i := uint64(0); i < 3; i++ {
		if err := h3.Append(rfc6962.DefaultHasher.HashLeaf(entryData(i)), nil); err != nil {
			panic(err)
		}
	}
	addNewRangeErr("valid [0,3)", 0, 3, h3.Hashes())
	addNewRangeErr("valid empty [5,5)", 5, 5, nil)
	addNewRangeErr("end before begin", 5, 3, nil)
	addNewRangeErr("too few hashes", 0, 3, h3.Hashes()[:1])
	addNewRangeErr("too many hashes", 0, 3, append(append([][]byte{}, h3.Hashes()...), h3.Hashes()[0]))
	addNewRangeErr("hashes for an empty range", 5, 5, h3.Hashes()[:1])

	addAppendRangeErr := func(desc string, lBegin, lEnd, rBegin, rEnd uint64, otherFactory *compact.RangeFactory) {
		left := rf.NewEmptyRange(lBegin)
		for i := lBegin; i < lEnd; i++ {
			if err := left.Append(rfc6962.DefaultHasher.HashLeaf(entryData(i)), nil); err != nil {
				panic(err)
			}
		}
		fac := rf
		if otherFactory != nil {
			fac = otherFactory
		}
		right := fac.NewEmptyRange(rBegin)
		for i := rBegin; i < rEnd; i++ {
			if err := right.Append(rfc6962.DefaultHasher.HashLeaf(entryData(i)), nil); err != nil {
				panic(err)
			}
		}
		err := left.AppendRange(right, nil)
		f.Errors = append(f.Errors, errorCase{
			Op: "appendRange", Desc: desc, Begin: U64(rBegin), End: U64(rEnd),
			Hashes: hexes(right.Hashes()), WantErr: err != nil, WantErrMsg: errString(err),
		})
	}
	addAppendRangeErr("adjacent ranges", 0, 3, 3, 7, nil)
	addAppendRangeErr("gap between ranges", 0, 3, 5, 7, nil)
	addAppendRangeErr("overlapping ranges", 0, 5, 3, 7, nil)
	addAppendRangeErr("empty right range", 0, 3, 3, 3, nil)
	addAppendRangeErr("mismatched right range start with empty right", 0, 3, 9, 9, nil)
	addAppendRangeErr("different hasher instance", 0, 3, 3, 7, &compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren})

	for _, lvl := range []uint{0, 1, 2, 8, 32, 62, 63} {
		for _, idx := range []uint64{0, 1, 2, 3, 255, 256, 1000, math.MaxUint64 >> 1} {
			id := compact.NewNodeID(lvl, idx)
			p := id.Parent()
			s := id.Sibling()
			cb, ce := id.Coverage()
			f.NodeIDs = append(f.NodeIDs, nodeIDCase{
				Level: int(id.Level), Index: U64(id.Index),
				ParentLevel: int(p.Level), ParentIndex: U64(p.Index),
				SiblingLevel: int(s.Level), SiblingIndex: U64(s.Index),
				CoverageBegin: U64(cb), CoverageEnd: U64(ce),
			})
		}
	}

	return f
}

// appendAndRecord appends leaf i to r and returns the resulting state.
func appendAndRecord(r *compact.Range, i uint64) appendStep {
	data := entryData(i)
	leafHash := rfc6962.DefaultHasher.HashLeaf(data)

	visited := []visitedNode{}
	if err := r.Append(leafHash, func(id compact.NodeID, hash []byte) {
		visited = append(visited, visitedNode{Level: int(id.Level), Index: U64(id.Index), Hash: Hex(hash)})
	}); err != nil {
		panic(err)
	}

	rootVisited := []visitedNode{}
	root, err := r.GetRootHash(func(id compact.NodeID, hash []byte) {
		rootVisited = append(rootVisited, visitedNode{Level: int(id.Level), Index: U64(id.Index), Hash: Hex(hash)})
	})
	if err != nil {
		panic(err)
	}

	return appendStep{
		Size: U64(r.End()), Leaf: Hex(data), LeafHash: Hex(leafHash),
		Hashes: hexes(r.Hashes()), Visited: visited,
		Root: Hex(root), RootVisited: rootVisited,
	}
}

// mergeAndRecord builds [begin, mid) and [mid, end) by appending leaves, then
// merges the second into the first and records the outcome.
func mergeAndRecord(rf *compact.RangeFactory, begin, mid, end uint64) mergeCase {
	left := rf.NewEmptyRange(begin)
	for i := begin; i < mid; i++ {
		if err := left.Append(rfc6962.DefaultHasher.HashLeaf(entryData(i)), nil); err != nil {
			panic(err)
		}
	}
	right := rf.NewEmptyRange(mid)
	for i := mid; i < end; i++ {
		if err := right.Append(rfc6962.DefaultHasher.HashLeaf(entryData(i)), nil); err != nil {
			panic(err)
		}
	}

	c := mergeCase{
		Desc:  fmt.Sprintf("[%d,%d) + [%d,%d)", begin, mid, mid, end),
		Begin: U64(begin), Mid: U64(mid), End: U64(end),
		LeftHashes: hexes(left.Hashes()), RightHashes: hexes(right.Hashes()),
	}

	visited := []visitedNode{}
	if err := left.AppendRange(right, func(id compact.NodeID, hash []byte) {
		visited = append(visited, visitedNode{Level: int(id.Level), Index: U64(id.Index), Hash: Hex(hash)})
	}); err != nil {
		panic(err)
	}
	c.Hashes = hexes(left.Hashes())
	c.Visited = visited

	if begin == 0 {
		root, err := left.GetRootHash(nil)
		if err != nil {
			panic(err)
		}
		c.Root = Hex(root)
	}

	return c
}
