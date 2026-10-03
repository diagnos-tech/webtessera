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
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/ctonly"
	"golang.org/x/mod/sumdb/note"
)

// diffPolicyComponent renders a parsed witness policy component:
// ["group", N, [children...]] or ["witness", keyName, keyHash, URL].
func diffPolicyComponent(c any) any {
	switch v := c.(type) {
	case tessera.WitnessGroup:
		children := []any{}
		for _, ch := range v.Components {
			children = append(children, diffPolicyComponent(ch))
		}
		return []any{"group", v.N, children}
	case tessera.Witness:
		return []any{"witness", v.Key.Name(), v.Key.KeyHash(), v.URL}
	}
	panic(fmt.Sprintf("unexpected policy component %T", c))
}

// genDiffWitnessPolicy records NewWitnessGroupFromPolicy over hand-written
// policies covering every keyword, error path and URL form, and over generated
// policies mixing valid and invalid lines with Unicode whitespace, comments
// and CRLF line endings.
func genDiffWitnessPolicy() diffFile {
	r := newDiffRand(0x9011c1)
	var keys []string
	for _, n := range []string{"sigsum.org", "example.com", "w3.example", "Señor.witness"} {
		_, vkey := dSeedKeys(n, randBytes(r, 32))
		keys = append(keys, vkey)
	}
	// keys[0..3] are alg-1 vkeys; their cosignature/v1 (alg-4) encodings follow.
	for _, k := range keys[:4] {
		keys = append(keys, mustCosigVKey(k))
	}
	badKeys := []string{"not-a-vkey", "sigsum.org+00000000+AZuU", keys[0][:len(keys[0])-2], "a+b+c"}
	urls := []string{
		"https://sigsum.org/witness/", "https://example.com/witness", "https://example.com", "https://example.com/",
		"https://example.com/a/../b//c/", "https://example.com/%7Efoo", "https://example.com/a%20b", "http://example.com:8080/x",
		"https://example.com:443/x", "HTTPS://EXAMPLE.com/x", "ftp://example.com/x", "https://example.com/x?a=b",
		"https://example.com/x#frag", "https://user:pw@example.com/x", "https://[::1]:8080/x", "example.com/x", "/x", "x",
		"https://%zz", "https://example.com/%zz", "://x", "https://exämple.com/x", "https://example.com/日本", "mailto:a@b",
		"https://example.com/add-checkpoint", "https://example.com/x/", "https://example.com//", "https://example.com/a?b#c",
	}
	W1, W2 := keys[0], keys[1]
	U1, U2 := urls[0], urls[1]
	policies := []string{
		"witness w1 " + W1 + " " + U1 + "\nquorum w1",
		"witness w1 " + W1 + " " + U1 + "\nwitness w2 " + W2 + " " + U2 + "\ngroup g 2 w1 w2\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 0 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 1 w1 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 2 w1 w1\nquorum g",
		"group g all\nquorum g", "group g any\nquorum g", "group g 0\nquorum g", "group g 1\nquorum g",
		"quorum none", "quorum none\nquorum none", "log foo\nquorum none", "log\nquorum none", "quorum", "quorum a b",
		"", "# only comment", "\n\n   \n",
		"witness w1 " + W1 + "\nquorum w1",
		"witness w1 " + W1 + " " + U1 + " extra\nquorum w1",
		"witness log " + W1 + " " + U1 + "\nquorum none",
		"witness w1 " + W1 + " " + U1 + "\ngroup w1 1 w1\nquorum w1",
		"witness w1 " + W1 + " " + U1 + "\ngroup g any w1\ngroup h 1 g\nquorum h",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 1 w1 unknown\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 1 all\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 256 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 255 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g +1 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 01 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g 0x1 w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\ngroup g ALL w1\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\r\nquorum w1\r\n",
		"witness\tw1\t" + W1 + "\t" + U1 + "\nquorum\tw1",
		"witness w1 " + W1 + " " + U1 + " # trailing\nquorum w1 # c",
		"#witness w1 " + W1 + " " + U1 + "\nquorum w1",
		"witness w1 " + W1 + " " + U1 + "\nquorum w2",
		"witness w1 " + W1 + " " + U1 + "\nquorum all",
		"witness w1 " + W1 + " " + U1 + "\nquorum w1\nquorum none",
		"witness w1 " + W1 + " " + U1 + "\nwitness w1 " + W2 + " " + U2 + "\nquorum w1",
		"foo bar\nquorum none", "Witness w1 " + W1 + " " + U1 + "\nquorum w1",
		"witness w1 " + W1 + " " + U1 + "\nwitness w2 " + W2 + " " + U1 + "\ngroup g all w1 w2\nquorum g",
		"witness w1 " + W1 + " " + U1 + "\n witness w2 " + W2 + " " + U2 + "\nquorum w1",
		"group g 1 g\nquorum g", "witness w1 " + W1 + " " + U1 + "\ngroup g 1 w1\nquorum none",
		"\ufefflog\nquorum none", "\u0085log\nquorum none", "log\u0085\nquorum none", "log quorum none", "quorum none ",
		"quorum none", "quorum none", "quorum\ufeffnone", "quorum none​", "　quorum none　",
		"quorum none\r", "quorum none\r\r", "quorum none\n\r", "quorum none\x00", "quorum #none", "quorum n#one",
		"witness w1 " + keys[4] + " " + U1 + "\nquorum w1",
		"witness w1 " + W1 + " " + U1 + "\nwitness w2 " + keys[4] + " " + U2 + "\nquorum w2",
	}
	for _, u := range urls {
		policies = append(policies, "witness w1 "+W1+" "+u+"\nquorum w1")
	}
	for _, k := range badKeys {
		policies = append(policies, "witness w1 "+k+" "+U1+"\nquorum w1")
	}
	// Generated policies.
	spaces := []string{" ", " ", " ", "\t", "  ", " ", "\u0085", " ", "\ufeff", "​", "\v", "\f"}
	ends := []string{"\n", "\n", "\n", "\r\n", "\n\n", " \n", "\r\r\n"}
	names := []string{"w1", "w2", "w3", "g1", "g2", "any", "all", "log", "none", "w#1", "Señor", "w1"}
	thresholds := []string{"0", "1", "2", "3", "any", "all", "256", "-1", "01", "x"}
	for i := 0; i < scaled(600); i++ {
		var b strings.Builder
		sp := func() string { return spaces[r.Intn(len(spaces))] }
		for j := 1 + r.Intn(6); j > 0; j-- {
			if r.Intn(8) == 0 {
				b.WriteString(sp())
			}
			switch r.Intn(9) {
			case 0, 1, 2:
				key := keys[r.Intn(len(keys))]
				if r.Intn(10) == 0 {
					key = badKeys[r.Intn(len(badKeys))]
				}
				b.WriteString("witness" + sp() + names[r.Intn(len(names))] + sp() + key + sp() + urls[r.Intn(len(urls))])
			case 3, 4:
				b.WriteString("group" + sp() + names[r.Intn(len(names))] + sp() + thresholds[r.Intn(len(thresholds))])
				for k := r.Intn(4); k > 0; k-- {
					b.WriteString(sp() + names[r.Intn(len(names))])
				}
			case 5:
				b.WriteString("quorum" + sp() + names[r.Intn(len(names))])
			case 6:
				b.WriteString("# comment " + names[r.Intn(len(names))])
			case 7:
				b.WriteString("log" + sp() + "example.com/log")
			default:
				b.WriteString([]string{"", "quorum none", "bogus line", "quorum"}[r.Intn(4)])
			}
			if r.Intn(6) == 0 {
				b.WriteString(sp() + "# trailing")
			}
			b.WriteString(ends[r.Intn(len(ends))])
		}
		if r.Intn(3) != 0 {
			b.WriteString("quorum " + names[r.Intn(len(names))])
		}
		policies = append(policies, b.String())
	}

	var rows [][]any
	for _, p := range policies {
		wg, err := tessera.NewWitnessGroupFromPolicy([]byte(p))
		if err != nil {
			rows = append(rows, []any{p, err.Error()})
			continue
		}
		var eps []string
		for u := range wg.Endpoints() {
			eps = append(eps, u)
		}
		sort.Strings(eps)
		if eps == nil {
			eps = []string{}
		}
		rows = append(rows, []any{p, "", diffPolicyComponent(wg), eps})
	}
	return diffFile{
		description: "Differential corpus for NewWitnessGroupFromPolicy: hand-written policies covering every keyword, error path and witness URL form, and generated policies mixing valid and invalid lines, Unicode whitespace (White_Space and look-alikes), comments and CRLF. Records the error text, or the parsed group tree and its sorted endpoint URLs.",
		upstream:    "github.com/transparency-dev/tessera (witness.go)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"cases": []string{"policy", "err", "group tree ([\"group\", N, children] / [\"witness\", key name, key hash, URL])", "sorted endpoint URLs"},
			}),
			dRows("cases", rows),
		},
	}
}

