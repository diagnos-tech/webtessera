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

// This file has no upstream counterpart. It reads the SQL values the SQLite ObjectStore
// stores back into JavaScript, whichever representation the engine chose for them.

import type { SqlValue } from "./database.ts";

/**
 * asInteger returns v, an INTEGER read from the column what, as a number.
 *
 * Engines return integers as number or bigint, and libSQL in its "string" intMode as
 * decimal text. Every integer the store writes (a size, a millisecond timestamp, a chunk
 * number, a schema version) is far below 2^53, so a number holds it exactly; anything
 * that is not such an integer means the column holds something the store did not write.
 */
export function asInteger(v: SqlValue | undefined, what: string): number {
	let n: number | undefined;
	if (typeof v === "number") {
		n = v;
	} else if (typeof v === "bigint") {
		n = Number(v);
	} else if (typeof v === "string" && /^-?[0-9]+$/.test(v)) {
		n = Number(v);
	}
	if (n === undefined || !Number.isSafeInteger(n)) {
		throw new Error(`sqlite: ${what} holds ${describe(v)}, not an integer the store wrote`);
	}
	return n;
}

/** asBytes returns v, a BLOB read from the column what. */
export function asBytes(v: SqlValue | undefined, what: string): Uint8Array {
	if (!(v instanceof Uint8Array)) {
		throw new Error(`sqlite: ${what} holds ${describe(v)}, not a BLOB`);
	}
	return v;
}

function describe(v: SqlValue | undefined): string {
	if (v instanceof Uint8Array) {
		return `a ${v.length}-byte BLOB`;
	}
	if (typeof v === "string") {
		return `the text ${JSON.stringify(v.length > 32 ? `${v.slice(0, 32)}…` : v)}`;
	}
	return v === null || v === undefined ? "NULL" : `the ${typeof v} ${String(v)}`;
}
