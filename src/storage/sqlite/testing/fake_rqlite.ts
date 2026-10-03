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

// A stand-in for an rqlite node's `/db/request` endpoint, over a node:sqlite connection,
// that reproduces the parts of rqlite's wire format and behaviour fromRqlite depends on:
// `X'…'` strings and byte arrays bound as BLOBs, BLOBs returned as base64 with their
// types, failed statements reported in the results with HTTP 200, a transaction stopped
// and rolled back at its first failure. It refuses statements that real rqlite would
// rewrite before running (time and random functions, EXPLAIN), which the store must never
// send. The services suite runs the same code against a real rqlite. Test-only, Node-only.

import type { DatabaseSync } from "node:sqlite";
import { fromHex, toBase64 } from "../../../internal/gostd/bytes.ts";

// rewritten matches what makes rqlite rewrite a statement before running it.
const rewritten = /time\(|date\(|julianday\(|unixepoch\(|random\(|randomblob\(|explain /i;

/** FakeRqlite is the fake node: its fetch function and what it has seen. */
export interface FakeRqlite {
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
	/** requests records each request's URL and headers. */
	readonly requests: { url: string; headers: Headers }[];
	/** failNext, if set, makes the next request fail with this HTTP status. */
	failNext: number | undefined;
}

/** newFakeRqlite returns a fake rqlite node keeping its data in db. */
export function newFakeRqlite(db: DatabaseSync): FakeRqlite {
	const fake: FakeRqlite = {
		requests: [],
		failNext: undefined,
		fetch: async (input, init) => {
			const url = new URL(input);
			fake.requests.push({ url: input, headers: new Headers(init?.headers) });
			if (fake.failNext !== undefined) {
				const status = fake.failNext;
				fake.failNext = undefined;
				return new Response("leader not found\n", { status });
			}
			if (url.pathname !== "/db/request" || init?.method !== "POST") {
				return new Response("not found\n", { status: 404 });
			}
			const statements = JSON.parse(String(init.body)) as unknown[][];
			const transaction = url.searchParams.has("transaction");
			const results: unknown[] = [];
			if (transaction) {
				db.exec("BEGIN IMMEDIATE");
			}
			let failed = false;
			for (const [sql, ...params] of statements) {
				try {
					if (rewritten.test(String(sql))) {
						throw new Error(`fake rqlite: ${String(sql)} would be rewritten`);
					}
					results.push(run(db, String(sql), params.map(decodeParam)));
				} catch (err) {
					results.push({ error: err instanceof Error ? err.message : String(err) });
					if (transaction) {
						failed = true;
						break;
					}
				}
			}
			if (transaction) {
				db.exec(failed ? "ROLLBACK" : "COMMIT");
			}
			return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
		},
	};
	return fake;
}

function run(db: DatabaseSync, sql: string, params: unknown[]): unknown {
	const stmt = db.prepare(sql);
	if (!/^\s*SELECT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
		const r = stmt.run(...params);
		return { last_insert_id: Number(r.lastInsertRowid), rows_affected: Number(r.changes) };
	}
	const rows = stmt.all(...params);
	const columns = Object.keys(rows[0] ?? {});
	if (rows.length === 0) {
		return { columns, types: [] };
	}
	const types = columns.map((c) => {
		const v = rows.map((r) => r[c]).find((x) => x !== null);
		return v instanceof Uint8Array ? "blob" : typeof v === "number" ? "integer" : typeof v === "string" ? "text" : "";
	});
	return {
		columns,
		types,
		values: rows.map((r) => columns.map((c) => (r[c] instanceof Uint8Array ? toBase64(r[c] as Uint8Array) : r[c]))),
	};
}

/** decodeParam binds p as rqlite does: an X'…' string or an array of byte values is a BLOB. */
function decodeParam(p: unknown): unknown {
	if (typeof p === "string") {
		const m = /^\s*[xX]'([0-9a-fA-F]*)'\s*$/.exec(p);
		if (m?.[1] !== undefined && m[1].length % 2 === 0) {
			return fromHex(m[1]);
		}
		return p;
	}
	if (Array.isArray(p)) {
		return Uint8Array.from(p as number[]);
	}
	return p;
}
