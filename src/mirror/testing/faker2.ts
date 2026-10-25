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

// A test-only, in-memory stand-in for a Workers R2 binding, with R2's conditional-write
// semantics: a put whose onlyIf does not hold resolves to null and stores nothing. The real
// binding is exercised by r2_workers_test.ts; this one lets the Node suites interleave
// writers deterministically. Not part of the published build.

import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2PutOptionsLike } from "../r2.ts";

/** StoredR2Object is an object the fake holds, with the metadata it was written with. */
export interface StoredR2Object {
	readonly data: Uint8Array;
	readonly etag: string;
	readonly contentType: string | undefined;
	readonly cacheControl: string | undefined;
}

/** FakeR2 is an in-memory R2 bucket. */
export class FakeR2 implements R2BucketLike {
	readonly objects = new Map<string, StoredR2Object>();
	/** puts records every put the fake was asked for, written or not. */
	readonly puts: { key: string; onlyIf: R2PutOptionsLike["onlyIf"]; written: boolean }[] = [];
	/**
	 * beforePut, if set, runs before each put is decided: the hook through which a test plays
	 * another writer that acts between a sink's read and its write.
	 */
	beforePut: ((key: string) => void) | undefined;
	#next = 0;

	async get(key: string): Promise<R2ObjectBodyLike | null> {
		const o = this.objects.get(key);
		if (o === undefined) {
			return null;
		}
		const data = o.data.slice();
		return { etag: o.etag, size: data.length, arrayBuffer: async () => data.buffer };
	}

	async put(key: string, value: Uint8Array, options: R2PutOptionsLike = {}): Promise<R2ObjectLike | null> {
		this.beforePut?.(key);
		const current = this.objects.get(key);
		const { etagMatches, etagDoesNotMatch } = options.onlyIf ?? {};
		const holds =
			(etagMatches === undefined || current?.etag === etagMatches) &&
			(etagDoesNotMatch === undefined ||
				(etagDoesNotMatch === "*" ? current === undefined : current?.etag !== etagDoesNotMatch));
		this.puts.push({ key, onlyIf: options.onlyIf, written: holds });
		if (!holds) {
			return null;
		}
		return this.store(key, value, options.httpMetadata);
	}

	/** store writes key unconditionally, as another writer would. */
	store(key: string, value: Uint8Array, httpMetadata: R2PutOptionsLike["httpMetadata"] = {}): R2ObjectLike {
		const o: StoredR2Object = {
			data: value.slice(),
			etag: `etag-${++this.#next}`,
			contentType: httpMetadata.contentType,
			cacheControl: httpMetadata.cacheControl,
		};
		this.objects.set(key, o);
		return { etag: o.etag, size: o.data.length };
	}
}