func mustCosigVKey(vkey string) string {
	// The alg-4 encoding of an alg-1 key, built the way the cosignature/v1
	// spec defines it: name, key hash over 0x04||key, base64(0x04||key).
	p := strings.SplitN(vkey, "+", 3)
	raw := decodeKeyPayload(vkey, 2)
	return dVKey(p[0], 4, raw[1:])
}

// captureAntispam is an Antispam whose only job is to capture the bundle ID
// hasher an options builder hands to Follower, which is the one public route
// to upstream's unexported defaultIDHasher and ctBundleIDHasher.
type captureAntispam struct {
	idHasher func([]byte) ([][]byte, error)
}

func (c *captureAntispam) Decorator() func(tessera.AddFn) tessera.AddFn {
	return func(f tessera.AddFn) tessera.AddFn { return f }
}

func (c *captureAntispam) Follower(h func([]byte) ([][]byte, error)) tessera.Follower {
	c.idHasher = h
	return nil
}

// genDiffBundleHashers records the four entry-bundle hashers Tessera ships —
// tlog-tiles and static-ct, identity and Merkle leaf — over well-formed bundles
// and seeded corruptions of them (truncations, byte flips, trailing junk). They
// are reached through the public API: MigrationOptions.LeafHasher, and the
// hasher an Antispam is handed by WithAntispam.
func genDiffBundleHashers() diffFile {
	r := newDiffRand(0xb0d1e)
	var defID, ctID captureAntispam
	tessera.NewMigrationOptions().WithAntispam(&defID)
	tessera.NewMigrationOptions().WithCTLayout().WithAntispam(&ctID)
	var ctAppendID captureAntispam
	tessera.NewAppendOptions().WithCTLayout().WithAntispam(256, &ctAppendID)
	defLeaf := tessera.NewMigrationOptions().LeafHasher()
	ctLeaf := tessera.NewMigrationOptions().WithCTLayout().LeafHasher()

	mutate := func(b []byte) []byte {
		switch r.Intn(5) {
		case 0:
			return append([]byte{}, b[:r.Intn(len(b)+1)]...)
		case 1:
			o := append([]byte{}, b...)
			if len(o) > 0 {
				o[r.Intn(len(o))] ^= byte(1 + r.Intn(255))
			}
			return o
		case 2:
			return append(append([]byte{}, b...), randBytes(r, 1+r.Intn(4))...)
		case 3:
			if len(b) == 0 {
				return b
			}
			i := r.Intn(len(b))
			return append(append([]byte{}, b[:i]...), b[i+1:]...)
		default:
			return b
		}
	}
	hashesOrErr := func(f func([]byte) ([][]byte, error), b []byte) []any {
		hs, err := f(b)
		if err != nil {
			return []any{err.Error()}
		}
		out := []string{}
		for _, h := range hs {
			out = append(out, hx(h))
		}
		return []any{"", out}
	}

	var tlog, ct [][]any
	for i := 0; i < scaled(200); i++ {
		var bundle []byte
		start := uint64(r.Intn(1000))
		for j := r.Intn(5); j > 0; j-- {
			size := r.Intn(40)
			if r.Intn(20) == 0 {
				size = 300 + r.Intn(300)
			}
			bundle = append(bundle, tessera.NewEntry(randBytes(r, size)).MarshalBundleData(start)...)
			start++
		}
		for k := r.Intn(3); k > 0; k-- {
			bundle = mutate(bundle)
		}
		tlog = append(tlog, []any{hx(bundle), hashesOrErr(defID.idHasher, bundle), hashesOrErr(defLeaf, bundle)})
	}
	for i := 0; i < scaled(200); i++ {
		var bundle []byte
		idx := uint64(r.Intn(1 << 20))
		if r.Intn(10) == 0 {
			idx = 1<<40 - 3
		}
		for j := r.Intn(4); j > 0; j-- {
			e := ctonly.Entry{
				Timestamp:   r.Uint64() >> uint(r.Intn(64)),
				IsPrecert:   r.Intn(2) == 0,
				Certificate: randBytes(r, r.Intn(30)),
			}
			if e.IsPrecert {
				e.Precertificate = randBytes(r, r.Intn(30))
				e.IssuerKeyHash = randBytes(r, 32)
			}
			for k := r.Intn(3); k > 0; k-- {
				var fp [32]byte
				copy(fp[:], randBytes(r, 32))
				e.FingerprintsChain = append(e.FingerprintsChain, fp)
			}
			if idx >= 1<<40 {
				break
			}
			bundle = append(bundle, e.LeafData(idx)...)
			idx++
		}
		for k := r.Intn(3); k > 0; k-- {
			bundle = mutate(bundle)
		}
		ct = append(ct, []any{hx(bundle), hashesOrErr(ctID.idHasher, bundle), hashesOrErr(ctLeaf, bundle), hashesOrErr(ctAppendID.idHasher, bundle)})
	}
	return diffFile{
		description: "Differential corpus for the entry-bundle hashers: the tlog-tiles identity and Merkle leaf hashers and the static-ct identity and Merkle leaf hashers (reached through MigrationOptions.LeafHasher and the hasher WithAntispam hands to an Antispam), over well-formed bundles and seeded truncations, byte flips and trailing junk.",
		upstream:    "github.com/transparency-dev/tessera (lifecycle.go, ct_only.go)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"tlog":   []string{"bundleHex", "identity hasher", "Merkle leaf hasher", "each [err] or [\"\", hashesHex]"},
				"static": []string{"bundleHex", "ctBundleIDHasher (MigrationOptions)", "ctMerkleLeafHasher", "ctBundleIDHasher (AppendOptions)"},
			}),
			dRows("tlog", tlog),
			dRows("static", ct),
		},
	}
}

