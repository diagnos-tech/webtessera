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

// The interop harness's entry corpus, version 1: the JavaScript twin of
// interop/internal/entries/entries.go, whose package comment is the specification. Both sides
// derive entry i from (seed, i) alone, so the Go verifier can check that a log holds exactly
// the entries the TypeScript side appended, and vice versa.

import { createHash } from "node:crypto";

const domain = Buffer.from("webtessera/interop/v1\x00", "latin1");

/**
 * corpusDigest pins the corpus exactly as entries_test.go's CorpusDigest does: SHA-256 over
 * uint32be(len) || entry for the first 4096 entries with seed 1.
 */
const corpusDigest = {
	seed: 1n,
	entries: 4096n,
	hex: "bdb57e7dc27d643f565bd4318458d511c2fc67f11490eccbd6a09081b3f6ec96",
};

/** entryData returns entry i (a bigint) of the corpus with the given seed (a bigint). */
export function entryData(seed, i) {
	const msg = Buffer.alloc(domain.length + 16);
	domain.copy(msg);
	msg.writeBigUInt64BE(seed, domain.length);
	msg.writeBigUInt64BE(i, domain.length + 8);
	const d = createHash("sha256").update(msg).digest();

	const n = entrySize(d);
	const out = new Uint8Array(n);
	const blk = Buffer.alloc(36);
	d.copy(blk);
	for (let k = 0, off = 0; off < n; k++, off += 32) {
		blk.writeUInt32BE(k, 32);
		const h = createHash("sha256").update(blk).digest();
		out.set(h.subarray(0, Math.min(32, n - off)), off);
	}
	return out;
}

/** entrySize picks an entry's length from its derivation hash d. */
function entrySize(d) {
	const r = d.readUInt16BE(1);
	if (d[0] === 0) {
		return 0;
	}
	if (d[0] < 4) {
		return 4096 + (r % 12288);
	}
	return r % 256;
}

/**
 * checkCorpus throws unless this implementation reproduces the pinned corpus digest, so that a
 * drift between the Go and JavaScript corpora is reported as exactly that, before any log is
 * written, rather than as a puzzling content mismatch later.
 */
export function checkCorpus() {
	const h = createHash("sha256");
	const len = Buffer.alloc(4);
	for (let i = 0n; i < corpusDigest.entries; i++) {
		const d = entryData(corpusDigest.seed, i);
		len.writeUInt32BE(d.length);
		h.update(len).update(d);
	}
	const got = h.digest("hex");
	if (got !== corpusDigest.hex) {
		throw new Error(
			`scripts/interop/entries.mjs produces corpus digest ${got}, but interop/internal/entries pins ${corpusDigest.hex}`,
		);
	}
}
