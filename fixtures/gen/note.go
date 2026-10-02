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
	"strings"

	"golang.org/x/mod/sumdb/note"
)

// The fixture key pairs are hard-coded literals, generated once with
// note.GenerateKey over a fixed-seed reader and pasted here. They are never
// generated at run time: Ed25519 signing is deterministic, so a fixed key makes
// every signed note in these fixtures byte-reproducible. These keys protect
// nothing and exist only as test data.
const (
	logSKey = "PRIVATE+KEY+webtessera.fixture.log+dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP"
	logVKey = "webtessera.fixture.log+dc00151b+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+"

	// A second key under the *same* name as the log key. Tessera's
	// WithCheckpointSigner requires additional signers to share the primary
	// signer's name, because that name becomes the checkpoint origin line.
	logAltSKey = "PRIVATE+KEY+webtessera.fixture.log+0b346a02+AatB/ryTC6yx/z9mfSFOpckaIj8rtUCMq5fJQCkqKqcS"
	logAltVKey = "webtessera.fixture.log+0b346a02+ASJeqgEv/cnbapkBc5C6Tbe4TbYEsD514XV+X+9rqqDA"

	// A key under a different name, standing in for a witness co-signature.
	witnessSKey = "PRIVATE+KEY+webtessera.fixture.witness+18f977d3+AWJLz5U03Pi3k4VdC8bTygn0Fp9s0JwfaD4tvnYM4ClS"
	witnessVKey = "webtessera.fixture.witness+18f977d3+AWfIJIn8/IKAwqkiLCaTIP6Z8DCka5VbRyQTewy1nIn2"

	// A third key, used for the "signature present but verifier unknown" case.
	secondSKey = "PRIVATE+KEY+webtessera.fixture.second+cb63cb3e+AacD49pY1MTETLoyc+lMyXbDyMyM44R4ayC4JTt5z+qM"
	secondVKey = "webtessera.fixture.second+cb63cb3e+AVUZuaiqKiGx0bQJhXhgv1V9wwvWtD/Q9zQIjrlHGqoM"
)

func mustSigner(skey string) note.Signer {
	s, err := note.NewSigner(skey)
	if err != nil {
		panic(err)
	}
	return s
}

func mustVerifier(vkey string) note.Verifier {
	v, err := note.NewVerifier(vkey)
	if err != nil {
		panic(err)
	}
	return v
}

type keyPair struct {
	Name string `json:"name"`
	SKey string `json:"skey"`
	VKey string `json:"vkey"`
	// KeyHash is the uint32 note key hash as a decimal string; KeyHashHex is
	// the same value in the 8-digit lower-case hex spelling that appears in the
	// encoded key and in the four-byte signature prefix.
	KeyHash    U64    `json:"keyHash"`
	KeyHashHex string `json:"keyHashHex"`
	// PublicKey is the raw ed25519 public key: the base64 payload of the
	// verifier key with its leading algorithm byte stripped.
	PublicKey Hex `json:"publicKey"`
	// AlgPublicKey is the full base64 payload: algorithm byte || public key.
	// This, not PublicKey, is what the key hash is computed over.
	AlgPublicKey Hex `json:"algPublicKey"`
	// Seed is the raw ed25519 seed from the signer key, algorithm byte stripped.
	Seed Hex `json:"seed"`
}

type keyHashCase struct {
	Name string `json:"name"`
	Key  Hex    `json:"key"`
	Want U64    `json:"want"`
	Hex  string `json:"hex"`
}

