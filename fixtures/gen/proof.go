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
	"math"

	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/merkle/testonly"
)

// smallTreeMax is the largest tree for which every leaf gets an inclusion proof
// and every size pair gets a consistency proof. 40 covers every shape of ragged
// right border that exists below 64 leaves, which is where proof construction
// bugs live.
const smallTreeMax = 40

// largeTreeSizes are trees big enough to cross the 256-entry tile boundary and
// to reach levels a 40-leaf tree never does. They get a selected set of proofs
// rather than an exhaustive one.
var largeTreeSizes = []uint64{255, 256, 257, 511, 512, 1000, 1024, 1025, 5000}

// entryTree returns a reference Merkle tree of the given size whose leaf i is
// entryData(i), together with its root hash.
func entryTree(size uint64) *testonly.Tree {
	t := testonly.New(rfc6962.DefaultHasher)
	for i := uint64(0); i < size; i++ {
		t.AppendData(entryData(i))
	}
	return t
}

type inclusionProof struct {
	Index    U64   `json:"index"`
	Leaf     Hex   `json:"leaf"`
	LeafHash Hex   `json:"leafHash"`
	Proof    []Hex `json:"proof"`
}

type inclusionTree struct {
	Size   U64              `json:"size"`
	Root   Hex              `json:"root"`
	Proofs []inclusionProof `json:"proofs"`
}

