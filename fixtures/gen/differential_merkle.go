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
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"strings"

	"github.com/transparency-dev/merkle/compact"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
)

// The merkle corpora draw every input hash from a pool of seeded random 32-byte
// values recorded in the file, and refer to them by index, so a proof of 64
// hashes costs a few hundred bytes instead of four kilobytes. A reference is:
//   - an integer i >= 0: hashPool[i];
//   - an integer i < 0: oddPool[-1-i], a value whose length is not 32;
//   - a string: a hash in hex, used for a root that upstream itself computed
//     (the CalculatedRoot of an earlier RootMismatchError), which the next
//     record feeds back in so that verification reaches the success path.

const diffHashPoolSize = 256

type hashPool struct {
	pool [][]byte
	odd  [][]byte
}

func newHashPool(r *rand.Rand) *hashPool {
	p := &hashPool{}
	for i := 0; i < diffHashPoolSize; i++ {
		p.pool = append(p.pool, randBytes(r, 32))
	}
	for _, n := range []int{31, 33, 0, 1, 64} {
		p.odd = append(p.odd, randBytes(r, n))
	}
	return p
}

func (p *hashPool) get(ref any) []byte {
	switch v := ref.(type) {
	case int:
		if v >= 0 {
			return p.pool[v]
		}
		return p.odd[-1-v]
	case string:
		return mustHex(v)
	}
	panic(fmt.Sprintf("bad hash reference %v", ref))
}

func (p *hashPool) sections() []diffSection {
	pool := make([]string, len(p.pool))
	for i, h := range p.pool {
		pool[i] = hx(h)
	}
	odd := make([]string, len(p.odd))
	for i, h := range p.odd {
		odd[i] = hx(h)
	}
	return []diffSection{dValue("hashPool", pool), dValue("oddPool", odd)}
}

// verifyResult renders a verification outcome: "" for success, ["m", calcHex]
// for a RootMismatchError (whose ExpectedRoot is the root that was passed in),
// and the error text for any other error.
func verifyResult(err error) any {
	if err == nil {
		return ""
	}
	var mm proof.RootMismatchError
	if errors.As(err, &mm) {
		return []any{"m", hx(mm.CalculatedRoot)}
	}
	return err.Error()
}

// sampleU64Pair draws two values from the uint64 boundary distribution.
func sampleU64Pair(r *rand.Rand) (uint64, uint64) { return randU64(r), randU64(r) }

func canonicalInclusionLen(index, size uint64) int {
	n, err := proof.Inclusion(index, size)
	if err != nil {
		return 0
	}
	return len(n.IDs) - max(0, ephemSpan(n)-1)
}

func canonicalConsistencyLen(size1, size2 uint64) int {
	n, err := proof.Consistency(size1, size2)
	if err != nil {
		return 0
	}
	return len(n.IDs) - max(0, ephemSpan(n)-1)
}

func ephemSpan(n proof.Nodes) int {
	_, b, e := n.Ephem()
	return e - b
}

// refList builds a list of n pool references, with seeded odd-length entries
// when oddRate > 0.
func refList(r *rand.Rand, n int, oddRate int) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = r.Intn(diffHashPoolSize)
		if oddRate > 0 && r.Intn(oddRate) == 0 {
			out[i] = -1 - r.Intn(5)
		}
	}
	return out
}

