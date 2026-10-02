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

// Command gen emits golden fixtures for the webtessera TypeScript port by
// executing the real Tessera implementation and serialising its outputs.
//
// Every byte in fixtures/data/ is produced by running upstream Go code. Nothing
// in this program computes a hash, a path, or an encoding by itself; it only
// calls upstream and records what came back. That property is what makes the
// fixtures evidence rather than assertion, so please preserve it.
//
// The output must be reproducible: running this program twice over an existing
// fixtures/data/ tree must leave the tree byte-identical. That rules out
// timestamps, randomness without a fixed seed, and any iteration over a Go map
// whose order leaks into the output. See docs/decisions/0006-golden-fixtures-from-go.md.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

var outDir = flag.String("out", "../data", "Directory into which fixture JSON files are written.")

// generator produces one fixture file. Name is the file's basename without the
// ".json" extension.
type generator struct {
	name string
	fn   func() any
}

func main() {
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "failed to create output directory %q: %v\n", *outDir, err)
		os.Exit(1)
	}

	gens := []generator{
		{"layout_paths", genLayoutPaths},
		{"layout_parse", genLayoutParse},
		{"layout_tile", genLayoutTile},
		{"layout_range", genLayoutRange},
		{"rfc6962", genRFC6962},
		{"compact_range", genCompactRange},
		{"proof_inclusion", genProofInclusion},
		{"proof_consistency", genProofConsistency},
		{"api_hash_tile", genAPIHashTile},
		{"api_entry_bundle", genAPIEntryBundle},
		{"note", genNote},
		{"checkpoint", genCheckpoint},
		{"ctonly", genCTOnly},
	}

	written := map[string]bool{}
	for _, g := range gens {
		if err := writeFixture(*outDir, g.name, g.fn()); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", g.name, err)
			os.Exit(1)
		}
		written[g.name+".json"] = true
		fmt.Printf("wrote %s.json\n", g.name)
	}

	// The full-log fixtures each drive a real Tessera POSIX log, so they are
	// generated together and name their own files.
	logNames, err := genLogs(*outDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "logs: %v\n", err)
		os.Exit(1)
	}
	for _, n := range logNames {
		written[n] = true
		fmt.Printf("wrote %s\n", n)
	}

	// client_log reads back the static checked-in log under
	// upstream's testdata/log, rather than building one, so it is generated
	// on its own too.
	if err := writeFixture(*outDir, "client_log", genClientLog()); err != nil {
		fmt.Fprintf(os.Stderr, "client_log: %v\n", err)
		os.Exit(1)
	}
	written["client_log.json"] = true
	fmt.Printf("wrote client_log.json\n")

	// Remove stale fixtures so that deleting a generator case cannot leave an
	// orphaned file behind that a test might still be asserting against.
	stale, err := staleFiles(*outDir, written)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to scan output directory: %v\n", err)
		os.Exit(1)
	}
	for _, s := range stale {
		if err := os.Remove(filepath.Join(*outDir, s)); err != nil {
			fmt.Fprintf(os.Stderr, "failed to remove stale fixture %q: %v\n", s, err)
			os.Exit(1)
		}
		fmt.Printf("removed stale %s\n", s)
	}
}

// staleFiles returns the .json files present in dir which were not written by
// this run, sorted for deterministic reporting.
func staleFiles(dir string, written map[string]bool) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var stale []string
	for _, e := range ents {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		if !written[e.Name()] {
			stale = append(stale, e.Name())
		}
	}
	sort.Strings(stale)
	return stale, nil
}
