// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/antispam_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { newInMemoryDedup } from "./antispam.ts";
import type { Index, IndexFuture } from "./append_lifecycle.ts";
import { type Entry, newEntry } from "./entry.ts";
import { toUTF8 } from "./internal/gostd/bytes.ts";

// Port note: Go's BenchmarkDedup is not ported, per docs/decisions/0034-go-benchmarks-not-ported.md.

describe("TestDedup", () => {
	const testCases = [
		{
			desc: "first element",
			newValue: "foo",
			wantIdx: 1n,
			wantDup: true,
		},
		{
			desc: "third element",
			newValue: "baz",
			wantIdx: 3n,
			wantDup: true,
		},
		{
			desc: "new element",
			newValue: "omega",
			wantIdx: 4n,
			wantDup: false,
		},
	];
	for (const tC of testCases) {
		it(tC.desc, async () => {
			let idx = 1n;
			const delegate = (_e: Entry, _signal?: AbortSignal): IndexFuture => {
				const thisIdx = idx;
				idx++;
				return async (): Promise<Index> => {
					return { index: thisIdx, isDup: false };
				};
			};
			const dedupAdd = newInMemoryDedup(256)(delegate);

			// Add foo, bar, baz to prime the cache to make things interesting
			for (const s of ["foo", "bar", "baz"]) {
				await dedupAdd(newEntry(toUTF8(s)))();
			}

			const i = await dedupAdd(newEntry(toUTF8(tC.newValue)))();
			expect(i.index).toBe(tC.wantIdx);
			expect(i.isDup).toBe(tC.wantDup);
		});
	}
});

it("TestDedupDoesNotCacheError", async () => {
	let idx = 0n;
	let rErr = true;

	// This delegate will return an error the first time it's called, but all further
	// calls will succeed.
	// When an error is returned, no entry will be "added" to the tree.
	const delegate = (_e: Entry, _signal?: AbortSignal): IndexFuture => {
		const thisIdx = idx;
		// Don't add an entry if we're returning an error
		if (!rErr) {
			idx++;
		}
		return async (): Promise<Index> => {
			// Return an error just the first time we're called
			if (rErr) {
				rErr = false;
				throw new Error("bad thing happened");
			}
			return { index: thisIdx, isDup: false };
		};
	};
	const dedupAdd = newInMemoryDedup(256)(delegate);

	const k = "foo";
	for (let i = 0; i < 10; i++) {
		// Port note: Go returns `(Index, error)` and reads both; the throw model
		// (docs/decisions/0004-errors-context-and-concurrency.md) loses the index half on
		// the error path, so idx is undefined when err is set and the `index === 0` check
		// only runs when a value was returned — exactly the values Go would have on the
		// success path.
		let idxRes: Index | undefined;
		let err: unknown;
		try {
			idxRes = await dedupAdd(newEntry(toUTF8(k)))();
		} catch (e) {
			err = e;
		}

		// We expect an error from the delegate the first time.
		if (i === 0) {
			expect(err).toBeDefined();
		}
		// But the 2nd call should work.
		if (i > 0) {
			expect(err).toBeUndefined();
		}

		// After which, all subsequent adds should dedup to that successful add.
		if (i > 1) {
			expect(idxRes?.isDup).toBe(true);
		}
		if (idxRes !== undefined) {
			expect(idxRes.index).toBe(0n);
		}
	}
});