func genDiffProofInclusion() diffFile {
	r := newDiffRand(0x1c1)
	pool := newHashPool(r)
	h := rfc6962.DefaultHasher
	var rows [][]any
	var texts [][]any
	addRow := func(index, size uint64, leaf any, proofRefs []any, root any) error {
		ps := make([][]byte, len(proofRefs))
		for i, ref := range proofRefs {
			ps[i] = pool.get(ref)
		}
		err := proof.VerifyInclusion(h, index, size, pool.get(leaf), ps, pool.get(root))
		res := verifyResult(err)
		var mm proof.RootMismatchError
		if errors.As(err, &mm) && len(texts) < 200 {
			texts = append(texts, []any{len(rows), err.Error()})
		}
		rows = append(rows, []any{u64s(index), u64s(size), leaf, proofRefs, root, res})
		return err
	}
	for i := 0; i < scaled(1800); i++ {
		index, size := sampleU64Pair(r)
		if r.Intn(5) != 0 && size > 0 {
			index %= size
		}
		l := canonicalInclusionLen(index, size)
		pl := l
		if r.Intn(3) == 0 {
			pl = max(0, l+r.Intn(4)-1)
		}
		var leaf any = r.Intn(diffHashPoolSize)
		if r.Intn(12) == 0 {
			leaf = -1 - r.Intn(5)
		}
		oddRate := 0
		if r.Intn(15) == 0 {
			oddRate = 4
		}
		refs := refList(r, pl, oddRate)
		var root any = r.Intn(diffHashPoolSize)
		if r.Intn(25) == 0 {
			root = -1 - r.Intn(5)
		}
		err := addRow(index, size, leaf, refs, root)
		var mm proof.RootMismatchError
		if errors.As(err, &mm) {
			// Feed upstream's calculated root back in: the success path.
			addRow(index, size, leaf, refs, hx(mm.CalculatedRoot))
		}
	}
	// Exhaustive over small trees: every index (and one past the end) of every
	// size up to 40, with the canonical proof length, so every proof shape is
	// verified once on the success path.
	for size := uint64(0); size <= 40; size++ {
		for index := uint64(0); index <= size; index++ {
			refs := refList(r, canonicalInclusionLen(index, size), 0)
			leaf := r.Intn(diffHashPoolSize)
			err := addRow(index, size, leaf, refs, r.Intn(diffHashPoolSize))
			var mm proof.RootMismatchError
			if errors.As(err, &mm) {
				addRow(index, size, leaf, refs, hx(mm.CalculatedRoot))
			}
		}
	}
	return diffFile{
		description: "Differential corpus for merkle/proof VerifyInclusion (and so RootFromInclusionProof) over random and exhaustive-small (index, size) pairs up to 2^64-1, with canonical and wrong proof lengths, wrong-size leaf hashes, a few wrong-size proof hashes and roots, and each mismatching case repeated with upstream's calculated root so that the success path is exercised.",
		upstream:    "github.com/transparency-dev/merkle/proof",
		sections: append(pool.sections(),
			dValue("columns", map[string]any{
				"cases":        []string{"index", "size", "leafHash ref", "proof refs", "root ref", "result (\"\": ok; [\"m\", calculatedRootHex]: RootMismatchError; otherwise the error text)"},
				"mismatchText": []string{"case number", "RootMismatchError.Error()"},
			}),
			dRows("cases", rows),
			dRows("mismatchText", texts),
		),
	}
}

func genDiffProofConsistency() diffFile {
	r := newDiffRand(0xc0c)
	pool := newHashPool(r)
	h := rfc6962.DefaultHasher
	var rows [][]any
	var texts [][]any
	addRow := func(size1, size2 uint64, proofRefs []any, root1, root2 any) error {
		ps := make([][]byte, len(proofRefs))
		for i, ref := range proofRefs {
			ps[i] = pool.get(ref)
		}
		err := proof.VerifyConsistency(h, size1, size2, ps, pool.get(root1), pool.get(root2))
		var mm proof.RootMismatchError
		if errors.As(err, &mm) && len(texts) < 200 {
			texts = append(texts, []any{len(rows), err.Error()})
		}
		rows = append(rows, []any{u64s(size1), u64s(size2), proofRefs, root1, root2, verifyResult(err)})
		return err
	}
	chase := func(size1, size2 uint64, refs []any, root1, root2 any) {
		err := addRow(size1, size2, refs, root1, root2)
		var mm proof.RootMismatchError
		if !errors.As(err, &mm) {
			return
		}
		// root1 := calculated root: verification moves on to the second root.
		calc1 := hx(mm.CalculatedRoot)
		err = addRow(size1, size2, refs, calc1, root2)
		if !errors.As(err, &mm) || size1 == size2 {
			return
		}
		// root2 := calculated root as well: the success path.
		addRow(size1, size2, refs, calc1, hx(mm.CalculatedRoot))
	}
	for i := 0; i < scaled(1500); i++ {
		s1, s2 := sampleU64Pair(r)
		if r.Intn(6) != 0 && s1 > s2 {
			s1, s2 = s2, s1
		}
		l := canonicalConsistencyLen(s1, s2)
		pl := l
		if r.Intn(3) == 0 {
			pl = max(0, l+r.Intn(4)-1)
		}
		oddRate := 0
		if r.Intn(15) == 0 {
			oddRate = 4
		}
		root1, root2 := any(r.Intn(diffHashPoolSize)), any(r.Intn(diffHashPoolSize))
		if r.Intn(8) == 0 {
			root2 = root1
		}
		if r.Intn(25) == 0 {
			root1 = -1 - r.Intn(5)
		}
		chase(s1, s2, refList(r, pl, oddRate), root1, root2)
	}
	for s2 := uint64(0); s2 <= 24; s2++ {
		for s1 := uint64(0); s1 <= s2+1; s1++ {
			chase(s1, s2, refList(r, canonicalConsistencyLen(s1, s2), 0), r.Intn(diffHashPoolSize), r.Intn(diffHashPoolSize))
		}
	}
	return diffFile{
		description: "Differential corpus for merkle/proof VerifyConsistency over random and exhaustive-small (size1, size2) pairs up to 2^64-1, with canonical and wrong proof lengths, equal roots, a few wrong-size hashes, and each mismatching case repeated with upstream's calculated roots so that the second-root check and the success path are exercised.",
		upstream:    "github.com/transparency-dev/merkle/proof",
		sections: append(pool.sections(),
			dValue("columns", map[string]any{
				"cases":        []string{"size1", "size2", "proof refs", "root1 ref", "root2 ref", "result (\"\": ok; [\"m\", calculatedRootHex]: RootMismatchError against the root it was checked against; otherwise the error text)"},
				"mismatchText": []string{"case number", "RootMismatchError.Error()"},
			}),
			dRows("cases", rows),
			dRows("mismatchText", texts),
		),
	}
}

