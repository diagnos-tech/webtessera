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
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"unicode/utf8"

	fnote "github.com/transparency-dev/formats/note"
	"golang.org/x/mod/sumdb/note"
)

// The note corpora build their inputs (encoded keys, signature lines) by hand,
// because most of them are deliberately malformed: names upstream would refuse
// to sign under, hashes in the wrong spelling, base64 with stray bytes. A key
// hash or an Ed25519 signature computed here is only ever part of an *input*;
// every verdict in the corpora comes from calling upstream on it.

// dKeyHash is the note key hash of name and an algorithm-prefixed key, as the
// signed-note format defines it. It is used to build input keys only.
func dKeyHash(name string, algKey []byte) uint32 {
	h := sha256.New()
	h.Write([]byte(name))
	h.Write([]byte("\n"))
	h.Write(algKey)
	return binary.BigEndian.Uint32(h.Sum(nil))
}

// dVKey encodes a verifier key with a correct hash over whatever name and key
// bytes it is given.
func dVKey(name string, alg byte, key []byte) string {
	payload := append([]byte{alg}, key...)
	return fmt.Sprintf("%s+%08x+%s", name, dKeyHash(name, payload), base64.StdEncoding.EncodeToString(payload))
}

// dSeedKeys encodes the signer and verifier keys of an Ed25519 seed under name.
func dSeedKeys(name string, seed []byte) (skey, vkey string) {
	pub := append([]byte{1}, ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)...)
	h := dKeyHash(name, pub)
	skey = fmt.Sprintf("PRIVATE+KEY+%s+%08x+%s", name, h, base64.StdEncoding.EncodeToString(append([]byte{1}, seed...)))
	vkey = fmt.Sprintf("%s+%08x+%s", name, h, base64.StdEncoding.EncodeToString(pub))
	return skey, vkey
}

// dSigLine builds a raw signature line for text under name, whether or not
// upstream would accept name.
func dSigLine(name string, seed, text []byte) []byte {
	priv := ed25519.NewKeyFromSeed(seed)
	pub := append([]byte{1}, priv.Public().(ed25519.PublicKey)...)
	hb := binary.BigEndian.AppendUint32(nil, dKeyHash(name, pub))
	sig := ed25519.Sign(priv, text)
	return []byte("— " + name + " " + base64.StdEncoding.EncodeToString(append(hb, sig...)) + "\n")
}

// dKeyVariants returns key plus the malformed spellings of it the key corpora
// try: hash-field mutations, base64-field mutations, and aliases of the final
// base64 character that differ only in its unused low bits. hashField is the
// index of the hash among the "+"-separated fields.
func dKeyVariants(key string, hashField int) []string {
	out := []string{key}
	parts := strings.SplitN(key, "+", hashField+2)
	if len(parts) < hashField+2 {
		return out
	}
	mk := func(f func(string) string) {
		if len(parts[hashField]) != 8 {
			// A name with a '+' in it shifts the fields; its hash field is
			// not where the mutations expect it.
			return
		}
		p := append([]string{}, parts...)
		p[hashField] = f(p[hashField])
		out = append(out, strings.Join(p, "+"))
	}
	mk(strings.ToUpper)
	mk(func(h string) string { return "+" + h[1:] })
	mk(func(h string) string { return " " + h[1:] })
	mk(func(h string) string { return h[:7] + "g" })
	mk(func(h string) string { return "0x" + h[2:] })
	mk(func(h string) string { return h + "0" })
	mk(func(h string) string { return h[:7] })
	mk(func(h string) string { return "-" + h[1:] })
	mk(func(h string) string { return h[:2] + "_" + h[3:] })
	head := strings.Join(parts[:hashField+1], "+") + "+"
	b64 := parts[hashField+1]
	if len(b64) < 6 {
		return out
	}
	out = append(out,
		head+b64+"\n",
		head+b64[:4]+"\n"+b64[4:],
		head+b64[:4]+"\r\n"+b64[4:],
		head+b64+" ",
		head+" "+b64,
		head+b64[:len(b64)-1],
		head+b64+"=",
		head+strings.TrimRight(b64, "="),
		head+b64[:len(b64)-2]+"==",
		head+b64[:4]+"\r"+b64[4:],
	)
	const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	trimmed := strings.TrimRight(b64, "=")
	i := len(trimmed) - 1
	if c := strings.IndexByte(al, b64[i]); c >= 0 {
		for _, d := range []int{1, 2, 3} {
			out = append(out, head+b64[:i]+string(al[(c^d)%64])+b64[i+1:])
		}
	}
	return out
}

