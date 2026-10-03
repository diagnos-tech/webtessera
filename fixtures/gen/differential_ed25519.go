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
	"crypto/sha512"
	"encoding/hex"
	"math/big"

	"filippo.io/edwards25519"
	"golang.org/x/mod/sumdb/note"
)

// genDiffEd25519 records Go's crypto/ed25519.Verify, the function sumdb/note's
// Ed25519 verifier is a one-line wrapper of, over the vectors on which Ed25519
// implementations are known to disagree: small-order and mixed-order public
// keys, non-canonical encodings of A and R, S >= L, the high bits of S, torsion
// added to R, and signatures that satisfy the cofactored equation but not the
// cofactorless one Go checks. See docs/decisions/0025-ed25519-rfc8032-not-zip215.md.
//
// The adversarial vectors are built with filippo.io/edwards25519, the
// standalone release of the code Go's crypto/ed25519 runs on, so that each one
// lands exactly on the boundary it is meant to probe. They are inputs only: the
// verdict recorded for every vector is what crypto/ed25519.Verify returned.
func genDiffEd25519() diffFile {
	r := newDiffRand(0xed25519)

	type vec struct {
		pub, msg, sig []byte
		cat           string
	}
	var vecs []vec
	add := func(cat string, pub, msg, sig []byte) {
		vecs = append(vecs, vec{append([]byte{}, pub...), append([]byte{}, msg...), append([]byte{}, sig...), cat})
	}

	l := new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 252), mustBig("27742317777372353535851937790883648493"))
	leToBig := func(b []byte) *big.Int {
		be := make([]byte, len(b))
		for i := range b {
			be[len(b)-1-i] = b[i]
		}
		return new(big.Int).SetBytes(be)
	}
	bigToLE := func(x *big.Int, n int) []byte {
		be := x.FillBytes(make([]byte, n))
		out := make([]byte, n)
		for i := range be {
			out[n-1-i] = be[i]
		}
		return out
	}
	smallScalar := func(t int) *edwards25519.Scalar {
		b := make([]byte, 32)
		b[0] = byte(t)
		s, err := edwards25519.NewScalar().SetCanonicalBytes(b)
		if err != nil {
			panic(err)
		}
		return s
	}
	randScalar := func() *edwards25519.Scalar {
		s, err := edwards25519.NewScalar().SetUniformBytes(randBytes(r, 64))
		if err != nil {
			panic(err)
		}
		return s
	}
	hashScalar := func(parts ...[]byte) *edwards25519.Scalar {
		h := sha512.New()
		for _, p := range parts {
			h.Write(p)
		}
		s, err := edwards25519.NewScalar().SetUniformBytes(h.Sum(nil))
		if err != nil {
			panic(err)
		}
		return s
	}

	// 1. Honest signatures and their corruptions.
	for i := 0; i < scaled(100); i++ {
		priv := ed25519.NewKeyFromSeed(randBytes(r, 32))
		pub := priv.Public().(ed25519.PublicKey)
		msg := randBytes(r, r.Intn(40))
		sig := ed25519.Sign(priv, msg)
		add("honest", pub, msg, sig)
		for j := 0; j < 4; j++ {
			s2 := append([]byte{}, sig...)
			s2[r.Intn(64)] ^= 1 << uint(r.Intn(8))
			add("bitflip-sig", pub, msg, s2)
		}
		if len(msg) > 0 {
			m2 := append([]byte{}, msg...)
			m2[0] ^= 1
			add("bitflip-msg", pub, m2, sig)
		}
		add("short-sig", pub, msg, sig[:63])
		add("long-sig", pub, msg, append(append([]byte{}, sig...), 0))
		// S + L: the same group element, non-canonically encoded.
		if s2 := new(big.Int).Add(leToBig(sig[32:]), l); s2.BitLen() <= 256 {
			add("s-plus-l", pub, msg, append(append([]byte{}, sig[:32]...), bigToLE(s2, 32)...))
		}
		// The three high bits of S, which Go checks before decoding anything.
		for _, bit := range []byte{0x20, 0x40, 0x80} {
			s2 := append([]byte{}, sig...)
			s2[63] |= bit
			add("s-high-bits", pub, msg, s2)
		}
		r2 := append([]byte{}, sig...)
		r2[31] ^= 0x80
		add("r-signflip", pub, msg, r2)
		p2 := append([]byte{}, pub...)
		p2[31] ^= 0x80
		add("a-signflip", p2, msg, sig)
	}

	// 2. Small-order public keys, canonically and non-canonically encoded, with
	// signatures that satisfy the cofactorless equation: R = [S]B - [t]A where
	// the challenge k happens to be congruent to t modulo A's order.
	torsion := []string{
		"0100000000000000000000000000000000000000000000000000000000000000",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0000000000000000000000000000000000000000000000000000000000000080",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
	}
	p := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	enc := func(y *big.Int, sign bool) string {
		b := bigToLE(y, 32)
		if sign {
			b[31] |= 0x80
		}
		return hex.EncodeToString(b)
	}
	nonCanonical := []string{
		enc(new(big.Int).Add(big.NewInt(1), p), false), enc(p, false), enc(new(big.Int).Add(big.NewInt(1), p), true),
		enc(p, true), enc(big.NewInt(1), true), enc(new(big.Int).Sub(p, big.NewInt(1)), true),
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	}
	for _, ah := range append(append([]string{}, torsion...), nonCanonical...) {
		pub := mustHex(ah)
		A, err := new(edwards25519.Point).SetBytes(pub)
		if err != nil {
			add("small-a-undecodable", pub, randBytes(r, 5), randBytes(r, 64))
			continue
		}
		found := 0
		for tries := 0; tries < 20000 && found < 6; tries++ {
			msg := randBytes(r, 1+r.Intn(8))
			S := randScalar()
			for t := 0; t < 8 && found < 6; t++ {
				R := new(edwards25519.Point).Subtract(new(edwards25519.Point).ScalarBaseMult(S), new(edwards25519.Point).ScalarMult(smallScalar(t), A))
				Rb := R.Bytes()
				k := hashScalar(Rb, pub, msg)
				resid := new(edwards25519.Point).Add(R, new(edwards25519.Point).ScalarMult(k, A))
				resid.Subtract(resid, new(edwards25519.Point).ScalarBaseMult(S))
				if resid.Equal(edwards25519.NewIdentityPoint()) == 1 {
					add("small-a-valid", pub, msg, append(Rb, S.Bytes()...))
					found++
				}
			}
		}
		add("small-a-invalid", pub, randBytes(r, 5), randBytes(r, 64))
	}

	// 3. Mixed-order public keys A = [a]B + T with S = r + k*a. The cofactored
	// equation always holds; the cofactorless one only when [k]T is the identity.
	for ti := 1; ti < len(torsion); ti++ {
		T, err := new(edwards25519.Point).SetBytes(mustHex(torsion[ti]))
		if err != nil {
			panic(err)
		}
		for i := 0; i < scaled(80); i++ {
			a := randScalar()
			A := new(edwards25519.Point).Add(new(edwards25519.Point).ScalarBaseMult(a), T)
			pub := A.Bytes()
			msg := randBytes(r, 1+r.Intn(8))
			rr := randScalar()
			Rb := new(edwards25519.Point).ScalarBaseMult(rr).Bytes()
			k := hashScalar(Rb, pub, msg)
			S := edwards25519.NewScalar().MultiplyAdd(k, a, rr)
			add("mixed-order", pub, msg, append(Rb, S.Bytes()...))
		}
	}

	// 4. Honest signatures with a torsion point added to R.
	for ti := 1; ti < len(torsion); ti++ {
		T, _ := new(edwards25519.Point).SetBytes(mustHex(torsion[ti]))
		for i := 0; i < scaled(30); i++ {
			priv := ed25519.NewKeyFromSeed(randBytes(r, 32))
			msg := randBytes(r, 4)
			sig := ed25519.Sign(priv, msg)
			R, err := new(edwards25519.Point).SetBytes(sig[:32])
			if err != nil {
				panic(err)
			}
			R.Add(R, T)
			add("r-plus-torsion", priv.Public().(ed25519.PublicKey), msg, append(R.Bytes(), sig[32:]...))
		}
	}

	// 5. Non-canonically encoded R for the identity: y = 1 + p. Go compares R
	// against a canonical re-encoding, so these never verify.
	for i := 0; i < 10; i++ {
		priv := ed25519.NewKeyFromSeed(randBytes(r, 32))
		msg := randBytes(r, 3)
		sig := ed25519.Sign(priv, msg)
		add("r-noncanonical", priv.Public().(ed25519.PublicKey), msg, append(mustHex(nonCanonical[i%len(nonCanonical)]), sig[32:]...))
	}

	// 6. Public keys that are mostly not curve points at all.
	for i := 0; i < scaled(60); i++ {
		priv := ed25519.NewKeyFromSeed(randBytes(r, 32))
		msg := randBytes(r, 3)
		add("random-pub", randBytes(r, 32), msg, ed25519.Sign(priv, msg))
	}

	// Classify every distinct public key, and record what note.NewVerifier says
	// about a verifier key built from it.
	type keyInfo struct {
		idx   int
		class string
	}
	keys := map[string]keyInfo{}
	var keyRows [][]any
	lMinus1 := bigToLE(new(big.Int).Sub(l, big.NewInt(1)), 32)
	lm1, err := edwards25519.NewScalar().SetCanonicalBytes(lMinus1)
	if err != nil {
		panic(err)
	}
	classify := func(pub []byte) string {
		A, err := new(edwards25519.Point).SetBytes(pub)
		if err != nil {
			return "not-a-point"
		}
		suffix := ""
		if !bytes.Equal(A.Bytes(), pub) {
			suffix = "-noncanonical"
		}
		eight := new(edwards25519.Point).ScalarMult(smallScalar(8), A)
		if eight.Equal(edwards25519.NewIdentityPoint()) == 1 {
			return "small-order" + suffix
		}
		lA := new(edwards25519.Point).Add(new(edwards25519.Point).ScalarMult(lm1, A), A)
		if lA.Equal(edwards25519.NewIdentityPoint()) != 1 {
			return "mixed-order" + suffix
		}
		return "prime-order" + suffix
	}
	var rows [][]any
	for _, v := range vecs {
		k := hex.EncodeToString(v.pub)
		ki, ok := keys[k]
		if !ok {
			ki = keyInfo{len(keyRows), classify(v.pub)}
			keys[k] = ki
			vkey := dVKey("ed25519-differential", 1, v.pub)
			nv, err := note.NewVerifier(vkey)
			verdictErr := ""
			if err != nil {
				verdictErr = err.Error()
			} else if nv.Name() != "ed25519-differential" {
				panic("unexpected verifier name")
			}
			keyRows = append(keyRows, []any{k, ki.class, vkey, verdictErr})
		}
		rows = append(rows, []any{ki.idx, hx(v.msg), hx(v.sig), v.cat, boolInt(ed25519.Verify(v.pub, v.msg, v.sig))})
	}

	return diffFile{
		description: "Differential corpus for Ed25519 verification as Go's crypto/ed25519.Verify performs it (sumdb/note's verifier): honest signatures and corruptions, S+L, S high bits, small-order and non-canonically encoded public keys with cofactorless-valid signatures, mixed-order keys, torsion added to R, non-canonical R, and random keys. Each public key is classified, and note.NewVerifier's verdict on a verifier key built from it is recorded.",
		upstream:    "crypto/ed25519 (Go standard library), golang.org/x/mod/sumdb/note",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"keys":    []string{"pubHex", "class (prime-order, mixed-order, small-order, not-a-point; -noncanonical if the encoding is not canonical)", "vkey", "note.NewVerifier err"},
				"vectors": []string{"key index", "msgHex", "sigHex", "category", "crypto/ed25519.Verify"},
			}),
			dRows("keys", keyRows),
			dRows("vectors", rows),
		},
	}
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func mustBig(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic(s)
	}
	return v
}
