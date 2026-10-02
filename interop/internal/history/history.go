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

// Package history stores the checkpoints a log published as it grew, one file
// per checkpoint, so that a verifier can later prove the final tree consistent
// with each of them.
//
// The layout is upstream's own testdata/log convention: a directory of files
// named checkpoint.<size>, each holding the exact signed checkpoint bytes the
// log published at that size. The harness keeps these directories next to, not
// inside, the log, so that the log directory holds exactly what a store holds.
package history

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const prefix = "checkpoint."

// Checkpoint is one recorded checkpoint.
type Checkpoint struct {
	// Size is the tree size the file name records.
	Size uint64
	// Raw is the signed checkpoint, exactly as the log published it.
	Raw []byte
	// From is the file it was read from, for error messages.
	From string
}

// Write records raw as the checkpoint the log published at size.
func Write(dir string, size uint64, raw []byte) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, prefix+strconv.FormatUint(size, 10)), raw, 0o644)
}

// Read returns every checkpoint recorded in dirs, ordered by size. Recording
// two different checkpoints for the same size is an error: a log that did that
// forked, and the verifier would otherwise check only one of the branches.
func Read(dirs ...string) ([]Checkpoint, error) {
	bySize := map[uint64]Checkpoint{}
	for _, dir := range dirs {
		des, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, de := range des {
			name := de.Name()
			if !strings.HasPrefix(name, prefix) {
				continue
			}
			size, err := strconv.ParseUint(strings.TrimPrefix(name, prefix), 10, 64)
			if err != nil {
				return nil, fmt.Errorf("%s: unexpected file name: %v", filepath.Join(dir, name), err)
			}
			p := filepath.Join(dir, name)
			raw, err := os.ReadFile(p)
			if err != nil {
				return nil, err
			}
			if prev, ok := bySize[size]; ok && string(prev.Raw) != string(raw) {
				return nil, fmt.Errorf("%s and %s record different checkpoints for size %d", prev.From, p, size)
			}
			bySize[size] = Checkpoint{Size: size, Raw: raw, From: p}
		}
	}
	r := make([]Checkpoint, 0, len(bySize))
	for _, c := range bySize {
		r = append(r, c)
	}
	sort.Slice(r, func(i, j int) bool { return r[i].Size < r[j].Size })
	return r, nil
}