// dHashByteSpellings are key-hash fields whose length in bytes and in UTF-16
// code units differ: 8 bytes in 4, 6 or 7 code units, and 8 code units in 9, 16
// or 24 bytes.
var dHashByteSpellings = []string{
	"éééé", "😀😀", "éabcdef", "\ufeffabcde", "\u0085abcdef",
	"éééééééé", "1234567é", "abcdéf12", "１２３４５６７８",
}

// dWithField returns key with its "+"-separated field i replaced by v.
func dWithField(key string, i int, v string) string {
	p := strings.Split(key, "+")
	p[i] = v
	return strings.Join(p, "+")
}

// dNameResult renders a constructor result: [err] on failure, ["", name, hash]
// on success.
func dNameResult(name string, hash uint32, err error) []any {
	if err != nil {
		return []any{err.Error()}
	}
	return []any{"", name, hash}
}

// dKeyNames are the signer names the key corpora try: valid names, names with
// every kind of character isValidName must reject (Unicode White_Space, '+',
// controls), and characters it must accept although they look like space (BOM,
// zero-width space, soft hyphen, word joiner).
var dKeyNames = []string{
	"log", "example.com/log", "Señor-0", "日本語", "a", strings.Repeat("x", 300),
	"with\u0085nel", "with nbsp", "with emsp", "with ogham", "with᠎mvs",
	"with\ufeffbom", "\ufeffleadingbom", "with​zwsp", "with ls", "with　ideo",
	"with+plus", "", "with space", "with\ttab", "with\nnl", "with\x00nul", "with\x7fdel",
	"🌲tree", "with­shy", "with⁠wj", "with\u0099c1", "with mmsp", "with\u000bvt",
}

