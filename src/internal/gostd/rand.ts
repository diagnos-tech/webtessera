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

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `math/rand` that upstream's *tests* use to drive randomised cross-checks
// against reference implementations.
//
// It is deliberately NOT bit-compatible with Go: reproducing Go's generator
// would mean shipping the 607-entry `rngCooked` table of its lagged Fibonacci
// source, and no upstream test asserts on specific random values — they assert
// that the optimised implementation agrees with the reference one for whatever
// inputs come out. See docs/decisions/0012-test-prng-not-go-math-rand.md.
//
// This generator is splitmix64. It is seeded explicitly, so the suite is
// deterministic and a failure is reproducible from the seed printed by vitest.

import { asUint64 } from "./bits.ts";

const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

/** Rand is a deterministic source of uint64 values, standing in for `*rand.Rand`. */
export class Rand {
	#state: bigint;

	constructor(seed: bigint) {
		this.#state = asUint64(seed);
	}

	/** uint64 returns a pseudo-random 64-bit value, standing in for `rand.Uint64`. */
	uint64(): bigint {
		this.#state = asUint64(this.#state + GOLDEN_GAMMA);
		let z = this.#state;
		z = asUint64((z ^ (z >> 30n)) * MIX1);
		z = asUint64((z ^ (z >> 27n)) * MIX2);
		return z ^ (z >> 31n);
	}

	/**
	 * int63n returns a pseudo-random value in [0, n), standing in for
	 * `rand.Int63n`. It throws for n <= 0, as Go's version panics.
	 *
	 * Unlike Go's, this does not reject values to remove modulo bias; the bias is
	 * ~2^-64 for the small bounds the tests use and no assertion depends on the
	 * distribution.
	 */
	int63n(n: bigint): bigint {
		if (n <= 0n) {
			throw new Error("invalid argument to int63n");
		}
		return (this.uint64() >> 1n) % n;
	}
}

/** newRand returns a Rand seeded with the given value, standing in for `rand.New(rand.NewSource(seed))`. */
export function newRand(seed: bigint): Rand {
	return new Rand(seed);
}
