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
	"math"

	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/merkle/rfc6962"
	"golang.org/x/mod/sumdb/note"
)

// fixtureCheckpointText returns the marshalled body of an eight-entry
// checkpoint over the standard fixture corpus, produced by formats/log.
// The note fixtures sign this exact text.
func fixtureCheckpointText() string {
	t := entryTree(8)
	return string(f_log.Checkpoint{
		Origin: mustVerifier(logVKey).Name(),
		Size:   8,
		Hash:   t.Hash(),
	}.Marshal())
}

type marshalCase struct {
	Desc   string `json:"desc"`
	Origin string `json:"origin"`
	Size   U64    `json:"size"`
	Hash   Hex    `json:"hash"`
	// Want is the marshalled checkpoint body. WantText is the same bytes as a
	// string, since a checkpoint body is always printable.
	Want     Hex    `json:"want"`
	WantText string `json:"wantText"`
}

type unmarshalCase struct {
	Desc string `json:"desc"`
	Raw  Hex    `json:"raw"`
	// WantOrigin/WantSize/WantHash are the parsed fields, and WantRest is the
	// trailing data Unmarshal hands back.
	WantOrigin string `json:"wantOrigin"`
	WantSize   U64    `json:"wantSize"`
	WantHash   Hex    `json:"wantHash"`
	WantRest   Hex    `json:"wantRest"`
	WantErr    bool   `json:"wantErr"`
	WantErrMsg string `json:"wantErrMsg"`
}

type parseCheckpointCase struct {
	Desc string `json:"desc"`
	Raw  Hex    `json:"raw"`
	// Origin is the origin the caller demands, and LogVKey/OtherVKeys are the
	// verifiers passed in.
	Origin     string   `json:"origin"`
	LogVKey    string   `json:"logVkey"`
	OtherVKeys []string `json:"otherVkeys"`
	// WantCheckpoint is non-nil only on success.
	WantOrigin string      `json:"wantOrigin"`
	WantSize   U64         `json:"wantSize"`
	WantHash   Hex         `json:"wantHash"`
	WantOther  Hex         `json:"wantOtherData"`
	WantSigs   []signature `json:"wantSigs"`
	WantErr    bool        `json:"wantErr"`
	WantErrMsg string      `json:"wantErrMsg"`
}

type signedCheckpointCase struct {
	Desc string `json:"desc"`
	// Signers lists the verifier keys of the signers, in order.
	Signers  []string `json:"signers"`
	Origin   string   `json:"origin"`
	Size     U64      `json:"size"`
	Hash     Hex      `json:"hash"`
	Want     Hex      `json:"want"`
	WantText string   `json:"wantText"`
}

type checkpointFixture struct {
	header
	Marshal         []marshalCase          `json:"marshal"`
	Unmarshal       []unmarshalCase        `json:"unmarshal"`
	Signed          []signedCheckpointCase `json:"signed"`
	ParseCheckpoint []parseCheckpointCase  `json:"parseCheckpoint"`
}

