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
	"math"
	"strings"
	"unicode/utf8"

	flog "github.com/transparency-dev/formats/log"
	"golang.org/x/mod/sumdb/note"
)

// genDiffCheckpoint records formats/log's Checkpoint.Unmarshal over a corpus of
// well-formed, boundary and random checkpoint bodies, Checkpoint.Marshal and
// log.ID over every origin a JavaScript string can carry, and ParseCheckpoint
// over signed checkpoints whose bodies are mutated before signing.
func genDiffCheckpoint() diffFile {
	r := newDiffRand(0x0c4ec4)

	origins := [][]byte{
		[]byte("example.com/log"), []byte("Log"), []byte(""), []byte("é"), []byte("ünïcodé.log"),
		[]byte("a\rb"), []byte("a\x00b"), {0xff}, {0xc3}, {'a', 0xe2, 0x82}, []byte("\xef\xbb\xbfbom"),
		[]byte("日本語"), []byte("😀"), []byte(" lead"), []byte("trail "), []byte("a b c"),
		[]byte("tab\there"), []byte("\u0085nel"), []byte("x y"), {0xed, 0xa0, 0x80}, {0xf4, 0x90, 0x80, 0x80},
	}
	sizes := []string{
		"0", "1", "00", "007", "42", "18446744073709551615", "18446744073709551616", "99999999999999999999",
		"99999999999999999999x", "+1", "-0", "-1", " 1", "1 ", "1_000", "0x10", "1e3", "１２３", "٣", "",
		"abc", "1\r", "1.0", "9223372036854775808", "0000000000000000000000000000001", "18446744073709551615x",
		"0b1", "0o7", "1\x00", "\xff", "1\xff",
	}
	hashes := []string{
		"YmFuYW5hcw==", "", "AAAA", "AAA=", "AA==", "AAA", "AA", "A", "AAAA\r", "AA\rAA", "AAAA ", " AAAA", "AA AA",
		"====", "A===", "AA=\r=", "AA==\r", "AA==AA", "AAAA====", "YmFuYW5hcw", "YmFuYW5hcw=", "YmFuYW5hcw===",
		"5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7", "5dyaeacGWamtVZy3Ad7Zoqudu+Oq0klgz/Nw7A==", "é", "AAAé",
		"YmFu\rYW5h\rcw==", "YmFuYW5hcw==\r", "\rYmFuYW5hcw==", "YmFuYW5hcw==\r\r", "!!!!", "AB==", "AAB=",
		"ZZ==", "Zg==", "Zg=", "Zm8=", "Zm9v", "Zm9vYg==", "TWFu", "AAAA\xff", "\x00AAA",
	}
	rests := []string{"", "x", "x\n", "\n", "\n\n\n", "a\nb\nc\n", "\r\n", "é\n", "\xff\n", "— sig AAAA\n"}

	type unmarshalRow = []any
	var unmarshal []unmarshalRow
	run := func(raw []byte) {
		var cp flog.Checkpoint
		rest, err := cp.Unmarshal(raw)
		if err != nil {
			unmarshal = append(unmarshal, unmarshalRow{hx(raw), boolInt(utf8.Valid(raw)), err.Error()})
			return
		}
		unmarshal = append(unmarshal, unmarshalRow{hx(raw), boolInt(utf8.Valid(raw)), "", hx([]byte(cp.Origin)), u64s(cp.Size), hx(cp.Hash), hx(rest)})
	}
	for _, o := range origins {
		for _, s := range sizes {
			for _, h := range hashes[:3] {
				run([]byte(string(o) + "\n" + s + "\n" + h + "\n"))
			}
		}
	}
	for _, s := range sizes {
		for _, h := range hashes {
			// Three trailing-data variants per (size, hash) pair, chosen by the seed.
			for k := 0; k < 3; k++ {
				run([]byte("Log\n" + s + "\n" + h + "\n" + rests[r.Intn(len(rests))]))
			}
		}
	}
	// A size line longer than the 64 code points the port's NumError quotes (ADR-0204).
	run([]byte("Log\n" + strings.Repeat("9", 80) + "\nYmFuYW5hcw==\n"))
	run([]byte("Log\n" + strings.Repeat("1", 70) + "x\nYmFuYW5hcw==\n"))
	base := []byte("Log\n123\nYmFuYW5hcw==\nrest\n")
	for i := 0; i <= len(base); i++ {
		run(base[:i])
	}
	alpha := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r -"
	for i := 0; i < scaled(2000); i++ {
		n := r.Intn(40)
		b := make([]byte, n)
		for k := range b {
			switch r.Intn(4) {
			case 0:
				b[k] = '\n'
			case 1:
				b[k] = "0123456789"[r.Intn(10)]
			case 2:
				b[k] = alpha[r.Intn(len(alpha))]
			default:
				b[k] = byte(r.Intn(256))
			}
		}
		run(b)
	}

	// Marshal and ID take a Go string. A JavaScript string cannot carry invalid
	// UTF-8, so those origins are left out of these two tables (Unmarshal, which
	// takes bytes, covers them).
	var marshal [][]any
	var ids [][]any
	for _, o := range origins {
		if !utf8.Valid(o) {
			continue
		}
		for _, sz := range []uint64{0, 1, 123, math.MaxUint64, 1 << 63} {
			for _, h := range [][]byte{nil, []byte("bananas"), make([]byte, 32), {0xff, 0xfe}, randBytes(r, 1+r.Intn(48))} {
				out := flog.Checkpoint{Origin: string(o), Size: sz, Hash: h}.Marshal()
				marshal = append(marshal, []any{string(o), u64s(sz), hx(h), hx(out)})
			}
		}
		ids = append(ids, []any{string(o), flog.ID(string(o))})
	}

	// ParseCheckpoint: bodies (some malformed) signed by the fixture log key, and
	// sometimes by the fixture witness key or a key under the same name, opened
	// with the log verifier plus a seeded selection of the others.
	logS, logV := mustSigner(logSKey), mustVerifier(logVKey)
	altS, altV := mustSigner(logAltSKey), mustVerifier(logAltVKey)
	witS, witV := mustSigner(witnessSKey), mustVerifier(witnessVKey)
	const logOrigin = "webtessera.fixture.log"
	bodies := []string{
		logOrigin + "\n5\nYmFuYW5hcw==\n",
		logOrigin + "\n5\nYmFuYW5hcw==\nextension line\n",
		logOrigin + "\n18446744073709551615\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n",
		logOrigin + "\n18446744073709551616\nYmFuYW5hcw==\n",
		logOrigin + "\n-1\nYmFuYW5hcw==\n",
		logOrigin + "\n5\nnot base64\n",
		logOrigin + "\n5\n",
		"other.origin\n5\nYmFuYW5hcw==\n",
		logOrigin + " \n5\nYmFuYW5hcw==\n",
		"\n5\nYmFuYW5hcw==\n",
		logOrigin + "\n05\nYmFuYW5hcw==\n",
		logOrigin + "\n5\nYmFuYW5hcw==\n\n",
		logOrigin + "\n5\nYmFuYW5hcw\n",
	}
	var parse [][]any
	for _, body := range bodies {
		for variant := 0; variant < 6; variant++ {
			var signers []note.Signer
			switch variant {
			case 0:
				signers = []note.Signer{logS}
			case 1:
				signers = []note.Signer{logS, witS}
			case 2:
				signers = []note.Signer{witS}
			case 3:
				signers = []note.Signer{altS, logS}
			case 4:
				signers = []note.Signer{altS}
			default:
				signers = []note.Signer{witS, logS, altS}
			}
			msg, err := note.Sign(&note.Note{Text: body}, signers...)
			if err != nil {
				panic(err)
			}
			for _, expect := range []string{logOrigin, "other.origin"} {
				var others []note.Verifier
				otherKeys := ""
				if r.Intn(2) == 0 {
					others = append(others, witV)
					otherKeys += "w"
				}
				if r.Intn(2) == 0 {
					others = append(others, altV)
					otherKeys += "a"
				}
				cp, other, n, err := flog.ParseCheckpoint(msg, expect, logV, others...)
				sigs := -1
				if n != nil {
					sigs = len(n.Sigs)
				}
				if err != nil {
					parse = append(parse, []any{hx(msg), expect, otherKeys, err.Error(), sigs})
					continue
				}
				parse = append(parse, []any{hx(msg), expect, otherKeys, "", sigs, cp.Origin, u64s(cp.Size), hx(cp.Hash), hx(other)})
			}
		}
	}

	return diffFile{
		description: "Differential corpus for formats/log: Checkpoint.Unmarshal over generated well-formed, boundary and random bodies (accept/reject, exact error text, every field and the trailing data), Checkpoint.Marshal and log.ID over every origin a JavaScript string can carry, and ParseCheckpoint over signed, mutated checkpoints.",
		upstream:    "github.com/transparency-dev/formats/log",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"unmarshal": []string{"rawHex", "rawIsUTF8", "err", "originHex", "size", "hashHex", "restHex"},
				"marshal":   []string{"origin", "size", "hashHex", "outHex"},
				"id":        []string{"origin", "id"},
				"parse":     []string{"msgHex", "expectedOrigin", "otherVerifiers (w=witness, a=alt log key)", "err", "noteSigCount (-1: no note)", "origin", "size", "hashHex", "otherDataHex"},
			}),
			dValue("keys", map[string]string{"log": logVKey, "alt": logAltVKey, "witness": witnessVKey}),
			dRows("unmarshal", unmarshal),
			dRows("marshal", marshal),
			dRows("id", ids),
			dRows("parse", parse),
		},
	}
}
