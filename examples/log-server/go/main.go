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

// Command verify checks a log served over HTTP with Tessera's own Go client, independently of
// webtessera: the checkpoint's signature, then an inclusion proof for every entry, built from
// the served tiles and checked against the checkpoint's root. A log that passes is, byte for
// byte, a log Tessera's tooling accepts.
//
// Usage:
//
//	go run . -log http://127.0.0.1:8080/ -vkey "$LOG_VKEY"
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"

	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/api"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
)

var (
	logURL = flag.String("log", "", "URL prefix the log is served at.")
	vkey   = flag.String("vkey", "", "Note verifier key of the log; its name is the checkpoint origin.")
)

func main() {
	flag.Parse()
	if err := run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "verify-go: FAIL: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	if *logURL == "" || *vkey == "" {
		return errors.New("-log and -vkey are required")
	}
	v, err := note.NewVerifier(*vkey)
	if err != nil {
		return fmt.Errorf("invalid -vkey: %v", err)
	}
	u, err := url.Parse(*logURL)
	if err != nil {
		return fmt.Errorf("invalid -log: %v", err)
	}
	f, err := client.NewHTTPFetcher(u, nil)
	if err != nil {
		return err
	}

	cp, _, _, err := client.FetchCheckpoint(ctx, f.ReadCheckpoint, v, v.Name())
	if err != nil {
		return fmt.Errorf("checkpoint: %v", err)
	}
	pb, err := client.NewProofBuilder(ctx, cp.Size, f.ReadTile)
	if err != nil {
		return fmt.Errorf("proof builder: %v", err)
	}

	var bundle api.EntryBundle
	for i := uint64(0); i < cp.Size; i++ {
		if i%layout.EntryBundleWidth == 0 {
			if bundle, err = client.GetEntryBundle(ctx, f.ReadEntryBundle, i/layout.EntryBundleWidth, cp.Size); err != nil {
				return fmt.Errorf("entry bundle %d: %v", i/layout.EntryBundleWidth, err)
			}
		}
		entry := bundle.Entries[i%layout.EntryBundleWidth]
		p, err := pb.InclusionProof(ctx, i)
		if err != nil {
			return fmt.Errorf("inclusion proof for entry %d: %v", i, err)
		}
		if err := proof.VerifyInclusion(rfc6962.DefaultHasher, i, cp.Size, rfc6962.DefaultHasher.HashLeaf(entry), p, cp.Hash); err != nil {
			return fmt.Errorf("entry %d: %v", i, err)
		}
	}
	fmt.Printf("verify-go: OK: checkpoint of %d entries signed by %s; every entry proven with Tessera's Go client\n", cp.Size, v.Name())
	return nil
}
