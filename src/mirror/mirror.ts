// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/cmd/experimental/mirror/internal/mirror.go @ 4a6d9f9
//
// Port note: upstream keeps this package under cmd/experimental/mirror/internal, private to
// its POSIX command-line tool. Here it is the library behind `webtessera/mirror`, so it lives
// at src/mirror/ instead of the mirrored path. `log.Printf` progress logging is dropped, as
// klog is everywhere else (docs/decisions/0051-storage-internal-drops-otel-and-klog.md);
// `progress()` remains for callers that want to report it. `retry.Do` from
// github.com/avast/retry-go is reproduced by ./retry.ts. See
// docs/decisions/0173-mirror-port.md.

// Package mirror provides support for the infrastructure-specific mirror tools.

import { range, TileHeight, TileWidth } from "../api/layout/index.ts";
import { asUint64 } from "../internal/gostd/bits.ts";
import { ErrNotExist, errorIs, throwIfAborted } from "../internal/gostd/errors.ts";
import { ErrGroup } from "../internal/gostd/sync.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { retry } from "./retry.ts";

const tileWidth64 = BigInt(TileWidth);
const tileHeight64 = BigInt(TileHeight);

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Target describes a type which can store log static resources. */
export interface Target {
	readCheckpoint(signal?: AbortSignal): Promise<Uint8Array>;
	writeCheckpoint(data: Uint8Array, signal?: AbortSignal): Promise<void>;
	writeTile(l: bigint, i: bigint, p: number, data: Uint8Array, signal?: AbortSignal): Promise<void>;
	writeEntryBundle(i: bigint, p: number, data: Uint8Array, signal?: AbortSignal): Promise<void>;
}

/**
 * Source describes a type which can fetch static resources from a source log, like
 * the .*Fetcher implementations in the client package.
 *
 * Port note: every LogReader satisfies it too, so a log held by this process can be mirrored
 * without going through HTTP.
 */
export interface Source {
	readCheckpoint(signal?: AbortSignal): Promise<Uint8Array>;
	readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;
	readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * MirrorProgress is what Mirror.progress returns.
 *
 * Port note: Go returns the two values positionally. See
 * docs/decisions/0031-multi-value-returns.md.
 */
export interface MirrorProgress {
	/** totalResources is the number of resources the current run has to copy. */
	readonly totalResources: bigint;
	/** resourcesFetched is the number of those copied so far. */
	readonly resourcesFetched: bigint;
}

/**
 * Mirror is a struct which knows how to use the Src and Store functions to copy a tlog-tiles compliant
 * log from one location to another.
 *
 * The checkpoint will only be stored once all static resources have been successfully copied.
 * Errors fetching or storing operations will cause the operation to be retried a few times before eventually giving up.
 *
 * Note that this function _only copies the data_; no self-consistency or correctness checking of
 * the copied tiles/entries/checkpoint is undertaken.
 */
export class Mirror {
	numWorkers: number;
	source: Source;
	target: Target;

	#totalResources = 0n;
	#resourcesFetched = 0n;

	/**
	 * Port note: stands in for Go's `&mirror.Mirror{NumWorkers: ..., Source: ..., Target: ...}`
	 * composite literal. numWorkers defaults to 30, the default of upstream's
	 * `--num_workers` flag; Go's zero value would divide by zero in Run.
	 */
	constructor(init: { numWorkers?: number; source: Source; target: Target }) {
		this.numWorkers = init.numWorkers ?? 30;
		this.source = init.source;
		this.target = init.target;
	}

