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
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/ctonly"
	"github.com/transparency-dev/tessera/storage/posix"
)

// diffCTLogSize is the size of the static-ct log: one full entry bundle and a
// partial one, so both kinds of bundle and tile are covered.
const diffCTLogSize = 300

// genDiffCTLog builds a static-ct log with the real POSIX driver,
// WithCTLayout and NewCertificateTransparencyAppender, from seeded CT entries,
// and records every file it wrote. The tlog-tiles log fixtures (log.go) cannot
// catch a mistake in the index an entry is marshalled at, because a tlog-tiles
// entry ignores it; a static-ct entry embeds it in its leaf_index extension and
// its Merkle leaf hash. The options mirror runLog's: one batch, GC off,
// republication off.
func genDiffCTLog() diffFile {
	r := newDiffRand(0xc7106)
	entries := make([]ctonly.Entry, diffCTLogSize)
	var entryRows [][]any
	for i := range entries {
		e := ctonly.Entry{
			Timestamp:   1700000000000 + uint64(i)*1000 + uint64(r.Intn(1000)),
			IsPrecert:   r.Intn(3) == 0,
			Certificate: randBytes(r, 8+r.Intn(40)),
		}
		if e.IsPrecert {
			e.Precertificate = randBytes(r, 8+r.Intn(40))
			e.IssuerKeyHash = randBytes(r, 32)
		}
		fps := []string{}
		for k := r.Intn(3); k > 0; k-- {
			var fp [32]byte
			copy(fp[:], randBytes(r, 32))
			e.FingerprintsChain = append(e.FingerprintsChain, fp)
			fps = append(fps, hx(fp[:]))
		}
		entries[i] = e
		entryRows = append(entryRows, []any{u64s(e.Timestamp), boolInt(e.IsPrecert), hx(e.Certificate), hx(e.Precertificate), hx(e.IssuerKeyHash), fps})
	}

	dir, err := os.MkdirTemp("", "webtessera-fixture-ctlog-")
	if err != nil {
		panic(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if err := runCTLog(dir, entries); err != nil {
		panic(err)
	}

	var files [][]any
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(d.Name(), ".lock") {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		files = append(files, []any{filepath.ToSlash(rel), hx(raw)})
		return nil
	})
	if err != nil {
		panic(err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i][0].(string) < files[j][0].(string) })

	return diffFile{
		description: fmt.Sprintf("A static-ct log of %d seeded CT entries built by the real Tessera POSIX driver with WithCTLayout and NewCertificateTransparencyAppender in one batch (GC and republication off): every file it wrote, .state included.", diffCTLogSize),
		upstream:    "github.com/transparency-dev/tessera (ct_only.go, storage/posix)",
		sections: []diffSection{
			dValue("columns", map[string]any{
				"entries": []string{"timestamp", "isPrecert", "certificateHex", "precertificateHex", "issuerKeyHashHex", "fingerprintsChain"},
				"files":   []string{"path", "contentHex"},
			}),
			dValue("signerKey", logSKey),
			dRows("entries", entryRows),
			dRows("files", files),
		},
	}
}

func runCTLog(dir string, entries []ctonly.Entry) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	driver, err := posix.New(ctx, posix.Config{Path: dir})
	if err != nil {
		return fmt.Errorf("posix.New: %w", err)
	}
	opts := tessera.NewAppendOptions().
		WithCheckpointSigner(mustSigner(logSKey)).
		WithBatching(uint(len(entries)), time.Hour).
		WithCheckpointInterval(100 * time.Millisecond).
		WithCheckpointRepublishInterval(0).
		WithGarbageCollectionInterval(0).
		WithCTLayout()
	appender, shutdown, rd, err := tessera.NewAppender(ctx, driver, opts)
	if err != nil {
		return fmt.Errorf("NewAppender: %w", err)
	}
	add := tessera.NewCertificateTransparencyAppender(appender)
	await := tessera.NewPublicationAwaiter(ctx, rd.ReadCheckpoint, 10*time.Millisecond)
	futures := make([]tessera.IndexFuture, 0, len(entries))
	for i := range entries {
		futures = append(futures, add(ctx, &entries[i]))
	}
	for i, fut := range futures {
		idx, _, err := await.Await(ctx, fut)
		if err != nil {
			return fmt.Errorf("await entry %d: %w", i, err)
		}
		if idx.Index != uint64(i) {
			return fmt.Errorf("entry %d was assigned index %d", i, idx.Index)
		}
	}
	return shutdown(ctx)
}
