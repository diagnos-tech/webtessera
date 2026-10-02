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
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// upstreamCommit is the Tessera revision these fixtures were produced from. It
// is recorded in every fixture file so that a reviewer regenerating them knows
// which checkout to point the `replace` directive at.
const upstreamCommit = "4a6d9f9"

// U64 renders a Go uint64 as a decimal JSON string.
//
// JSON numbers are IEEE-754 doubles in every JavaScript runtime, so a uint64
// above 2^53 cannot survive a round trip as a number. Tessera counts tree
// sizes and node indices in uint64 and its own tests reach math.MaxUint64, so
// the fixtures must carry them losslessly. The TypeScript side decodes these
// back to bigint. See PORTING.md §5 and docs/decisions/0003-uint64-as-bigint.md.
type U64 uint64

func (u U64) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(strconv.FormatUint(uint64(u), 10))), nil
}

// Hex renders a byte slice as a lower-case hex JSON string. A nil slice and an
// empty slice both render as "", which is correct for every use here: no
// fixture distinguishes the two.
type Hex []byte

func (h Hex) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(hex.EncodeToString(h))), nil
}

// hexes converts a [][]byte for serialisation.
func hexes(bs [][]byte) []Hex {
	// A non-nil empty slice renders as [] rather than null, which keeps the
	// TypeScript decoder from having to handle two spellings of "no hashes".
	out := make([]Hex, 0, len(bs))
	for _, b := range bs {
		out = append(out, Hex(b))
	}
	return out
}

// header is embedded in every fixture file. It records where the data came
// from so the file is self-describing when read in isolation.
type header struct {
	// Description explains what the fixture pins down.
	Description string `json:"description"`
	// Upstream is the Go package the values were produced by.
	Upstream string `json:"upstream"`
	// Commit is the pinned Tessera revision.
	Commit string `json:"commit"`
}

func hdr(desc, upstream string) header {
	return header{Description: desc, Upstream: upstream, Commit: upstreamCommit}
}

// writeFixture serialises v as canonical JSON into <dir>/<name>.json.
//
// Canonical here means: 2-space indent, no HTML escaping, a trailing newline,
// and stable key order. Struct fields serialise in declaration order and Go's
// encoder sorts map keys, so both are stable by construction; ordering is only
// a hazard where this program iterates a map to build a slice, and every such
// place sorts explicitly.
func writeFixture(dir, name string, v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return err
	}
	// json.Encoder.Encode already terminates the document with a newline.
	return os.WriteFile(filepath.Join(dir, name+".json"), buf.Bytes(), 0o644)
}

// errString renders an error for a fixture. Upstream tests assert on message
// text, so the port must reproduce it exactly; recording it here makes that
// checkable rather than aspirational.
func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
