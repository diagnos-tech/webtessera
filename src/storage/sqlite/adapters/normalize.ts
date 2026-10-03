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

// This file has no upstream counterpart. It converts what the various SQLite engines
// return into the SqlValue and SqlRow types every adapter promises.

import type { SqlRow, SqlValue } from "../database.ts";

/**
 * normalizeValue returns v, a value an engine read, as a SqlValue: BLOBs, whether the
 * engine returns them as an ArrayBuffer (libSQL, Durable Objects, D1), another view, or
 * an array of byte values (older D1), become a Uint8Array, and undefined becomes null.
 */
export function normalizeValue(v: unknown): SqlValue {
	if (v === null || v === undefined) {
		return null;
	}
	if (typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array) {
		return v;
	}
	if (v instanceof ArrayBuffer) {
		return new Uint8Array(v);
	}
	if (ArrayBuffer.isView(v)) {
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	if (Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
		return Uint8Array.from(v as number[]);
	}
	throw new Error(`sqlite: the engine returned a value of unsupported type ${typeof v}`);
}

/** normalizeRow returns a row object an engine returned as a SqlRow. */
export function normalizeRow(row: unknown): SqlRow {
	const out: Record<string, SqlValue> = {};
	for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
		out[k] = normalizeValue(v);
	}
	return out;
}

/**
 * memoize returns the SqlDatabase make builds for handle, building it only the first time
 * it is asked for, so that every store over one engine handle shares one SqlDatabase and
 * with it one set of in-process locks.
 */
export function memoize<H extends object, D>(cache: WeakMap<H, D>, handle: H, make: () => D): D {
	let db = cache.get(handle);
	if (db === undefined) {
		db = make();
		cache.set(handle, db);
	}
	return db;
}
