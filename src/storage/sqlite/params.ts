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
// unchanged on every engine. See docs/decisions/0151-sqlite-schema-and-chunking.md.

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
 */
export const textParam = `CAST(${blobParam} AS TEXT)`;
