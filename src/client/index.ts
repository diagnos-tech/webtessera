// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This file has no counterpart in Go, where the package itself is the unit of import.
// It is the barrel that `webtessera/client` resolves to, re-exporting exactly what Go's
// `client` package exports, following the same pattern api/layout/index.ts and
// vendor/formats/log/index.ts already use.
//
// Deliberately NOT re-exported: `nodeCache`/`newNodeCache` (client.ts) and
// `ProofBuilder.fetchNodes` are unexported in Go and reachable only by importing
// client.ts directly, per docs/decisions/0010-package-private-members.md. `FileFetcher`
// is not ported at all; see docs/decisions/0064-filefetcher-not-ported.md.

export {
	type CheckpointFetcherFunc,
	type ConsensusCheckpointFunc,
	type EntryBundleFetcherFunc,
	ErrInconsistency,
	type FetchedCheckpoint,
	fetchCheckpoint,
	fetchLeafHashes,
	fetchRangeNodes,
	getEntryBundle,
	LogStateTracker,
	newLogStateTracker,
	newProofBuilder,
	ProofBuilder,
	type TileFetcherFunc,
	type UpdateResult,
	unilateralConsensus,
} from "./client.ts";
export { type FetchFn, HTTPFetcher, type HTTPFetcherOptions, newHTTPFetcher } from "./fetcher.ts";
export { type Bundle, type Entry, entries, entryBundles, type TreeSizeFunc } from "./stream.ts";
