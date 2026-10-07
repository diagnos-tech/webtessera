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

// This file has no upstream counterpart. It is the tripwire behind a single-writer
// declaration ("local" locking chosen by the caller): a claim, recorded in the database, by
// which a second realm that starts writing the same database is noticed, and the first one
// stops writing before the two can fork the log. See
// docs/decisions/0210-sqlite-locking-fails-closed.md (its 2026-10-07 update).

import { SentinelError } from "../../internal/gostd/errors.ts";
import type { SqlDatabase, SqlStatement } from "./database.ts";
import { leaseLostConstraint, type Tables } from "./schema.ts";
import { asInteger } from "./values.ts";

/**
 * ErrWriterConflict is the cause of every error a SQLite ObjectStore opened with
 * `locking: "single-writer"` (or `"local"`) reports once another realm, usually another
 * process, has started writing the same database under the same declaration. Check for it
 * with `errorIs(err, ErrWriterConflict)`.
 *
 * The store stops writing for good at that point, so the two writers cannot fork the log;
 * nothing it wrote before the other realm took over is lost. It means the declaration was
 * wrong: give every process that can reach the database lease locking, or stop all writers
 * but one.
 */
export const ErrWriterConflict = new SentinelError("sqlite: another writer took over this single-writer database");

/** claimName is the meta row naming the realm that last claimed a single-writer database. */
const claimName = "local_writer";

// token identifies this JavaScript realm (a process, a worker thread, a page) among the
// writers of a database: 48 random bits, a safe integer the meta table's INTEGER column holds,
// drawn on first use, since workerd refuses random numbers at a Worker's global scope. Every
// store of the realm claims with it, so they never trip over each other, as they share its
// in-process locks.
let realmToken: number | undefined;

function token(): number {
	if (realmToken === undefined) {
		const [hi = 0, lo = 0] = crypto.getRandomValues(new Uint32Array(2));
		realmToken = (hi & 0xffff) * 2 ** 32 + lo;
	}
	return realmToken;
}

/**
 * WriterClaim is one store's single-writer claim on its database.
 *
 * The store claims the database the first time it takes a lock, which only a writer does:
 * it records this realm's token in the meta table, replacing whichever was there, since a
 * token left behind by a process that has exited is indistinguishable from one a live
 * process holds, and a restart must not need an operator. From then on, every critical
 * section starts by reading the token back, and every write batch is fenced on it, in the
 * same transaction, as lease writes are fenced on their leases. Once the token is another
 * realm's, the store refuses every write it is asked for, for good: the latest realm to
 * start writing wins, and every earlier one stops at its next lock or write, so their writes
 * never interleave. A store that only reads never claims.
 *
 * The check at the start of a critical section stops a stale writer before it reads the tree
 * state and signs a checkpoint over it, in all but the race where the other realm claims
 * during that critical section; the fence stops its writes even then.
 */
export class WriterClaim {
	readonly #db: SqlDatabase;
	readonly #t: Tables;
	#state: "unclaimed" | "claimed" | "lost" = "unclaimed";

	constructor(db: SqlDatabase, t: Tables) {
		this.#db = db;
		this.#t = t;
	}

	/**
	 * check runs at the start of each critical section: it claims the database the first
	 * time, and afterwards throws an error caused by ErrWriterConflict if another realm has
	 * claimed it since.
	 */
	async check(): Promise<void> {
		if (this.#state === "lost") {
			throw writerConflictError();
		}
		if (this.#state === "unclaimed") {
			await this.#db.query({
				sql: `INSERT OR REPLACE INTO ${this.#t.meta} (name, value) VALUES ('${claimName}', ?)`,
				params: [token()],
			});
			this.#state = "claimed";
			return;
		}
		const row = (
			await this.#db.query({ sql: `SELECT value FROM ${this.#t.meta} WHERE name = '${claimName}'`, params: [] })
		)[0];
		if (row === undefined || asInteger(row.value, `${this.#t.meta}.${claimName}`) !== token()) {
			this.#state = "lost";
			throw writerConflictError();
		}
	}

	/**
	 * fence returns the statement that, run first in a write batch, fails the whole batch with
	 * a NOT NULL constraint error unless the database is still claimed by this realm, or
	 * undefined before this store has claimed it. It throws, without a round trip, once the
	 * claim is known to be lost.
	 */
	fence(): SqlStatement | undefined {
		if (this.#state === "lost") {
			throw writerConflictError();
		}
		if (this.#state === "unclaimed") {
			return undefined;
		}
		return {
			sql:
				`INSERT INTO ${this.#t.fence} (${leaseLostConstraint}) SELECT NULL WHERE NOT EXISTS ` +
				`(SELECT 1 FROM ${this.#t.meta} WHERE name = '${claimName}' AND value = ?)`,
			params: [token()],
		};
	}

	/** lost records that a batch this claim fenced failed on it: another realm holds the database. */
	lost(): void {
		this.#state = "lost";
	}
}

/** writerConflictError returns the error a store whose single-writer claim was taken over reports. */
export function writerConflictError(): Error {
	// The sentinel's text leads, as `fmt.Errorf("%w: …")` would put it, so that it survives
	// the storage driver's flattening of wrapped errors into their messages.
	return new Error(
		`${ErrWriterConflict.message}: another process opened it with single-writer locking too and started ` +
			"writing it, so this store has stopped writing before the two could fork the log; use " +
			'locking: "lease" wherever more than one process can write the database',
		{ cause: ErrWriterConflict },
	);
}

/**
 * isWriterConflict reports whether err, or an error in its cause chain, is a store's report
 * that its single-writer claim was taken over: by identity, or, since the storage driver
 * flattens the errors it wraps into their messages as Go's `%v` does, by ErrWriterConflict's
 * text in a message.
 *
 * @internal For webtessera/server, which explains the error in its own terms.
 */
export function isWriterConflict(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 16; depth++) {
		if (e === ErrWriterConflict || String(e instanceof Error ? e.message : e).includes(ErrWriterConflict.message)) {
			return true;
		}
		e = e instanceof Error ? e.cause : undefined;
	}
	return false;
}
