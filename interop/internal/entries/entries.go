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

// Package entries defines the entry corpus of the interop harness: a
// deterministic, seeded sequence of entries of varied sizes that both halves of
// the harness, this Go module and scripts/interop/entries.mjs, derive
// independently from (seed, index) alone.
//
// Deriving the corpus on each side, rather than handing a list of entries from
// one to the other, is what lets the verifier check that a log holds exactly the
// entries that were appended, in order, whichever side appended them. The two
// implementations are kept honest by a pinned digest that both check
// (CorpusDigest in entries_test.go) and, end to end, by interop/verify checking
// every entry of every log the harness writes.
//
// Version 1 of the corpus, for seed s and index i:
//
//	d    = SHA-256("webtessera/interop/v1" || 0x00 || uint64be(s) || uint64be(i))
//	r    = uint16be(d[1:3])
//	size = 0                   if d[0] == 0       (1 in 256: empty entries)
//	       4096 + r mod 12288  if 1 <= d[0] < 4   (3 in 256: 4 KiB to 16 KiB)
//	       r mod 256           otherwise          (0 to 255 bytes)
//	data = the first size bytes of SHA-256(d || uint32be(0)) || SHA-256(d || uint32be(1)) || ...
//
// The size mix exercises what a fixed-size corpus cannot: empty entries, entry
// bundles whose length varies by two orders of magnitude, and length prefixes
// above 255 that need both bytes of their uint16.
package entries

import (
	"crypto/sha256"
	"encoding/binary"
)

// domain separates this corpus's hashes from any other use of SHA-256 over
// similar inputs, and names its version.
const domain = "webtessera/interop/v1\x00"

// MaxSize is the largest entry the corpus produces: well inside the 65535 bytes
// a tlog-tiles entry bundle can frame.
const MaxSize = 4096 + 12288 - 1

// Data returns entry i of the corpus with the given seed.
func Data(seed, i uint64) []byte {
	msg := make([]byte, 0, len(domain)+16)
	msg = append(msg, domain...)
	msg = binary.BigEndian.AppendUint64(msg, seed)
	msg = binary.BigEndian.AppendUint64(msg, i)
	d := sha256.Sum256(msg)

	n := size(d)
	out := make([]byte, 0, n+sha256.Size)
	blk := make([]byte, sha256.Size+4)
	copy(blk, d[:])
	for k := uint32(0); len(out) < n; k++ {
		binary.BigEndian.PutUint32(blk[sha256.Size:], k)
		h := sha256.Sum256(blk)
		out = append(out, h[:]...)
	}
	return out[:n]
}

// size picks an entry's length from its derivation hash d.
func size(d [sha256.Size]byte) int {
	r := int(binary.BigEndian.Uint16(d[1:3]))
	switch {
	case d[0] == 0:
		return 0
	case d[0] < 4:
		return 4096 + r%12288
	default:
		return r % 256
	}
}
