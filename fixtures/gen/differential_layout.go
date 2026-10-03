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
	"math/rand"
	"strings"

	"github.com/transparency-dev/tessera/api/layout"
)

// genDiffLayout records api/layout's tlog-tiles path parsers over generated
// path segments built from the tokens the parsers branch on, and its path
// builders, tile arithmetic and Range over random uint64 coordinates.
func genDiffLayout() diffFile {
	r := newDiffRand(0x1a7047)
	tokens := []string{
		"000", "001", "999", "256", "255", "1000", "00", "0", "1", "x", "x", "/", "/", ".p", ".p/", "p", "-", "+",
		"_", " ", "\t", "18446744073709551615", "18446744073709551616", "99999999999999999999", "x001/", "x999/",
		"1234", "٣", "０", "..", "x.p", "/x", "\n",
	}
	gen := func() string {
		var b strings.Builder
		for n := 1 + r.Intn(6); n > 0; n-- {
			b.WriteString(tokens[r.Intn(len(tokens))])
		}
		return b.String()
	}
	structured := func(r *rand.Rand) string {
		// A well-formed index path (up to seven groups) and an optional partial
		// width, then one seeded corruption half of the time.
		groups := 1 + r.Intn(7)
		parts := make([]string, groups)
		for i := range parts {
			parts[i] = []string{"000", "001", "999", "123", "500"}[r.Intn(5)]
			if i < groups-1 {
				parts[i] = "x" + parts[i]
			}
		}
		s := strings.Join(parts, "/")
		if r.Intn(2) == 0 {
			s += ".p/" + []string{"1", "255", "256", "0", "128", "01", "+1"}[r.Intn(7)]
		}
		if r.Intn(2) == 0 {
			i := r.Intn(len(s) + 1)
			s = s[:i] + tokens[r.Intn(len(tokens))] + s[i:]
		}
		return s
	}

	var indexRows, levelRows, levelIndexRows [][]any
	seen := map[string]bool{}
	addIndex := func(s string) {
		if seen[s] {
			return
		}
		seen[s] = true
		i, w, err := layout.ParseTileIndexPartial(s)
		if err != nil {
			indexRows = append(indexRows, []any{s, err.Error()})
			return
		}
		indexRows = append(indexRows, []any{s, "", u64s(i), w})
	}
	for _, s := range []string{"", "000", "x000/000", "x18446744073709551615/000", "x018/446/744/073/709/551/615", "x018/446/744/073/709/551/616", "x018/446/744/073/709/551/615.p/255", "999.p/0", "999.p/256"} {
		addIndex(s)
	}
	for i := 0; i < scaled(2500); i++ {
		addIndex(gen())
		addIndex(structured(r))
	}
	levels := []string{"", "0", "63", "64", "00", "01", "-1", "+1", " 1", "1 ", "18446744073709551615", "18446744073709551616", "0x1", "٣", "1e1"}
	for i := 0; i < scaled(300); i++ {
		levels = append(levels, gen())
	}
	for _, l := range levels {
		v, err := layout.ParseTileLevel(l)
		if err != nil {
			levelRows = append(levelRows, []any{l, err.Error()})
		} else {
			levelRows = append(levelRows, []any{l, "", u64s(v)})
		}
	}
	for i := 0; i < scaled(300); i++ {
		l := levels[r.Intn(len(levels))]
		idx := structured(r)
		lv, iv, w, err := layout.ParseTileLevelIndexPartial(l, idx)
		if err != nil {
			levelIndexRows = append(levelIndexRows, []any{l, idx, err.Error()})
		} else {
			levelIndexRows = append(levelIndexRows, []any{l, idx, "", u64s(lv), u64s(iv), w})
		}
	}

	// Builders and arithmetic over random coordinates.
	var pathRows, tileRows, rangeRows [][]any
	for i := 0; i < scaled(1500); i++ {
		level := uint64(r.Intn(70))
		if r.Intn(10) == 0 {
			level = randU64(r)
		}
		index := randU64(r)
		p := uint8(r.Intn(256))
		if r.Intn(3) == 0 {
			p = 0
		}
		logSize := randU64(r)
		pathRows = append(pathRows, []any{u64s(level), u64s(index), p, layout.TilePath(level, index, p), layout.EntriesPath(index, p), layout.NWithSuffix(level, index, p), u64s(logSize), layout.EntriesPathForLogIndex(index, logSize)})
		tl, ti, nl, ni := layout.NodeCoordsToTileAddress(level, index)
		tileRows = append(tileRows, []any{u64s(level), u64s(index), u64s(logSize), layout.PartialTileSize(level, index, logSize), u64s(tl), u64s(ti), nl, u64s(ni)})
	}
	for i := 0; i < scaled(800); i++ {
		from, n, size := randU64(r), randU64(r), randU64(r)
		if r.Intn(2) == 0 {
			n = uint64(r.Intn(1000))
		}
		if r.Intn(3) == 0 && size > 0 {
			from %= size
		}
		var items [][]any
		for ri := range layout.Range(from, n, size) {
			items = append(items, []any{u64s(ri.Index), ri.Partial, u64s(uint64(ri.First)), u64s(uint64(ri.N))})
			if len(items) == 6 {
				break
			}
		}
		if items == nil {
			items = [][]any{}
		}
		rangeRows = append(rangeRows, []any{u64s(from), u64s(n), u64s(size), items})
	}

	return diffFile{
		description: "Differential corpus for api/layout: ParseTileIndexPartial, ParseTileLevel and ParseTileLevelIndexPartial over generated path segments (accept/reject, exact error text, values), and TilePath, EntriesPath, NWithSuffix, EntriesPathForLogIndex, PartialTileSize, NodeCoordsToTileAddress and the first six items of Range over random uint64 coordinates.",
		upstream:    "github.com/transparency-dev/tessera/api/layout",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"index":      []string{"index", "err", "tileIndex", "partialWidth"},
				"level":      []string{"level", "err", "tileLevel"},
				"levelIndex": []string{"level", "index", "err", "tileLevel", "tileIndex", "partialWidth"},
				"paths":      []string{"level", "index", "p", "TilePath", "EntriesPath(index, p)", "NWithSuffix(level, index, p)", "logSize", "EntriesPathForLogIndex(index, logSize)"},
				"tiles":      []string{"level", "index", "logSize", "PartialTileSize", "tileLevel", "tileIndex", "nodeLevel", "nodeIndex (NodeCoordsToTileAddress)"},
				"range":      []string{"from", "N", "treeSize", "first six items [index, partial, first, n]"},
			}),
			dRows("index", indexRows),
			dRows("level", levelRows),
			dRows("levelIndex", levelIndexRows),
			dRows("paths", pathRows),
			dRows("tiles", tileRows),
			dRows("range", rangeRows),
		},
	}
}
