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

// This file has no upstream counterpart. It holds the SQL expressions through which the
// SQLite ObjectStore binds strings and byte arrays, so that they reach the database
// unchanged on every engine, and the check that they do. See
// docs/decisions/0151-sqlite-schema-and-chunking.md.

import { toUTF8 } from "../../internal/gostd/bytes.ts";
import type { SqlDatabase } from "./database.ts";

/**
 * blobParam is the SQL expression every BLOB parameter is bound through.
 *
 * Some drivers bind a zero-length Uint8Array as NULL rather than as an empty BLOB:
 * node:sqlite does whenever the array's buffer was never allocated, as with
 * `new TextEncoder().encode("")`. COALESCE turns that NULL back into the empty BLOB it
 * stood for; no BLOB the store binds is ever meant to be NULL.
 */
export const blobParam = "COALESCE(?, X'')";

/**
 * textParam is the SQL expression every string parameter is bound through.
 *
 * Strings are bound as their UTF-8 bytes, a BLOB, and cast to TEXT in SQL rather than
 * bound as text. That makes what is stored and compared exactly those bytes on every
 * engine: drivers disagree about strings containing NUL, and rqlite binds any string
 * spelled like a hex literal (`X'00'`) as a BLOB. It also lets a range bound be a byte
 * sequence that is not valid UTF-8 at all (see prefixRange in ./keys.ts). Casting a BLOB
 * to TEXT reinterprets its bytes without validating them, and TEXT compares by memcmp
 * under the BINARY collation, so `key = CAST(... AS TEXT)` still searches the primary
 * key index.
 *
 * All of that holds only in a database whose text encoding is UTF-8: in a UTF-16 one, the
 * cast reads the bytes as UTF-16 code units, dropping an odd last byte, so distinct keys
 * collide. checkTextEncoding refuses such a database.
 */
export const textParam = `CAST(${blobParam} AS TEXT)`;

// encodingSamples are the strings checkTextEncoding round-trips through textParam: one of
// odd length, which a UTF-16 reading truncates, and one of every UTF-8 sequence length,
// with a NUL in it.
const encodingSamples = ["abc", "\u00e9\u20ac\u{1f600}\u0000x"].map(toUTF8);

/**
 * checkTextEncoding throws unless a string bound through textParam and cast back to a
 * BLOB is byte for byte the BLOB bound: that is, unless the database's text encoding is
 * UTF-8. The encoding is fixed when a database is created (`PRAGMA encoding`), so a
 * database that fails cannot be fixed in place; its contents must be copied into a UTF-8
 * one.
 *
 * The bytes are compared in SQL, where BLOBs compare with memcmp whatever the encoding,
 * and only the verdicts are read back: rqlite returns an expression's BLOB as text, which
 * does not survive the trip.
 */
export async function checkTextEncoding(db: SqlDatabase): Promise<void> {
	const rows = await db.query({
		sql: `SELECT ${encodingSamples.map((_, i) => `CAST(${textParam} AS BLOB) = ${blobParam} AS s${i}`).join(", ")}`,
		params: encodingSamples.flatMap((sample) => [sample, sample]),
	});
	for (const i of encodingSamples.keys()) {
		const same = rows[0]?.[`s${i}`];
		if (!(same === 1 || same === 1n || same === "1")) {
			throw new Error(
				"sqlite: the database does not store text as UTF-8 (see PRAGMA encoding), so distinct keys would " +
					"collide in it; keep the log in a database created with the default UTF-8 encoding",
			);
		}
	}
}
