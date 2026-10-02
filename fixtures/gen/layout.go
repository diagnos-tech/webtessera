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
	"math"

	"github.com/transparency-dev/tessera/api/layout"
)

// The matrices below are deliberately dominated by boundaries: the tile width
// (256), its neighbours, the three-decimal-digit grouping boundaries of the
// tlog-tiles path encoding (1000, 1000000), the 16-bit boundary, and
// math.MaxUint64. Interior values rarely catch a port bug; edges always do.
var (
	tileLevels = []uint64{0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 63}

	tileIndices = []uint64{
		0, 1, 2, 255, 256, 257,
		998, 999, 1000, 1001,
		65535, 65536, 65537,
		999999, 1000000, 1000001,
		1234067, 123456789, 455667,
		999999999999999999,
		math.MaxUint64 - 1, math.MaxUint64,
	}

	partialSizes = []uint8{0, 1, 2, 41, 65, 89, 127, 128, 253, 254, 255}

	logSizes = []uint64{
		0, 1, 2, 111, 255, 256, 257, 511, 512, 513,
		1000, 65535, 65536, 65537,
		1 << 20,
		math.MaxUint64,
	}
)

// --- TilePath / EntriesPath / NWithSuffix / EntriesPathForLogIndex ---

type nWithSuffixCase struct {
	Level U64    `json:"level"`
	Index U64    `json:"index"`
	P     int    `json:"p"`
	Want  string `json:"want"`
}

type tilePathCase struct {
	TileLevel U64    `json:"tileLevel"`
	TileIndex U64    `json:"tileIndex"`
	P         int    `json:"p"`
	Want      string `json:"want"`
}

type entriesPathCase struct {
	N    U64    `json:"n"`
	P    int    `json:"p"`
	Want string `json:"want"`
}

type entriesPathForLogIndexCase struct {
	Seq     U64    `json:"seq"`
	LogSize U64    `json:"logSize"`
	Want    string `json:"want"`
}

type layoutPathsFixture struct {
	header
	// CheckpointPath is layout.CheckpointPath, pinned so the port cannot drift
	// on the one path that is a bare constant.
	CheckpointPath         string                       `json:"checkpointPath"`
	NWithSuffix            []nWithSuffixCase            `json:"nWithSuffix"`
	TilePath               []tilePathCase               `json:"tilePath"`
	EntriesPath            []entriesPathCase            `json:"entriesPath"`
	EntriesPathForLogIndex []entriesPathForLogIndexCase `json:"entriesPathForLogIndex"`
}

func genLayoutPaths() any {
	f := layoutPathsFixture{
		header:         hdr("Path construction for the tlog-tiles API.", "github.com/transparency-dev/tessera/api/layout"),
		CheckpointPath: layout.CheckpointPath,
	}

	// NWithSuffix takes a level but does not use it. A couple of levels are
	// still exercised so a port that starts using the parameter is caught.
	for _, l := range []uint64{0, 1, 63} {
		for _, i := range tileIndices {
			for _, p := range partialSizes {
				f.NWithSuffix = append(f.NWithSuffix, nWithSuffixCase{
					Level: U64(l), Index: U64(i), P: int(p),
					Want: layout.NWithSuffix(l, i, p),
				})
			}
		}
	}

	for _, l := range tileLevels {
		for _, i := range tileIndices {
			for _, p := range []uint8{0, 1, 41, 128, 255} {
				f.TilePath = append(f.TilePath, tilePathCase{
					TileLevel: U64(l), TileIndex: U64(i), P: int(p),
					Want: layout.TilePath(l, i, p),
				})
			}
		}
	}

	for _, n := range tileIndices {
		for _, p := range partialSizes {
			f.EntriesPath = append(f.EntriesPath, entriesPathCase{
				N: U64(n), P: int(p),
				Want: layout.EntriesPath(n, p),
			})
		}
	}

	// EntriesPathForLogIndex derives the partial suffix from the log size, so
	// the interesting axis is (seq, logSize) pairs that straddle a bundle
	// boundary. The upstream test's own cases are included verbatim.
	seqs := []uint64{
		0, 1, 3, 251, 255, 256, 257, 511, 512,
		65535, 65536,
		123456789 * 256,
		math.MaxUint64,
	}
	for _, seq := range seqs {
		for _, ls := range logSizes {
			f.EntriesPathForLogIndex = append(f.EntriesPathForLogIndex, entriesPathForLogIndexCase{
				Seq: U64(seq), LogSize: U64(ls),
				Want: layout.EntriesPathForLogIndex(seq, ls),
			})
		}
	}
	for _, tc := range []struct{ seq, logSize uint64 }{
		{0, 256}, {255, 256}, {251, 255}, {256, 512}, {3, 257}, {256, 257},
		{123456789 * 256, 123456790 * 256},
	} {
		f.EntriesPathForLogIndex = append(f.EntriesPathForLogIndex, entriesPathForLogIndexCase{
			Seq: U64(tc.seq), LogSize: U64(tc.logSize),
			Want: layout.EntriesPathForLogIndex(tc.seq, tc.logSize),
		})
	}

	return f
}