// nodeIDsString renders node IDs as "level:index" pairs joined by spaces.
func nodeIDsString(ids []compact.NodeID) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprintf("%d:%d", id.Level, id.Index)
	}
	return strings.Join(parts, " ")
}

func genDiffProofNodes() diffFile {
	r := newDiffRand(0x40de5)
	pool := newHashPool(r)
	hc := rfc6962.DefaultHasher.HashChildren
	// rehashOut renders Rehash's output: an input passed through is its pool
	// index, a hash Rehash computed is hex.
	nodesRow := func(n proof.Nodes, err error, withRehash bool) []any {
		if err != nil {
			return []any{err.Error()}
		}
		e, b, en := n.Ephem()
		row := []any{"", nodeIDsString(n.IDs), b, en, fmt.Sprintf("%d:%d", e.Level, e.Index)}
		if withRehash {
			in := make([][]byte, len(n.IDs))
			for i := range in {
				in[i] = pool.pool[i%diffHashPoolSize]
			}
			// Rehash reuses its input slice for its output, so it gets a copy.
			out, err := n.Rehash(append([][]byte{}, in...), hc)
			if err != nil {
				panic(err)
			}
			refs := make([]any, len(out))
			for i, o := range out {
				refs[i] = hx(o)
				for j, p := range pool.pool {
					if bytes.Equal(o, p) {
						refs[i] = j
						break
					}
				}
			}
			row = append(row, refs)
		}
		return row
	}
	var incl, cons, rehashLen [][]any
	for size := uint64(0); size <= 40; size++ {
		for index := uint64(0); index <= size; index++ {
			n, err := proof.Inclusion(index, size)
			incl = append(incl, append([]any{u64s(index), u64s(size)}, nodesRow(n, err, true)...))
		}
		for s1 := uint64(0); s1 <= size+1; s1++ {
			n, err := proof.Consistency(s1, size)
			cons = append(cons, append([]any{u64s(s1), u64s(size)}, nodesRow(n, err, true)...))
		}
	}
	for i := 0; i < scaled(600); i++ {
		index, size := sampleU64Pair(r)
		if r.Intn(3) != 0 && size > 0 {
			index %= size
		}
		n, err := proof.Inclusion(index, size)
		incl = append(incl, append([]any{u64s(index), u64s(size)}, nodesRow(n, err, i%4 == 0)...))
		s1, s2 := sampleU64Pair(r)
		if r.Intn(4) != 0 && s1 > s2 {
			s1, s2 = s2, s1
		}
		n, err = proof.Consistency(s1, s2)
		cons = append(cons, append([]any{u64s(s1), u64s(s2)}, nodesRow(n, err, i%4 == 0)...))
	}
	for i := 0; i < 60; i++ {
		size := uint64(r.Intn(100)) + 2
		index := uint64(r.Intn(int(size)))
		n, _ := proof.Inclusion(index, size)
		k := max(0, len(n.IDs)+r.Intn(5)-2)
		_, err := n.Rehash(append([][]byte{}, pool.pool[:k]...), hc)
		rehashLen = append(rehashLen, []any{u64s(index), u64s(size), k, errString(err)})
	}
	return diffFile{
		description: "Differential corpus for merkle/proof Inclusion and Consistency: the node IDs, the ephemeral node and its child span, and Rehash's output (inputs taken from the hash pool in order), exhaustively for trees up to 40 and for random sizes up to 2^64-1; and Rehash's length check.",
		upstream:    "github.com/transparency-dev/merkle/proof",
		sections: []diffSection{
			dValue("hashPool", pool.sections()[0].value),
			dValue("columns", map[string]any{
				"inclusion":   []string{"index", "size", "err", "ids (level:index ...)", "ephem begin", "ephem end", "ephem level:index", "Rehash(hashPool[0..len(ids)) mod 256) output: pool index if passed through, hex if computed (absent if not recorded)"},
				"consistency": []string{"size1", "size2", "err", "ids", "ephem begin", "ephem end", "ephem level:index", "Rehash output"},
				"rehashLen":   []string{"index", "size", "number of hashes passed", "err"},
			}),
			dRows("inclusion", incl),
			dRows("consistency", cons),
			dRows("rehashLen", rehashLen),
		},
	}
}