func genDiffNoteKeys() diffFile {
	r := newDiffRand(0x4e07e5)
	k32 := randBytes(r, 32)
	type keySpec struct {
		alg byte
		key []byte
	}
	specs := []keySpec{
		{1, k32}, {4, k32}, {2, k32}, {0, k32}, {255, k32}, {1, randBytes(r, 31)}, {1, randBytes(r, 33)},
		{4, randBytes(r, 31)}, {1, nil}, {4, nil},
	}

	var vkeys, skeys []string
	for _, n := range dKeyNames {
		for _, s := range specs {
			for i, v := range dKeyVariants(dVKey(n, s.alg, s.key), 1) {
				// Every base key, and a seeded half of its malformed spellings.
				if i == 0 || r.Intn(2) == 0 {
					vkeys = append(vkeys, v)
				}
			}
		}
		skey, vkey := dSeedKeys(n, randBytes(r, 32))
		vkeys = append(vkeys, dKeyVariants(vkey, 1)...)
		skeys = append(skeys, dKeyVariants(skey, 3)...)
		// A signer key whose seed has the wrong length or algorithm, with a
		// hash that is right for what it encodes.
		for _, s := range specs[5:] {
			payload := append([]byte{s.alg}, s.key...)
			skeys = append(skeys, fmt.Sprintf("PRIVATE+KEY+%s+%08x+%s", n, dKeyHash(n, payload), base64.StdEncoding.EncodeToString(payload)))
		}
		p := strings.SplitN(skey, "+", 3)
		skeys = append(skeys, "private+KEY+"+p[2], "PRIVATE+key+"+p[2], "PRIVATE+KEY", "PRIVATE+KEY+"+n, p[2])
	}
	// Truncations of seeded keys from either end.
	base := append([]string{}, vkeys...)
	for i := 0; i < scaled(400); i++ {
		b := base[r.Intn(len(base))]
		// Cut on a rune boundary: a JavaScript string cannot carry half a rune.
		i := r.Intn(len(b) + 1)
		for i > 0 && i < len(b) && !utf8.RuneStart(b[i]) {
			i--
		}
		if r.Intn(2) == 0 {
			vkeys = append(vkeys, b[i:])
		} else {
			vkeys = append(vkeys, b[:i])
		}
	}

	// Hash fields that are 8 bytes without being 8 UTF-16 code units, or the
	// reverse: Go's len counts bytes, which a JavaScript port must not confuse
	// with a string's length. They draw from their own seed and are appended
	// last, so the records above and below keep their values.
	rh := newDiffRand(0x4e07e6)
	for _, n := range []string{"log", "Señor-0"} {
		skey, vkey := dSeedKeys(n, randBytes(rh, 32))
		for _, h := range dHashByteSpellings {
			vkeys = append(vkeys, dWithField(vkey, 1, h))
			skeys = append(skeys, dWithField(skey, 3, h))
		}
	}

	var verifierRows [][]any
	for _, k := range vkeys {
		nv, err := note.NewVerifier(k)
		var noteRes []any
		if err != nil {
			noteRes = dNameResult("", 0, err)
		} else {
			noteRes = dNameResult(nv.Name(), nv.KeyHash(), nil)
		}
		cv, err := fnote.NewVerifierForCosignatureV1(k)
		var cosigRes []any
		if err != nil {
			cosigRes = dNameResult("", 0, err)
		} else {
			cosigRes = dNameResult(cv.Name(), cv.KeyHash(), nil)
		}
		var toCosig []any
		if out, err := fnote.VKeyToCosignatureV1(k); err != nil {
			toCosig = []any{err.Error()}
		} else {
			toCosig = []any{"", out}
		}
		verifierRows = append(verifierRows, []any{k, noteRes, cosigRes, toCosig})
	}
	var signerRows [][]any
	for _, k := range skeys {
		ns, err := note.NewSigner(k)
		var noteRes []any
		if err != nil {
			noteRes = dNameResult("", 0, err)
		} else {
			noteRes = dNameResult(ns.Name(), ns.KeyHash(), nil)
		}
		cs, err := fnote.NewSignerForCosignatureV1(k)
		var cosigRes []any
		if err != nil {
			cosigRes = dNameResult("", 0, err)
		} else {
			cosigRes = dNameResult(cs.Name(), cs.KeyHash(), nil)
		}
		signerRows = append(signerRows, []any{k, noteRes, cosigRes})
	}

	// NewEd25519VerifierKey and GenerateKey, the two key encoders. GenerateKey is
	// fed a fixed seed through its reader, so its output is reproducible.
	var encodeRows [][]any
	for _, n := range dKeyNames {
		for _, kl := range []int{32, 31, 33, 0} {
			key := randBytes(r, kl)
			out, err := note.NewEd25519VerifierKey(n, key)
			if err != nil {
				encodeRows = append(encodeRows, []any{n, hx(key), err.Error()})
			} else {
				encodeRows = append(encodeRows, []any{n, hx(key), "", out})
			}
		}
	}
	var generateRows [][]any
	for _, n := range dKeyNames {
		seed := randBytes(r, 32)
		skey, vkey, err := note.GenerateKey(bytes.NewReader(seed), n)
		if err != nil {
			generateRows = append(generateRows, []any{n, hx(seed), err.Error()})
		} else {
			generateRows = append(generateRows, []any{n, hx(seed), "", skey, vkey})
		}
	}

	return diffFile{
		description: "Differential corpus for encoded note keys: sumdb/note NewVerifier, NewSigner, NewEd25519VerifierKey and GenerateKey, and formats/note NewVerifierForCosignatureV1, NewSignerForCosignatureV1 and VKeyToCosignatureV1, over names with every class of Unicode space, BOM, controls and '+', every algorithm byte and key length, and malformed spellings of the hash and base64 fields.",
		upstream:    "golang.org/x/mod/sumdb/note, github.com/transparency-dev/formats/note",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"result":   "[err] on failure, [\"\", name, keyHash] on success; toCosig is [err] or [\"\", vkey]",
				"verifier": []string{"vkey", "note.NewVerifier", "note.NewVerifierForCosignatureV1", "note.VKeyToCosignatureV1"},
				"signer":   []string{"skey", "note.NewSigner", "note.NewSignerForCosignatureV1"},
				"encode":   []string{"name", "keyHex", "err", "vkey"},
				"generate": []string{"name", "seedHex (the reader's bytes)", "err", "skey", "vkey"},
			}),
			dRows("verifier", verifierRows),
			dRows("signer", signerRows),
			dRows("encode", encodeRows),
			dRows("generate", generateRows),
		},
	}
}

