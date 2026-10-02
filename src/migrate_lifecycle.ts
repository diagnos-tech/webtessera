// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/migrate_lifecycle.go @ 4a6d9f9
//
// Port note: `Migrate`'s background "Progress: ..." stats-printing goroutine is dropped.
// It exists solely to format and feed a string to `klog.Infof` once a second; with klog
// itself dropped (docs/decisions/0070-witness-and-migrate-drop-otel-and-klog.md), the loop would
// compute strings nobody reads, i.e. dead code, which AGENTS.md's "no invention" and "no
// console.log" rules both argue against reinstating some other way. `progress()` itself is
// still ported and directly tested below (its own doc comment says why), it is simply not
// wired into a live printer here.

import { EntryBundleWidth, entriesPath } from "./api/layout/index.ts";
import type { EntryBundleFetcherFunc } from "./client/index.ts";
import { bytesEqual, toHex } from "./internal/gostd/bytes.ts";
import { ErrGroup, sleep } from "./internal/gostd/sync.ts";
import type { MigrationWriter } from "./internal/migrate/migrate.ts";
import { type Antispam, defaultIDHasher, defaultMerkleLeafHasher, type Follower, type LogReader } from "./lifecycle.ts";
import type { Driver } from "./log.ts";
import { newCopier } from "./migrate.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** formatType renders a value's runtime type the way Go's `%T` verb does, as closely as JavaScript allows. */
function formatType(d: unknown): string {
	if (d === null) {
		return "<nil>";
	}
	if (d === undefined) {
		return "undefined";
	}
	if (typeof d === "object") {
		return d.constructor.name;
	}
	return typeof d;
}

/**
 * migrateLifecycle is the contract a storage `Driver` must satisfy to be usable as a
 * migration target.
 *
 * Port note: mirrors Go's local `type migrateLifecycle interface { MigrationWriter(...) }`
 * declared inside `NewMigrationTarget` itself -- the same local-interface-plus-type-assertion
 * idiom `append_lifecycle.go`'s `NewAppender` uses for its own `appendLifecycle`. Declared
 * at module scope here only because TypeScript has no equivalent of a function-local type
 * declaration that also participates in a type guard.
 */
interface migrateLifecycle {
	migrationWriter(
		opts: MigrationOptions,
		signal?: AbortSignal,
	): Promise<{ writer: MigrationWriter; reader: LogReader }>;
}

/** hasMigrationWriter is the type-guard form of Go's `d.(migrateLifecycle)` type assertion. */
function hasMigrationWriter(d: Driver): d is migrateLifecycle {
	return (
		typeof d === "object" && d !== null && typeof (d as { migrationWriter?: unknown }).migrationWriter === "function"
	);
}

/**
 * newMigrationTarget returns a MigrationTarget, which allows a personality to "import" a C2SP
 * tlog-tiles or static-ct compliant log into a Tessera instance.
 */
export async function newMigrationTarget(
	d: Driver,
	opts: MigrationOptions,
	signal?: AbortSignal,
): Promise<MigrationTarget> {
	if (!hasMigrationWriter(d)) {
		throw new Error(`driver ${formatType(d)} does not implement MigrationTarget lifecycle`);
	}
	let mw: MigrationWriter;
	let r: LogReader;
	try {
		({ writer: mw, reader: r } = await d.migrationWriter(opts, signal));
	} catch (err) {
		throw new Error(`failed to init MigrationTarget lifecycle: ${errText(err)}`);
	}
	return new MigrationTarget(mw, r, opts.internal.followers);
}

/**
 * newMigrationOptions constructs a MigrationOptions carrying Tessera's own default
 * tlog-tiles layout, identity hasher and Merkle leaf hasher.
 */
export function newMigrationOptions(): MigrationOptions {
	return new MigrationOptions();
}

/**
 * MigrationOptions holds migration lifecycle settings for all storage implementations.
 *
 * Port note: Go's `entriesPath`/`bundleIDHasher`/`bundleLeafHasher`/`followers` fields are
 * unexported but touched from `ct_only.go`'s `WithCTLayout` method, defined in a different
 * Go *file* of the same package. TypeScript has no file-pair visibility (ADR-0010), so
 * they are grouped under a public `internal` object the way `src/entry.ts`'s `Entry.internal`
 * is: `entriesPath` (the field) would otherwise collide with `entriesPath()` (the method
 * below, Go: `EntriesPath()`), and nesting avoids that without an `_` prefix on every field.
 * `src/ct_only.ts`'s `withCTLayout` reaches `o.internal.entriesPath` etc. directly, exactly
 * as `ct_only.go`'s `WithCTLayout` reaches `o.entriesPath` directly (same-package, unexported
 * field access) -- see that file for the closing half of this port.
 */
export class MigrationOptions {
	internal: {
		entriesPath: (n: bigint, p: number) => string;
		bundleIDHasher: (bundle: Uint8Array) => Uint8Array[];
		bundleLeafHasher: (bundle: Uint8Array) => Uint8Array[];
		followers: Follower[];
	};

	/**
	 * @internal Stands in for Go's `&MigrationOptions{...}` composite literal inside
	 * NewMigrationOptions; construct via newMigrationOptions. Unlike src/entry.ts's
	 * `Entry` (whose bare constructor deliberately mirrors Go's blank zero value because
	 * something -- newEntry -- needs to fill it in afterwards), nothing in this port ever
	 * needs a MigrationOptions with nil hashers: every construction site wants Tessera's
	 * real defaults, so the constructor supplies them directly rather than requiring a
	 * separate "now fill in the defaults" step.
	 */
	constructor() {
		this.internal = {
			entriesPath: entriesPath,
			bundleIDHasher: defaultIDHasher,
			bundleLeafHasher: defaultMerkleLeafHasher,
			followers: [],
		};
	}

