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

// This file has no upstream counterpart. It adapts rqlite, the distributed database
// built on SQLite and Raft, to SqlDatabase through its HTTP API. See
// docs/decisions/0150-sqlite-object-store.md.

import type { FetchFn } from "../../../client/fetcher.ts";
import { fromBase64, toHex } from "../../../internal/gostd/bytes.ts";
import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "../database.ts";
import { normalizeValue } from "./normalize.ts";

/**
 * RqliteReadLevel is an rqlite read consistency level that always reads the latest
 * committed data: "linearizable" confirms the node's leadership with a quorum before
 * reading, and "strong" sends the read through the Raft log. rqlite's weaker levels are
 * not offered: a stale read of the tree state, during a leadership change, would have
 * the driver assign indices that are already taken. See
 * https://rqlite.io/docs/api/read-consistency/.
 */
export type RqliteReadLevel = "linearizable" | "strong";

/** RqliteOptions configures fromRqlite. */
export interface RqliteOptions {
	/** url is the base URL of any node of the cluster, such as "http://localhost:4001". */
	readonly url: string;
	/** fetch sends the HTTP requests. If unset, the global fetch is used. */
	readonly fetch?: FetchFn;
	/** headers are added to every request, for example an Authorization header for rqlite's basic auth. */
	readonly headers?: Readonly<Record<string, string>>;
	/** level is the read consistency level of queries. It defaults to "linearizable". */
	readonly level?: RqliteReadLevel;
}

/** rqliteResult is one statement's entry in an rqlite response. */
interface rqliteResult {
	readonly error?: string;
	readonly columns?: readonly string[];
	readonly types?: readonly string[];
	readonly values?: readonly (readonly unknown[])[] | null;
}

/**
 * fromRqlite adapts an rqlite cluster to the SqlDatabase the SQLite ObjectStore runs on:
 *
 *	const driver = await newSqliteDriver({ database: fromRqlite({ url: "http://localhost:4001" }) });
 *
 * Every statement goes through rqlite's unified `/db/request` endpoint, and a batch as one
 * transaction. Reads are linearizable by default. A write resolves once the cluster has
 * committed it to its Raft log, which a quorum of nodes has persisted, and applied it.
 * It needs rqlite 8.32 or later.
 *
 * Every client of the cluster reaches the same data, so stores default to "lease"
 * locking, timed by the store's clock rather than the database's: rqlite replicates
 * statements, not their effects, and makes a time function deterministic only by
 * rewriting it, at whichever node received the request, into a constant, which it does
 * only for statements its own SQL parser understands. A clock passed as a parameter
 * depends on neither.
 *
 * rqlite carries BLOB parameters as `X'…'` hex strings and returns BLOBs as base64, so
 * BLOBs cost about twice their size on the wire; the default maxChunkBytes keeps each
 * request well within what rqlite accepts. It binds a string parameter spelled like such
 * a hex literal as a BLOB, so such strings are refused rather than silently changed; the
 * store itself binds every string as UTF-8 bytes and never sends one.
 */
export function fromRqlite(opts: RqliteOptions): SqlDatabase {
	const base = opts.url.replace(/\/+$/, "");
	const f: FetchFn = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const level = opts.level ?? "linearizable";
	const send = async (statements: readonly SqlStatement[], transaction: boolean): Promise<SqlRow[][]> => {
		const url = `${base}/db/request?level=${level}${transaction ? "&transaction" : ""}`;
		const res = await f(url, {
			method: "POST",
			headers: { ...opts.headers, "Content-Type": "application/json" },
			body: JSON.stringify(statements.map((s) => [s.sql, ...s.params.map(encodeParam)])),
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`rqlite: ${url}: HTTP ${res.status}: ${text.trim()}`);
		}
		const body = JSON.parse(text) as { readonly results?: readonly rqliteResult[]; readonly error?: string };
		// rqlite reports a failed statement in its result rather than in the HTTP status,
		// and stops a transaction at it, rolling the transaction back.
		if (body.error !== undefined) {
			throw new Error(`rqlite: ${body.error}`);
		}
		const results = body.results ?? [];
		for (const r of results) {
			if (r.error !== undefined) {
				throw new Error(`rqlite: ${r.error}`);
			}
		}
		if (results.length !== statements.length) {
			throw new Error(`rqlite: ${results.length} results for ${statements.length} statements`);
		}
		return results.map(decodeRows);
	};
	return {
		defaultLocking: "lease",
		leaseClock: "client",
		query: async (s) => (await send([s], false))[0] ?? [],
		batch: (statements) => send(statements, true),
	};
}

// hexLiteral matches what rqlite parses a string parameter as a BLOB for: X'…' with hex
// digits between the quotes, after trimming white space.
const hexLiteral = /^\s*[xX]'[0-9a-fA-F]*'\s*$/;

/** encodeParam returns v as rqlite's JSON request format carries it. */
function encodeParam(v: SqlValue): unknown {
	if (v instanceof Uint8Array) {
		return `X'${toHex(v)}'`;
	}
	if (typeof v === "bigint") {
		if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new RangeError(`rqlite: integer parameter ${v} cannot be sent exactly as JSON`);
		}
		return Number(v);
	}
	if (typeof v === "string" && hexLiteral.test(v)) {
		throw new Error(`rqlite: string parameter ${JSON.stringify(v)} would be bound as a BLOB; bind its bytes instead`);
	}
	return v;
}

/**
 * decodeRows returns a result's rows as SqlRows. rqlite renders a BLOB as base64 text and
 * says so in the result's types, which come from the columns' declared types or, for an
 * expression, from the first row's values.
 */
function decodeRows(r: rqliteResult): SqlRow[] {
	const columns = r.columns ?? [];
	const types = r.types ?? [];
	return (r.values ?? []).map((row) => {
		const out: Record<string, SqlValue> = {};
		for (const [i, column] of columns.entries()) {
			const value = row[i];
			out[column] = types[i] === "blob" && typeof value === "string" ? fromBase64(value) : normalizeValue(value);
		}
		return out;
	});
}