func genCheckpoint() any {
	f := checkpointFixture{
		header: hdr("formats/log Checkpoint: marshalling, parsing, and signature-verified parsing.",
			"github.com/transparency-dev/formats/log"),
	}

	origin := mustVerifier(logVKey).Name()
	h := rfc6962.DefaultHasher

	addMarshal := func(desc, o string, size uint64, hash []byte) []byte {
		raw := f_log.Checkpoint{Origin: o, Size: size, Hash: hash}.Marshal()
		f.Marshal = append(f.Marshal, marshalCase{
			Desc: desc, Origin: o, Size: U64(size), Hash: Hex(hash),
			Want: Hex(raw), WantText: string(raw),
		})
		return raw
	}

	// An empty log's checkpoint commits to the RFC6962 empty root, not to nil.
	addMarshal("empty log", origin, 0, h.EmptyRoot())
	addMarshal("size 1", origin, 1, entryTree(1).Hash())
	addMarshal("size 2", origin, 2, entryTree(2).Hash())
	cp8 := addMarshal("size 8", origin, 8, entryTree(8).Hash())
	addMarshal("size 255", origin, 255, entryTree(255).Hash())
	addMarshal("size 256", origin, 256, entryTree(256).Hash())
	addMarshal("size 257", origin, 257, entryTree(257).Hash())
	addMarshal("nil hash", origin, 3, nil)
	addMarshal("empty hash", origin, 3, []byte{})
	addMarshal("short hash", origin, 3, []byte{0x01, 0x02, 0x03})
	addMarshal("max uint64 size", origin, math.MaxUint64, h.EmptyRoot())
	addMarshal("origin with slash", "example.com/log", 4, entryTree(4).Hash())
	addMarshal("origin with unicode", "ünïcodé.log", 4, entryTree(4).Hash())
	addMarshal("empty origin", "", 4, entryTree(4).Hash())

	addUnmarshal := func(desc string, raw []byte) {
		cp := f_log.Checkpoint{}
		rest, err := cp.Unmarshal(raw)
		f.Unmarshal = append(f.Unmarshal, unmarshalCase{
			Desc: desc, Raw: Hex(raw),
			WantOrigin: cp.Origin, WantSize: U64(cp.Size), WantHash: Hex(cp.Hash),
			WantRest: Hex(rest), WantErr: err != nil, WantErrMsg: errString(err),
		})
	}

	addUnmarshal("round trip size 8", cp8)
	addUnmarshal("round trip empty log", f_log.Checkpoint{Origin: origin, Size: 0, Hash: h.EmptyRoot()}.Marshal())
	addUnmarshal("with trailing other data", append(append([]byte{}, cp8...), []byte("some other data\n")...))
	addUnmarshal("with trailing data lacking newline", append(append([]byte{}, cp8...), []byte("no newline")...))
	addUnmarshal("max uint64 size", f_log.Checkpoint{Origin: origin, Size: math.MaxUint64, Hash: h.EmptyRoot()}.Marshal())
	// Rejections.
	addUnmarshal("empty input", []byte{})
	addUnmarshal("only origin", []byte(origin+"\n"))
	addUnmarshal("two lines only", []byte(origin+"\n8\n"))
	addUnmarshal("three lines, no trailing newline", []byte(origin+"\n8\naaaa"))
	addUnmarshal("empty origin", []byte("\n8\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("size not a number", []byte(origin+"\nabc\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("size negative", []byte(origin+"\n-1\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("size overflows uint64", []byte(origin+"\n18446744073709551616\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("size with leading plus", []byte(origin+"\n+8\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("size empty", []byte(origin+"\n\n"+b64Hash(h.EmptyRoot())+"\n"))
	addUnmarshal("hash not base64", []byte(origin+"\n8\nnot base64!!\n"))
	addUnmarshal("hash empty", []byte(origin+"\n8\n\n"))
	addUnmarshal("hash base64url instead of std", []byte(origin+"\n8\n5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7\n"))

	// Signed checkpoints, which is what a real log publishes.
	logS := mustSigner(logSKey)
	altS := mustSigner(logAltSKey)
	witS := mustSigner(witnessSKey)

	addSigned := func(desc string, size uint64, hash []byte, vkeys []string, signers ...note.Signer) []byte {
		body := f_log.Checkpoint{Origin: origin, Size: size, Hash: hash}.Marshal()
		msg, err := note.Sign(&note.Note{Text: string(body)}, signers...)
		if err != nil {
			panic(err)
		}
		f.Signed = append(f.Signed, signedCheckpointCase{
			Desc: desc, Signers: vkeys, Origin: origin, Size: U64(size), Hash: Hex(hash),
			Want: Hex(msg), WantText: string(msg),
		})
		return msg
	}

	signed0 := addSigned("empty log, log signature", 0, h.EmptyRoot(), []string{logVKey}, logS)
	signed8 := addSigned("size 8, log signature", 8, entryTree(8).Hash(), []string{logVKey}, logS)
	signed8Two := addSigned("size 8, two log keys", 8, entryTree(8).Hash(), []string{logVKey, logAltVKey}, logS, altS)
	signed8Wit := addSigned("size 8, log and witness", 8, entryTree(8).Hash(), []string{logVKey, witnessVKey}, logS, witS)
	signed256 := addSigned("size 256, log signature", 256, entryTree(256).Hash(), []string{logVKey}, logS)
	signedWitOnly := addSigned("size 8, witness signature only", 8, entryTree(8).Hash(), []string{witnessVKey}, witS)

	addParse := func(desc string, raw []byte, wantOrigin string, logVKeyStr string, otherVKeys ...string) {
		lv := mustVerifier(logVKeyStr)
		others := make([]note.Verifier, 0, len(otherVKeys))
		for _, k := range otherVKeys {
			others = append(others, mustVerifier(k))
		}
		cp, other, n, err := f_log.ParseCheckpoint(raw, wantOrigin, lv, others...)
		c := parseCheckpointCase{
			Desc: desc, Raw: Hex(raw), Origin: wantOrigin, LogVKey: logVKeyStr,
			OtherVKeys: append([]string{}, otherVKeys...),
			WantSigs:   []signature{},
			WantErr:    err != nil, WantErrMsg: errString(err),
		}
		if cp != nil {
			c.WantOrigin, c.WantSize, c.WantHash = cp.Origin, U64(cp.Size), Hex(cp.Hash)
		}
		c.WantOther = Hex(other)
		if n != nil {
			for _, s := range n.Sigs {
				c.WantSigs = append(c.WantSigs, signature{Name: s.Name, Hash: U64(s.Hash), Base64: s.Base64})
			}
		}
		f.ParseCheckpoint = append(f.ParseCheckpoint, c)
	}

	addParse("empty log", signed0, origin, logVKey)
	addParse("size 8", signed8, origin, logVKey)
	addParse("size 8, two log keys, both supplied", signed8Two, origin, logVKey, logAltVKey)
	addParse("size 8, two log keys, only primary supplied", signed8Two, origin, logVKey)
	addParse("size 8, log and witness, both supplied", signed8Wit, origin, logVKey, witnessVKey)
	addParse("size 8, log and witness, only log supplied", signed8Wit, origin, logVKey)
	addParse("size 256", signed256, origin, logVKey)
	addParse("with trailing other data", appendOtherData(signed8, "extra\n", logS), origin, logVKey)
	// Rejections.
	addParse("wrong origin demanded", signed8, "some.other.log", logVKey)
	addParse("witness signature only", signedWitOnly, origin, logVKey, witnessVKey)
	addParse("unsigned checkpoint body", cp8, origin, logVKey)
	addParse("empty input", []byte{}, origin, logVKey)
	addParse("signature does not verify", flipSigBytes(signed8), origin, logVKey)
	addParse("body is not a checkpoint", mustSign("hello world\n", logS), origin, logVKey)

	return f
}

// appendOtherData re-signs a checkpoint body with extra trailing lines, which
// is how a log carries data beyond the three mandatory checkpoint lines.
func appendOtherData(signed []byte, extra string, signers ...note.Signer) []byte {
	text, _ := splitNote(signed)
	return mustSign(string(text)+extra, signers...)
}

func mustSign(text string, signers ...note.Signer) []byte {
	msg, err := note.Sign(&note.Note{Text: text}, signers...)
	if err != nil {
		panic(err)
	}
	return msg
}