// dOpenNames are the names signature lines are made under in the Open corpus,
// valid or not; dOpenVerifierNames are the ones a verifier can be built for.
var (
	dOpenNames         = []string{"alpha", "Señor-0", "with\ufeffbom", "\ufeffleadingbom", "日本語", "with\u0085nel", "with nbsp", "with+plus", "with space", "", "bad name", "with​zwsp"}
	dOpenVerifierNames = []string{"alpha", "Señor-0", "with\ufeffbom", "\ufeffleadingbom", "日本語", "with​zwsp"}
)

// dMutateNote applies one seeded mutation to a signed note.
func dMutateNote(r *rand.Rand, m []byte) []byte {
	interesting := []byte{0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x20, 0x2b, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xe0, 0xe2, 0x94, 0xa0, 0xed, 0xef, 0xbb, 0xf0, 0xf4, 0x90, 0xf5, 0xff, 0x3d, 0x41}
	p := r.Intn(len(m) + 1)
	cat := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	switch r.Intn(11) {
	case 0:
		o := append([]byte{}, m...)
		if len(o) > 0 {
			o[r.Intn(len(o))] = interesting[r.Intn(len(interesting))]
		}
		return o
	case 1:
		return cat(m[:p], []byte{interesting[r.Intn(len(interesting))]}, m[p:])
	case 2:
		if len(m) == 0 {
			return m
		}
		q := min(p, len(m)-1)
		return cat(m[:q], m[q+1:])
	case 3:
		return append([]byte{}, m[:p]...)
	case 4:
		return cat([]byte{0xef, 0xbb, 0xbf}, m)
	case 5:
		return cat(m, []byte("\n"))
	case 6:
		return cat(m, []byte("\n\n"))
	case 7:
		return bytes.Replace(m, []byte("\n\n"), []byte("\n\n\n"), 1)
	case 8:
		o := append([]byte{}, m...)
		if len(o) > 0 {
			q := r.Intn(len(o))
			o[q] ^= 1 << uint(r.Intn(8))
		}
		return o
	case 9:
		// Repeat the last signature line.
		last := bytes.LastIndexByte(m[:max(0, len(m)-1)], '\n')
		return cat(m, m[last+1:])
	default:
		// Break a signature line's base64 with a newline or a space.
		i := bytes.LastIndex(m, []byte(" "))
		if i < 0 || i+5 > len(m) {
			return m
		}
		if r.Intn(2) == 0 {
			return cat(m[:i+5], []byte("\n"), m[i+5:])
		}
		return cat(m[:i+5], []byte(" "), m[i+5:])
	}
}