	/**
	 * run performs the copy operation.
	 *
	 * This is a long-lived operation, returning only once ctx becomes Done, the copy is completed,
	 * or an error occurs during the operation.
	 */
	async run(signal?: AbortSignal): Promise<void> {
		if (!Number.isInteger(this.numWorkers) || this.numWorkers < 1) {
			throw new Error(`numWorkers must be a positive integer, got ${this.numWorkers}`);
		}
		let sourceCP: Uint8Array;
		let sourceSize: bigint;
		try {
			({ cp: sourceCP, size: sourceSize } = await fetchAndParseCP((s) => this.source.readCheckpoint(s), signal));
		} catch (err) {
			throw new Error(`failed to fetch source checkpoint size: ${errText(err)}`);
		}
		let targetSize = 0n;
		try {
			({ size: targetSize } = await fetchAndParseCP((s) => this.target.readCheckpoint(s), signal));
		} catch (err) {
			if (!errorIs(err, ErrNotExist)) {
				throw new Error(`failed to read checkpoint in target: ${errText(err)}`);
			}
		}

		// Port note: Go's uint64 subtraction wraps when the target is larger than the source;
		// asUint64 keeps that, so such a target gets no work and the source checkpoint.
		const delta = asUint64(sourceSize - targetSize);
		let stride = delta / BigInt(this.numWorkers);
		const r = stride % tileWidth64;
		if (r !== 0n) {
			stride += tileWidth64 - r;
		}
		// Port note: upstream leaves stride at zero when delta < NumWorkers, and jobs() then
		// yields zero-length jobs forever, so a mirror that is fewer entries behind its source
		// than it has workers never finishes. A stride of one tile is what the rounding above
		// produces for every other small delta. See docs/decisions/0173-mirror-port.md.
		if (stride === 0n) {
			stride = tileWidth64;
		}

		if (delta === 0n) {
			return;
		}

		this.#totalResources = calcNumResources(sourceSize, targetSize, stride);
		this.#resourcesFetched = 0n;

		// Port note: Go feeds jobs to the workers through a channel, from a producer goroutine
		// that stops when ctx is Done. The workers share one generator instead, and check the
		// signal before taking each job; see docs/decisions/0077-copier-work-distribution-is-a-shared-generator.md.
		const work = jobs(sourceSize, targetSize, stride);

		// Port note: a plain errgroup.Group, not errgroup.WithContext: as upstream, one
		// worker's failure does not stop the others, and Wait reports the first error.
		const g = new ErrGroup();
		for (let i = 0; i < this.numWorkers; i++) {
			g.go(async () => {
				for (;;) {
					throwIfAborted(signal);
					const { done, value: j } = work.next();
					if (done) {
						return;
					}
					for (const ri of range(j.from, j.N, sourceSize >> (j.level * tileHeight64))) {
						await retry(this.#copyTile(j.level, ri.index, ri.partial, signal), retryOptions(signal));

						if (j.level === 0n) {
							await retry(this.#copyBundle(ri.index, ri.partial, signal), retryOptions(signal));
						}
					}
				}
			});
		}
		try {
			await g.wait();
		} catch (err) {
			throw new Error(`failed to migrate static resources: ${errText(err)}`);
		}
		return this.target.writeCheckpoint(sourceCP, signal);
	}

	/**
	 * progress returns the total number of resources present in the source log, and the number of resources
	 * successfully copied to the destination so far.
	 */
	progress(): MirrorProgress {
		return { totalResources: this.#totalResources, resourcesFetched: this.#resourcesFetched };
	}

	/** copyTile reads a tile from the source log and stores it into the same location in the destination log. */
	#copyTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): () => Promise<void> {
		return async () => {
			const d = await this.source.readTile(l, i, p, signal);
			await this.target.writeTile(l, i, p, d, signal);
			this.#resourcesFetched++;
		};
	}

	/** copyBundle reads an entry bundle from the source log and stores it into the same location in the destination log. */
	#copyBundle(i: bigint, p: number, signal?: AbortSignal): () => Promise<void> {
		return async () => {
			const d = await this.source.readEntryBundle(i, p, signal);
			await this.target.writeEntryBundle(i, p, d, signal);
			this.#resourcesFetched++;
		};
	}
}

/**
 * retryOptions are retry-go's defaults, which is what upstream's `retry.Do` calls use.
 *
 * Port note: upstream does not hand ctx to retry.Do, so once ctx is cancelled each failing
 * attempt still waits out its backoff, about 50 seconds across ten attempts. The signal
 * aborts those waits here; the run fails either way.
 */
function retryOptions(signal?: AbortSignal): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

/** job is a range of entries, at one level of the tree, for one worker to copy. */
interface job {
	readonly level: bigint;
	readonly from: bigint;
	readonly N: bigint;
}

/**
 * jobString renders a job for diagnostics.
 *
 * Port note: Go's `(job) String()` method; upstream only uses it in log lines, which are
 * dropped (see the header), and it is kept for parity and for tests.
 */
export function jobString(j: job): string {
	return `Level: ${j.level}, Range: [${j.from}, ${j.from + j.N})`;
}

/** @internal Exported for mirror_test.ts. */
export function* jobs(srcSize: bigint, targetSize: bigint, stride: bigint): Generator<job> {
	for (
		let start = targetSize, ext = srcSize, l = 0n;
		ext > 0n;
		start = start >> tileHeight64, ext = ext >> tileHeight64, l = l + 1n
	) {
		for (let from = start; from < ext; ) {
			let N = stride;
			// If we're starting from a partial tile, then just fetch the remainder first so we're tile-aligned from then on.
			const r = from % tileWidth64;
			if (r !== 0n) {
				N = tileWidth64 - r;
			}
			N = N < ext - from ? N : ext - from;
			yield { level: l, from, N };
			from = from + N;
		}
	}
}

/**
 * calcNumResources calculates the number of new static resources which need to be mirrored, given the
 * size of the source and target.
 *
 * @internal Exported for mirror_test.ts.
 */
export function calcNumResources(srcSize: bigint, targetSize: bigint, stride: bigint): bigint {
	let leafBundles = 0n;
	let tiles = 0n;

	for (const j of jobs(srcSize, targetSize, stride)) {
		const nTiles = (j.N + tileWidth64 - 1n) / tileWidth64;
		tiles += nTiles;
		if (j.level === 0n) {
			leafBundles += nTiles;
		}
	}

	return leafBundles + tiles;
}

async function fetchAndParseCP(
	f: (signal?: AbortSignal) => Promise<Uint8Array>,
	signal?: AbortSignal,
): Promise<{ cp: Uint8Array; size: bigint }> {
	const cp = await f(signal);
	const { size } = checkpointUnsafe(cp);
	return { cp, size };
}