// h16 renders the first eight bytes of a hash, which is how the compact range
// traces record intermediate node hashes to stay small. Root hashes are always
// recorded in full.
func h16(b []byte) string {
	if len(b) > 8 {
		b = b[:8]
	}
	return hx(b)
}

func diffLeafHash(i uint64) []byte {
	return rfc6962.DefaultHasher.HashLeaf(binary.BigEndian.AppendUint64(nil, i))
}

func genDiffCompact() diffFile {
	r := newDiffRand(0xc0ac7)
	vals := interestingU64()
	for i := 0; i < 400; i++ {
		vals = append(vals, randU64(r))
	}
	sample := func() uint64 { return vals[r.Intn(len(vals))] }

	var decs, rns, nodes [][]any
	for i := 0; i < scaled(3000); i++ {
		b, e := sample(), sample()
		if r.Intn(4) != 0 && b > e {
			b, e = e, b
		}
		lft, rgt := compact.Decompose(b, e)
		decs = append(decs, []any{u64s(b), u64s(e), u64s(lft), u64s(rgt)})
	}
	for i := 0; i < scaled(800); i++ {
		b, e := sample(), sample()
		if b > e {
			b, e = e, b
		}
		rns = append(rns, []any{u64s(b), u64s(e), compact.RangeSize(b, e), nodeIDsString(compact.RangeNodes(b, e, nil))})
	}
	for i := 0; i < scaled(1500); i++ {
		lvl := uint(r.Intn(64))
		idx := sample()
		id := compact.NewNodeID(lvl, idx)
		p, s := id.Parent(), id.Sibling()
		cb, ce := id.Coverage()
		nodes = append(nodes, []any{lvl, u64s(idx), p.Level, u64s(p.Index), s.Level, u64s(s.Index), u64s(cb), u64s(ce)})
	}

	factory := &compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren}
	type visit = string
	visitStr := func(id compact.NodeID, h []byte) visit { return fmt.Sprintf("%d:%d:%s", id.Level, id.Index, h16(h)) }
	hashesStr := func(r *compact.Range) string {
		parts := make([]string, len(r.Hashes()))
		for i, h := range r.Hashes() {
			parts[i] = h16(h)
		}
		return strings.Join(parts, " ")
	}
	safe := func(f func() error) (err error, panicked string) {
		defer func() {
			if x := recover(); x != nil {
				panicked = fmt.Sprint(x)
			}
		}()
		return f(), ""
	}

	begins := []uint64{0, 1, 2, 3, 5, 7, 8, 13, 255, 256, 1<<32 - 3, 1 << 32, 1<<63 - 20, 1<<63 - 1, 1 << 63, 1<<63 + 1, 1<<63 + 5, math.MaxUint64 - 40, math.MaxUint64 - 17, math.MaxUint64 - 8, math.MaxUint64 - 1, math.MaxUint64}
	for i := 0; i < 16; i++ {
		begins = append(begins, randU64(r))
	}

	// Sequential appends from each begin, with the visitor on two appends out of
	// three, then GetRootHash. Ranges starting within 40 of 2^64-1 are appended
	// past the end of the uint64 space, where upstream's end wraps to 0.
	var seq [][]any
	for _, b := range begins {
		rg := factory.NewEmptyRange(b)
		var steps [][]any
		n := 24
		if b > math.MaxUint64-40 {
			n = int(math.MaxUint64-b) + 3
		}
		for k := 0; k < n; k++ {
			idx := rg.End()
			var vis []string
			var visitor compact.VisitFn
			if k%3 != 2 {
				visitor = func(id compact.NodeID, h []byte) { vis = append(vis, visitStr(id, h)) }
			}
			err, pn := safe(func() error { return rg.Append(diffLeafHash(idx), visitor) })
			if vis == nil {
				vis = []string{}
			}
			steps = append(steps, []any{u64s(idx), boolInt(visitor != nil), errString(err), pn, u64s(rg.Begin()), u64s(rg.End()), hashesStr(rg), strings.Join(vis, " ")})
			if pn != "" {
				break
			}
		}
		var rootVis []string
		root, err := rg.GetRootHash(func(id compact.NodeID, h []byte) { rootVis = append(rootVis, visitStr(id, h)) })
		seq = append(seq, []any{u64s(b), steps, errString(err), hx(root), boolInt(root == nil), strings.Join(rootVis, " ")})
	}

	// Recursive random merges: [b, e) is built by splitting at seeded midpoints
	// and merging the halves with AppendRange.
	var merges [][]any
	for i := 0; i < scaled(150); i++ {
		b := begins[r.Intn(len(begins))]
		span := uint64(r.Intn(48))
		if b > math.MaxUint64-span {
			span = math.MaxUint64 - b
		}
		e := b + span
		var mids []string
		var vis []string
		vf := func(id compact.NodeID, h []byte) { vis = append(vis, visitStr(id, h)) }
		var build func(lo, hi uint64) *compact.Range
		build = func(lo, hi uint64) *compact.Range {
			rg := factory.NewEmptyRange(lo)
			if hi == lo {
				return rg
			}
			if hi == lo+1 {
				if err := rg.Append(diffLeafHash(lo), vf); err != nil {
					panic(err)
				}
				return rg
			}
			mid := lo + uint64(r.Int63n(int64(hi-lo)))
			mids = append(mids, u64s(mid))
			left, right := build(lo, mid), build(mid, hi)
			if err := rg.AppendRange(left, vf); err != nil {
				panic(err)
			}
			if err := rg.AppendRange(right, vf); err != nil {
				panic(err)
			}
			return rg
		}
		rg := build(b, e)
		full := make([]string, len(rg.Hashes()))
		for k, h := range rg.Hashes() {
			full[k] = hx(h)
		}
		if mids == nil {
			mids = []string{}
		}
		merges = append(merges, []any{u64s(b), u64s(e), mids, strings.Join(full, " "), strings.Join(vis, " ")})
	}

	// AppendRange of ranges that may be disjoint, or carry too few hashes.
	var mergeErrs [][]any
	for i := 0; i < scaled(200); i++ {
		b := begins[r.Intn(len(begins))]
		m := b + uint64(r.Intn(20))
		e := m + uint64(r.Intn(20))
		ob := m + uint64(r.Intn(3))
		oe := e + uint64(r.Intn(3))
		if m < b || e < m || ob < m || oe < e || oe < ob {
			continue
		}
		left := factory.NewEmptyRange(b)
		for k := b; k < m; k++ {
			left.Append(diffLeafHash(k), nil)
		}
		// The right range is rebuilt from a possibly truncated hash list.
		full := factory.NewEmptyRange(ob)
		for k := ob; k < oe; k++ {
			full.Append(diffLeafHash(k), nil)
		}
		hs := full.Hashes()
		drop := 0
		if r.Intn(3) == 0 && len(hs) > 0 {
			drop = 1 + r.Intn(len(hs))
		}
		right, err := factory.NewRange(ob, oe, hs[:len(hs)-drop])
		if err != nil {
			// NewRange refuses the truncated list; merge the full one instead.
			right, drop = full, 0
		}
		var vis []string
		err, pn := safe(func() error {
			return left.AppendRange(right, func(id compact.NodeID, h []byte) { vis = append(vis, visitStr(id, h)) })
		})
		mergeErrs = append(mergeErrs, []any{u64s(b), u64s(m), u64s(ob), u64s(oe), drop, errString(err), pn, u64s(left.Begin()), u64s(left.End()), hashesStr(left), strings.Join(vis, " ")})
	}

	// NewRange validation.
	var newRange [][]any
	for i := 0; i < scaled(400); i++ {
		b, e := randU64(r), randU64(r)
		if r.Intn(2) == 0 && b > e {
			b, e = e, b
		}
		nh := r.Intn(10)
		if r.Intn(2) == 0 && b <= e {
			nh = compact.RangeSize(b, e)
		}
		hs := make([][]byte, nh)
		for k := range hs {
			hs[k] = diffLeafHash(uint64(k))
		}
		_, err := factory.NewRange(b, e, hs)
		newRange = append(newRange, []any{u64s(b), u64s(e), nh, errString(err)})
	}

	return diffFile{
		description: "Differential corpus for merkle/compact: Decompose (including begin > end, whose output upstream leaves unspecified), RangeNodes and RangeSize, NodeID Parent/Sibling/Coverage, and Range traces: sequential Append from begins up to 2^64-1 and past it (every visited node, the hashes after each step, GetRootHash and its visits), recursive AppendRange merges, AppendRange errors for disjoint and truncated ranges, and NewRange validation. Leaf i is rfc6962 HashLeaf of i as 8 big-endian bytes; intermediate node hashes are recorded by their first 8 bytes, merge results and roots in full.",
		upstream:    "github.com/transparency-dev/merkle/compact",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"decompose":  []string{"begin", "end", "left", "right"},
				"rangeNodes": []string{"begin", "end", "RangeSize", "RangeNodes (level:index ...)"},
				"nodeID":     []string{"level", "index", "parent level", "parent index", "sibling level", "sibling index", "coverage begin", "coverage end"},
				"sequential": []string{"begin", "steps [leaf index, visitor used, err, panic, begin, end, hashes (8-byte prefixes), visits (level:index:prefix ...)]", "GetRootHash err", "root hex", "root is nil", "root visits"},
				"merges":     []string{"begin", "end", "split points in build order", "final hashes (full hex)", "visits"},
				"mergeErrs":  []string{"left begin", "left end", "right begin", "right end", "hashes dropped from the right range", "err", "panic", "begin after", "end after", "hashes after", "visits"},
				"newRange":   []string{"begin", "end", "number of hashes", "err"},
			}),
			dRows("decompose", decs),
			dRows("rangeNodes", rns),
			dRows("nodeID", nodes),
			dRows("sequential", seq),
			dRows("merges", merges),
			dRows("mergeErrs", mergeErrs),
			dRows("newRange", newRange),
		},
	}
}