func genDiffNoteOpen() diffFile {
	r := newDiffRand(0x0be7)
	seeds := map[string][]byte{}
	for _, n := range dOpenNames {
		seeds[n] = randBytes(r, 32)
	}
	var vkeys []string
	var verifiers []note.Verifier
	for _, n := range dOpenVerifierNames {
		_, vkey := dSeedKeys(n, seeds[n])
		vkeys = append(vkeys, vkey)
		verifiers = append(verifiers, mustVerifier(vkey))
	}
	texts := []string{
		"hello\n", "origin\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n", "\n", "a\n\n", "\ufeffbom text\n",
		"tab\there\n", "del\x7f\n", "nul\x00\n", "cr\r\n", "ünï code\u0085\n", "�replacement\n", "🌲\n", "x\n\ny\n",
		"— looks like a sig line\n", "no final newline",
	}

	type sigOut = []any
	conv := func(ss []note.Signature) []sigOut {
		out := []sigOut{}
		for _, s := range ss {
			out = append(out, sigOut{s.Name, s.Hash, s.Base64})
		}
		return out
	}

	var rows [][]any
	record := func(msg []byte, mask int) {
		var vs []note.Verifier
		for i, v := range verifiers {
			if mask&(1<<i) != 0 {
				vs = append(vs, v)
			}
		}
		// Bit 6 adds the first verifier a second time, which makes it ambiguous.
		if mask&(1<<len(verifiers)) != 0 {
			vs = append(vs, verifiers[0])
		}
		n, err := note.Open(msg, note.VerifierList(vs...))
		if err == nil {
			rows = append(rows, []any{hx(msg), mask, "ok", "", len(n.Text), conv(n.Sigs), conv(n.UnverifiedSigs)})
			return
		}
		var une *note.UnverifiedNoteError
		var ise *note.InvalidSignatureError
		switch {
		case errors.As(err, &une):
			rows = append(rows, []any{hx(msg), mask, "unverified", err.Error(), len(une.Note.Text), conv(une.Note.Sigs), conv(une.Note.UnverifiedSigs)})
		case errors.As(err, &ise):
			rows = append(rows, []any{hx(msg), mask, "invalid", err.Error()})
		default:
			rows = append(rows, []any{hx(msg), mask, "other", err.Error()})
		}
	}
	fullMask := 1<<len(verifiers) - 1

	for _, t := range texts {
		for rep := 0; rep < scaled(110); rep++ {
			nl := 1 + r.Intn(3)
			m := []byte(t + "\n")
			for j := 0; j < nl; j++ {
				n := dOpenNames[r.Intn(len(dOpenNames))]
				m = append(m, dSigLine(n, seeds[n], []byte(t))...)
			}
			for j := r.Intn(3); j > 0; j-- {
				m = dMutateNote(r, m)
			}
			mask := r.Intn(fullMask + 1)
			if r.Intn(20) == 0 {
				mask |= 1 << len(verifiers)
			}
			record(m, mask)
		}
	}
	// 100 signatures are allowed, 101 are not; and the same for duplicates.
	t := "many\n"
	for _, count := range []int{100, 101} {
		m := []byte(t + "\n")
		for j := 0; j < count; j++ {
			n := dOpenVerifierNames[j%len(dOpenVerifierNames)]
			m = append(m, dSigLine(n, seeds[n], []byte(t))...)
		}
		record(m, fullMask)
		record(m, 0)
	}

	return diffFile{
		description: "Differential corpus for sumdb/note Open: notes signed under valid and invalid names (Unicode spaces, BOM, '+', empty), with seeded mutations (stray bytes, invalid UTF-8, controls, BOM prefix, truncation, bit flips, duplicate and broken signature lines), opened against seeded verifier sets. Records the verdict, the error kind and text, and the verified and unverified signatures.",
		upstream:    "golang.org/x/mod/sumdb/note",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"cases":        []string{"msgHex", "verifierMask (bit i: verifierKeys[i]; bit 6: verifierKeys[0] again)", "kind (ok, unverified, invalid, other)", "err", "textLen (bytes)", "sigs [name, hash, base64]", "unverifiedSigs"},
				"verifierKeys": "the vkeys verifierMask selects from",
			}),
			dValue("verifierKeys", vkeys),
			dRows("cases", rows),
		},
	}
}

