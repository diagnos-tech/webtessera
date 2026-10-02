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
	"github.com/transparency-dev/merkle/rfc6962"
)

type hashLeafCase struct {
	// Desc names the case; where it matches an upstream test case the name is
	// taken verbatim from rfc6962_test.go.
	Desc string `json:"desc"`
	Leaf Hex    `json:"leaf"`
	Want Hex    `json:"want"`
}

type hashChildrenCase struct {
	Desc  string `json:"desc"`
	Left  Hex    `json:"left"`
	Right Hex    `json:"right"`
	Want  Hex    `json:"want"`
}

type rfc6962Fixture struct {
	header
	LeafHashPrefix int                `json:"leafHashPrefix"`
	NodeHashPrefix int                `json:"nodeHashPrefix"`
	HashSize       int                `json:"hashSize"`
	EmptyRoot      Hex                `json:"emptyRoot"`
	HashLeaf       []hashLeafCase     `json:"hashLeaf"`
	HashChildren   []hashChildrenCase `json:"hashChildren"`
}

func genRFC6962() any {
	h := rfc6962.DefaultHasher

	f := rfc6962Fixture{
		header:         hdr("RFC6962 leaf and node hashing.", "github.com/transparency-dev/merkle/rfc6962"),
		LeafHashPrefix: rfc6962.RFC6962LeafHashPrefix,
		NodeHashPrefix: rfc6962.RFC6962NodeHashPrefix,
		HashSize:       h.Size(),
		EmptyRoot:      Hex(h.EmptyRoot()),
	}

	leaf := func(desc string, b []byte) {
		f.HashLeaf = append(f.HashLeaf, hashLeafCase{Desc: desc, Leaf: Hex(b), Want: Hex(h.HashLeaf(b))})
	}

	// Upstream's own vectors first, under their upstream names.
	leaf("RFC6962 Empty Leaf", []byte{})
	leaf("RFC6962 Leaf", []byte("L123456"))
	leaf("nil leaf", nil)
	leaf("single zero byte", []byte{0x00})
	leaf("single 0xff byte", []byte{0xff})
	leaf("Hello", []byte("Hello"))
	leaf("World", []byte("World"))
	leaf("utf8 multibyte", []byte("héllo wörld — ünïcodé"))
	leaf("all byte values", allBytes())
	leaf("255 bytes", repeatBytes(0x5a, 255))
	leaf("256 bytes", repeatBytes(0x5a, 256))
	leaf("257 bytes", repeatBytes(0x5a, 257))
	leaf("1000 bytes", repeatBytes(0xa5, 1000))
	// 64 bytes lands exactly on the SHA-256 block boundary once the one-byte
	// domain prefix is added, which is where a hand-rolled padding bug shows up.
	leaf("63 bytes", repeatBytes(0x01, 63))
	leaf("64 bytes", repeatBytes(0x01, 64))
	leaf("65 bytes", repeatBytes(0x01, 65))
	for i := 0; i < 16; i++ {
		leaf(entryName(uint64(i)), []byte(entryName(uint64(i))))
	}

	children := func(desc string, l, r []byte) {
		f.HashChildren = append(f.HashChildren, hashChildrenCase{
			Desc: desc, Left: Hex(l), Right: Hex(r), Want: Hex(h.HashChildren(l, r)),
		})
	}

	children("RFC6962 Node", []byte("N123"), []byte("N456"))
	hello := h.HashLeaf([]byte("Hello"))
	world := h.HashLeaf([]byte("World"))
	children("Hello|World", hello, world)
	children("World|Hello", world, hello)
	children("empty|empty", []byte{}, []byte{})
	children("nil|nil", nil, nil)
	children("emptyRoot|emptyRoot", h.EmptyRoot(), h.EmptyRoot())
	children("zeros|ones", repeatBytes(0x00, 32), repeatBytes(0xff, 32))
	children("ones|zeros", repeatBytes(0xff, 32), repeatBytes(0x00, 32))
	children("hash|empty", hello, []byte{})
	children("empty|hash", []byte{}, hello)
	// Second-preimage check from upstream's collision test: hashing the
	// concatenation as a leaf must not equal the node hash.
	children("second preimage pair", hello, world)
	leaf("second preimage concat", append(append([]byte{}, hello...), world...))

	return f
}

func repeatBytes(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func allBytes() []byte {
	out := make([]byte, 256)
	for i := range out {
		out[i] = byte(i)
	}
	return out
}
