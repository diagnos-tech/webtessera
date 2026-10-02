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
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/mod/sumdb/note"
)

// This file builds the malformed notes used as *inputs* to the Open fixture.
// Nothing here computes an expected result; every "want" in the fixture comes
// from calling upstream note.Open on the bytes these helpers produce.

// itoa8 renders a note key hash the way the note format spells it: eight
// lower-case hex digits.
func itoa8(h uint32) string {
	return fmt.Sprintf("%08x", h)
}

// b64Hash renders a root hash the way a checkpoint body spells it: standard
// base64 with padding.
func b64Hash(h []byte) string {
	return base64.StdEncoding.EncodeToString(h)
}

// decodeKeyPayload base64-decodes the payload of an encoded note key.
//
// The payload is everything after the nth "+", and must be located by cutting
// from the left exactly as upstream does: standard base64 itself contains "+",
// so scanning from the right finds the wrong separator whenever a key happens
// to encode to a string ending in "+". Two of the fixture keys do.
func decodeKeyPayload(key string, fields int) []byte {
	rest := key
	for i := 0; i < fields; i++ {
		_, after, found := strings.Cut(rest, "+")
		if !found {
			panic("malformed fixture key: " + key)
		}
		rest = after
	}
	b, err := base64.StdEncoding.DecodeString(rest)
	if err != nil {
		panic(err)
	}
	return b
}

// encodedVerifierKey builds an encoded note verifier key by hand, for algorithm
// bytes that note.NewEd25519VerifierKey cannot emit.
//
// The key hash is SHA-256 over name || "\n" || (alg || key), truncated to its
// first four bytes and read big-endian; that is note.keyHash, which is
// unexported. This computes an *input*: what the fixture records is still
// whatever note.NewVerifier does with the result, and genNote asserts that the
// case reaches the branch it was written for.
func encodedVerifierKey(name string, alg byte, key []byte) string {
	payload := append([]byte{alg}, key...)
	sum := sha256.Sum256(append(append([]byte(name), '\n'), payload...))
	h := binary.BigEndian.Uint32(sum[:4])
	return fmt.Sprintf("%s+%08x+%s", name, h, base64.StdEncoding.EncodeToString(payload))
}

// mustOpen opens a note that is expected to verify.
func mustOpen(msg []byte, vs ...note.Verifier) *note.Note {
	n, err := note.Open(msg, note.VerifierList(vs...))
	if err != nil {
		panic(err)
	}
	return n
}

// unverifiedNote extracts the salvaged note from an UnverifiedNoteError, which
// is the one error upstream returns that still carries a parsed result.
func unverifiedNote(err error) *note.Note {
	var une *note.UnverifiedNoteError
	if errors.As(err, &une) {
		return une.Note
	}
	return nil
}

// errKind names the concrete error type note.Open returned. Callers of Open
// branch on these types, so a port has to reproduce the distinction and not
// just the message.
func errKind(err error) string {
	if err == nil {
		return ""
	}
	var une *note.UnverifiedNoteError
	if errors.As(err, &une) {
		return "UnverifiedNoteError"
	}
	var ise *note.InvalidSignatureError
	if errors.As(err, &ise) {
		return "InvalidSignatureError"
	}
	var uve *note.UnknownVerifierError
	if errors.As(err, &uve) {
		return "UnknownVerifierError"
	}
	// The remaining errors upstream returns from Open are unexported sentinel
	// values distinguished only by their message.
	return "error"
}

// splitNote divides a signed note into its text (including the trailing blank
// line separator) and its signature block.
func splitNote(msg []byte) (text, sigs []byte) {
	i := bytes.LastIndex(msg, []byte("\n\n"))
	if i < 0 {
		panic("fixture note has no signature block")
	}
	return msg[:i+2], msg[i+2:]
}

// repeatSigBlock repeats the note's (single) signature line n times.
func repeatSigBlock(msg []byte, n int) []byte {
	text, sigs := splitNote(msg)
	out := append([]byte{}, text...)
	for i := 0; i < n; i++ {
		out = append(out, sigs...)
	}
	return out
}