func genDiffNoteSign() diffFile {
	r := newDiffRand(0x5197)
	wire := []string{"alpha", "Señor", "x\ufeffy", "bad name", "plus+name", "", "nel\u0085", "日本"}
	seeds := make([][]byte, len(wire))
	hashes := make([]uint32, len(wire))
	for i, n := range wire {
		seeds[i] = randBytes(r, 32)
		pub := append([]byte{1}, ed25519.NewKeyFromSeed(seeds[i]).Public().(ed25519.PublicKey)...)
		hashes[i] = dKeyHash(n, pub)
	}
	texts := []string{"hello\n", "no newline", "", "\n", "a\n\nb\n", "\x01ctl\n", "café 日本語 🌲\n", "\ufeffbom\n", "cr\r\n", "x\n\n", "\x7f\n", "a\nb\n\n"}
	b64s := []string{"", "AAAA", "AAAAAAAA", "AAA", "AAA=", "A", "AAAA\nAAAA", "AA==\n", "!!!!", "AAAAAAAAAAAA", "x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM="}

	mkSig := func() []any {
		k := r.Intn(len(wire))
		h := hashes[k]
		if r.Intn(3) == 0 {
			h = r.Uint32()
		}
		var b64 string
		switch {
		case r.Intn(3) == 0:
			b64 = b64s[r.Intn(len(b64s))]
		default:
			raw := binary.BigEndian.AppendUint32(nil, h)
			raw = append(raw, randBytes(r, r.Intn(6))...)
			b64 = base64.StdEncoding.EncodeToString(raw)
			if r.Intn(4) == 0 {
				b64 = b64[:4] + "\n" + b64[4:]
			}
		}
		return []any{wire[k], h, b64}
	}
	toSigs := func(in [][]any) []note.Signature {
		var out []note.Signature
		for _, s := range in {
			out = append(out, note.Signature{Name: s[0].(string), Hash: s[1].(uint32), Base64: s[2].(string)})
		}
		return out
	}

	var rows [][]any
	for i := 0; i < scaled(1500); i++ {
		text := texts[r.Intn(len(texts))]
		var signerIdx []int
		var signers []note.Signer
		for j := r.Intn(4); j > 0; j-- {
			k := r.Intn(len(wire))
			signerIdx = append(signerIdx, k)
			signers = append(signers, &dRawSigner{wire[k], hashes[k], ed25519.NewKeyFromSeed(seeds[k])})
		}
		sigs := [][]any{}
		for j := r.Intn(3); j > 0; j-- {
			sigs = append(sigs, mkSig())
		}
		unv := [][]any{}
		for j := r.Intn(3); j > 0; j-- {
			unv = append(unv, mkSig())
		}
		if signerIdx == nil {
			signerIdx = []int{}
		}
		msg, err := note.Sign(&note.Note{Text: text, Sigs: toSigs(sigs), UnverifiedSigs: toSigs(unv)}, signers...)
		if err != nil {
			rows = append(rows, []any{text, sigs, unv, signerIdx, err.Error()})
			continue
		}
		rows = append(rows, []any{text, sigs, unv, signerIdx, "", hx(msg)})
	}

	signerTable := [][]any{}
	for i, n := range wire {
		signerTable = append(signerTable, []any{n, hx(seeds[i]), hashes[i]})
	}
	return diffFile{
		description: "Differential corpus for sumdb/note Sign: texts with and without a final newline, controls and BOM, existing verified and unverified signatures (valid and malformed), and signers under valid and invalid names. Records the error text or the signed note's exact bytes.",
		upstream:    "golang.org/x/mod/sumdb/note",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"signers": []string{"name", "ed25519SeedHex", "keyHash"},
				"cases":   []string{"text", "sigs [name, hash, base64]", "unverifiedSigs", "signer indices into signers", "err", "msgHex"},
			}),
			dRows("signers", signerTable),
			dRows("cases", rows),
		},
	}
}

// dRawSigner is a note.Signer under any name, which note.NewSigner would refuse
// to build for an invalid one.
type dRawSigner struct {
	name string
	hash uint32
	priv ed25519.PrivateKey
}

func (s *dRawSigner) Name() string                    { return s.name }
func (s *dRawSigner) KeyHash() uint32                 { return s.hash }
func (s *dRawSigner) Sign(msg []byte) ([]byte, error) { return ed25519.Sign(s.priv, msg), nil }
