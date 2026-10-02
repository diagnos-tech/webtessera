// Copyright 2026 MedDeck. All Rights Reserved.
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
// This file has no counterpart in Go, where the package itself is the unit of import. It
// is the barrel that `webtessera/fsck` resolves to (package.json's `exports`),
// re-exporting exactly what Go's `fsck` package exports, following the same pattern
// client/index.ts and api/layout/index.ts use.
//
// Deliberately NOT re-exported: `resource`, `fsckTree`, `ResourceQueue`, `countingFetcher`
// / `newCountingFetcher` (all unexported in Go, or -- ResourceQueue -- have no Go
// counterpart at all) and `rangeTracker`/`newRangeTracker` (status.go, also unexported).
// All are reachable only by importing `./fsck` / `./status` directly, which is what the
// ported `fsck_test.ts` / `status_test.ts` do, per docs/decisions/0010-package-private-members.md.

export { type Fetcher, Fsck, newFsck, type Opts, Status } from "./fsck.ts";
export {
	Calculating,
	FetchError,
	Fetched,
	Fetching,
	Invalid,
	OK,
	Range,
	type State,
	stateString,
	Unchecked,
} from "./status.ts";
