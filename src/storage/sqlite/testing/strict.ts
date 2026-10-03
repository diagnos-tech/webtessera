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

// StrictSqlDatabase holds the SQLite ObjectStore to the production limits of the
// strictest engines it runs on, which a local engine does not enforce: a store that
// passes against node:sqlite, or against local workerd, could otherwise still fail on
// Cloudflare D1 or a production Durable Object. It also checks the SQL itself against
// what every adapter needs. Runtime-neutral and test-only.

import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "../database.ts";

/** SqlLimits are an engine's limits on statements and rows. */
export interface SqlLimits {
	/** maxValueBytes bounds a single TEXT or BLOB, bound or returned. */
	readonly maxValueBytes: number;
	/** maxRowBytes bounds a row: every value a statement binds, and every value of a returned row, together. */
	readonly maxRowBytes: number;
	/** maxSqlBytes bounds the UTF-8 length of a statement's SQL. */
	readonly maxSqlBytes: number;
	/** maxParams bounds the parameters a statement binds. */
	readonly maxParams: number;
}

/** D1Limits are Cloudflare D1's limits (https://developers.cloudflare.com/d1/platform/limits/). */
export const D1Limits: SqlLimits = {
	maxValueBytes: 2_000_000,
	maxRowBytes: 2_000_000,
	maxSqlBytes: 100_000,
	maxParams: 100,
};

/**
 * DurableObjectSqlLimits are the limits of a SQLite-backed Durable Object's SQL API
 * (https://developers.cloudflare.com/durable-objects/platform/limits/).
 */
export const DurableObjectSqlLimits: SqlLimits = D1Limits;

const enc = new TextEncoder();

// transactionControl matches the statements D1 and Durable Objects reject: transactions
// there are batches and transactionSync, so a statement must never manage its own.
const transactionControl = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function valueBytes(v: SqlValue | undefined): number {
	if (v instanceof Uint8Array) {
		return v.length;
	}
	if (typeof v === "string") {
		return enc.encode(v).length;
	}
	return 8;
}

/**
 * StrictSqlDatabase wraps a SqlDatabase, rejecting every statement the production
 * engines would reject for exceeding limits or managing transactions, or that uses
 * anything but anonymous `?` placeholders, and counting what passes through it.
 */
export class StrictSqlDatabase implements SqlDatabase {
	/** batches is the number of batches run so far. */
	batches = 0;
	/** statements is the number of statements run so far, in batches or alone. */
	statements = 0;
	/** sql is every distinct statement run so far. */
	readonly sql = new Set<string>();

	/** beforeBatch, if set, runs before each batch is passed on, so that a test can interleave something with it. */
	beforeBatch: ((statements: readonly SqlStatement[]) => Promise<void>) | undefined;

	readonly #db: SqlDatabase;
	readonly #limits: SqlLimits;
	readonly defaultLocking: SqlDatabase["defaultLocking"];

	constructor(db: SqlDatabase, limits: SqlLimits) {
		this.#db = db;
		this.#limits = limits;
		this.defaultLocking = db.defaultLocking;
	}

	async query(statement: SqlStatement): Promise<SqlRow[]> {
		this.#check(statement);
		return this.#checkRows(await this.#db.query(statement));
	}

	async batch(statements: readonly SqlStatement[]): Promise<SqlRow[][]> {
		for (const s of statements) {
			this.#check(s);
		}
		this.batches++;
		await this.beforeBatch?.(statements);
		return (await this.#db.batch(statements)).map((rows) => this.#checkRows(rows));
	}

	#check(s: SqlStatement): void {
		this.statements++;
		this.sql.add(s.sql);
		const fail = (why: string): never => {
			throw new Error(`strict database: ${why}: ${s.sql.slice(0, 120)}`);
		};
		if (transactionControl.test(s.sql)) {
			fail("transaction control is not allowed");
		}
		if (/\?[0-9]/.test(s.sql)) {
			fail("numbered parameters are not portable");
		}
		const placeholders = s.sql.split("?").length - 1;
		if (placeholders !== s.params.length) {
			fail(`${placeholders} placeholders but ${s.params.length} parameters`);
		}
		if (enc.encode(s.sql).length > this.#limits.maxSqlBytes) {
			fail("the statement is too long");
		}
		if (s.params.length > this.#limits.maxParams) {
			fail(`${s.params.length} parameters`);
		}
		let row = 0;
		for (const p of s.params) {
			const n = valueBytes(p);
			if (n > this.#limits.maxValueBytes) {
				fail(`a ${n}-byte parameter`);
			}
			row += n;
		}
		if (row > this.#limits.maxRowBytes) {
			fail(`${row} bytes of parameters`);
		}
	}

	#checkRows(rows: SqlRow[]): SqlRow[] {
		for (const r of rows) {
			let n = 0;
			for (const v of Object.values(r)) {
				if (valueBytes(v) > this.#limits.maxValueBytes) {
					throw new Error(`strict database: a ${valueBytes(v)}-byte value was read`);
				}
				n += valueBytes(v);
			}
			if (n > this.#limits.maxRowBytes) {
				throw new Error(`strict database: a ${n}-byte row was read`);
			}
		}
		return rows;
	}
}