	entriesPath(): (n: bigint, p: number) => string {
		return this.internal.entriesPath;
	}

	leafHasher(): (bundle: Uint8Array) => Uint8Array[] {
		return this.internal.bundleLeafHasher;
	}

	/**
	 * withAntispam configures the migration target to *populate* the provided antispam storage using
	 * the data being migrated into the target tree.
	 *
	 * Note that since the tree is being _migrated_, the resulting target tree must match the structure
	 * of the source tree and so no attempt is made to reject/deduplicate entries.
	 */
	withAntispam(as: Antispam | undefined): MigrationOptions {
		if (as !== undefined) {
			this.internal.followers.push(as.follower(this.internal.bundleIDHasher));
		}
		return this;
	}
}

/** MigrationTarget handles the process of migrating/importing a source log into a Tessera instance. */
export class MigrationTarget {
	readonly #writer: MigrationWriter;
	readonly #reader: LogReader;
	readonly #followers: Follower[];

	/** @internal Stands in for Go's `&MigrationTarget{...}` composite literal; construct via newMigrationTarget. */
	constructor(writer: MigrationWriter, reader: LogReader, followers: Follower[]) {
		this.#writer = writer;
		this.#reader = reader;
		this.#followers = followers;
	}

	/**
	 * migrate performs the work of importing a source log into the local Tessera instance.
	 *
	 * Any entry bundles implied by the provided source log size which are not already present in the local log
	 * will be fetched using the provided getEntries function, and stored by the underlying driver.
	 * A background process will continuously attempt to integrate these bundles into the local tree.
	 *
	 * An error will be thrown if there is an unrecoverable problem encountered during the migration
	 * process, or if, once all entries have been copied and integrated into the local tree, the local
	 * root hash does not match the provided sourceRoot.
	 */
	async migrate(
		numWorkers: number,
		sourceSize: bigint,
		sourceRoot: Uint8Array,
		getEntries: EntryBundleFetcherFunc,
		signal?: AbortSignal,
	): Promise<void> {
		const controller = new AbortController();
		const cSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
		try {
			const c = newCopier(numWorkers, this.#writer.setEntryBundle.bind(this.#writer), getEntries);

			let fromSize: bigint;
			try {
				fromSize = await this.#writer.integratedSize(cSignal);
			} catch (err) {
				throw new Error(`fetching integrated size failed: ${errText(err)}`);
			}
			c._bundlesCopied = fromSize / BigInt(EntryBundleWidth);

			// go integrate
			const errG = new ErrGroup();
			errG.go(() => c.copy(fromSize, sourceSize, cSignal));

			let calculatedRoot: Uint8Array = new Uint8Array(0);
			errG.go(async () => {
				try {
					calculatedRoot = await this.#writer.awaitIntegration(sourceSize, cSignal);
				} catch (err) {
					throw new Error(`awaiting integration failed: ${errText(err)}`);
				}
			});

			for (const f of this.#followers) {
				f.follow(this.#reader, cSignal);
				errG.go(awaitFollower(f, sourceSize, cSignal));
			}

			try {
				await errG.wait();
			} catch (err) {
				throw new Error(`migrate failed: ${errText(err)}`);
			}

			if (!bytesEqual(calculatedRoot, sourceRoot)) {
				throw new Error(
					`migration completed, but local root hash ${toHex(calculatedRoot)} != source root hash ${toHex(sourceRoot)}`,
				);
			}
		} finally {
			controller.abort();
		}
	}
}

/**
 * awaitFollower returns a function which will block until the provided follower has processed
 * at least as far as the provided index.
 *
 * Port note: `ctx context.Context` becomes a required `signal` here rather than optional --
 * every call site (`MigrationTarget.migrate` above) already has one, since it is what lets
 * this polling loop ever stop.
 *
 * @internal Go's `awaitFollower` is unexported and has no direct upstream test (there is
 * no migrate_lifecycle_test.go); exported here (ADR-0010's pattern) specifically so
 * `migrate_lifecycle_test.ts` can exercise the follower-catch-up polling loop directly,
 * per this package's mission brief. Not re-exported from `src/index.ts`.
 */
export function awaitFollower(f: Follower, i: bigint, signal: AbortSignal): () => Promise<void> {
	return async (): Promise<void> => {
		for (;;) {
			try {
				await sleep(1000, signal);
			} catch {
				return;
			}

			let pos: bigint;
			try {
				pos = await f.entriesProcessed(signal);
			} catch {
				continue;
			}
			if (pos >= i) {
				return;
			}
		}
	};
}

/**
 * progress renders a single "name: count (pct%)" progress fragment, e.g. `"copy: 12
 * (46.15%)"`.
 *
 * Port note: ported and tested directly even though nothing in this file currently calls
 * it (the printer loop that did is dropped -- this file's own header comment says why):
 * its exact output format may be relied on by tooling that scrapes a real Tessera binary's
 * logs, and this package's mission brief calls it out by name for that reason.
 */
export function progress(n: string, p: bigint, total: bigint): string {
	const pct = Number(p * 100n) / Number(total);
	return `${n}: ${p} (${formatGoFloat2(pct)}%)`;
}

/** formatGoFloat2 renders a float64 the way Go's `%.2f` verb does, including the +Inf/-Inf/NaN cases `.toFixed` does not spell the same way. */
function formatGoFloat2(v: number): string {
	if (Number.isNaN(v)) {
		return "NaN";
	}
	if (v === Number.POSITIVE_INFINITY) {
		return "+Inf";
	}
	if (v === Number.NEGATIVE_INFINITY) {
		return "-Inf";
	}
	return v.toFixed(2);
}
