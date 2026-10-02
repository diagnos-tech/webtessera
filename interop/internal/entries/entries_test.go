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

package entries

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

// CorpusDigest pins the first CorpusDigestEntries entries of the corpus with
// seed CorpusDigestSeed: SHA-256 over uint32be(len(entry)) || entry for each of
// them, in order. scripts/interop/entries.mjs checks the same value before the
// harness runs, so the Go and JavaScript implementations cannot drift apart
// without one of them noticing.
const (
	CorpusDigest        = "bdb57e7dc27d643f565bd4318458d511c2fc67f11490eccbd6a09081b3f6ec96"
	CorpusDigestSeed    = 1
	CorpusDigestEntries = 4096
)

func TestCorpusDigest(t *testing.T) {
	h := sha256.New()
	for i := range uint64(CorpusDigestEntries) {
		d := Data(CorpusDigestSeed, i)
		_ = binary.Write(h, binary.BigEndian, uint32(len(d)))
		h.Write(d)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != CorpusDigest {
		t.Errorf("corpus digest = %s, want %s", got, CorpusDigest)
	}
}

func TestDataIsDeterministicAndSeeded(t *testing.T) {
	for i := range uint64(64) {
		if a, b := Data(7, i), Data(7, i); !bytes.Equal(a, b) {
			t.Fatalf("Data(7, %d) differs between calls", i)
		}
	}
	same := 0
	for i := range uint64(64) {
		if bytes.Equal(Data(7, i), Data(8, i)) {
			same++
		}
	}
	// Only two empty entries can coincide across seeds; anything more means the
	// seed is not reaching the derivation.
	if same > 2 {
		t.Errorf("%d of 64 entries are identical for seeds 7 and 8", same)
	}
}

func TestSizesCoverEveryClass(t *testing.T) {
	var empty, small, twoByte, large int
	for i := range uint64(20000) {
		n := len(Data(1, i))
		switch {
		case n > MaxSize:
			t.Fatalf("entry %d has %d bytes, more than MaxSize %d", i, n, MaxSize)
		case n == 0:
			empty++
		case n >= 4096:
			large++
		case n > 255:
			twoByte++
		default:
			small++
		}
	}
	if empty == 0 || small == 0 || large == 0 {
		t.Errorf("sizes over 20000 entries: %d empty, %d small, %d large; want each class represented", empty, small, large)
	}
	// Only the large class has lengths above 255.
	if twoByte != 0 {
		t.Errorf("%d entries between 256 and 4095 bytes; the v1 corpus has none", twoByte)
	}
}
