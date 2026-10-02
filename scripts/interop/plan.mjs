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

// The batch plan of an interop run: the log sizes at which each batch ends, for the two phases
// every scenario has (the first writer grows the log to size1, the second carries it on to
// size2). Both writers, Go's POSIX driver and webtessera's, are handed the same plan, and with
// GC disabled the set of files a log holds is a function of its batch boundaries alone, which
// is what makes a byte-for-byte comparison of the two logs meaningful.

/** maxBatch is the largest batch either writer is given: interop/produce's maxBatchSize. */
export const maxBatch = 4096;

/**
 * landmarks are sizes every plan ends a batch on when its phase reaches them: either side of
 * the first bundle and tile boundaries, of the first level-1 tile's second slot, and of
 * 65536 = 256^2, where the first level-2 tile appears.
 */
const landmarks = [1n, 2n, 255n, 256n, 257n, 511n, 512n, 513n, 65535n, 65536n, 65537n];

/**
 * makePlan returns the batch ends of both phases. Batch lengths are drawn from a generator
 * seeded with seed, a third of them short (up to 64 entries, so that partial resources of many
 * widths pile up) and the rest anywhere up to maxBatch; every landmark inside a phase is a batch
 * end, as is the phase's last size.
 */
export function makePlan(seed, size1, size2) {
	if (!(0n < size1 && size1 < size2)) {
		throw new Error(`interop sizes must satisfy 0 < size1 < size2, got ${size1} and ${size2}`);
	}
	const next = rng(seed);
	return { phase1: phaseEnds(next, 0n, size1), phase2: phaseEnds(next, size1, size2) };
}

function phaseEnds(next, from, to) {
	const ends = [];
	for (let cur = from; cur < to; ) {
		const short = next() % 3n === 0n;
		const len = 1n + (short ? next() % 64n : next() % BigInt(maxBatch));
		let end = cur + len < to ? cur + len : to;
		const landmark = landmarks.find((l) => l > cur && l <= to);
		if (landmark !== undefined && landmark < end) {
			end = landmark;
		}
		ends.push(end);
		cur = end;
	}
	return ends;
}

/**
 * rng returns a splitmix64 generator of uint64 bigints seeded with seed: tiny, well
 * distributed, and specified exactly enough to reproduce a plan from its seed alone.
 */
export function rng(seed) {
	const mask = (1n << 64n) - 1n;
	let s = BigInt.asUintN(64, seed);
	return () => {
		s = (s + 0x9e3779b97f4a7c15n) & mask;
		let z = s;
		z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
		z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
		return z ^ (z >> 31n);
	};
}
