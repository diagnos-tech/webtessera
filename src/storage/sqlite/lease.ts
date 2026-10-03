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

// This file has no upstream counterpart. It implements ObjectStore.lock for SQLite
// databases that several processes share, as leases kept in the database itself, and the
// fencing that keeps a holder whose lease has lapsed from writing. See
// docs/decisions/0152-sqlite-locking-local-and-lease.md.

import { toHex, toUTF8 } from "../../internal/gostd/bytes.ts";
import { SentinelError } from "../../internal/gostd/errors.ts";
import { sleep } from "../../internal/gostd/sync.ts";
import type { SqlDatabase, SqlStatement } from "./database.ts";
import { textParam } from "./params.ts";
import { leaseLostConstraint, type Tables } from "./schema.ts";

/**
 * ErrLeaseLost is the cause of every error a lease-mode SQLite ObjectStore reports for a
 * write it refused because a lock lease the store held has lapsed and another holder may
 * have taken it over. Check for it with `errorIs(err, ErrLeaseLost)`.
 *
 * It means the store stalled for longer than the lease's time to live (a paused process,
 * a lost network) while holding a lock. Nothing it wrote under the lapsed lease after
 * that point reached the database; the operation that failed may be retried.
 */
export const ErrLeaseLost = new SentinelError("sqlite: lock lease lost");

/** LeaseTimings are a lease-mode store's resolved timings, all in milliseconds. */
export interface LeaseTimings {
	/** ttlMs is how long a lease lasts from its last renewal. */
	readonly ttlMs: number;
	/** renewIntervalMs is how often a held lease is renewed. */
	readonly renewIntervalMs: number;
	/** maxPollIntervalMs bounds the backoff between attempts to take a held lock. */
	readonly maxPollIntervalMs: number;
}

/**
 * LeaseClock is where a LeaseLocks reads the time: the database's clock, or a function
 * returning milliseconds since the Unix epoch.
 */
export type LeaseClock = "database" | (() => number);

// databaseNow is SQLite's current time in whole milliseconds since the Unix epoch.
// julianday('now') is understood by every SQLite, unlike unixepoch('subsec') (3.42), and
// 'now' has millisecond resolution; 2440587.5 is the Julian day of the Unix epoch.
const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// minPollIntervalMs is the first backoff after a failed attempt to take a lock. It
// doubles on each further failure, up to LeaseTimings.maxPollIntervalMs.
const minPollIntervalMs = 5;

/** heldLease is a lease this store holds. */
interface heldLease {
	readonly name: Uint8Array;
	/** token identifies this one acquisition: it is random, and never reused. */
	readonly token: string;
	/** lost is set once a renewal finds that another holder has taken the lock over. */
	lost: boolean;
	/** inflight counts the batches fenced on this lease that have not yet settled. */
	inflight: number;
	/** drained, while set, is called once inflight falls to zero. */
	drained: (() => void) | undefined;
}

/**
 * Fence is the fencing statement for one batch, and the lease bookkeeping that goes with
 * it: done must be called once the batch has settled, whether or not it succeeded.
 */
export interface Fence {
	readonly statement: SqlStatement;
	done(): void;
}

/**
 * LeaseLocks grants a store's locks as leases recorded in the locks table.
 *
 * A lease is a row naming its holder, by a random token drawn for each acquisition, and
 * the time it expires. Taking a lock replaces an expired row, or inserts one where there
 * is none, and then reads the row back to see whose it is, all in one batch, so that two
 * contenders can never both win. While fn runs, the holder renews the lease every
 * renewIntervalMs; afterwards it deletes the row, and a holder that dies instead leaves
 * it to expire.
 *
 * Times come from the database's own clock where the adapter vouches for it (see
 * SqlDatabase.leaseClock), so that every contender measures expiry on one clock, and
 * otherwise from the store's clock. Either way, whether a lease has expired only decides
 * when another contender may take the lock over: mutual exclusion of writes rests on
 * fencing (see fence), which compares tokens, not times. A wrong clock therefore costs
 * liveness at worst: a contender whose clock runs ahead of the holder's by more than
 * ttlMs - renewIntervalMs can take over a live lease, after which the old holder's
 * writes fail with ErrLeaseLost rather than corrupt the log.
 */
export class LeaseLocks {
	readonly #db: SqlDatabase;
	readonly #t: Tables;
	readonly #timings: LeaseTimings;
	readonly #clock: LeaseClock;
	readonly #held = new Set<heldLease>();

	constructor(db: SqlDatabase, t: Tables, timings: LeaseTimings, clock: LeaseClock) {
		this.#db = db;
		this.#t = t;
		this.#timings = timings;
		this.#clock = clock;
	}