type verifierKeyCase struct {
	Name       string `json:"name"`
	PublicKey  Hex    `json:"publicKey"`
	Want       string `json:"want"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type verifierParseCase struct {
	VKey       string `json:"vkey"`
	WantName   string `json:"wantName"`
	WantHash   U64    `json:"wantHash"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type signerParseCase struct {
	SKey       string `json:"skey"`
	WantName   string `json:"wantName"`
	WantHash   U64    `json:"wantHash"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type signature struct {
	Name   string `json:"name"`
	Hash   U64    `json:"hash"`
	Base64 string `json:"base64"`
}

type signCase struct {
	Desc string `json:"desc"`
	Text string `json:"text"`
	// Signers lists the verifier keys of the signers applied, in order.
	Signers []string `json:"signers"`
	// ExistingSigs are signatures already on the note before Sign is called.
	ExistingSigs []signature `json:"existingSigs"`
	// Want is the encoded note; empty when WantErr is true. WantText is the
	// same bytes as a string, for eyeballing during review.
	Want       Hex    `json:"want"`
	WantText   string `json:"wantText"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type openCase struct {
	Desc string `json:"desc"`
	Msg  Hex    `json:"msg"`
	// Verifiers lists the verifier keys made known to Open.
	Verifiers          []string    `json:"verifiers"`
	WantText           string      `json:"wantText"`
	WantSigs           []signature `json:"wantSigs"`
	WantUnverifiedSigs []signature `json:"wantUnverifiedSigs"`
	WantErr            bool        `json:"wantErr"`
	WantErrMsg         string      `json:"wantErrMsg"`
	// WantErrKind names the concrete error type upstream returns, so the port
	// can reproduce the difference between a malformed note, an unverified
	// note, and an invalid signature. Callers branch on that difference.
	WantErrKind string `json:"wantErrKind"`
}

type noteFixture struct {
	header
	Keys                  []keyPair           `json:"keys"`
	AlgEd25519            int                 `json:"algEd25519"`
	SigSplit              Hex                 `json:"sigSplit"`
	SigPrefix             Hex                 `json:"sigPrefix"`
	MaxSignatures         int                 `json:"maxSignatures"`
	KeyHash               []keyHashCase       `json:"keyHash"`
	NewEd25519VerifierKey []verifierKeyCase   `json:"newEd25519VerifierKey"`
	NewVerifier           []verifierParseCase `json:"newVerifier"`
	NewSigner             []signerParseCase   `json:"newSigner"`
	Sign                  []signCase          `json:"sign"`
	Open                  []openCase          `json:"open"`
}

func genNote() any {
	f := noteFixture{
		header: hdr("sumdb/note: key encoding, key hashing, signing and opening, including every rejection upstream performs.",
			"golang.org/x/mod/sumdb/note"),
		// algEd25519 is unexported upstream; its value is fixed by the note
		// format and appears as the first byte of every encoded key.
		AlgEd25519: 1,
		// The two separators the note wire format is built from. sigPrefix is
		// U+2014 EM DASH followed by a space, not an ASCII hyphen.
		SigSplit:  Hex("\n\n"),
		SigPrefix: Hex("— "),
		// Open refuses a note with more than 100 signature lines.
		MaxSignatures: 100,
	}

	for _, k := range [][2]string{
		{logSKey, logVKey}, {logAltSKey, logAltVKey},
		{witnessSKey, witnessVKey}, {secondSKey, secondVKey},
	} {
		f.Keys = append(f.Keys, describeKey(k[0], k[1]))
	}

	// keyHash is unexported upstream but observable: NewEd25519VerifierKey
	// embeds it in the encoded key, so these vectors pin it exactly.
	for _, kp := range f.Keys {
		f.KeyHash = append(f.KeyHash, keyHashCase{
			Name: kp.Name, Key: kp.AlgPublicKey, Want: kp.KeyHash, Hex: kp.KeyHashHex,
		})
	}

	addVKeyCase := func(name string, pub []byte) {
		got, err := note.NewEd25519VerifierKey(name, pub)
		f.NewEd25519VerifierKey = append(f.NewEd25519VerifierKey, verifierKeyCase{
			Name: name, PublicKey: Hex(pub), Want: got,
			WantErr: err != nil, WantErrMsg: errString(err),
		})
	}
	for _, kp := range f.Keys {
		addVKeyCase(kp.Name, kp.PublicKey)
	}
	// The same key under other names, so a port cannot drop the name or the
	// "\n" separator from the hash input without the fixtures noticing.
	logPub := []byte(f.Keys[0].PublicKey)
	for _, n := range []string{"a", "example.com/log", "log+", "unicode.log.ünïcodé", strings.Repeat("x", 200)} {
		addVKeyCase(n, logPub)
	}
	addVKeyCase("short-key", []byte{0x01, 0x02})
	addVKeyCase("empty-key", nil)
	addVKeyCase("33-byte-key", repeatBytes(0xab, 33))

	addVerifier := func(vkey string) {
		v, err := note.NewVerifier(vkey)
		c := verifierParseCase{VKey: vkey, WantErr: err != nil, WantErrMsg: errString(err)}
		if err == nil {
			c.WantName, c.WantHash = v.Name(), U64(v.KeyHash())
		}
		f.NewVerifier = append(f.NewVerifier, c)
	}
	for _, kp := range f.Keys {
		addVerifier(kp.VKey)
	}
	for _, bad := range []string{
		"",
		"nohash",
		"name+dc00151b",
		"+dc00151b+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"na me+dc00151b+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"webtessera.fixture.log+dc0015+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"webtessera.fixture.log+dc00151b1+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"webtessera.fixture.log+zzzzzzzz+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"webtessera.fixture.log+00000000+AUeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		"webtessera.fixture.log+dc00151b+not-base64!!",
		"webtessera.fixture.log+dc00151b+",
		// Wrong algorithm byte, hash left stale: the hash check fires first.
		"webtessera.fixture.log+dc00151b+AkeIGKl2KxQNkIaKQYoZiZT3MbL8/GB3Q3Yo3fTwAV2+",
		strings.Replace(logVKey, "webtessera.fixture.log", "other.log", 1),
	} {
		addVerifier(bad)
	}
	// A key whose algorithm byte is not algEd25519, but whose key hash is
	// correct for that payload. Without a correct hash the hash check fires
	// first and the algorithm branch is never reached.
	unknownAlg := encodedVerifierKey("webtessera.fixture.unknownalg", 2, []byte(f.Keys[0].PublicKey))
	addVerifier(unknownAlg)
	if got := f.NewVerifier[len(f.NewVerifier)-1]; got.WantErrMsg != "unknown verifier algorithm" {
		panic("the unknown-algorithm verifier case did not reach the algorithm check: " + got.WantErrMsg)
	}
	// An Ed25519 key whose payload is not 32 bytes.
	addVerifier(encodedVerifierKey("webtessera.fixture.shortkey", 1, repeatBytes(0xcd, 16)))

	addSigner := func(skey string) {
		s, err := note.NewSigner(skey)
		c := signerParseCase{SKey: skey, WantErr: err != nil, WantErrMsg: errString(err)}
		if err == nil {
			c.WantName, c.WantHash = s.Name(), U64(s.KeyHash())
		}
		f.NewSigner = append(f.NewSigner, c)
	}
	for _, kp := range f.Keys {
		addSigner(kp.SKey)
	}
	for _, bad := range []string{
		"",
		"PRIVATE+KEY",
		"PUBLIC+KEY+webtessera.fixture.log+dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		"PRIVATE+NOTKEY+webtessera.fixture.log+dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		"PRIVATE+KEY+webtessera.fixture.log+00000000+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		"PRIVATE+KEY++dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		"PRIVATE+KEY+webtessera.fixture.log+dc00151b+not-base64!!",
		"PRIVATE+KEY+webtessera.fixture.log+dc0015+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		logVKey,
		// NewSigner checks the algorithm byte before the key hash, so an
		// unknown algorithm is reachable without a matching hash.
		"PRIVATE+KEY+webtessera.fixture.log+dc00151b+AswDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP",
		// An Ed25519 signer key whose seed is not 32 bytes.
		"PRIVATE+KEY+webtessera.fixture.log+dc00151b+AQID",
	} {
		addSigner(bad)
	}

	// --- Sign ---

	type namedSigner struct {
		s    note.Signer
		vkey string
	}
	logS := namedSigner{mustSigner(logSKey), logVKey}
	altS := namedSigner{mustSigner(logAltSKey), logAltVKey}
	witS := namedSigner{mustSigner(witnessSKey), witnessVKey}

	logV := mustVerifier(logVKey)
	altV := mustVerifier(logAltVKey)
	witV := mustVerifier(witnessVKey)
	secV := mustVerifier(secondVKey)

	addSign := func(desc, text string, existing []note.Signature, signers ...namedSigner) []byte {
		ss := make([]note.Signer, 0, len(signers))
		names := make([]string, 0, len(signers))
		for _, s := range signers {
			ss = append(ss, s.s)
			names = append(names, s.vkey)
		}
		ex := []signature{}
		for _, s := range existing {
			ex = append(ex, signature{Name: s.Name, Hash: U64(s.Hash), Base64: s.Base64})
		}
		msg, err := note.Sign(&note.Note{Text: text, Sigs: existing}, ss...)
		c := signCase{
			Desc: desc, Text: text, Signers: names, ExistingSigs: ex,
			Want: Hex(msg), WantErr: err != nil, WantErrMsg: errString(err),
		}
		if err == nil {
			c.WantText = string(msg)
		}
		f.Sign = append(f.Sign, c)
		return msg
	}

	// The signed body is a real checkpoint, so these vectors double as evidence
	// for the format a log actually publishes.
	cpText := fixtureCheckpointText()

	single := addSign("single signer", cpText, nil, logS)
	twoSameName := addSign("two signers, same name different keys", cpText, nil, logS, altS)
	logWit := addSign("log plus witness", cpText, nil, logS, witS)
	three := addSign("three signers", cpText, nil, logS, altS, witS)
	addSign("newline-only text", "\n", nil, logS)
	addSign("checkpoint with trailing other data", cpText+"extra data line\n", nil, logS)
	addSign("text with trailing blank line", "hello\n\n", nil, logS)
	addSign("unicode text", "unicode ünïcodé — em dash\n", nil, logS)
	addSign("no signers", cpText, nil)
	addSign("text without trailing newline", "no newline", nil, logS)
	addSign("empty text", "", nil, logS)

	// Signing a note that already carries signatures: existing ones are kept
	// unless the same key signs again, in which case the old one is elided.
	openedSingle := mustOpen(single, logV)
	addSign("preserve existing signature", cpText, openedSingle.Sigs, witS)
	addSign("replace existing signature", cpText, openedSingle.Sigs, logS)
	openedThree := mustOpen(three, logV, altV, witV)
	addSign("preserve two, replace one", cpText, openedThree.Sigs, altS)

	// --- Open ---

	vkeyOf := map[string]string{
		logV.Name() + itoa8(logV.KeyHash()): logVKey,
		altV.Name() + itoa8(altV.KeyHash()): logAltVKey,
		witV.Name() + itoa8(witV.KeyHash()): witnessVKey,
		secV.Name() + itoa8(secV.KeyHash()): secondVKey,
	}
	addOpen := func(desc string, msg []byte, vs ...note.Verifier) {
		names := make([]string, 0, len(vs))
		for _, v := range vs {
			names = append(names, vkeyOf[v.Name()+itoa8(v.KeyHash())])
		}
		n, err := note.Open(msg, note.VerifierList(vs...))
		c := openCase{
			Desc: desc, Msg: Hex(msg), Verifiers: names,
			WantSigs: []signature{}, WantUnverifiedSigs: []signature{},
			WantErr: err != nil, WantErrMsg: errString(err), WantErrKind: errKind(err),
		}
		if n == nil {
			// UnverifiedNoteError carries the parsed note; record it so the
			// port can be checked on the salvage path too.
			n = unverifiedNote(err)
		}
		if n != nil {
			c.WantText = n.Text
			for _, s := range n.Sigs {
				c.WantSigs = append(c.WantSigs, signature{Name: s.Name, Hash: U64(s.Hash), Base64: s.Base64})
			}
			for _, s := range n.UnverifiedSigs {
				c.WantUnverifiedSigs = append(c.WantUnverifiedSigs, signature{Name: s.Name, Hash: U64(s.Hash), Base64: s.Base64})
			}
		}
		f.Open = append(f.Open, c)
	}

	addOpen("single signature, known verifier", single, logV)
	addOpen("single signature, no verifiers", single)
	addOpen("single signature, unrelated verifier", single, witV)
	addOpen("two signatures, both known", twoSameName, logV, altV)
	addOpen("two signatures, one known", twoSameName, logV)
	addOpen("log plus witness, both known", logWit, logV, witV)
	addOpen("log plus witness, only witness known", logWit, witV)
	addOpen("three signatures, all known", three, logV, altV, witV)
	addOpen("three signatures, none known", three, secV)
	// Two verifiers with the same name and hash make the lookup ambiguous,
	// which Open surfaces as an error rather than picking one.
	addOpen("ambiguous verifier list", single, logV, mustVerifier(logVKey))
	addOpen("duplicate signature lines", repeatSigBlock(single, 2), logV)
	addOpen("100 identical signature lines", repeatSigBlock(single, 100), logV)
	addOpen("101 identical signature lines", repeatSigBlock(single, 101), logV)

	// Malformed notes. Each mutation targets exactly one rule in Open.
	addOpen("empty message", []byte{}, logV)
	addOpen("text only, no signature block", []byte(cpText), logV)
	addOpen("no blank line before sigs", []byte(strings.Replace(string(single), "\n\n", "\n", 1)), logV)
	addOpen("signature block not newline terminated", single[:len(single)-1], logV)
	addOpen("signature line missing the em-dash prefix", []byte(strings.Replace(string(single), "— ", "", 1)), logV)
	addOpen("signature line with ascii dash", []byte(strings.Replace(string(single), "— ", "- ", 1)), logV)
	addOpen("signature line with em-dash but no space", []byte(strings.Replace(string(single), "— ", "—", 1)), logV)
	addOpen("signature base64 corrupted", corruptSigBase64(single), logV)
	addOpen("signature truncated below 5 bytes", truncatedSigNote(cpText, logV), logV)
	addOpen("signature bytes flipped", flipSigBytes(single), logV)
	addOpen("text mutated after signing", mutateText(single), logV)
	addOpen("ascii control character in text", withControlChar(single), logV)
	addOpen("invalid utf8 in text", withInvalidUTF8(single), logV)
	addOpen("signature name contains a space", renameSigner(single, "webtessera fixture.log"), logV)
	addOpen("signature name contains a plus", renameSigner(single, "webtessera+fixture.log"), logV)
	addOpen("signature name empty", renameSigner(single, ""), logV)
	addOpen("empty base64 signature", emptySigNote(single), logV)
	addOpen("key hash prefix does not match verifier", rehashSig(single), logV)

	return f
}

// describeKey decomposes a fixture key pair into the pieces a port needs.
func describeKey(skey, vkey string) keyPair {
	v := mustVerifier(vkey)
	s := mustSigner(skey)
	if v.Name() != s.Name() || v.KeyHash() != s.KeyHash() {
		panic("fixture key pair mismatch: " + vkey)
	}
	// The verifier key is "<name>+<hash>+<base64>" and the signer key is
	// "PRIVATE+KEY+<name>+<hash>+<base64>", so the payload sits after the
	// second and fourth "+" respectively. Both payloads start with the
	// algorithm byte.
	algPub := decodeKeyPayload(vkey, 2)
	seed := decodeKeyPayload(skey, 4)
	return keyPair{
		Name: v.Name(), SKey: skey, VKey: vkey,
		KeyHash: U64(v.KeyHash()), KeyHashHex: itoa8(v.KeyHash()),
		PublicKey: Hex(algPub[1:]), AlgPublicKey: Hex(algPub), Seed: Hex(seed[1:]),
	}
}
