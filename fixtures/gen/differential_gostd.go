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
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"math/bits"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// genDiffGoStd records the Go standard-library functions that
// src/internal/gostd stands in for, over the inputs Tessera and its
// dependencies feed them: encoding/base64's StdEncoding.DecodeString,
// encoding/hex's DecodeString, strconv.ParseUint in the bases and bit sizes
// upstream uses, strconv.Quote, strings.Fields and strings.TrimSpace, and
// math/bits.
func genDiffGoStd() diffFile {
	r := newDiffRand(0x60570d)

	// base64.StdEncoding.DecodeString.
	alpha := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	junk := []string{"=", "=", "\n", "\r", " ", "-", "_", "\t", "*", "é", "Ā", "Ľ", "\x00", "€"}
	var b64In []string
	for i := 0; i < scaled(5000); i++ {
		var s strings.Builder
		for j := r.Intn(16); j > 0; j-- {
			if r.Intn(5) == 0 {
				s.WriteString(junk[r.Intn(len(junk))])
			} else {
				s.WriteByte(alpha[r.Intn(64)])
			}
		}
		b64In = append(b64In, s.String())
	}
	for i := 0; i < scaled(3000); i++ {
		s := base64.StdEncoding.EncodeToString(randBytes(r, r.Intn(12)))
		switch r.Intn(6) {
		case 0:
			if len(s) > 0 {
				p := r.Intn(len(s))
				s = s[:p] + junk[r.Intn(len(junk))] + s[p:]
			}
		case 1:
			if len(s) > 0 {
				s = s[:r.Intn(len(s))]
			}
		case 2:
			s += junk[r.Intn(len(junk))]
		case 3:
			if len(s) > 0 {
				p := r.Intn(len(s))
				s = s[:p] + junk[r.Intn(len(junk))] + s[p+1:]
			}
		case 4:
			// Flip the unused low bits of the last data character.
			t := strings.TrimRight(s, "=")
			if len(t) > 0 {
				c := strings.IndexByte(alpha, t[len(t)-1])
				s = t[:len(t)-1] + string(alpha[c^(1+r.Intn(3))]) + s[len(t):]
			}
		}
		b64In = append(b64In, s)
	}
	var b64Rows [][]any
	for _, s := range b64In {
		if b, err := base64.StdEncoding.DecodeString(s); err != nil {
			b64Rows = append(b64Rows, []any{s, err.Error()})
		} else {
			b64Rows = append(b64Rows, []any{s, "", hex.EncodeToString(b)})
		}
	}

	// hex.DecodeString.
	hexAlpha := []string{"0", "1", "9", "a", "f", "A", "F", "g", "G", "-", "+", " ", "x", "_", "\n", "\t", "٣", "é", "\x7f", "\x00"}
	var hexRows [][]any
	for i := 0; i < scaled(4000); i++ {
		var s strings.Builder
		for j := r.Intn(9); j > 0; j-- {
			if r.Intn(3) == 0 {
				s.WriteString(hexAlpha[r.Intn(len(hexAlpha))])
			} else {
				s.WriteByte("0123456789abcdefABCDEF"[r.Intn(22)])
			}
		}
		in := s.String()
		if b, err := hex.DecodeString(in); err != nil {
			hexRows = append(hexRows, []any{in, err.Error()})
		} else {
			hexRows = append(hexRows, []any{in, "", hex.EncodeToString(b)})
		}
	}

	// strconv.ParseUint: base 16 at bit sizes 32 and 64 (note key hashes, the
	// cosignature key hash), base 10 at 64 (checkpoint sizes, tile paths) and 8
	// (witness policy thresholds).
	puAlpha := "0123456789abcdefABCDEFgxX+-_ ٠"
	puIn := []string{"", "0", "ffffffff", "100000000", "FFFFFFFF", "ffffffffffffffff", "10000000000000000",
		"ffffffffffffffffx", "100000000x", "x100000000", "00000000000000000000000001", "18446744073709551615",
		"18446744073709551616", "99999999999999999999", "99999999999999999999x", "255", "256", "1_000", "0x10", "+1", "-0"}
	for i := 0; i < scaled(2500); i++ {
		var s strings.Builder
		for j := r.Intn(22); j > 0; j-- {
			if r.Intn(8) == 0 {
				c := []rune(puAlpha)
				s.WriteRune(c[r.Intn(len(c))])
			} else if r.Intn(2) == 0 {
				s.WriteByte("0123456789"[r.Intn(10)])
			} else {
				s.WriteByte("0123456789abcdefABCDEF"[r.Intn(22)])
			}
		}
		puIn = append(puIn, s.String())
	}
	// Inputs longer than the 64 code points the port's NumError quotes (ADR-0204).
	puIn = append(puIn, strings.Repeat("9", 65), strings.Repeat("f", 64)+"x", strings.Repeat("1", 100)+"z", strings.Repeat("日", 70), strings.Repeat("0", 300)+"1")
	puResult := func(s string, base, bitSize int) []any {
		v, err := strconv.ParseUint(s, base, bitSize)
		if err != nil {
			return []any{err.Error()}
		}
		return []any{"", strconv.FormatUint(v, 10)}
	}
	var puRows [][]any
	for _, s := range puIn {
		puRows = append(puRows, []any{s, puResult(s, 16, 32), puResult(s, 16, 64), puResult(s, 10, 64), puResult(s, 10, 8)})
	}

	// strconv.Quote: which code points it escapes (as inclusive ranges, over
	// every Unicode scalar value), and the exact output for every escaped code
	// point below U+3000 plus a seeded sample above, and for assorted strings.
	var escapedRanges [][2]int
	var quoteRows [][]any
	inRange := false
	for cp := 0; cp <= unicode.MaxRune; cp++ {
		if cp >= 0xd800 && cp <= 0xdfff {
			inRange = false
			continue
		}
		s := string(rune(cp))
		q := strconv.Quote(s)
		escaped := q != `"`+s+`"`
		if escaped {
			if inRange {
				escapedRanges[len(escapedRanges)-1][1] = cp
			} else {
				escapedRanges = append(escapedRanges, [2]int{cp, cp})
			}
			if cp < 0x3000 || r.Intn(600) == 0 {
				quoteRows = append(quoteRows, []any{cp, q})
			}
		}
		inRange = escaped
	}
	quoteStrings := []string{"", "Señor-0", "origin.example.com/log", "tab\there", `quo"te`, `back\slash`, "\x00\x01\x7f", "日本語 🌲", "\ufeffbom", "a b", "­", "x\U000e0001y", "�"}
	var quoteStringRows [][]any
	for _, s := range quoteStrings {
		quoteStringRows = append(quoteStringRows, []any{s, strconv.Quote(s)})
	}

	// strings.Fields and strings.TrimSpace, over strings mixing every
	// White_Space code point with look-alikes that are not White_Space.
	spaceish := []rune{'\t', '\n', '\v', '\f', '\r', ' ', 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x200b, 0x180e, 0x2060, 0x1c, 0x1f, 0x00}
	var fieldRows [][]any
	for i := 0; i < scaled(1500); i++ {
		var s strings.Builder
		for j := r.Intn(12); j > 0; j-- {
			if r.Intn(2) == 0 {
				s.WriteRune(spaceish[r.Intn(len(spaceish))])
			} else {
				s.WriteString([]string{"a", "b", "é", "日", "x+y", "#"}[r.Intn(6)])
			}
		}
		in := s.String()
		f := strings.Fields(in)
		if f == nil {
			f = []string{}
		}
		fieldRows = append(fieldRows, []any{in, f, strings.TrimSpace(in)})
	}

	// math/bits and uint64 shifts.
	var bitRows, shiftRows [][]any
	xs := interestingU64()
	for i := 0; i < scaled(1200); i++ {
		xs = append(xs, r.Uint64()>>uint(r.Intn(64)))
	}
	for _, x := range xs {
		bitRows = append(bitRows, []any{u64s(x), bits.TrailingZeros64(x), bits.Len64(x), bits.OnesCount64(x)})
	}
	for i, x := range xs {
		if i%5 != 0 {
			continue
		}
		for _, n := range []uint{0, 1, 2, 7, 31, 32, 33, 62, 63, 64, 65, 70, 127, 128, 255} {
			shiftRows = append(shiftRows, []any{u64s(x), n, u64s(x << n), u64s(x >> n)})
		}
	}

	return diffFile{
		description: "Differential corpus for the Go standard library behaviour src/internal/gostd stands in for: base64.StdEncoding.DecodeString, hex.DecodeString, strconv.ParseUint (base 16 at 32/64 bits, base 10 at 64/8 bits), strconv.Quote (every escaped code point as ranges, exact output for a sample), strings.Fields and strings.TrimSpace around Unicode White_Space, and math/bits with uint64 shifts.",
		upstream:    "Go standard library (encoding/base64, encoding/hex, strconv, strings, math/bits)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"base64":        []string{"input", "err", "decodedHex"},
				"hex":           []string{"input", "err", "decodedHex"},
				"parseUint":     []string{"input", "ParseUint(s, 16, 32)", "ParseUint(s, 16, 64)", "ParseUint(s, 10, 64)", "ParseUint(s, 10, 8)", "each [err] or [\"\", decimal]"},
				"quoteEscaped":  "inclusive [first, last] code point ranges whose single-rune string Quote escapes; every other scalar value is quoted verbatim",
				"quote":         []string{"code point", "Quote(string(rune))"},
				"quoteStrings":  []string{"input", "Quote(input)"},
				"fields":        []string{"input", "Fields(input)", "TrimSpace(input)"},
				"bits":          []string{"x", "TrailingZeros64", "Len64", "OnesCount64"},
				"shifts":        []string{"x", "n", "x << n", "x >> n"},
				"quoteEscapedN": "number of escaped scalar values",
			}),
			dRows("base64", b64Rows),
			dRows("hex", hexRows),
			dRows("parseUint", puRows),
			dValue("quoteEscaped", escapedRanges),
			dValue("quoteEscapedN", countRanges(escapedRanges)),
			dRows("quote", quoteRows),
			dRows("quoteStrings", quoteStringRows),
			dRows("fields", fieldRows),
			dRows("bits", bitRows),
			dRows("shifts", shiftRows),
		},
	}
}

