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

// This file has no upstream counterpart. It recognises the errors SQLite engines report
// when another connection holds a lock a statement needs. See
// docs/decisions/0210-sqlite-locking-fails-closed.md.

// SQLITE_BUSY and SQLITE_LOCKED, the primary result codes for a lock another connection
// holds. Extended codes (SQLITE_BUSY_SNAPSHOT, SQLITE_LOCKED_SHAREDCACHE, ...) carry
// them in their low byte.
const sqliteBusy = 5;
const sqliteLocked = 6;

// The messages SQLite's sqlite3_errstr gives the two codes, which engines that report no
// code of their own (node:sqlite's message, D1, rqlite) pass on.
const busyMessage = /\bSQLITE_(BUSY|LOCKED)\b|\bdatabase (table )?is locked\b/;

/**
 * isBusy reports whether err, or an error in its cause chain, says that the statement
 * could not take a lock another connection holds: SQLite's SQLITE_BUSY or SQLITE_LOCKED,
 * however the engine reports them. A statement or batch that fails that way has not taken
 * effect, so it may be run again.
 *
 * Engines report the code as a string (`code`, "SQLITE_BUSY" in libSQL, better-sqlite3
 * and bun:sqlite), as a number (`errcode` in node:sqlite, `rawCode` in libSQL,
 * `resultCode` in sqlite-wasm), or only in the message. `errno` is left alone: elsewhere
 * it is an operating-system error number, and 5 and 6 are EIO and ENXIO there.
 */
export function isBusy(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 16; depth++) {
		if (typeof e === "object") {
			const fields = e as Record<string, unknown>;
			if (typeof fields.code === "string" && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(fields.code)) {
				return true;
			}
			for (const key of ["errcode", "rawCode", "resultCode"]) {
				const code = fields[key];
				if (typeof code === "number" && Number.isInteger(code) && [sqliteBusy, sqliteLocked].includes(code & 0xff)) {
					return true;
				}
			}
		}
		if (busyMessage.test(e instanceof Error ? e.message : String(e))) {
			return true;
		}
		e = e instanceof Error ? e.cause : undefined;
	}
	return false;
}
