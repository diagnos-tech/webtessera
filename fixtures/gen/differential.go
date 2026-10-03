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

// This file is the shared machinery of the differential corpora: the
// fixtures/data/differential_*.json files. See docs/compatibility.md
// ("Differential tests") and docs/decisions/0215-differential-corpora.md.
//
// A golden fixture pins a handful of hand-picked cases. A differential corpus
// instead runs upstream over thousands of generated inputs, most of them
// malformed, and records every verdict: accept or reject, the exact error text,
// and every output field. The TypeScript side replays each input and must reach
// the same verdict on every record, except where a named, ADR-backed divergence
// says otherwise.
//
// The inputs are generated here from fixed seeds, so they are as reproducible as
// the outputs; the generator still never computes an expected value itself. Each
// corpus has its own seed, so growing one corpus never reshuffles another.
//
// The files are larger than the golden fixtures, so they are written with one
// record per line, each record a compact JSON array whose columns are named in
// the file's "columns" section. That keeps every file well under 2 MB and keeps a
// regeneration diff readable record by record.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"unicode/utf8"
)

// diffScale multiplies the size of every random part of the differential
// corpora. The committed fixtures are generated with the default of 1; a larger
// value produces the same corpora with more random records (the deterministic
// boundary cases are unchanged), for a soak run that is not committed.
var diffScale = flag.Int("diffscale", 1, "Multiplier for the number of random records in the differential corpora.")

// scaled returns n random records' worth, scaled by -diffscale.
func scaled(n int) int {
	if *diffScale < 1 {
		return n
	}
	return n * *diffScale
}

// newDiffRand returns the seeded generator for one corpus. math/rand's
// rand.NewSource sequence is fixed by the Go 1 compatibility promise, so a
// given seed yields the same inputs on every Go version this module builds
// with.
func newDiffRand(seed int64) *rand.Rand {
	return rand.New(rand.NewSource(seed))
}

// diffGenerator produces one differential corpus file.
type diffGenerator struct {
	name string
	fn   func() diffFile
}

// diffFile is a differential corpus: a header and an ordered list of sections.
type diffFile struct {
	description string
	upstream    string
	sections    []diffSection
}

// diffSection is one top-level key of a corpus file. A value section is written
// as a single compact JSON value; a rows section is written as an array with one
// compact record per line.
type diffSection struct {
	key    string
	value  any
	rows   []any
	isRows bool
}

func dValue(key string, v any) diffSection { return diffSection{key: key, value: v} }

func dRows[T any](key string, rows []T) diffSection {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return diffSection{key: key, rows: out, isRows: true}
}

// compactJSON marshals v on one line, without HTML escaping, and refuses any
// string that is not valid UTF-8: encoding/json would silently replace the bad
// bytes with U+FFFD, which would turn an input into a different input. Byte
// strings that may be invalid UTF-8 must be carried as hex.
func compactJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	b := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	checkStringsUTF8(v)
	return b
}

// checkStringsUTF8 walks the values the corpora use (strings, numbers, bools and
// nested slices/maps of them) and panics on an invalid UTF-8 string.
func checkStringsUTF8(v any) {
	switch x := v.(type) {
	case string:
		if !utf8.ValidString(x) {
			panic(fmt.Sprintf("differential corpus string is not valid UTF-8 (carry it as hex): %q", x))
		}
	case []any:
		for _, e := range x {
			checkStringsUTF8(e)
		}
	case []string:
		for _, e := range x {
			checkStringsUTF8(e)
		}
	case map[string]any:
		for k, e := range x {
			checkStringsUTF8(k)
			checkStringsUTF8(e)
		}
	}
}

