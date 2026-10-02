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
	"encoding/binary"
	"fmt"

	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/api"
)

type hashTileMarshalCase struct {
	Desc  string `json:"desc"`
	Nodes []Hex  `json:"nodes"`
	// Want is the marshalled tile: the node hashes concatenated.
	Want Hex `json:"want"`
}

type hashTileUnmarshalCase struct {
	Desc string `json:"desc"`
	Raw  Hex    `json:"raw"`
	// WantNodes is the decoded node list, empty when WantErr is true.
	WantNodes  []Hex  `json:"wantNodes"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type apiHashTileFixture struct {
	header
	Marshal   []hashTileMarshalCase   `json:"marshal"`
	Unmarshal []hashTileUnmarshalCase `json:"unmarshal"`
}

func genAPIHashTile() any {
	f := apiHashTileFixture{
		header: hdr("api.HashTile MarshalText/UnmarshalText, including the inputs upstream rejects.", "github.com/transparency-dev/tessera/api"),
	}

	marshal := func(desc string, nodes [][]byte) []byte {
		raw, err := api.HashTile{Nodes: nodes}.MarshalText()
		if err != nil {
			panic(err)
		}
		f.Marshal = append(f.Marshal, hashTileMarshalCase{Desc: desc, Nodes: hexes(nodes), Want: Hex(raw)})
		return raw
	}

	unmarshal := func(desc string, raw []byte) {
		t := api.HashTile{}
		err := t.UnmarshalText(raw)
		c := hashTileUnmarshalCase{
			Desc: desc, Raw: Hex(raw),
			WantNodes: hexes(t.Nodes),
			WantErr:   err != nil, WantErrMsg: errString(err),
		}
		if err != nil {
			// On error upstream leaves Nodes untouched; do not imply otherwise.
			c.WantNodes = []Hex{}
		}
		f.Unmarshal = append(f.Unmarshal, c)
	}

	// Real leaf hashes, so the tiles here are the same bytes a real log writes.
	leafHashes := make([][]byte, 0, 256)
	for i := uint64(0); i < 256; i++ {
		leafHashes = append(leafHashes, rfc6962.DefaultHasher.HashLeaf(entryData(i)))
	}

	empty := marshal("empty tile", nil)
	one := marshal("single node", leafHashes[:1])
	two := marshal("two nodes", leafHashes[:2])
	partial := marshal("partial tile of 41", leafHashes[:41])
	almost := marshal("partial tile of 255", leafHashes[:255])
	full := marshal("full tile of 256", leafHashes)

	// Round trips.
	unmarshal("empty", empty)
	unmarshal("single node", one)
	unmarshal("two nodes", two)
	unmarshal("partial tile of 41", partial)
	unmarshal("partial tile of 255", almost)
	unmarshal("full tile of 256", full)

	// Rejections: anything whose length is not a multiple of the hash size.
	unmarshal("one byte", []byte{0x00})
	unmarshal("31 bytes", repeatBytes(0xaa, 31))
	unmarshal("33 bytes", repeatBytes(0xaa, 33))
	unmarshal("truncated single node", one[:31])
	unmarshal("single node plus one byte", append(append([]byte{}, one...), 0x00))
	unmarshal("two nodes minus one byte", two[:63])
	unmarshal("full tile plus one byte", append(append([]byte{}, full...), 0xff))

	return f
}

// --- EntryBundle ---

type entryBundleCase struct {
	Desc string `json:"desc"`
	Raw  Hex    `json:"raw"`
	// WantEntries is the decoded entry list, empty when WantErr is true.
	WantEntries []Hex  `json:"wantEntries"`
	WantErr     bool   `json:"wantErr"`
	WantErrMsg  string `json:"wantErrMsg"`
}

type apiEntryBundleFixture struct {
	header
	// BundleEncoding documents how the raw bytes are built, since api.EntryBundle
	// only implements the decoder: each entry is a big-endian uint16 length
	// followed by that many bytes. tessera.NewEntry produces exactly this.
	BundleEncoding string            `json:"bundleEncoding"`
	Cases          []entryBundleCase `json:"cases"`
}

func genAPIEntryBundle() any {
	f := apiEntryBundleFixture{
		header:         hdr("api.EntryBundle UnmarshalText, including the malformed bundles upstream rejects.", "github.com/transparency-dev/tessera/api"),
		BundleEncoding: "concatenation of (uint16 big-endian length || payload) records",
	}

	add := func(desc string, raw []byte) {
		b := api.EntryBundle{}
		err := b.UnmarshalText(raw)
		c := entryBundleCase{Desc: desc, Raw: Hex(raw), WantEntries: hexes(b.Entries), WantErr: err != nil, WantErrMsg: errString(err)}
		if err != nil {
			c.WantEntries = []Hex{}
		}
		f.Cases = append(f.Cases, c)
	}

	// Well-formed bundles built the way tessera.NewEntry does.
	add("empty bundle", []byte{})
	add("single entry", bundleOf(0, 1))
	add("two entries", bundleOf(0, 2))
	add("full bundle of 256", bundleOf(0, 256))
	add("partial bundle of 41", bundleOf(0, 41))
	add("bundle starting at index 1000", bundleOf(1000, 5))
	add("single zero-length entry", encodeEntries([][]byte{{}}))
	add("zero-length entries mixed with data", encodeEntries([][]byte{{}, []byte("a"), {}, []byte("bc"), {}}))
	add("entry of 65535 bytes", encodeEntries([][]byte{repeatBytes(0x7f, 65535)}))
	add("entry of 255 bytes", encodeEntries([][]byte{repeatBytes(0x7f, 255)}))
	add("entry of 256 bytes", encodeEntries([][]byte{repeatBytes(0x7f, 256)}))

	// Rejections.
	one := bundleOf(0, 1)
	add("dangling single byte", []byte{0x00})
	add("dangling byte after a valid entry", append(append([]byte{}, one...), 0x00))
	add("truncated length prefix only", []byte{0x00, 0x05})
	add("payload shorter than declared", []byte{0x00, 0x05, 0x01, 0x02})
	add("payload one byte short", one[:len(one)-1])
	add("declared length overruns buffer", append([]byte{0xff, 0xff}, repeatBytes(0x01, 10)...))
	add("second entry length prefix truncated", append(append([]byte{}, one...), 0x00, 0x03, 0x01))

	return f
}

// bundleOf builds the entry bundle covering leaves [start, start+n) by asking
// tessera.NewEntry to marshal each one, so the well-formed inputs in this
// fixture are produced by upstream rather than by this program.
func bundleOf(start, n uint64) []byte {
	out := []byte{}
	for i := start; i < start+n; i++ {
		out = append(out, tessera.NewEntry(entryData(i)).MarshalBundleData(i)...)
	}
	return out
}

func encodeEntries(entries [][]byte) []byte {
	out := []byte{}
	for _, e := range entries {
		if len(e) > 0xffff {
			panic(fmt.Sprintf("entry of %d bytes does not fit a uint16 length prefix", len(e)))
		}
		out = binary.BigEndian.AppendUint16(out, uint16(len(e)))
		out = append(out, e...)
	}
	return out
}