// corruptSigBase64 replaces four characters in the middle of the base64
// signature with characters that are valid base64 but decode to different
// bytes, leaving the length intact.
func corruptSigBase64(msg []byte) []byte {
	text, sigs := splitNote(msg)
	line := string(sigs)
	sp := strings.LastIndex(strings.TrimSuffix(line, "\n"), " ")
	b64 := strings.TrimSuffix(line[sp+1:], "\n")
	mid := len(b64) / 2
	replacement := "ABCD"
	if b64[mid:mid+4] == replacement {
		replacement = "EFGH"
	}
	b64 = b64[:mid] + replacement + b64[mid+4:]
	return append(append([]byte{}, text...), []byte(line[:sp+1]+b64+"\n")...)
}

// truncatedSigNote builds a note whose signature blob is only four bytes long,
// which is below the five-byte minimum Open enforces.
func truncatedSigNote(text string, v note.Verifier) []byte {
	var hbuf [4]byte
	binary.BigEndian.PutUint32(hbuf[:], v.KeyHash())
	b64 := base64.StdEncoding.EncodeToString(hbuf[:])
	return []byte(text + "\n— " + v.Name() + " " + b64 + "\n")
}

// flipSigBytes inverts the low bit of every byte of the signature payload,
// leaving the key hash prefix intact, so the note parses but does not verify.
func flipSigBytes(msg []byte) []byte {
	text, sigs := splitNote(msg)
	line := strings.TrimSuffix(string(sigs), "\n")
	sp := strings.LastIndex(line, " ")
	raw, err := base64.StdEncoding.DecodeString(line[sp+1:])
	if err != nil {
		panic(err)
	}
	for i := 4; i < len(raw); i++ {
		raw[i] ^= 0x01
	}
	return append(append([]byte{}, text...), []byte(line[:sp+1]+base64.StdEncoding.EncodeToString(raw)+"\n")...)
}

// mutateText changes one character of the signed text, so the signature no
// longer matches the body.
func mutateText(msg []byte) []byte {
	text, sigs := splitNote(msg)
	mutated := bytes.Replace(text, []byte("\n8\n"), []byte("\n9\n"), 1)
	if bytes.Equal(mutated, text) {
		panic("mutateText found nothing to change")
	}
	return append(append([]byte{}, mutated...), sigs...)
}

// withControlChar inserts a US-ASCII control character into the note text.
// Open rejects any rune below 0x20 other than newline.
func withControlChar(msg []byte) []byte {
	out := append([]byte{}, msg...)
	out = bytes.Replace(out, []byte("\n"), []byte("\t\n"), 1)
	return out
}

// withInvalidUTF8 splices a lone continuation byte into the note text.
func withInvalidUTF8(msg []byte) []byte {
	text, sigs := splitNote(msg)
	bad := append([]byte{}, text[:4]...)
	bad = append(bad, 0x80)
	bad = append(bad, text[4:]...)
	return append(bad, sigs...)
}

// renameSigner rewrites the name on the signature line, leaving the signature
// bytes untouched.
func renameSigner(msg []byte, name string) []byte {
	text, sigs := splitNote(msg)
	line := strings.TrimSuffix(string(sigs), "\n")
	const prefix = "— "
	rest := strings.TrimPrefix(line, prefix)
	sp := strings.Index(rest, " ")
	return append(append([]byte{}, text...), []byte(prefix+name+rest[sp:]+"\n")...)
}

// emptySigNote drops the base64 blob from the signature line entirely.
func emptySigNote(msg []byte) []byte {
	text, sigs := splitNote(msg)
	line := strings.TrimSuffix(string(sigs), "\n")
	sp := strings.LastIndex(line, " ")
	return append(append([]byte{}, text...), []byte(line[:sp+1]+"\n")...)
}

// rehashSig rewrites the four-byte key hash prefix of the signature so it no
// longer names the verifier that produced it.
func rehashSig(msg []byte) []byte {
	text, sigs := splitNote(msg)
	line := strings.TrimSuffix(string(sigs), "\n")
	sp := strings.LastIndex(line, " ")
	raw, err := base64.StdEncoding.DecodeString(line[sp+1:])
	if err != nil {
		panic(err)
	}
	raw[0] ^= 0xff
	return append(append([]byte{}, text...), []byte(line[:sp+1]+base64.StdEncoding.EncodeToString(raw)+"\n")...)
}
