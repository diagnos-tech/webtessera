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
	"crypto/sha256"
	"math"

	"github.com/transparency-dev/tessera/ctonly"
)

type ctEntryCase struct {
	Desc string `json:"desc"`
	// The entry fields, mirroring ctonly.Entry.
	Timestamp         U64   `json:"timestamp"`
	IsPrecert         bool  `json:"isPrecert"`
	Certificate       Hex   `json:"certificate"`
	Precertificate    Hex   `json:"precertificate"`
	IssuerKeyHash     Hex   `json:"issuerKeyHash"`
	FingerprintsChain []Hex `json:"fingerprintsChain"`
	// Index is the leaf index the entry is marshalled at; it is embedded in
	// the leaf_index extension, so the same entry produces different bytes at
	// different indices.
	Index U64 `json:"index"`
	// The four outputs of ctonly.Entry.
	LeafData       Hex `json:"leafData"`
	MerkleTreeLeaf Hex `json:"merkleTreeLeaf"`
	MerkleLeafHash Hex `json:"merkleLeafHash"`
	Identity       Hex `json:"identity"`
}

type ctonlyFixture struct {
	header
	// LeafIndexLimit is the exclusive upper bound the leaf_index extension
	// accepts: 2^40. Marshalling at or above it fails.
	LeafIndexLimit U64           `json:"leafIndexLimit"`
	Cases          []ctEntryCase `json:"cases"`
	// PanicIndices records the indices at which LeafData/MerkleTreeLeaf panic
	// because the leaf_index extension rejects them. Upstream propagates the
	// failure through cryptobyte's BytesOrPanic, so there is no error return
	// to record.
	PanicIndices []U64 `json:"panicIndices"`
}

func genCTOnly() any {
	f := ctonlyFixture{
		header:         hdr("ctonly.Entry marshalling: leaf data, RFC6962 MerkleTreeLeaf, leaf hash, and dedup identity.", "github.com/transparency-dev/tessera/ctonly"),
		LeafIndexLimit: U64(1 << 40),
	}

	// Deterministic stand-ins for DER blobs. Real certificates are not needed:
	// ctonly treats them as opaque byte strings and only length-prefixes them.
	cert := func(n int, seed byte) []byte {
		out := make([]byte, n)
		for i := range out {
			out[i] = byte(int(seed) + i*7)
		}
		return out
	}
	fp := func(seed byte) [32]byte {
		return sha256.Sum256([]byte{seed})
	}

	add := func(desc string, e ctonly.Entry, idx uint64) {
		fps := make([]Hex, 0, len(e.FingerprintsChain))
		for _, x := range e.FingerprintsChain {
			b := x
			fps = append(fps, Hex(b[:]))
		}
		f.Cases = append(f.Cases, ctEntryCase{
			Desc: desc, Timestamp: U64(e.Timestamp), IsPrecert: e.IsPrecert,
			Certificate: Hex(e.Certificate), Precertificate: Hex(e.Precertificate),
			IssuerKeyHash: Hex(e.IssuerKeyHash), FingerprintsChain: fps,
			Index:          U64(idx),
			LeafData:       Hex(e.LeafData(idx)),
			MerkleTreeLeaf: Hex(e.MerkleTreeLeaf(idx)),
			MerkleLeafHash: Hex(e.MerkleLeafHash(idx)),
			Identity:       Hex(e.Identity()),
		})
	}

	ikh := fp(0xaa)
	x509Entry := func(ts uint64, certLen int, chain int) ctonly.Entry {
		e := ctonly.Entry{Timestamp: ts, IsPrecert: false, Certificate: cert(certLen, 0x10)}
		for i := 0; i < chain; i++ {
			e.FingerprintsChain = append(e.FingerprintsChain, fp(byte(i)))
		}
		return e
	}
	precertEntry := func(ts uint64, tbsLen, preLen, chain int) ctonly.Entry {
		e := ctonly.Entry{
			Timestamp:      ts,
			IsPrecert:      true,
			Certificate:    cert(tbsLen, 0x20),
			Precertificate: cert(preLen, 0x30),
			IssuerKeyHash:  ikh[:],
		}
		for i := 0; i < chain; i++ {
			e.FingerprintsChain = append(e.FingerprintsChain, fp(byte(128+i)))
		}
		return e
	}

	// Index axis: zero, small, the three-byte and four-byte boundaries of the
	// 40-bit leaf_index encoding, and its largest legal value.
	indices := []uint64{0, 1, 255, 256, 65535, 65536, 16777215, 16777216, 4294967295, 4294967296, (1 << 40) - 1}
	for _, idx := range indices {
		add("x509, 32-byte cert, empty chain", x509Entry(0, 32, 0), idx)
	}

	// Timestamp axis: a uint64 written big-endian, so the high word matters.
	for _, ts := range []uint64{0, 1, 1234567890123, math.MaxUint32, math.MaxUint32 + 1, math.MaxUint64} {
		add("x509, timestamp axis", x509Entry(ts, 16, 1), 7)
	}

	add("x509, empty certificate", ctonly.Entry{Timestamp: 5, Certificate: []byte{}}, 0)
	add("x509, nil certificate", ctonly.Entry{Timestamp: 5}, 0)
	add("x509, 1-byte certificate", x509Entry(5, 1, 0), 0)
	add("x509, 255-byte certificate", x509Entry(5, 255, 0), 0)
	add("x509, 256-byte certificate", x509Entry(5, 256, 0), 0)
	// A few kilobytes is the size of a real certificate chain element. The
	// length prefix here is uint24, so there is no 16-bit boundary to probe;
	// larger cases would only bloat the fixture.
	add("x509, 4095-byte certificate", x509Entry(5, 4095, 0), 0)
	add("x509, 4096-byte certificate", x509Entry(5, 4096, 0), 0)
	add("x509, chain of 1", x509Entry(5, 32, 1), 3)
	add("x509, chain of 2", x509Entry(5, 32, 2), 3)
	add("x509, chain of 8", x509Entry(5, 32, 8), 3)

	add("precert, empty chain", precertEntry(9, 32, 48, 0), 0)
	add("precert, chain of 1", precertEntry(9, 32, 48, 1), 1)
	add("precert, chain of 3", precertEntry(9, 32, 48, 3), 1)
	add("precert, empty tbs", precertEntry(9, 0, 48, 1), 1)
	add("precert, empty precertificate", precertEntry(9, 32, 0, 1), 1)
	add("precert, large tbs and precert", precertEntry(9, 1000, 2000, 2), 65536)
	add("precert, max legal index", precertEntry(9, 32, 48, 1), (1<<40)-1)

	// 2^40 and above are rejected by the extension encoder. Upstream surfaces
	// that as a panic out of cryptobyte, so the fixture records only which
	// indices are out of range rather than a marshalled value.
	f.PanicIndices = []U64{U64(1 << 40), U64(1<<40 + 1), U64(math.MaxUint64)}

	return f
}