// --- ParseTileLevelIndexPartial ---

type parseCase struct {
	PathLevel string `json:"pathLevel"`
	PathIndex string `json:"pathIndex"`
	WantLevel U64    `json:"wantLevel"`
	WantIndex U64    `json:"wantIndex"`
	WantP     int    `json:"wantP"`
	WantErr   bool   `json:"wantErr"`
	// WantErrMsg is the exact error text upstream produces, or "" when
	// WantErr is false. The port throws an Error with this message.
	WantErrMsg string `json:"wantErrMsg"`
}

type parseLevelCase struct {
	PathLevel  string `json:"pathLevel"`
	WantLevel  U64    `json:"wantLevel"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type parseIndexCase struct {
	PathIndex  string `json:"pathIndex"`
	WantIndex  U64    `json:"wantIndex"`
	WantP      int    `json:"wantP"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type layoutParseFixture struct {
	header
	ParseTileLevelIndexPartial []parseCase      `json:"parseTileLevelIndexPartial"`
	ParseTileLevel             []parseLevelCase `json:"parseTileLevel"`
	ParseTileIndexPartial      []parseIndexCase `json:"parseTileIndexPartial"`
}

func genLayoutParse() any {
	f := layoutParseFixture{
		header: hdr("Parsing of tlog-tiles level/index/partial path components, including every rejection upstream performs.",
			"github.com/transparency-dev/tessera/api/layout"),
	}

	// Every (level, index) pair upstream's paths_test.go exercises, plus cases
	// covering rejections that test does not reach individually: index overflow
	// past MaxUint64, a partial width of zero, and non-canonical digit groups.
	pairs := []struct{ level, index string }{
		// Accepted by upstream.
		{"0", "x001/x234/067"},
		{"0", "x001/x234/067.p/89"},
		{"63", "x999/x999/x999/x999/x999/999.p/255"},
		{"0", "001"},
		{"0", "000"},
		{"0", "255"},
		{"0", "000.p/1"},
		{"0", "000.p/255"},
		{"1", "x000/000"},
		{"8", "x001/002"},
		{"63", "x184/x467/x440/x737/x095/x516/615"},
		{"63", "x018/x446/x744/x073/x709/x551/615"},
		// Rejected: malformed partial suffix.
		{"0", "x001/x234/067.p/"},
		{"0", "x001/x234/067.p"},
		{"0", "x001/x234/067.p/0"},
		{"0", "x001/x234/067.p/256"},
		{"0", "x001/x234/067.p/-1"},
		{"0", "x001/x234/067.p/abc"},
		{"1", "x001/.p/abc"},
		{"8", "x001/002.p/256"},
		{"8", "x001/002.p/0"},
		// Rejected: malformed index grouping.
		{"0", "x001/x234/"},
		{"0", "x001/x234"},
		{"0", "x001/"},
		{"0", "x001"},
		{"0", ""},
		{"0", "1"},
		{"0", "01"},
		{"0", "0001"},
		{"8", "001/002"},
		{"8", "x001/0002"},
		{"8", "x001/-002"},
		{"8", "x001/x002"},
		{"0", "x1/002"},
		// Rejected: level out of range or not a number.
		{"64", "x001/002"},
		{"-1", "x001/002"},
		{"abc", "x001/002"},
		{"", "000"},
		{"00", "000"},
		{"063", "000"},
		{"18446744073709551616", "000"},
		// Rejected: index arithmetic would overflow uint64.
		// MaxUint64 is 18446744073709551615, so x018/x446/.../615 is the
		// largest representable index and the group above it must fail.
		{"63", "x018/x446/x744/x073/x709/x551/616"},
		{"63", "x999/x999/x999/x999/x999/x999/999.p/255"},
		{"63", "x184/x467/x440/x737/x095/x516/x150/000"},
	}
	for _, p := range pairs {
		l, i, w, err := layout.ParseTileLevelIndexPartial(p.level, p.index)
		f.ParseTileLevelIndexPartial = append(f.ParseTileLevelIndexPartial, parseCase{
			PathLevel: p.level, PathIndex: p.index,
			WantLevel: U64(l), WantIndex: U64(i), WantP: int(w),
			WantErr: err != nil, WantErrMsg: errString(err),
		})
	}

	levels := []string{
		"0", "1", "8", "15", "31", "62", "63",
		"64", "65", "255", "-1", "abc", "", " 0", "0 ", "+0", "00", "007",
		"18446744073709551615", "18446744073709551616", "0x10",
	}
	for _, l := range levels {
		got, err := layout.ParseTileLevel(l)
		f.ParseTileLevel = append(f.ParseTileLevel, parseLevelCase{
			PathLevel: l, WantLevel: U64(got),
			WantErr: err != nil, WantErrMsg: errString(err),
		})
	}

	indices := []string{
		"000", "001", "255", "999",
		"x001/x234/067", "x001/x234/067.p/89", "x000/000",
		"x999/x999/x999/x999/x999/999.p/255",
		"x018/x446/x744/x073/x709/x551/615",
		"x018/x446/x744/x073/x709/x551/616",
		"x999/x999/x999/x999/x999/x999/999.p/255",
		"", "1", "01", "0001", "x1", "x01",
		"x001", "x001/", "x001/x234", "x001/x234/",
		"001/002", "x001/0002", "x001/-002", "x001/x002",
		"000.p/0", "000.p/1", "000.p/255", "000.p/256", "000.p/", "000.p",
		"000.p/abc", "000.p/-1", "000.p/+1",
	}
	for _, s := range indices {
		i, w, err := layout.ParseTileIndexPartial(s)
		f.ParseTileIndexPartial = append(f.ParseTileIndexPartial, parseIndexCase{
			PathIndex: s, WantIndex: U64(i), WantP: int(w),
			WantErr: err != nil, WantErrMsg: errString(err),
		})
	}

	return f
}

// --- PartialTileSize / NodeCoordsToTileAddress ---

type partialTileSizeCase struct {
	Level   U64 `json:"level"`
	Index   U64 `json:"index"`
	LogSize U64 `json:"logSize"`
	Want    int `json:"want"`
}

type nodeCoordsCase struct {
	TreeLevel U64 `json:"treeLevel"`
	TreeIndex U64 `json:"treeIndex"`
	TileLevel U64 `json:"tileLevel"`
	TileIndex U64 `json:"tileIndex"`
	NodeLevel int `json:"nodeLevel"`
	NodeIndex U64 `json:"nodeIndex"`
}

type layoutTileFixture struct {
	header
	TileHeight              int                   `json:"tileHeight"`
	TileWidth               int                   `json:"tileWidth"`
	EntryBundleWidth        int                   `json:"entryBundleWidth"`
	PartialTileSize         []partialTileSizeCase `json:"partialTileSize"`
	NodeCoordsToTileAddress []nodeCoordsCase      `json:"nodeCoordsToTileAddress"`
}

func genLayoutTile() any {
	f := layoutTileFixture{
		header:           hdr("Tile geometry: partial tile sizing and tree-node to tile-address mapping.", "github.com/transparency-dev/tessera/api/layout"),
		TileHeight:       layout.TileHeight,
		TileWidth:        layout.TileWidth,
		EntryBundleWidth: layout.EntryBundleWidth,
	}

	// Levels above 7 shift the log size by 64 or more bits. Go defines that as
	// zero rather than leaving it undefined, and a naive JavaScript port using
	// Number >> would wrap the shift count modulo 32 and get a wrong answer, so
	// those levels are pinned explicitly.
	ptLevels := []uint64{0, 1, 2, 3, 7, 8, 9, 16, 63}
	ptIndices := []uint64{0, 1, 2, 3, 255, 256, 1000, math.MaxUint64}
	ptLogSizes := []uint64{0, 1, 2, 255, 256, 257, 511, 512, 65535, 65536, 1 << 20, math.MaxUint64}
	for _, l := range ptLevels {
		for _, i := range ptIndices {
			for _, ls := range ptLogSizes {
				f.PartialTileSize = append(f.PartialTileSize, partialTileSizeCase{
					Level: U64(l), Index: U64(i), LogSize: U64(ls),
					Want: int(layout.PartialTileSize(l, i, ls)),
				})
			}
		}
	}

	ncLevels := []uint64{0, 1, 2, 7, 8, 9, 15, 16, 17, 63, 64}
	ncIndices := []uint64{0, 1, 2, 3, 127, 128, 129, 255, 256, 257, 65535, 65536, math.MaxUint64}
	for _, tl := range ncLevels {
		for _, ti := range ncIndices {
			tileLevel, tileIndex, nodeLevel, nodeIndex := layout.NodeCoordsToTileAddress(tl, ti)
			f.NodeCoordsToTileAddress = append(f.NodeCoordsToTileAddress, nodeCoordsCase{
				TreeLevel: U64(tl), TreeIndex: U64(ti),
				TileLevel: U64(tileLevel), TileIndex: U64(tileIndex),
				NodeLevel: int(nodeLevel), NodeIndex: U64(nodeIndex),
			})
		}
	}

	return f
}

// --- Range ---

type rangeInfo struct {
	Index   U64 `json:"index"`
	Partial int `json:"partial"`
	First   int `json:"first"`
	N       int `json:"n"`
}

type rangeCase struct {
	Desc     string      `json:"desc"`
	From     U64         `json:"from"`
	N        U64         `json:"n"`
	TreeSize U64         `json:"treeSize"`
	Want     []rangeInfo `json:"want"`
}

type layoutRangeFixture struct {
	header
	Cases []rangeCase `json:"cases"`
}

func genLayoutRange() any {
	f := layoutRangeFixture{
		header: hdr("layout.Range: the bundles and offsets covering [from, min(from+N, treeSize)).", "github.com/transparency-dev/tessera/api/layout"),
	}

	add := func(desc string, from, n, treeSize uint64) {
		// A non-nil empty slice keeps empty ranges as [] rather than null.
		want := []rangeInfo{}
		for ri := range layout.Range(from, n, treeSize) {
			want = append(want, rangeInfo{
				Index: U64(ri.Index), Partial: int(ri.Partial),
				First: int(ri.First), N: int(ri.N),
			})
		}
		f.Cases = append(f.Cases, rangeCase{
			Desc: desc, From: U64(from), N: U64(n), TreeSize: U64(treeSize), Want: want,
		})
	}

	// The upstream table, verbatim.
	add("from beyond extent", 10, 1, 5)
	add("range end beyond extent", 3, 100, 5)
	add("empty range", 1, 0, 2)
	add("ok: full first bundle", 0, 256, 257)
	add("ok: entire single (partial) bundle", 20, 90, 111)
	add("ok: slice from single bundle with initial offset", 20, 90, 1<<20)
	add("ok: multiple bundles, first is full, last is truncated", 0, 4*256+42, 1<<20)
	add("ok: multiple bundles, first is offset, last is truncated", 2, 4*256+4, 1<<20)
	add("ok: offset and trucated from single bundle in middle of tree", 8*256+66, 4, 1<<20)

	// Additional boundary coverage: zero-sized trees, from == treeSize, ranges
	// that stop exactly on a bundle boundary, and single-bundle ranges.
	add("empty tree", 0, 1, 0)
	add("from == treeSize", 5, 1, 5)
	add("from == treeSize-1", 4, 1, 5)
	add("N covers whole tree of 1", 0, 1, 1)
	add("N covers whole tree of 256", 0, 256, 256)
	add("N covers whole tree of 257", 0, 257, 257)
	add("single entry in last partial bundle", 256, 1, 257)
	add("exactly one full bundle mid-tree", 256, 256, 1024)
	add("range ends on bundle boundary", 0, 512, 1024)
	add("range starts on bundle boundary", 512, 512, 1024)
	add("single entry at bundle boundary", 255, 1, 1024)
	add("single entry after bundle boundary", 256, 1, 1024)
	add("spans two bundles by one entry each", 255, 2, 1024)
	add("N larger than tree from zero", 0, 1<<20, 1000)
	add("last bundle partial, N overshoots", 900, 1000, 1000)
	add("tree of 65536, mid slice", 65000, 500, 65536)
	add("tree of 65537, final partial bundle", 65536, 1, 65537)
	add("N zero at zero", 0, 0, 1000)

	return f
}
