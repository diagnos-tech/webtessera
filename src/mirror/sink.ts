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

// This file has no upstream counterpart. Upstream's only Target is the POSIX tool's
// `posixTarget` (cmd/experimental/mirror/posix/main.go), which writes each resource to the
// file at its tlog-tiles path. SinkTarget is the same mapping onto any key/value store with a
// `put`. See docs/decisions/0175-mirror-sinks.md.

import { CheckpointPath, entriesPath, tilePath } from "../api/layout/index.ts";
import { partialOrFullResource } from "../internal/fetcher/fallback.ts";
import { ErrNotExist, wrapError } from "../internal/gostd/errors.ts";
import { quote } from "../internal/gostd/strconv.ts";
import type { Source, Target } from "./mirror.ts";
import { S3Sink } from "./s3.ts";

/**
 * SinkObject is what a sink's `get` may resolve to: the bytes themselves, or a body to read
 * them from.
 */
export type SinkObject = Uint8Array | ArrayBuffer | { arrayBuffer(): Promise<ArrayBuffer> };

/**
 * Sink is the minimal storage a log can be mirrored into: something that stores bytes under
 * slash-separated keys. Many existing objects satisfy it as they are:
 *
 *   - every webtessera `ObjectStore` (memory, IndexedDB, SQLite, Durable Object storage),
 *     so a mirror can land in exactly the storage a log is served from;
 *   - an S3-compatible bucket through {@link newS3Sink} (AWS S3, Cloudflare R2, Google Cloud
 *     Storage, Backblaze B2, MinIO, Ceph, ...);
 *   - object-storage bindings whose `put(key, bytes)` and `get(key)` have these shapes,
 *     such as a Cloudflare Workers R2 bucket binding, or a thin wrapper around any other
 *     SDK's.
 *
 * `get` is optional. With it, a mirror resumes from the checkpoint it last wrote; without
 * it, every run copies the whole log again, which is correct (resources are immutable and
 * `put` overwrites them with identical bytes) but slower.
 *
 * `put` must replace what is stored, as every ObjectStore and R2 binding does. A sink that
 * instead keeps an object already stored under the key must make sure that it holds the
 * same bytes, as newS3Sink's conditional writes do, or fail: a mirror interrupted while
 * copying from a source that then served a different history would otherwise publish its
 * new checkpoint over part of the old tree.
 */
export interface Sink {
	/** put stores data under key, replacing whatever was there. */
	put(key: string, data: Uint8Array): Promise<unknown>;
	/** get returns what is stored under key, or null or undefined if nothing is. */
	get?(key: string): Promise<SinkObject | null | undefined>;
}

/** SinkTargetOptions configures newSinkTarget. */
export interface SinkTargetOptions {
	/**
	 * prefix is prepended to every key, to keep several logs in one bucket or store:
	 * `logs/a/` puts the checkpoint at `logs/a/checkpoint`. Defaults to "".
	 *
	 * A sink from newS3Sink takes the prefix itself, so that it still sees each key as a
	 * tlog-tiles path and stores it with the matching metadata and conditional write. A
	 * sink of your own that derives anything from the key should be given the prefix the
	 * same way, rather than here.
	 */
	readonly prefix?: string;
}

/**
 * newSinkTarget returns the mirror Target that writes each resource to the sink under its
 * tlog-tiles path (`checkpoint`, `tile/0/x001/234`, `tile/entries/000.p/7`, ...), so that the
 * sink ends up holding a static tlog-tiles log that any file server, CDN or public bucket
 * can serve as it is.
 *
 * The result is also a Source, and an `fsck` Fetcher, reading the mirrored log back when
 * the sink has a `get`: the way to check a mirror, since mirroring itself verifies nothing.
 */
export function newSinkTarget(sink: Sink, options: SinkTargetOptions = {}): SinkTarget {
	const prefix = options.prefix ?? "";
	if (sink instanceof S3Sink && prefix !== "") {
		return new SinkTarget(sink._withPrefix(prefix), "");
	}
	return new SinkTarget(sink, prefix);
}

/** SinkTarget is a mirror Target, and a Source, over a Sink. Construct it with {@link newSinkTarget}. */
export class SinkTarget implements Target, Source {
	readonly #sink: Sink;
	readonly #prefix: string;

	/** @internal Construct via {@link newSinkTarget}. */
	constructor(sink: Sink, prefix: string) {
		this.#sink = sink;
		this.#prefix = prefix;
	}

	/**
	 * readCheckpoint reads the mirrored checkpoint. It throws an error caused by ErrNotExist
	 * when there is none, or when the sink has no `get`, which makes the mirror start from
	 * the beginning.
	 */
	readCheckpoint(): Promise<Uint8Array> {
		return this.#get(CheckpointPath);
	}

	readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (pp) => this.#get(tilePath(l, i, pp)), signal);
	}

	readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (pp) => this.#get(entriesPath(i, pp)), signal);
	}

	async writeCheckpoint(data: Uint8Array): Promise<void> {
		await this.#sink.put(this.#prefix + CheckpointPath, data);
	}

	async writeTile(l: bigint, i: bigint, p: number, data: Uint8Array): Promise<void> {
		await this.#sink.put(this.#prefix + tilePath(l, i, p), data);
	}

	async writeEntryBundle(i: bigint, p: number, data: Uint8Array): Promise<void> {
		await this.#sink.put(this.#prefix + entriesPath(i, p), data);
	}

	async #get(path: string): Promise<Uint8Array> {
		const key = this.#prefix + path;
		const o = this.#sink.get === undefined ? undefined : await this.#sink.get(key);
		if (o === undefined || o === null) {
			throw wrapError(`get(${quote(key)})`, ErrNotExist);
		}
		if (o instanceof Uint8Array) {
			return o;
		}
		return new Uint8Array(o instanceof ArrayBuffer ? o : await o.arrayBuffer());
	}
}
