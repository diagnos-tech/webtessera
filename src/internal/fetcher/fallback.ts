// Copyright 2025 Google LLC. All Rights Reserved.
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
// Ported from tessera/internal/fetcher/fallback.go @ 4a6d9f9
//
// Port note: `context.Context` becomes an optional trailing `AbortSignal` per
// docs/decisions/0004-errors-context-and-concurrency.md. It moves from the first
// Go parameter to the last TypeScript one both on this function and on the
// callback it takes, which is the convention docs/decisions/0060-fetcher-signal-parameter-order.md
// establishes for every fetcher-shaped function in this work package.

import { ErrNotExist, errorIs, wrapError } from "../gostd/errors.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * partialOrFullResource calls the provided function with the provided partial resource size value in order to fetch and return a static resource.
 * If p is non-zero, and f throws ErrNotExist, this function will try to fetch the corresponding full resource by calling f a second time passing
 * zero.
 */
export async function partialOrFullResource(
	p: number,
	f: (p: number, signal?: AbortSignal) => Promise<Uint8Array>,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	let sRaw: Uint8Array;
	try {
		sRaw = await f(p, signal);
	} catch (err) {
		if (errorIs(err, ErrNotExist) && p === 0) {
			throw wrapError("resource not found", err);
		}
		if (errorIs(err, ErrNotExist) && p > 0) {
			// It could be that the partial resource was removed as the tree has grown and a full resource is now present, so try
			// falling back to that.
			try {
				return await f(0, signal);
			} catch (fallbackErr) {
				throw wrapError("neither partial nor full resource found", fallbackErr);
			}
		}
		throw new Error(`failed to fetch resource: ${errText(err)}`);
	}
	return sRaw;
}
