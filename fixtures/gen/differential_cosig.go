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
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	fnote "github.com/transparency-dev/formats/note"
	"golang.org/x/mod/sumdb/note"
)

// genDiffCosig records formats/note's cosignature/v1 support.
//
// A cosignature/v1 Signer reads the wall clock, so its output cannot be recorded
// reproducibly. The corpus therefore records the signatures a signer must
// produce at fixed timestamps: each is the 8-byte big-endian timestamp followed
// by an Ed25519 signature over the cosignature/v1 message, built here and then
// *proven* by upstream's own verifier, NewVerifierForCosignatureV1, which
// rebuilds the message with its unexported formatCosignatureV1 and accepts only
// an exact match. Ed25519 signing is deterministic, so a signer run with its
// clock at that timestamp has exactly one correct output. Everything else in the
// corpus (verdicts, error texts, key hashes, timestamps) is upstream's output.
func genDiffCosig() diffFile {
	r := newDiffRand(0xc051)
	names := []string{"wit", "Señor", "k2", "日本語-witness", "with\ufeffbom"}
	type key struct {
		name, skey, vkey, cosigVKey string
		priv                        ed25519.PrivateKey
	}
	var keys []key
	var keyRows [][]any
	for _, n := range names {
		seed := randBytes(r, 32)
		skey, vkey := dSeedKeys(n, seed)
		cv, err := fnote.VKeyToCosignatureV1(vkey)
		if err != nil {
			panic(err)
		}
		s, err := fnote.NewSignerForCosignatureV1(skey)
		if err != nil {
			panic(err)
		}
		keys = append(keys, key{n, skey, vkey, cv, ed25519.NewKeyFromSeed(seed)})
		keyRows = append(keyRows, []any{n, skey, vkey, cv, s.Name(), s.KeyHash(), s.Verifier().KeyHash()})
	}

	msgs := []string{
		"", "a", "a\n", "a\nb", "a\nb\n", "a\nb\nc", "origin\n5\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n",
		"origin\n5\nhash\next1\n", "\n\n", "\n\n\n", "café\n1\nh\n", "x\ny\nz\n\n", "\r\n\r\n",
	}
	stamps := []uint64{0, 1, 1727964367, 1 << 31, 1 << 32, 253402300799, 8640000000000}
	verifyStamps := append(append([]uint64{}, stamps...), 8640000000001, 1<<53, 1<<62, math.MaxInt64, 1<<63, math.MaxUint64)

	cosigMessage := func(t uint64, msg []byte) []byte {
		return []byte(fmt.Sprintf("cosignature/v1\ntime %d\n%s", t, msg))
	}
	sigAt := func(k key, t uint64, msg []byte) []byte {
		sig := binary.BigEndian.AppendUint64(nil, t)
		return append(sig, ed25519.Sign(k.priv, cosigMessage(t, msg))...)
	}

	var signRows, signErrRows, verifyRows [][]any
	for ki, k := range keys {
		s, err := fnote.NewSignerForCosignatureV1(k.skey)
		if err != nil {
			panic(err)
		}
		vPlain, err := fnote.NewVerifierForCosignatureV1(k.vkey)
		if err != nil {
			panic(err)
		}
		vCosig, err := fnote.NewVerifierForCosignatureV1(k.cosigVKey)
		if err != nil {
			panic(err)
		}
		for _, m := range msgs {
			msg := []byte(m)
			if _, err := s.Sign(msg); err != nil {
				// The format check precedes any use of the clock, so the error
				// is reproducible.
				signErrRows = append(signErrRows, []any{ki, hx(msg), err.Error()})
				continue
			}
			for _, t := range stamps {
				sig := sigAt(k, t, msg)
				if !vPlain.Verify(msg, sig) || !vCosig.Verify(msg, sig) || !s.Verifier().Verify(msg, sig) {
					panic(fmt.Sprintf("upstream rejected the cosignature built for t=%d msg=%q", t, m))
				}
				signRows = append(signRows, []any{ki, hx(msg), u64s(t), hx(sig)})
			}
			for _, t := range verifyStamps {
				if ki >= 3 {
					// Three keys are enough to cover the tampered variants.
					break
				}
				sig := sigAt(k, t, msg)
				variants := [][2][]byte{{msg, sig}}
				flip := func(i int) []byte {
					o := append([]byte{}, sig...)
					o[i] ^= 1
					return o
				}
				variants = append(variants,
					[2][]byte{msg, flip(7)},
					[2][]byte{msg, flip(0)},
					[2][]byte{msg, flip(20)},
					[2][]byte{msg, flip(71)},
					[2][]byte{msg, sig[:71]},
					[2][]byte{msg, append(append([]byte{}, sig...), 0)},
					[2][]byte{append(append([]byte{}, msg...), 'x'), sig},
					[2][]byte{msg, sig[8:]},
				)
				for _, v := range variants {
					verifyRows = append(verifyRows, []any{ki, hx(v[0]), hx(v[1]), boolInt(vPlain.Verify(v[0], v[1])), boolInt(vCosig.Verify(v[0], v[1]))})
				}
			}
		}
	}

	// CoSigV1Timestamp over well-formed and malformed signatures.
	var tsRows [][]any
	tsInputs := []string{}
	for _, t := range verifyStamps {
		raw := append(randBytes(r, 4), binary.BigEndian.AppendUint64(nil, t)...)
		raw = append(raw, randBytes(r, 64)...)
		b := base64.StdEncoding.EncodeToString(raw)
		tsInputs = append(tsInputs, b, b[:10]+"\n"+b[10:], b+"\r\n")
	}
	tsInputs = append(tsInputs, "", "!!!", "AAAA", base64.StdEncoding.EncodeToString(randBytes(r, 75)),
		base64.StdEncoding.EncodeToString(randBytes(r, 77)), base64.StdEncoding.EncodeToString(randBytes(r, 76))[1:],
		base64.StdEncoding.EncodeToString(randBytes(r, 76))+"=", " "+base64.StdEncoding.EncodeToString(randBytes(r, 76)))
	for _, b := range tsInputs {
		t, err := fnote.CoSigV1Timestamp(note.Signature{Base64: b})
		if err != nil {
			tsRows = append(tsRows, []any{b, err.Error()})
			continue
		}
		tsRows = append(tsRows, []any{b, "", fmt.Sprint(t.Unix())})
	}

	// Cosigned notes through note.Open, with the cosignature/v1 verifier and
	// with a plain Ed25519 verifier for the same key.
	var openRows [][]any
	for ki, k := range keys {
		vCosig, _ := fnote.NewVerifierForCosignatureV1(k.cosigVKey)
		vPlain := mustVerifier(k.vkey)
		for _, text := range []string{"origin\n5\nhash\n", "origin\n5\nhash\next\n", "a\nb\n"} {
			for _, t := range []uint64{1727964367, 0, math.MaxUint64} {
				sig := sigAt(k, t, []byte(text))
				line := "— " + k.name + " " + base64.StdEncoding.EncodeToString(append(binary.BigEndian.AppendUint32(nil, vCosig.KeyHash()), sig...)) + "\n"
				msg := []byte(text + "\n" + line)
				for vi, v := range []note.Verifier{vCosig, vPlain} {
					_, err := note.Open(msg, note.VerifierList(v))
					kind := "ok"
					var une *note.UnverifiedNoteError
					var ise *note.InvalidSignatureError
					switch {
					case err == nil:
					case errors.As(err, &une):
						kind = "unverified"
					case errors.As(err, &ise):
						kind = "invalid"
					default:
						kind = "other"
					}
					openRows = append(openRows, []any{ki, hx(msg), []string{"cosig", "plain"}[vi], kind, errString(err)})
				}
			}
		}
	}

	return diffFile{
		description: "Differential corpus for formats/note cosignature/v1: signer and verifier key hashes, the exact signature a signer must produce at fixed timestamps (proven by upstream's verifier), Sign's format errors, Verify over honest and tampered signatures at timestamps up to 2^64-1 with both key encodings, CoSigV1Timestamp, and cosigned notes through note.Open.",
		upstream:    "github.com/transparency-dev/formats/note",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"keys":      []string{"name", "skey", "vkey (alg 1)", "cosignature vkey (alg 4, from VKeyToCosignatureV1)", "signer Name", "signer KeyHash", "signer Verifier().KeyHash"},
				"sign":      []string{"key index", "msgHex", "unix seconds", "sigHex (what Sign returns with the clock at that second)"},
				"signError": []string{"key index", "msgHex", "err"},
				"verify":    []string{"key index", "msgHex", "sigHex", "verifier from vkey", "verifier from cosignature vkey"},
				"timestamp": []string{"signature base64", "err", "unix seconds (int64)"},
				"open":      []string{"key index", "msgHex", "verifier (cosig or plain Ed25519)", "kind", "err"},
			}),
			dRows("keys", keyRows),
			dRows("sign", signRows),
			dRows("signError", signErrRows),
			dRows("verify", verifyRows),
			dRows("timestamp", tsRows),
			dRows("open", openRows),
		},
	}
}