	/**
	 * run runs fn while holding the lease on the lock called name, and resolves to its
	 * result once the lease has been released. If signal aborts while waiting for the
	 * lease, run rejects with the signal's reason and fn is never called.
	 */
	async run<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const lease = await this.#acquire(toUTF8(name), signal);
		this.#held.add(lease);
		const stopRenewing = this.#renewWhileHeld(lease);
		try {
			return await fn();
		} finally {
			stopRenewing();
			// No batch fences on the lease from here on. Those already in flight may still
			// be on their way to the database, where releasing the lease first would fail
			// them, so the release waits for them.
			this.#held.delete(lease);
			if (lease.inflight > 0) {
				await new Promise<void>((resolve) => {
					lease.drained = resolve;
				});
			}
			await this.#release(lease);
		}
	}

	/**
	 * fence returns the statement that, run first in a batch, fails the whole batch with
	 * a NOT NULL constraint error unless every lease this store holds is still held, or
	 * undefined if it holds none. Inside the batch's transaction no other contender can
	 * take a lease over, so the check holds for every statement after it. NOT NULL, unlike
	 * CHECK, is enforced whatever pragmas the connection has set.
	 *
	 * Every write is fenced on every lease the store holds, not only the one its caller
	 * holds: JavaScript cannot tell which lock an asynchronous caller is running under.
	 * Losing any lease means the store has stalled, and refusing all its writes until
	 * those locks are released is the conservative response.
	 *
	 * Each lease the fence names stays unreleased until the fence's done is called, so
	 * that a lease released by its own holder while the batch is in flight cannot fail the
	 * batch. It throws an error caused by ErrLeaseLost, without a round trip, if a renewal
	 * has already found a lease lost.
	 */
	fence(): Fence | undefined {
		if (this.#held.size === 0) {
			return undefined;
		}
		const leases = [...this.#held];
		if (leases.some((l) => l.lost)) {
			throw leaseLostError();
		}
		for (const l of leases) {
			l.inflight++;
		}
		let settled = false;
		return {
			statement: {
				sql:
					`INSERT INTO ${this.#t.fence} (${leaseLostConstraint}) SELECT NULL WHERE ` +
					`(SELECT count(*) FROM ${this.#t.locks} WHERE holder IN (${leases.map(() => "?").join(", ")})) < ?`,
				params: [...leases.map((l) => l.token), leases.length],
			},
			done: () => {
				if (settled) {
					return;
				}
				settled = true;
				for (const l of leases) {
					if (--l.inflight === 0) {
						l.drained?.();
					}
				}
			},
		};
	}

	/** acquire takes the lease on the lock called name, polling with backoff while another holder has it. */
	async #acquire(name: Uint8Array, signal: AbortSignal | undefined): Promise<heldLease> {
		const locks = this.#t.locks;
		let backoff = minPollIntervalMs;
		for (;;) {
			signal?.throwIfAborted();
			const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
			const now = this.#now();
			const results = await this.#db.batch([
				{
					sql: `DELETE FROM ${locks} WHERE name = ${textParam} AND expires <= ${now.sql}`,
					params: [name, ...now.params],
				},
				{
					sql: `INSERT OR IGNORE INTO ${locks} (name, holder, expires) VALUES (${textParam}, ?, ${now.sql} + ?)`,
					params: [name, token, ...now.params, this.#timings.ttlMs],
				},
				{ sql: `SELECT holder FROM ${locks} WHERE name = ${textParam}`, params: [name] },
			]);
			if (results[2]?.[0]?.holder === token) {
				const lease: heldLease = { name, token, lost: false, inflight: 0, drained: undefined };
				if (signal?.aborted) {
					// The wait was abandoned while the winning attempt was in flight.
					await this.#release(lease);
					throw signal.reason;
				}
				return lease;
			}
			// Full jitter keeps contenders that collided from retrying in lockstep.
			await sleep(backoff * (0.5 + Math.random() / 2), signal);
			backoff = Math.min(backoff * 2, this.#timings.maxPollIntervalMs);
		}
	}

	/**
	 * renewWhileHeld extends lease every renewIntervalMs until the returned function is
	 * called. A renewal that finds the lease taken over marks it lost and stops; one that
	 * fails to reach the database is retried at the next interval, since the lease may
	 * well still be valid, and fencing catches the case where it is not.
	 */
	#renewWhileHeld(lease: heldLease): () => void {
		const locks = this.#t.locks;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const renew = async (): Promise<void> => {
			try {
				const now = this.#now();
				const results = await this.#db.batch([
					{
						sql: `UPDATE ${locks} SET expires = ${now.sql} + ? WHERE name = ${textParam} AND holder = ?`,
						params: [...now.params, this.#timings.ttlMs, lease.name, lease.token],
					},
					{ sql: `SELECT holder FROM ${locks} WHERE name = ${textParam}`, params: [lease.name] },
				]);
				if (results[1]?.[0]?.holder !== lease.token) {
					lease.lost = true;
					return;
				}
			} catch {
				// The database could not be reached; try again at the next interval.
			}
			if (!stopped) {
				timer = setTimeout(renew, this.#timings.renewIntervalMs);
			}
		};
		timer = setTimeout(renew, this.#timings.renewIntervalMs);
		return () => {
			stopped = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		};
	}

	/** now returns the SQL expression for the current time in milliseconds, and its parameters. */
	#now(): { readonly sql: string; readonly params: readonly number[] } {
		if (this.#clock === "database") {
			return { sql: databaseNow, params: [] };
		}
		const now = Math.floor(this.#clock());
		if (!Number.isSafeInteger(now)) {
			throw new Error(`sqlite: the clock returned ${now}, not a time in milliseconds`);
		}
		return { sql: "?", params: [now] };
	}

	/**
	 * release deletes lease's row if it is still lease's. A release that fails is not
	 * reported: the lease then expires ttlMs after its last renewal, and reporting it
	 * would turn a completed critical section into a failure.
	 */
	async #release(lease: heldLease): Promise<void> {
		try {
			await this.#db.query({
				sql: `DELETE FROM ${this.#t.locks} WHERE name = ${textParam} AND holder = ?`,
				params: [lease.name, lease.token],
			});
		} catch {
			// Left to expire.
		}
	}
}

/** isLeaseLost reports whether err, or an error in its cause chain, is a fenced-out batch's constraint failure. */
export function isLeaseLost(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 16; depth++) {
		if (e === ErrLeaseLost || String(e instanceof Error ? e.message : e).includes(leaseLostConstraint)) {
			return true;
		}
		e = e instanceof Error ? e.cause : undefined;
	}
	return false;
}

/** leaseLostError returns the error a fenced-out write reports. */
export function leaseLostError(): Error {
	return new Error("a lock lease this store held lapsed, and another holder may have taken the lock over", {
		cause: ErrLeaseLost,
	});
}