type proofNodesCase struct {
	// Index/Level/Size describe the query; for inclusion proofs Level is 0.
	Index U64 `json:"index"`
	Size  U64 `json:"size"`
	// IDs are the non-ephemeral node IDs the proof is built from.
	IDs []nodeID `json:"ids"`
	// EphemLevel/EphemIndex identify the ephemeral node, and Begin/End are the
	// half-open slice of IDs whose hashes recompute it. Begin == End means the
	// proof has no ephemeral node.
	EphemLevel int    `json:"ephemLevel"`
	EphemIndex U64    `json:"ephemIndex"`
	Begin      int    `json:"begin"`
	End        int    `json:"end"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type verifyErrCase struct {
	Desc       string `json:"desc"`
	Index      U64    `json:"index"`
	Size       U64    `json:"size"`
	LeafHash   Hex    `json:"leafHash"`
	Proof      []Hex  `json:"proof"`
	Root       Hex    `json:"root"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type proofInclusionFixture struct {
	header
	EntryScheme string `json:"entryScheme"`
	// SmallTrees holds an inclusion proof for every leaf of every tree of size
	// 1..smallTreeMax.
	SmallTrees []inclusionTree `json:"smallTrees"`
	// LargeTrees holds selected inclusion proofs in trees that cross the tile
	// boundary.
	LargeTrees []inclusionTree `json:"largeTrees"`
	// Reference is the canonical RFC6962 eight-leaf tree from
	// merkle/testonly.LeafInputs(), included so the port can be checked against
	// vectors that predate Tessera.
	Reference referenceTree `json:"reference"`
	// Nodes pins proof.Inclusion's node-ID output, including its rejections.
	Nodes []proofNodesCase `json:"nodes"`
	// VerifyErrors pins the messages RootFromInclusionProof produces.
	VerifyErrors []verifyErrCase `json:"verifyErrors"`
}

type referenceTree struct {
	Leaves []Hex `json:"leaves"`
	// RootsBySize[i] is the root hash of the tree containing the first i leaves.
	RootsBySize []Hex             `json:"rootsBySize"`
	Proofs      []inclusionTree   `json:"proofs"`
	Consistency []consistencyCase `json:"consistency"`
}

func genProofInclusion() any {
	f := proofInclusionFixture{
		header:      hdr("Merkle inclusion proofs, with the root hashes needed to verify them end to end.", "github.com/transparency-dev/merkle/proof"),
		EntryScheme: `leaf i is the UTF-8 bytes of "entry-<i>"`,
	}

	for size := uint64(1); size <= smallTreeMax; size++ {
		t := entryTree(size)
		tree := inclusionTree{Size: U64(size), Root: Hex(t.Hash())}
		for i := uint64(0); i < size; i++ {
			p, err := t.InclusionProof(i, size)
			if err != nil {
				panic(err)
			}
			tree.Proofs = append(tree.Proofs, inclusionProof{
				Index: U64(i), Leaf: Hex(entryData(i)),
				LeafHash: Hex(t.LeafHash(i)), Proof: hexes(p),
			})
		}
		f.SmallTrees = append(f.SmallTrees, tree)
	}

	for _, size := range largeTreeSizes {
		t := entryTree(size)
		tree := inclusionTree{Size: U64(size), Root: Hex(t.Hash())}
		for _, i := range selectedIndices(size) {
			p, err := t.InclusionProof(i, size)
			if err != nil {
				panic(err)
			}
			tree.Proofs = append(tree.Proofs, inclusionProof{
				Index: U64(i), Leaf: Hex(entryData(i)),
				LeafHash: Hex(t.LeafHash(i)), Proof: hexes(p),
			})
		}
		f.LargeTrees = append(f.LargeTrees, tree)
	}

	f.Reference = genReferenceTree()

	// proof.Inclusion node IDs, including the rejection when index >= size.
	for _, tc := range []struct{ index, size uint64 }{
		{0, 1}, {0, 2}, {1, 2}, {0, 3}, {1, 3}, {2, 3},
		{0, 7}, {3, 7}, {6, 7}, {0, 8}, {7, 8},
		{0, 40}, {17, 40}, {39, 40},
		{0, 256}, {255, 256}, {0, 257}, {256, 257},
		{0, 1000}, {999, 1000}, {500, 1000},
		{0, math.MaxUint64}, {math.MaxUint64 - 1, math.MaxUint64},
		// Rejections.
		{0, 0}, {1, 1}, {5, 5}, {40, 40}, {math.MaxUint64, math.MaxUint64},
	} {
		n, err := proof.Inclusion(tc.index, tc.size)
		f.Nodes = append(f.Nodes, proofNodesCaseFrom(tc.index, tc.size, n, err))
	}

	// RootFromInclusionProof rejections. The proofs here are deliberately the
	// wrong length or the leaf hash the wrong size; upstream asserts on these
	// message strings.
	t8 := entryTree(8)
	good, err := t8.InclusionProof(3, 8)
	if err != nil {
		panic(err)
	}
	addVerifyErr := func(desc string, index, size uint64, leafHash []byte, pf [][]byte) {
		root, verr := proof.RootFromInclusionProof(rfc6962.DefaultHasher, index, size, leafHash, pf)
		f.VerifyErrors = append(f.VerifyErrors, verifyErrCase{
			Desc: desc, Index: U64(index), Size: U64(size),
			LeafHash: Hex(leafHash), Proof: hexes(pf), Root: Hex(root),
			WantErr: verr != nil, WantErrMsg: errString(verr),
		})
	}
	addVerifyErr("valid", 3, 8, t8.LeafHash(3), good)
	addVerifyErr("index beyond size", 8, 8, t8.LeafHash(3), good)
	addVerifyErr("index far beyond size", 100, 8, t8.LeafHash(3), good)
	addVerifyErr("leaf hash too short", 3, 8, t8.LeafHash(3)[:31], good)
	addVerifyErr("leaf hash too long", 3, 8, append(append([]byte{}, t8.LeafHash(3)...), 0x00), good)
	addVerifyErr("proof too short", 3, 8, t8.LeafHash(3), good[:2])
	addVerifyErr("proof too long", 3, 8, t8.LeafHash(3), append(append([][]byte{}, good...), good[0]))
	addVerifyErr("empty proof in non-trivial tree", 3, 8, t8.LeafHash(3), nil)

	return f
}

func proofNodesCaseFrom(index, size uint64, n proof.Nodes, err error) proofNodesCase {
	ids := make([]nodeID, 0, len(n.IDs))
	for _, id := range n.IDs {
		ids = append(ids, nodeID{Level: int(id.Level), Index: U64(id.Index)})
	}
	ephem, begin, end := n.Ephem()
	return proofNodesCase{
		Index: U64(index), Size: U64(size), IDs: ids,
		EphemLevel: int(ephem.Level), EphemIndex: U64(ephem.Index),
		Begin: begin, End: end,
		WantErr: err != nil, WantErrMsg: errString(err),
	}
}

// selectedIndices picks the leaf indices worth proving in a large tree: the
// ends, the tile boundaries, and the midpoint.
func selectedIndices(size uint64) []uint64 {
	cands := []uint64{0, 1, 2, 127, 128, 254, 255, 256, 257, 511, 512, 1023, 1024, size / 2, size - 2, size - 1}
	seen := map[uint64]bool{}
	out := []uint64{}
	for _, c := range cands {
		if c < size && !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	// The candidate list is already in ascending order except for the derived
	// values, so sort to keep the output stable regardless of size.
	sortU64(out)
	return out
}

func sortU64(s []uint64) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

// --- consistency ---

type consistencyCase struct {
	Size1 U64   `json:"size1"`
	Size2 U64   `json:"size2"`
	Proof []Hex `json:"proof"`
}

type rootBySize struct {
	Size U64 `json:"size"`
	Root Hex `json:"root"`
}

type proofConsistencyFixture struct {
	header
	EntryScheme string            `json:"entryScheme"`
	Roots       []rootBySize      `json:"roots"`
	Cases       []consistencyCase `json:"cases"`
	LargeCases  []consistencyCase `json:"largeCases"`
	Nodes       []proofNodesCase  `json:"nodes"`
	// VerifyErrors pins the messages VerifyConsistency produces for rejected
	// inputs; upstream asserts on them.
	VerifyErrors []consistencyVerifyErrCase `json:"verifyErrors"`
}

type consistencyVerifyErrCase struct {
	Desc       string `json:"desc"`
	Size1      U64    `json:"size1"`
	Size2      U64    `json:"size2"`
	Proof      []Hex  `json:"proof"`
	Root1      Hex    `json:"root1"`
	Root2      Hex    `json:"root2"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

func genProofConsistency() any {
	f := proofConsistencyFixture{
		header:      hdr("Merkle consistency proofs between every pair of sizes up to 40, plus selected large pairs.", "github.com/transparency-dev/merkle/proof"),
		EntryScheme: `leaf i is the UTF-8 bytes of "entry-<i>"`,
	}

	// One tree of the maximum size serves every (size1, size2) pair, because
	// the reference Tree can answer for any size <= its own.
	big := entryTree(smallTreeMax)
	for size := uint64(0); size <= smallTreeMax; size++ {
		f.Roots = append(f.Roots, rootBySize{Size: U64(size), Root: Hex(big.HashAt(size))})
	}
	for s2 := uint64(0); s2 <= smallTreeMax; s2++ {
		for s1 := uint64(0); s1 <= s2; s1++ {
			p, err := big.ConsistencyProof(s1, s2)
			if err != nil {
				panic(err)
			}
			f.Cases = append(f.Cases, consistencyCase{Size1: U64(s1), Size2: U64(s2), Proof: hexes(p)})
		}
	}

	// Large pairs. Building one 5000-leaf tree covers all of them.
	const largeMax = 5000
	huge := entryTree(largeMax)
	largePairs := [][2]uint64{}
	for _, s2 := range largeTreeSizes {
		for _, s1 := range []uint64{0, 1, 2, 127, 128, 255, 256, 257, 511, 512, 1000, 1024, 4999} {
			if s1 <= s2 {
				largePairs = append(largePairs, [2]uint64{s1, s2})
			}
		}
		largePairs = append(largePairs, [2]uint64{s2 - 1, s2}, [2]uint64{s2, s2})
	}
	seen := map[[2]uint64]bool{}
	for _, p := range largePairs {
		if seen[p] {
			continue
		}
		seen[p] = true
		pf, err := huge.ConsistencyProof(p[0], p[1])
		if err != nil {
			panic(err)
		}
		f.LargeCases = append(f.LargeCases, consistencyCase{Size1: U64(p[0]), Size2: U64(p[1]), Proof: hexes(pf)})
	}
	// largeTreeSizes ends at largeMax, so no separate entry for it is needed.
	for _, size := range largeTreeSizes {
		f.Roots = append(f.Roots, rootBySize{Size: U64(size), Root: Hex(huge.HashAt(size))})
	}

	for _, tc := range []struct{ s1, s2 uint64 }{
		{0, 0}, {0, 1}, {1, 1}, {1, 2}, {1, 3}, {2, 3}, {3, 7}, {4, 8}, {6, 8},
		{7, 8}, {8, 8}, {8, 9}, {17, 40}, {40, 40},
		{255, 256}, {256, 257}, {256, 512}, {1000, 1024},
		{1, math.MaxUint64}, {math.MaxUint64 - 1, math.MaxUint64},
		// Rejection: size1 > size2.
		{2, 1}, {40, 39}, {math.MaxUint64, 1},
	} {
		n, err := proof.Consistency(tc.s1, tc.s2)
		c := proofNodesCaseFrom(tc.s1, tc.s2, n, err)
		f.Nodes = append(f.Nodes, c)
	}

	// VerifyConsistency rejections.
	addErr := func(desc string, s1, s2 uint64, pf [][]byte, r1, r2 []byte) {
		err := proof.VerifyConsistency(rfc6962.DefaultHasher, s1, s2, pf, r1, r2)
		f.VerifyErrors = append(f.VerifyErrors, consistencyVerifyErrCase{
			Desc: desc, Size1: U64(s1), Size2: U64(s2), Proof: hexes(pf),
			Root1: Hex(r1), Root2: Hex(r2),
			WantErr: err != nil, WantErrMsg: errString(err),
		})
	}
	p37, err := big.ConsistencyProof(3, 7)
	if err != nil {
		panic(err)
	}
	r3, r7 := big.HashAt(3), big.HashAt(7)
	addErr("valid", 3, 7, p37, r3, r7)
	addErr("size2 < size1", 7, 3, p37, r7, r3)
	addErr("size1 == size2 with non-empty proof", 7, 7, p37, r7, r7)
	addErr("size1 == size2 with empty proof", 7, 7, nil, r7, r7)
	addErr("size1 == 0 with non-empty proof", 0, 7, p37, big.HashAt(0), r7)
	addErr("size1 == 0 with empty proof", 0, 7, nil, big.HashAt(0), r7)
	addErr("empty proof", 3, 7, nil, r3, r7)
	addErr("proof too short", 3, 7, p37[:1], r3, r7)
	addErr("proof too long", 3, 7, append(append([][]byte{}, p37...), p37[0]), r3, r7)

	return f
}

func genReferenceTree() referenceTree {
	inputs := testonly.LeafInputs()
	t := testonly.New(rfc6962.DefaultHasher)
	t.AppendData(inputs...)

	rt := referenceTree{Leaves: hexes(inputs)}
	for size := uint64(0); size <= uint64(len(inputs)); size++ {
		rt.RootsBySize = append(rt.RootsBySize, Hex(t.HashAt(size)))
	}
	for size := uint64(1); size <= uint64(len(inputs)); size++ {
		tree := inclusionTree{Size: U64(size), Root: Hex(t.HashAt(size))}
		for i := uint64(0); i < size; i++ {
			p, err := t.InclusionProof(i, size)
			if err != nil {
				panic(err)
			}
			tree.Proofs = append(tree.Proofs, inclusionProof{
				Index: U64(i), Leaf: Hex(inputs[i]),
				LeafHash: Hex(t.LeafHash(i)), Proof: hexes(p),
			})
		}
		rt.Proofs = append(rt.Proofs, tree)
	}
	for s2 := uint64(0); s2 <= uint64(len(inputs)); s2++ {
		for s1 := uint64(0); s1 <= s2; s1++ {
			p, err := t.ConsistencyProof(s1, s2)
			if err != nil {
				panic(err)
			}
			rt.Consistency = append(rt.Consistency, consistencyCase{Size1: U64(s1), Size2: U64(s2), Proof: hexes(p)})
		}
	}
	return rt
}