func countRanges(rs [][2]int) int {
	n := 0
	for _, x := range rs {
		n += x[1] - x[0] + 1
	}
	return n
}

// utf8Boundaries is the byte set the structured UTF-8 sweeps take their
// non-exhaustive positions from: both ends of every byte class
// utf8.Valid distinguishes, and their neighbours.
var utf8Boundaries = []int{
	0x00, 0x01, 0x7e, 0x7f, 0x80, 0x81, 0x8e, 0x8f, 0x90, 0x91, 0x9e, 0x9f, 0xa0, 0xa1, 0xbe, 0xbf, 0xc0, 0xc1,
	0xc2, 0xc3, 0xde, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xf7, 0xf8, 0xfb,
	0xfc, 0xfe, 0xff,
}

// genDiffUnicode records utf8.Valid and unicode.IsSpace for the runtime-parity
// sweeps, which re-run them in Node, Chromium and workerd: the port's validUTF8
// delegates to the platform's TextDecoder, so it is only as Go-exact as the
// runtime it runs in.
//
// An exhaustive sweep of every 3-byte sequence takes close to a minute in a
// JavaScript runtime, so the UTF-8 sweeps are structured instead: every byte at
// the positions where all 256 values are cheap enough, and the boundary set
// elsewhere. Each sweep enumerates its byte sequences in lexicographic order
// (first byte most significant) and is recorded as the SHA-256 of Go's verdict
// bytes (1 valid, 0 invalid) in that order, the number of valid sequences, and
// the number of valid sequences per first byte, which localises any mismatch.
// The SHA-256 compresses upstream's output; it is not an expected value computed
// here.
func genDiffUnicode() diffFile {
	all := make([]int, 256)
	for i := range all {
		all[i] = i
	}
	type sweep struct {
		name      string
		positions []string // "all" or "boundaries"
	}
	sweeps := []sweep{
		{"1:all", []string{"all"}},
		{"2:all,all", []string{"all", "all"}},
		{"3:all,b,b", []string{"all", "boundaries", "boundaries"}},
		{"3:b,b,all", []string{"boundaries", "boundaries", "all"}},
		{"4:high,b,cont,cont", []string{"boundariesHigh", "boundaries", "continuation", "continuation"}},
	}
	high := []int{}
	for _, b := range utf8Boundaries {
		if b >= 0xe0 {
			high = append(high, b)
		}
	}
	cont := []int{0x00, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff}
	setOf := func(name string) []int {
		switch name {
		case "all":
			return all
		case "boundaries":
			return utf8Boundaries
		case "boundariesHigh":
			return high
		case "continuation":
			return cont
		}
		panic(name)
	}
	var sweepRows [][]any
	for _, sw := range sweeps {
		sets := make([][]int, len(sw.positions))
		for i, p := range sw.positions {
			sets[i] = setOf(p)
		}
		h := sha256.New()
		count := 0
		perFirst := map[int]int{}
		buf := make([]byte, len(sets))
		var rec func(pos int)
		rec = func(pos int) {
			if pos == len(sets) {
				v := byte(0)
				if utf8.Valid(buf) {
					v = 1
					count++
					perFirst[int(buf[0])]++
				}
				h.Write([]byte{v})
				return
			}
			for _, b := range sets[pos] {
				buf[pos] = byte(b)
				rec(pos + 1)
			}
		}
		rec(0)
		first := []int{}
		for _, b := range sets[0] {
			first = append(first, perFirst[b])
		}
		sweepRows = append(sweepRows, []any{sw.name, sw.positions, hex.EncodeToString(h.Sum(nil)), count, first})
	}

	// Random byte strings, biased towards multi-byte lead and continuation
	// bytes, with Go's verdict on each.
	r := newDiffRand(0x07f8)
	var randomRows [][]any
	for i := 0; i < scaled(4000); i++ {
		b := make([]byte, r.Intn(14))
		for k := range b {
			if r.Intn(2) == 0 {
				b[k] = byte(utf8Boundaries[r.Intn(len(utf8Boundaries))])
			} else {
				b[k] = byte(r.Intn(256))
			}
		}
		randomRows = append(randomRows, []any{hex.EncodeToString(b), boolInt(utf8.Valid(b))})
	}

	// unicode.IsSpace over every code point.
	var spaces []int
	hs := sha256.New()
	for cp := 0; cp <= unicode.MaxRune; cp++ {
		v := byte(0)
		if unicode.IsSpace(rune(cp)) {
			v = 1
			spaces = append(spaces, cp)
		}
		hs.Write([]byte{v})
	}

	return diffFile{
		description: "Runtime-parity corpus for unicode/utf8.Valid (structured sweeps over every byte class boundary, plus random strings) and unicode.IsSpace (every code point, U+0000 to U+10FFFF).",
		upstream:    "Go standard library (unicode/utf8, unicode)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"sweeps": []string{"name", "byte set per position (all: 0x00-0xff; boundaries; boundariesHigh: boundaries >= 0xe0; continuation)", "sha256 of the verdict bytes in lexicographic order", "valid count", "valid count per first byte, in the order of the first position's set"},
				"random": []string{"bytesHex", "utf8.Valid"},
			}),
			dValue("boundaries", utf8Boundaries),
			dValue("boundariesHigh", high),
			dValue("continuation", cont),
			dRows("sweeps", sweepRows),
			dRows("random", randomRows),
			dValue("isSpace", spaces),
			dValue("isSpaceSha256", hex.EncodeToString(hs.Sum(nil))),
		},
	}
}
