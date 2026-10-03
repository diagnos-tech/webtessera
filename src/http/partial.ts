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

// This file has no upstream counterpart. See docs/decisions/0170-http-log-handler.md.

import { readUint16BE } from "../internal/gostd/bytes.ts";
import type { LogResource } from "./resources.ts";

// hashSize is the size of one Merkle tree hash in a tile: tlog-tiles fixes SHA-256.
const hashSize = 32;

/**
 * trimToWidth returns data, the body a LogReader returned for r, cut down to the number
 * of hashes or entries r's partial width names.
 *
 * A reader may answer a request for a partial resource with the full one: Tessera's
 * drivers fall back to the full tile once the partial has been garbage collected
 * (`internal/fetcher/fallback.go`), which is what lets a client holding an old checkpoint
 * keep verifying it. tlog-tiles, however, defines the partial tile of width W as exactly
 * W hashes, and some clients check that. The first W hashes of the full tile (or the first
 * W entries of the full bundle) are, by construction, the partial resource, so the
 * handler can serve the exact bytes the spec describes instead of passing the substitute
 * on.
 *
 * Anything that is not longer than the width implies, or does not parse, is returned
 * unchanged: the handler serves what the reader produced rather than guessing.
 */
export function trimToWidth(r: LogResource, data: Uint8Array): Uint8Array {
	if (r.kind === "checkpoint" || r.width === 0) {
		return data;
	}
	if (r.kind === "tile") {
		const want = r.width * hashSize;
		return data.length > want && data.length % hashSize === 0 ? data.subarray(0, want) : data;
	}
	// Entry bundles are sequences of big-endian uint16 length-prefixed entries.
	let off = 0;
	for (let n = 0; n < r.width; n++) {
		if (off + 2 > data.length) {
			return data;
		}
		off += 2 + readUint16BE(data, off);
		if (off > data.length) {
			return data;
		}
	}
	return off < data.length ? data.subarray(0, off) : data;
}