// diffLogReader serves one fixed checkpoint (or none) to the publisher, which
// reads the previous checkpoint to tell witnesses where they stand.
type diffLogReader struct {
	cp []byte
}

func (d diffLogReader) ReadCheckpoint(context.Context) ([]byte, error) {
	if d.cp == nil {
		return nil, os.ErrNotExist
	}
	return d.cp, nil
}
func (diffLogReader) ReadTile(context.Context, uint64, uint64, uint8) ([]byte, error) {
	return nil, os.ErrNotExist
}
func (diffLogReader) ReadEntryBundle(context.Context, uint64, uint8) ([]byte, error) {
	return nil, os.ErrNotExist
}
func (diffLogReader) NextIndex(context.Context) (uint64, error)      { return 0, nil }
func (diffLogReader) IntegratedSize(context.Context) (uint64, error) { return 0, nil }

// genDiffCheckpointPublisher records AppendOptions.CheckpointPublisher with no
// witnesses: the signed checkpoint bytes for assorted sizes and roots with one
// and two signers, and its handling of the previous checkpoint, which it parses
// with internal/parse.CheckpointUnsafe and rejects with that function's error.
func genDiffCheckpointPublisher() diffFile {
	r := newDiffRand(0xc9b)
	ctx := context.Background()
	s1, s2 := mustSigner(logSKey), mustSigner(logAltSKey)
	configs := [][]note.Signer{{s1}, {s1, s2}, {s2, s1}}
	var signRows [][]any
	for ci, signers := range configs {
		pub := tessera.NewAppendOptions().WithCheckpointSigner(signers[0], signers[1:]...).CheckpointPublisher(diffLogReader{}, nil)
		for _, size := range []uint64{0, 1, 5, 255, 256, 1 << 40, 1<<63 + 7, ^uint64(0)} {
			for _, root := range [][]byte{nil, randBytes(r, 32), randBytes(r, 31), randBytes(r, 1)} {
				cp, err := pub(ctx, size, root)
				signRows = append(signRows, []any{ci, u64s(size), hx(root), errString(err), hx(cp)})
			}
		}
	}

	// Previous checkpoints: well-formed, and every way CheckpointUnsafe can
	// reject one.
	olds := [][]byte{
		[]byte("origin\n5\nYmFuYW5hcw==\n"), []byte("origin\n5\nYmFuYW5hcw==\n\n— sig\n"), []byte("origin\n5\nYmFuYW5hcw=="),
		[]byte("origin\n5\n"), []byte("origin"), []byte(""), []byte("\n\n\n"), []byte("o\n-1\nAA==\n"), []byte("o\n18446744073709551616\nAA==\n"),
		[]byte("o\n1\nAA=\n"), []byte("o\n1\n!!\n"), []byte("o\n\nAA==\n"), []byte("o\n1 \nAA==\n"), {0xff, '\n', '1', '\n', 'A', 'A', '=', '=', '\n'},
		[]byte("o\n\xff\nAA==\n"), []byte("o\n1\n\xffA==\n"), []byte("\"quoted\"\n1\n\n"), []byte("o\n9\n\x00\n"),
	}
	for i := 0; i < scaled(300); i++ {
		b := make([]byte, r.Intn(30))
		for k := range b {
			switch r.Intn(4) {
			case 0:
				b[k] = '\n'
			case 1:
				b[k] = "0123456789"[r.Intn(10)]
			case 2:
				b[k] = "ABCDEFabc+/= \r-"[r.Intn(15)]
			default:
				b[k] = byte(r.Intn(256))
			}
		}
		olds = append(olds, b)
	}
	pub := tessera.NewAppendOptions().WithCheckpointSigner(s1).CheckpointPublisher(diffLogReader{}, nil)
	want, err := pub(ctx, 9, make([]byte, 32))
	if err != nil {
		panic(err)
	}
	var oldRows [][]any
	for _, old := range olds {
		pub := tessera.NewAppendOptions().WithCheckpointSigner(s1).CheckpointPublisher(diffLogReader{cp: old}, nil)
		cp, err := pub(ctx, 9, make([]byte, 32))
		if err == nil && string(cp) != string(want) {
			panic("the previous checkpoint changed the published one")
		}
		oldRows = append(oldRows, []any{hx(old), errString(err)})
	}
	return diffFile{
		description: "Differential corpus for AppendOptions.CheckpointPublisher without witnesses: the signed checkpoint for assorted sizes (0 forces the RFC 6962 empty root) and roots with one and two signers, and the error for each previous checkpoint internal/parse.CheckpointUnsafe rejects.",
		upstream:    "github.com/transparency-dev/tessera (append_lifecycle.go, internal/parse)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"signerConfigs": "signer keys per configuration: the first signs the origin line, the rest are additional signers",
				"sign":          []string{"signer config", "size", "rootHex", "err", "checkpointHex"},
				"previous":      []string{"previous checkpoint hex (size 9, zero root published over it)", "err (\"\": published unchanged)"},
			}),
			dValue("signerConfigs", [][]string{{logSKey}, {logSKey, logAltSKey}, {logAltSKey, logSKey}}),
			dRows("sign", signRows),
			dRows("previous", oldRows),
		},
	}
}
