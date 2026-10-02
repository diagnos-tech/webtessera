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

// Command produce writes a tlog-tiles log with Tessera's own POSIX driver: the
// Go reference against which webtessera's logs are compared, and the Go writer
// that carries on a log webtessera started.
//
// It appends entries of the interop corpus (internal/entries) in batches that
// end exactly at the sizes given by -ends, waiting after each batch for a
// checkpoint that commits to it. Every batch is added in one tight loop and
// flushed by the batch age (or by filling up), so the batch boundaries, and with
// them the set of partial tiles and bundles on disk, are a function of -ends
// alone. webtessera, given the same -ends, must leave the same files.
//
// If -dir already holds a log (one webtessera wrote, say), the POSIX driver
// resumes it from its .state/ directory, and produce checks that the first new
// entry is given index -from: the proof that Go read the other side's tree state
// correctly.
//
// Usage:
//
//	produce -dir DIR -skey SKEY -seed 1 -from 0 -ends 1,255,300,4096 [-history HISTDIR]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/diagnos-tech/webtessera/interop/internal/entries"
	"github.com/diagnos-tech/webtessera/interop/internal/history"
	f_log "github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/storage/posix"
	"golang.org/x/mod/sumdb/note"
	"k8s.io/klog/v2"
)

// maxBatchSize is the appender's batch size. No batch in -ends may be larger,
// and only a batch of exactly this size is flushed by filling up; every other
// batch is flushed by its age. It matches Tessera's default pushback limit.
const maxBatchSize = 4096

var (
	dir         = flag.String("dir", "", "Directory holding the log; created if absent, resumed if it already holds one.")
	skey        = flag.String("skey", "", "Note signer key that signs the log's checkpoints.")
	seed        = flag.Uint64("seed", 1, "Seed of the interop entry corpus.")
	from        = flag.Uint64("from", 0, "Size of the log in -dir before this run: the index the first new entry must be given.")
	ends        = flag.String("ends", "", "Comma-separated, strictly increasing log sizes at which the batches end.")
	historyDir  = flag.String("history", "", "If set, the checkpoint published after each batch is written here as checkpoint.<size>.")
	batchMaxAge = flag.Duration("batch_max_age", 100*time.Millisecond, "Age at which a batch smaller than the maximum is flushed.")
)

func main() {
	klog.InitFlags(nil)
	flag.Parse()
	if err := run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "produce: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	if *dir == "" || *skey == "" || *ends == "" {
		return errors.New("-dir, -skey and -ends are required")
	}
	batchEnds, err := parseEnds(*ends, *from)
	if err != nil {
		return err
	}
	signer, err := note.NewSigner(*skey)
	if err != nil {
		return fmt.Errorf("invalid -skey: %v", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	driver, err := posix.New(ctx, posix.Config{Path: *dir})
	if err != nil {
		return fmt.Errorf("posix.New: %v", err)
	}
	// The options mirror fixtures/gen/log.go's: republication and garbage
	// collection off, so that the files on disk depend on the batch boundaries
	// only, and the minimum checkpoint interval.
	opts := tessera.NewAppendOptions().
		WithCheckpointSigner(signer).
		WithBatching(maxBatchSize, *batchMaxAge).
		WithCheckpointInterval(100 * time.Millisecond).
		WithCheckpointRepublishInterval(0).
		WithGarbageCollectionInterval(0)
	appender, shutdown, reader, err := tessera.NewAppender(ctx, driver, opts)
	if err != nil {
		return fmt.Errorf("NewAppender: %v", err)
	}
	awaiter := tessera.NewPublicationAwaiter(ctx, reader.ReadCheckpoint, 10*time.Millisecond)

	cur := *from
	var cp *f_log.Checkpoint
	for _, end := range batchEnds {
		if cp, err = appendBatch(ctx, appender, awaiter, cur, end); err != nil {
			return err
		}
		cur = end
	}
	if err := shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %v", err)
	}
	fmt.Printf("produce: appended entries [%d, %d) in %d batches; checkpoint size %d, root %x\n",
		*from, cur, len(batchEnds), cp.Size, cp.Hash)
	return nil
}

// appendBatch appends entries [from, to) as one batch, checks that they were
// sequenced in order, waits for the checkpoint that commits to them, and records
// it in the history directory.
func appendBatch(ctx context.Context, appender *tessera.Appender, awaiter *tessera.PublicationAwaiter, from, to uint64) (*f_log.Checkpoint, error) {
	// Build every entry before adding any: the adding loop must finish well
	// inside the batch age, or the queue would split the batch in two.
	batch := make([]*tessera.Entry, 0, to-from)
	for i := from; i < to; i++ {
		batch = append(batch, tessera.NewEntry(entries.Data(*seed, i)))
	}
	futures := make([]tessera.IndexFuture, 0, len(batch))
	for _, e := range batch {
		futures = append(futures, appender.Add(ctx, e))
	}
	for k, f := range futures {
		idx, err := f()
		if err != nil {
			return nil, fmt.Errorf("entry %d: %v", from+uint64(k), err)
		}
		if want := from + uint64(k); idx.Index != want {
			return nil, fmt.Errorf("entry %d was given index %d; the log was not at size %d, or entries were reordered", want, idx.Index, from)
		}
	}
	_, raw, err := awaiter.Await(ctx, futures[len(futures)-1])
	if err != nil {
		return nil, fmt.Errorf("awaiting a checkpoint covering entry %d: %v", to-1, err)
	}
	cp, err := checkpointBody(raw)
	if err != nil {
		return nil, err
	}
	if cp.Size != to {
		return nil, fmt.Errorf("the checkpoint published after the batch ending at %d commits to %d entries", to, cp.Size)
	}
	if *historyDir != "" {
		if err := history.Write(*historyDir, to, raw); err != nil {
			return nil, fmt.Errorf("recording checkpoint %d: %v", to, err)
		}
	}
	return cp, nil
}

// checkpointBody parses the body of a signed checkpoint without verifying its
// signature: produce knows only the private key, and verifying the log is
// interop/verify's job.
func checkpointBody(raw []byte) (*f_log.Checkpoint, error) {
	body, _, ok := strings.Cut(string(raw), "\n\n")
	if !ok {
		return nil, fmt.Errorf("malformed checkpoint %q", raw)
	}
	cp := &f_log.Checkpoint{}
	if _, err := cp.Unmarshal([]byte(body + "\n")); err != nil {
		return nil, fmt.Errorf("malformed checkpoint %q: %v", raw, err)
	}
	return cp, nil
}

// parseEnds parses -ends, checking that every batch is non-empty and fits in
// one queue flush.
func parseEnds(s string, from uint64) ([]uint64, error) {
	var r []uint64
	prev := from
	for _, f := range strings.Split(s, ",") {
		end, err := strconv.ParseUint(strings.TrimSpace(f), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid -ends element %q: %v", f, err)
		}
		if end <= prev || end-prev > maxBatchSize {
			return nil, fmt.Errorf("-ends: a batch from %d to %d is empty or larger than %d", prev, end, maxBatchSize)
		}
		r = append(r, end)
		prev = end
	}
	return r, nil
}
