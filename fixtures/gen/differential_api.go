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
	"bytes"

	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/api"
)

// genDiffAPI records api's HashTile and EntryBundle UnmarshalText over tiles
// and bundles of every size up to past the 256 the tlog-tiles spec allows, with
// truncations and stray bytes, and tessera.NewEntry around the 65535-byte limit
// of the uint16 length prefix.
func genDiffAPI() diffFile {
	r := newDiffRand(0xa91)

	var tiles [][]any
	tileSizes := []int{0, 1, 2, 31, 32, 33, 64, 255 * 32, 256 * 32, 256*32 + 1, 257 * 32, 300 * 32}
	for i := 0; i < scaled(40); i++ {
		tileSizes = append(tileSizes, r.Intn(258*32))
	}
	for _, n := range tileSizes {
		raw := randBytes(r, n)
		var t api.HashTile
		if err := t.UnmarshalText(raw); err != nil {
			tiles = append(tiles, []any{hx(raw), err.Error()})
			continue
		}
		tiles = append(tiles, []any{hx(raw), "", len(t.Nodes)})
	}

	var bundles [][]any
	counts := []int{0, 1, 2, 255, 256, 257, 300}
	for i := 0; i < scaled(40); i++ {
		counts = append(counts, r.Intn(260))
	}
	for _, c := range counts {
		var raw []byte
		for i := 0; i < c; i++ {
			raw = append(raw, tessera.NewEntry(randBytes(r, r.Intn(6))).MarshalBundleData(uint64(i))...)
		}
		for k := r.Intn(3); k > 0 && len(raw) > 0; k-- {
			switch r.Intn(3) {
			case 0:
				raw = raw[:r.Intn(len(raw))]
			case 1:
				raw = append(raw, randBytes(r, 1+r.Intn(3))...)
			default:
				raw[r.Intn(len(raw))] = byte(r.Intn(256))
			}
		}
		var b api.EntryBundle
		if err := b.UnmarshalText(raw); err != nil {
			bundles = append(bundles, []any{hx(raw), err.Error()})
			continue
		}
		entries := []string{}
		for _, e := range b.Entries {
			entries = append(entries, hx(e))
		}
		bundles = append(bundles, []any{hx(raw), "", entries})
	}

	// NewEntry with data of n copies of one byte, around the uint16 length
	// prefix limit. The bundle data is summarised by its length and its first and
	// last 16 bytes, since the input itself is a function of (byte, n).
	var entries [][]any
	for _, n := range []int{0, 1, 255, 256, 65534, 65535, 65536, 65537, 70000} {
		data := bytes.Repeat([]byte{0xab}, n)
		e := tessera.NewEntry(data)
		m := e.MarshalBundleData(7)
		head, tail := m, m
		if len(m) > 16 {
			head, tail = m[:16], m[len(m)-16:]
		}
		entries = append(entries, []any{"ab", n, len(m), hx(head), hx(tail), hx(e.LeafHash()), hx(e.Identity())})
	}

	return diffFile{
		description: "Differential corpus for api.HashTile.UnmarshalText and api.EntryBundle.UnmarshalText over tiles and bundles of up to 300 elements (the spec allows 256) with truncations and stray bytes, and tessera.NewEntry around the 65535-byte limit of a bundle entry's uint16 length prefix.",
		upstream:    "github.com/transparency-dev/tessera (api/state.go, entry.go)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"tiles":   []string{"rawHex", "err", "number of hashes"},
				"bundles": []string{"rawHex", "err", "entriesHex"},
				"entries": []string{"data byte (hex)", "data length n", "MarshalBundleData(7) length", "first 16 bytes", "last 16 bytes", "LeafHash", "Identity"},
			}),
			dRows("tiles", tiles),
			dRows("bundles", bundles),
			dRows("entries", entries),
		},
	}
}