func genDiffRFC6962() diffFile {
	r := newDiffRand(0x6962)
	h := rfc6962.DefaultHasher
	var leaves [][]any
	lengths := []int{}
	for n := 0; n <= 140; n++ {
		lengths = append(lengths, n)
	}
	lengths = append(lengths, 183, 184, 191, 192, 247, 248, 255, 256, 511, 512, 1000, 1023, 1024, 4095, 4096)
	for i := 0; i < scaled(80); i++ {
		lengths = append(lengths, r.Intn(1500))
	}
	for _, n := range lengths {
		in := randBytes(r, n)
		leaves = append(leaves, []any{hx(in), hx(h.HashLeaf(in))})
	}
	var children [][]any
	for i := 0; i < scaled(200); i++ {
		ln, rn := 32, 32
		if r.Intn(5) == 0 {
			ln, rn = r.Intn(70), r.Intn(70)
		}
		a, b := randBytes(r, ln), randBytes(r, rn)
		children = append(children, []any{hx(a), hx(b), hx(h.HashChildren(a, b))})
	}
	return diffFile{
		description: "Differential corpus for merkle/rfc6962: HashLeaf over every input length up to 140 bytes, the SHA-256 block boundaries and random lengths, HashChildren over 32-byte and odd-length children, and EmptyRoot.",
		upstream:    "github.com/transparency-dev/merkle/rfc6962",
		sections: []diffSection{
			dValue("columns", map[string]any{"leaf": []string{"inputHex", "HashLeaf"}, "children": []string{"leftHex", "rightHex", "HashChildren"}}),
			dValue("emptyRoot", hx(h.EmptyRoot())),
			dRows("leaf", leaves),
			dRows("children", children),
		},
	}
}