// writeDiffFile serialises f into <dir>/<name>.json.
func writeDiffFile(dir, name string, f diffFile) error {
	var buf bytes.Buffer
	buf.WriteString("{\n")
	writeKV := func(key string, val []byte, last bool) {
		buf.WriteString("  ")
		buf.Write(compactJSON(key))
		buf.WriteString(": ")
		buf.Write(val)
		if !last {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	writeKV("description", compactJSON(f.description), false)
	writeKV("upstream", compactJSON(f.upstream), false)
	writeKV("commit", compactJSON(upstreamCommit), len(f.sections) == 0)
	for i, s := range f.sections {
		last := i == len(f.sections)-1
		if !s.isRows {
			writeKV(s.key, compactJSON(s.value), last)
			continue
		}
		buf.WriteString("  ")
		buf.Write(compactJSON(s.key))
		if len(s.rows) == 0 {
			buf.WriteString(": []")
		} else {
			buf.WriteString(": [\n")
			for j, r := range s.rows {
				buf.WriteString("    ")
				buf.Write(compactJSON(r))
				if j != len(s.rows)-1 {
					buf.WriteString(",")
				}
				buf.WriteString("\n")
			}
			buf.WriteString("  ]")
		}
		if !last {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	return os.WriteFile(filepath.Join(dir, name+".json"), buf.Bytes(), 0o644)
}

// differentialGenerators lists every differential corpus, in output order.
func differentialGenerators() []diffGenerator {
	return []diffGenerator{
		{"differential_checkpoint", genDiffCheckpoint},
		{"differential_note_keys", genDiffNoteKeys},
		{"differential_note_open", genDiffNoteOpen},
		{"differential_note_sign", genDiffNoteSign},
		{"differential_ed25519", genDiffEd25519},
		{"differential_cosig", genDiffCosig},
		{"differential_layout", genDiffLayout},
		{"differential_proof_inclusion", genDiffProofInclusion},
		{"differential_proof_consistency", genDiffProofConsistency},
		{"differential_proof_nodes", genDiffProofNodes},
		{"differential_compact", genDiffCompact},
		{"differential_rfc6962", genDiffRFC6962},
		{"differential_gostd", genDiffGoStd},
		{"differential_unicode", genDiffUnicode},
		{"differential_witness_policy", genDiffWitnessPolicy},
		{"differential_bundle_hashers", genDiffBundleHashers},
		{"differential_checkpoint_publisher", genDiffCheckpointPublisher},
		{"differential_ct_log", genDiffCTLog},
		{"differential_api", genDiffAPI},
	}
}

// writeDifferentialFixtures writes every differential corpus into dir and
// records each file name in written, so that main's stale-file sweep keeps them.
func writeDifferentialFixtures(dir string, written map[string]bool) error {
	for _, g := range differentialGenerators() {
		if err := writeDiffFile(dir, g.name, g.fn()); err != nil {
			return fmt.Errorf("%s: %v", g.name, err)
		}
		written[g.name+".json"] = true
		fmt.Printf("wrote %s.json\n", g.name)
	}
	return nil
}

// Helpers shared by the corpora.

func hx(b []byte) string { return hex.EncodeToString(b) }

func u64s(x uint64) string { return strconv.FormatUint(x, 10) }

// randBytes returns n bytes from r.
func randBytes(r *rand.Rand, n int) []byte {
	b := make([]byte, n)
	r.Read(b)
	return b
}

// interestingU64 is the boundary set every uint64-taking corpus samples from:
// small values, every power of two with its neighbours, and the top of the
// range.
func interestingU64() []uint64 {
	v := []uint64{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 100, 255, 256, 257, 1000, 65535, 65536, 65537}
	for p := 0; p < 64; p++ {
		x := uint64(1) << p
		v = append(v, x, x-1, x+1, x+2, x-2, x|(x>>1))
	}
	v = append(v, ^uint64(0), ^uint64(0)-1, ^uint64(0)-2, ^uint64(0)-3, ^uint64(0)-100)
	return v
}

// randU64 draws a uint64 biased towards the values where bit arithmetic goes
// wrong: boundaries, their neighbours, small values and uniformly random ones.
func randU64(r *rand.Rand) uint64 {
	iv := interestingU64()
	switch r.Intn(5) {
	case 0:
		return r.Uint64()
	case 1:
		return r.Uint64() >> uint(r.Intn(64))
	case 2:
		return iv[r.Intn(len(iv))]
	case 3:
		return iv[r.Intn(len(iv))] + uint64(r.Intn(9)) - 4
	default:
		return uint64(r.Intn(1000))
	}
}

// boolInt renders a bool as 0 or 1, which keeps the record arrays short.
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
