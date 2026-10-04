// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/storage/posix/files.go @ 4a6d9f9
//
// Port note: the POSIX driver persists a log as a directory tree; this driver persists the
// same log, under the same paths, in an ObjectStore (./objectstore.ts), so that one engine
// serves memory, IndexedDB and Durable Object storage alike. Each filesystem operation maps
// onto exactly one ObjectStore method: os.ReadFile onto get, os.Stat onto stat, overwrite
// onto put, createEx onto create, os.RemoveAll onto deletePrefix, and the flock-based
// lockFile onto lock. file_ops.go, which implements the first four atomically on POSIX
// (temporary files, link/rename, fsync of the parent directory), is not ported: providing
// that atomicity and durability is the ObjectStore contract's job. Error texts that name an
// os function name the ObjectStore method that replaced it. See
// docs/decisions/0100-objectstore-driver.md.
//
// Port note: Go declares the methods of Storage, appender and logResourceStorage
// interleaved through the file. TypeScript requires a class's methods inside its body, so
// each class holds its methods in their upstream order, and the classes and free
// declarations follow the order of their Go type or func declarations.
//
// Port note: every OpenTelemetry metric (otel.go and each posixOpsHistogram.Record) and
// every klog call are dropped, following docs/decisions/0051-storage-internal-drops-otel-and-klog.md
// and docs/decisions/0080-append-lifecycle-otel-and-klog.md. Helpers whose context.Context
// fed only those metrics take no AbortSignal here.

import {
	CheckpointPath,
	EntryBundleWidth,
	partialTileSize,
	range,
	TileHeight,
	TileWidth,
	tilePath,
} from "../../api/layout/index.ts";
import { HashTile } from "../../api/state.ts";
import {
	Appender,
	type AppenderInit,
	type AppendLifecycle,
	type AppendOptions,
	type IndexFuture,
} from "../../append_lifecycle.ts";
import type { FetchFn } from "../../client/fetcher.ts";
import type { Entry } from "../../entry.ts";
import { partialOrFullResource } from "../../internal/fetcher/fallback.ts";
import { bytesEqual, concatBytes, fromUTF8, toHex, toUTF8 } from "../../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs, wrapError } from "../../internal/gostd/errors.ts";
import { parseUint, quote } from "../../internal/gostd/strconv.ts";
import { sleep, ticker } from "../../internal/gostd/sync.ts";
import { durationFromMs, durationString } from "../../internal/gostd/time.ts";
import type { MigrationWriter } from "../../internal/migrate/migrate.ts";
import { checkpointUnsafe } from "../../internal/parse/parse.ts";
import type { LogReader } from "../../lifecycle.ts";
import type { MigrationOptions } from "../../migrate_lifecycle.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { type GetTilesFunc, type IntegrateResult, integrate } from "../internal/integrate.ts";
import { newQueue, type Queue } from "../internal/queue.ts";
import type { TileID } from "../internal/tileid.ts";
import { marshalGCState, marshalTreeState, unmarshalGCState, unmarshalTreeState } from "./json.ts";
import type { ObjectInfo, ObjectStore } from "./objectstore.ts";

/**
 * compatibilityVersion is the required version of the log state directory.
 * This should be bumped whenever a change is made that would break compatibility with old versions.
 * When this is bumped, ensure that the version file is only written when a new log is being
 * created. Currently, this version is written whenever it is missing in order to upgrade logs
 * that were created before we introduced this.
 */
const compatibilityVersion = 1;

/** stateDir holds any private (but not secret) internal state needed to maintain/operate the log. */
const stateDir = ".state";
/** gcStateFile contains the state of the garbage collection operations. */
const gcStateFile = "gcState";
/** gcStateLock must be held when performing GC operations and updating the gcState file. */
const gcStateLock = `${gcStateFile}.lock`;
/** publishLock must be held when checking/updating the published checkpoint. */
const publishLock = "publish.lock";
/** treeStateFile contains the integrated (but not necessarily published) state of the tree. */
const treeStateFile = "treeState";
/** treeStateLock must be held when integrating entries into the tree or writing to the treeState file. */
const treeStateLock = `${treeStateFile}.lock`;

const minCheckpointInterval = 100; // ms (Go: 100 * time.Millisecond)

// Port note: layout's spec constants are exported as `number`; these bigint companions serve
// the uint64 arithmetic below. See docs/decisions/0030-untyped-go-constants.md.
const entryBundleWidth64 = BigInt(EntryBundleWidth);
const tileHeight64 = BigInt(TileHeight);
const tileWidth64 = BigInt(TileWidth);

/**
 * ObjectStoreDriver implements storage functions for an ObjectStore.
 * It leverages the ObjectStore's atomic operations where needed.
 *
 * Port note: Go's `posix.Storage`. It is renamed because `Storage` is the Web Storage API's
 * global interface in every browser, and because a TypeScript barrel loses the package
 * qualification (`posix.Storage`) that makes the Go name unambiguous. Go's `mu sync.Mutex`,
 * which serialises goroutines that fcntl locks cannot (a process never conflicts with its
 * own record locks), is dropped: ObjectStore.lock already excludes holders in the same
 * realm. See docs/decisions/0103-objectstore-locking-model.md and
 * docs/decisions/0104-objectstore-public-api.md.
 */
export class ObjectStoreDriver implements AppendLifecycle {
	/** @internal */
	readonly cfg: Required<ObjectStoreDriverConfig>;

	/** @internal Stands in for Go's `&Storage{...}` composite literal; construct via newObjectStoreDriver. */
	constructor(cfg: Required<ObjectStoreDriverConfig>) {
		this.cfg = cfg;
	}

	async appender(opts: AppendOptions, signal?: AbortSignal): Promise<AppenderInit> {
		const logStorage = new logResourceStorage(this, opts.entriesPath());

		const { appender: a, reader: lr } = await this.newAppender(logStorage, opts, signal);

		return {
			appender: new Appender((e: Entry, s?: AbortSignal): IndexFuture => a.add(e, s)),
			reader: lr,
		};
	}

	/**
	 * @internal Unexported in Go; reached directly by the ported files_test.go cases.
	 *
	 * Port note: the background goroutines Go starts here run for as long as signal does; with
	 * no signal they run for the life of the realm, as Go's run for a context.Background().
	 */
	async newAppender(
		o: logResourceStorage,
		opts: AppendOptions,
		signal?: AbortSignal,
	): Promise<{ appender: appender; reader: LogReader }> {
		if (opts.checkpointInterval() < minCheckpointInterval) {
			throw new Error(
				`requested CheckpointInterval (${fmtDuration(opts.checkpointInterval())}) is less than minimum permitted ${fmtDuration(minCheckpointInterval)}`,
			);
		}

		const a = new appender(this, o, opts.checkpointPublisher(o, this.cfg.fetch));
		await a.initialise(signal);
		a.queue = newQueue(
			opts.batchMaxAge(),
			opts.batchMaxSize(),
			(entries: readonly Entry[], s?: AbortSignal) => a.sequenceBatch(entries, s),
			signal,
		);

		const bgSignal = signal ?? new AbortController().signal;
		void (async (i: number): Promise<void> => {
			for (;;) {
				try {
					await a.cpUpdated.recv(i, bgSignal);
				} catch {
					return;
				}
				try {
					await a.publishCheckpoint(i, opts.checkpointRepublishInterval(), bgSignal);
				} catch {
					// Go: klog.Warningf("publishCheckpoint: %v", err)
				}
			}
		})(opts.checkpointInterval());
		const i = opts.garbageCollectionInterval();
		if (i > 0) {
			void a.garbageCollectorJob(i, bgSignal);
		}

		return { appender: a, reader: a.logStorage };
	}

	/**
	 * lockFile takes the named lock, runs fn while holding it, and releases it again.
	 *
	 * Note that a) this is advisory, and b) should use an non-API specified name
	 * (e.g. <something>.lock>) so that it can never be confused with a log resource.
	 *
	 * Port note: Go returns an unlock function for the caller to defer; ObjectStore.lock takes
	 * the critical section as a callback instead, which makes forgetting to unlock impossible.
	 * The lock is named after the file posix flocks, `.state/<name>`. Go's callers wrap a
	 * failure to lock as `lockFile(<name>): <err>` or panic; the wrapping is done here, once,
	 * and nobody panics. Since Go's F_SETLKW wait cannot be cancelled, an aborted wait is a
	 * failure mode only this port has. See docs/decisions/0103-objectstore-locking-model.md.
	 *
	 * @internal
	 */
	async lockFile<T>(p: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		let locked = false;
		try {
			return await this.cfg.store.lock(
				`${stateDir}/${p}`,
				() => {
					locked = true;
					return fn();
				},
				signal,
			);
		} catch (err) {
			if (locked) {
				throw err;
			}
			throw wrapError(`lockFile(${p})`, err);
		}
	}

	/**
	 * ensureVersion will fail if the compatibility version stored in the state directory
	 * is not the expected version. If no file exists, then it is created with the expected version.
	 *
	 * @internal
	 */
	async ensureVersion(version: number): Promise<void> {
		const versionFile = `${stateDir}/version`;

		let info: ObjectInfo | undefined;
		try {
			info = await this.stat(versionFile);
		} catch (err) {
			throw new Error(`stat(${versionFile}): ${errText(err)}`);
		}
		if (info === undefined) {
			const data = toUTF8(`${version}`);
			try {
				await this.createExclusive(versionFile, data);
			} catch (err) {
				throw new Error(`failed to create version file: ${errText(err)}`);
			}
			return;
		}

		let data: Uint8Array;
		try {
			data = await this.readAll(versionFile);
		} catch (err) {
			throw new Error(`failed to read version file: ${errText(err)}`);
		}
		let parsed: bigint;
		try {
			parsed = parseUint(fromUTF8(data), 10, 16);
		} catch (err) {
			throw new Error(`failed to parse version: ${errText(err)}`);
		}
		const got = Number(parsed);
		const want = version;
		if (got !== want) {
			throw new Error(`wanted version ${want} but found ${got}`);
		}
	}

	/**
	 * writeTreeState stores the current tree size and root hash in the store.
	 *
	 * Port note: Go's `error in Marshal` branch cannot occur for this struct and has no
	 * counterpart; see docs/decisions/0102-objectstore-state-json-encoding.md for the encoding.
	 *
	 * @internal
	 */
	async writeTreeState(size: bigint, root: Uint8Array): Promise<void> {
		const raw = marshalTreeState({ size, root });

		try {
			await this.createOverwrite(`${stateDir}/${treeStateFile}`, raw);
		} catch (err) {
			throw wrapError("failed to create/overwrite private tree state file", err);
		}
	}

	/**
	 * readTreeState reads and returns the currently stored tree state.
	 *
	 * @internal
	 */
	async readTreeState(): Promise<treeState> {
		const p = `${stateDir}/${treeStateFile}`;
		let raw: Uint8Array;
		try {
			raw = await this.readAll(p);
		} catch (err) {
			throw wrapError(`error in get(${quote(p)})`, err);
		}
		try {
			return unmarshalTreeState(raw);
		} catch (err) {
			throw new Error(`error in Unmarshal: ${errText(err)}`);
		}
	}

	/**
	 * writeGCState stores the high water mark below which garbage collection has successfully completed.
	 *
	 * @internal
	 */
	async writeGCState(size: bigint): Promise<void> {
		const raw = marshalGCState({ fromSize: size });

		try {
			await this.createOverwrite(`${stateDir}/${gcStateFile}`, raw);
		} catch (err) {
			throw wrapError("failed to create/overwrite private GC state file", err);
		}
	}

	/**
	 * readGCState reads and returns the currently stored GC state, if any.
	 *
	 * If no GC state is stored, no GC run has completed successfully, so zero is returned to indicate
	 * that GC should start from the beginning of the log.
	 *
	 * @internal
	 */
	async readGCState(): Promise<bigint> {
		const p = `${stateDir}/${gcStateFile}`;
		let raw: Uint8Array;
		try {
			raw = await this.readAll(p);
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				// gcState file doesn't exist yet - we've probably just not completed a GC run before so start from index 0.
				return 0n;
			}
			throw wrapError(`error in get(${quote(p)})`, err);
		}
		try {
			return unmarshalGCState(raw).fromSize;
		} catch (err) {
			throw new Error(`error in Unmarshal: ${errText(err)}`);
		}
	}

	/** @internal Unexported in Go; reached directly by the ported files_test.go cases. */
	async garbageCollect(
		treeSize: bigint,
		maxBundles: number,
		entriesPath: (n: bigint, p: number) => string,
		signal?: AbortSignal,
	): Promise<void> {
		// Lock the gc location:
		await this.lockFile(
			gcStateLock,
			async () => {
				let fromSize: bigint;
				try {
					fromSize = await this.readGCState();
				} catch (err) {
					throw new Error(`readGCState: ${errText(err)}`);
				}

				if (fromSize === treeSize) {
					// Nothing to do, nothing done.
					return;
				}

				let d = 0;
				// GC the tree in "vertical" chunks defined by entry bundles.
				for (const ri of range(fromSize, treeSize - fromSize, treeSize)) {
					// Only known-full bundles are in-scope for for GC, so exit if the current bundle is partial or
					// we've reached our limit of chunks.
					if (ri.partial > 0 || d > maxBundles) {
						break;
					}

					// GC any partial versions of the entry bundle itself and the tile which sits immediately above it.
					await this.removeDirAll(`${entriesPath(ri.index, 0)}.p/`);
					await this.removeDirAll(`${tilePath(0n, ri.index, 0)}.p/`);
					fromSize += BigInt(ri.n);
					d++;

					// Now consider (only) the part of the tree which sits above the bundle.
					// We'll walk up the parent tiles for as a long as we're tracing the right-hand
					// edge of a perfect subtree.
					// This gives the property we'll only visit each parent tile once, rather than up to 256 times.
					let pL = 0n;
					let pIdx = ri.index;
					while (isLastLeafInParent(pIdx)) {
						// Move our coordinates up to the parent
						pL++;
						pIdx >>= tileHeight64;
						// GC any partial versions of the parent tile.
						await this.removeDirAll(`${tilePath(pL, pIdx, 0)}.p/`);
					}
				}
				try {
					await this.writeGCState(fromSize);
				} catch (err) {
					throw new Error(`writeGCState: ${errText(err)}`);
				}
			},
			signal,
		);
	}

	/**
	 * createExclusive atomically creates an object at the given key containing the provided data.
	 *
	 * It will error if an object already exists at the specified location.
	 *
	 * @internal
	 */
	async createExclusive(p: string, d: Uint8Array): Promise<void> {
		if (!(await this.cfg.store.create(p, d))) {
			throw new Error(`create ${p}: file already exists`);
		}
	}

	/**
	 * createOverwrite atomically creates or overwrites an object at the given key with the provided data.
	 *
	 * @internal
	 */
	async createOverwrite(p: string, d: Uint8Array): Promise<void> {
		await this.cfg.store.put(p, d);
	}

	/**
	 * readAll returns the contents of the object at the given key, throwing an error which
	 * wraps ErrNotExist if there is none.
	 *
	 * @internal
	 */
	async readAll(p: string): Promise<Uint8Array> {
		const d = await this.cfg.store.get(p);
		if (d === undefined) {
			throw wrapError(`get ${p}`, ErrNotExist);
		}
		return d;
	}

	/**
	 * stat returns info for the specified object.
	 *
	 * Port note: Go reports a missing file as os.ErrNotExist, which every caller tests for;
	 * here it is reported as undefined, as ObjectStore.stat reports it.
	 *
	 * @internal
	 */
	async stat(p: string): Promise<ObjectInfo | undefined> {
		return this.cfg.store.stat(p);
	}

	/**
	 * removeDirAll removes every object stored under the given prefix.
	 *
	 * Port note: Go removes a directory and everything it contains. Every caller passes a
	 * path ending in "/", for which removing that prefix removes exactly the same resources.
	 *
	 * @internal
	 */
	async removeDirAll(p: string): Promise<void> {
		await this.cfg.store.deletePrefix(p);
	}

	/** migrationWriter creates a new ObjectStore storage for the MigrationTarget lifecycle mode. */
	async migrationWriter(
		opts: MigrationOptions,
		signal?: AbortSignal,
	): Promise<{ writer: MigrationWriter; reader: LogReader }> {
		const r = new MigrationStorage(this, new logResourceStorage(this, opts.entriesPath()), opts.leafHasher());
		await r.initialise(signal);
		return { writer: r, reader: r.logStorage };
	}
}

/**
 * appender implements the Tessera append lifecycle.
 *
 * @internal Unexported in Go; exported from this module (not from the package barrel) so
 * that the ported files_test.go cases can reach it, per docs/decisions/0010-package-private-members.md.
 */
export class appender {
	readonly s: ObjectStoreDriver;
	readonly logStorage: logResourceStorage;
	queue: Queue | undefined = undefined;

	curSize = 0n;
	/** May be undefined for mirrored logs. */
	newCP: ((size: bigint, root: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>) | undefined;

	readonly cpUpdated = new notifyChan();

	constructor(
		s: ObjectStoreDriver,
		logStorage: logResourceStorage,
		newCP: ((size: bigint, root: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>) | undefined,
	) {
		this.s = s;
		this.logStorage = logStorage;
		this.newCP = newCP;
	}

	/**
	 * add takes an entry and queues it for inclusion in the log.
	 * Upon placing the entry in an in-memory queue to be sequenced, it returns a future that will
	 * evaluate to either the sequence number assigned to this entry, or an error.
	 * This future is made available when the entry is queued. Any further calls to add after
	 * this returns will guarantee that the later entry appears later in the log than any
	 * earlier entries. Concurrent calls to add are supported, but the order they are queued and
	 * thus included in the log is non-deterministic.
	 *
	 * If the future resolves to a non-error state then it means that the entry is both
	 * sequenced and integrated into the log. This means that a checkpoint will be available
	 * that commits to this entry.
	 *
	 * It is recommended that the caller keeps the process running until all futures returned
	 * by this method have successfully evaluated. Terminating earlier than this will likely
	 * mean that some of the entries added are not committed to by a checkpoint, and thus are
	 * not considered to be in the log.
	 */
	add(e: Entry, signal?: AbortSignal): IndexFuture {
		if (this.queue === undefined) {
			// Unreachable: newAppender sets the queue before handing the appender out. Go
			// would dereference a nil queue here.
			throw new Error("appender: add called before the queue was started");
		}
		return this.queue.add(e, signal);
	}

	/**
	 * sequenceBatch writes the entries from the provided batch into the entry bundle files of the log.
	 *
	 * This func starts filling entries bundles at the next available slot in the log, ensuring that the
	 * sequenced entries are contiguous from the zeroth entry (i.e left-hand dense).
	 * We try to minimise the number of partially complete entry bundles by writing entries in chunks rather
	 * than one-by-one.
	 *
	 * Port note: Go takes both its in-process mutex and the treeState lock file here ("double
	 * locking"); ObjectStore.lock alone covers both, see the Port note on ObjectStoreDriver.
	 * The tree state is read afresh under the lock for every batch, which is what lets several
	 * drivers (two browser tabs on one IndexedDB database, say) share one store.
	 */
	async sequenceBatch(entries: readonly Entry[], signal?: AbortSignal): Promise<void> {
		await this.s.lockFile(
			treeStateLock,
			async () => {
				let size: bigint;
				try {
					({ size } = await this.s.readTreeState());
				} catch (err) {
					if (!errorIs(err, ErrNotExist)) {
						throw err;
					}
					size = 0n;
				}
				this.curSize = size;

				if (entries.length === 0) {
					return;
				}
				// Port note: Go accumulates the bundle in a bytes.Buffer, whose writes cannot fail;
				// its two "failed to write ... into buffer" error paths have no counterpart.
				let currTile: Uint8Array[] = [];
				const seq = this.curSize;
				let bundleIndex = seq / entryBundleWidth64;
				let entriesInBundle = Number(seq % entryBundleWidth64);
				if (entriesInBundle > 0) {
					// If the latest bundle is partial, we need to read the data it contains in for our newer, larger, bundle.
					const part = await this.logStorage.readEntryBundle(
						bundleIndex,
						Number(this.curSize % entryBundleWidth64),
						signal,
					);
					currTile.push(part);
				}
				const writeBundle = (bundleIndex: bigint, partialSize: number): Promise<void> =>
					this.logStorage.writeBundle(bundleIndex, partialSize, concatBytes(...currTile));

				const leafHashes: Uint8Array[] = [];
				// Add new entries to the bundle
				for (const [i, e] of entries.entries()) {
					currTile.push(e.marshalBundleData(seq + BigInt(i)));
					leafHashes.push(e.leafHash());

					entriesInBundle++;
					if (entriesInBundle === EntryBundleWidth) {
						//  This bundle is full, so we need to write it out...
						// ... and prepare the next entry bundle for any remaining entries in the batch
						await writeBundle(bundleIndex, 0);
						bundleIndex++;
						entriesInBundle = 0;
						currTile = [];
					}
				}
				// If we have a partial bundle remaining once we've added all the entries from the batch,
				// this needs writing out too.
				if (entriesInBundle > 0) {
					// This check should be redundant since this is [currently] checked above, but an overflow around the uint8 below could
					// potentially be bad news if that check was broken/defeated as we'd be writing invalid bundle data, so do a belt-and-braces
					// check and bail if need be.
					if (entriesInBundle > EntryBundleWidth) {
						throw new Error(`logic error: entriesInBundle(${entriesInBundle}) > max bundle size ${EntryBundleWidth}`);
					}
					await writeBundle(bundleIndex, entriesInBundle);
				}

				// For simplicity, in-line the integration of these new entries into the Merkle structure too.
				// If this is broken out into an async process, we'll need to update the implementation of nextIndex, too.
				const { newSize, newRoot } = await doIntegrate(seq, leafHashes, this.logStorage, signal);
				try {
					await this.s.writeTreeState(newSize, newRoot);
				} catch (err) {
					throw new Error(`failed to write new tree state: ${errText(err)}`);
				}
				// Notify that we know for sure there's a new checkpoint, but don't block if there's already
				// an outstanding notification in the channel.
				this.cpUpdated.trySend();
			},
			signal,
		);
	}

	/**
	 * initialise ensures that the storage location is valid by loading the checkpoint from this location, or
	 * creating a zero-sized one if it doesn't already exist.
	 *
	 * Port note: Go first creates the .state directory; an object store has no directories to
	 * create. As in sequenceBatch, ObjectStore.lock replaces Go's double locking.
	 *
	 * Port note: Go starts a fresh, empty tree whenever the tree state is missing, even if a
	 * checkpoint is already published at the same location — after which it signs a size-0
	 * checkpoint over the published one and re-sequences entries at indices it has already
	 * published, a fork of the log. This refuses instead: with no tree state, a new tree is
	 * started only if no checkpoint is published. Recovery is the operator's decision (restore
	 * `.state/treeState`, or start a new log elsewhere); see
	 * docs/decisions/0205-checkpoint-publication-fails-closed.md.
	 *
	 * Port note: the refusal is decided before ensureVersion, from reads alone, so that a
	 * refused store is left exactly as it was: ensureVersion would otherwise create
	 * .state/version first, as Go's does. A version file that already exists is still checked
	 * before refusing (ensureVersion only reads it then), so its errors come first, as in Go.
	 * Everything else runs in Go's order.
	 */
	async initialise(signal?: AbortSignal): Promise<void> {
		await this.s.lockFile(
			treeStateLock,
			async () => {
				const exists = async (key: string): Promise<boolean> => {
					try {
						return (await this.s.stat(key)) !== undefined;
					} catch (err) {
						throw new Error(`stat(${key}): ${errText(err)}`);
					}
				};
				if (!(await exists(`${stateDir}/${treeStateFile}`)) && (await exists(CheckpointPath))) {
					if (await exists(`${stateDir}/version`)) {
						await this.s.ensureVersion(compatibilityVersion);
					}
					throw new Error(
						`refusing to initialise a new tree: ${stateDir}/${treeStateFile} does not exist but a checkpoint is already published at ${quote(CheckpointPath)}; starting over would fork the published log (restore ${stateDir}/${treeStateFile}, or start the new log in an empty store)`,
					);
				}
				await this.s.ensureVersion(compatibilityVersion);
				let curSize: bigint;
				try {
					({ size: curSize } = await this.s.readTreeState());
				} catch (err) {
					if (!errorIs(err, ErrNotExist)) {
						throw new Error(`failed to load checkpoint for log: ${errText(err)}`);
					}
					// Create the directory structure and write out an empty checkpoint
					try {
						await this.s.writeTreeState(0n, DefaultHasher.emptyRoot());
					} catch (err) {
						throw new Error(`failed to write tree-state checkpoint: ${errText(err)}`);
					}
					if (this.newCP !== undefined) {
						try {
							await this.publishCheckpoint(0, 0, signal);
						} catch (err) {
							throw new Error(`failed to publish checkpoint: ${errText(err)}`);
						}
					}
					return;
				}
				this.curSize = curSize;
			},
			signal,
		);
	}

	/**
	 * publishCheckpoint checks whether the currently published checkpoint (if any) is more than
	 * minStaleness old, and, if so, creates and published a fresh checkpoint from the current
	 * stored tree state.
	 *
	 * Port note: a checkpoint's age is measured from ObjectStore.stat's modTime, the
	 * counterpart of the file's mtime.
	 *
	 * Port note: Go writes whatever newCP returns. This first checks that it parses as a
	 * checkpoint for exactly the size and root it was asked to sign, and refuses to publish
	 * it otherwise: an empty or unparsable checkpoint would replace the published one, and
	 * every later publish would fail on publishedSize, leaving the log unable to publish
	 * again. See docs/decisions/0205-checkpoint-publication-fails-closed.md.
	 */
	async publishCheckpoint(minStalenessActive: number, minStalenessRepub: number, signal?: AbortSignal): Promise<void> {
		// Lock the destination "published" checkpoint location:
		await this.s.lockFile(
			publishLock,
			async () => {
				let publishedAge = 0;
				let publishedSize = 0n;
				let cpExists = true;
				let info: ObjectInfo | undefined;
				try {
					info = await this.s.stat(CheckpointPath);
				} catch (err) {
					throw new Error(`stat(${CheckpointPath}): ${errText(err)}`);
				}
				if (info === undefined) {
					cpExists = false;
				} else {
					publishedAge = Date.now() - info.modTime;
					if (publishedAge < minStalenessActive) {
						return;
					}
					publishedSize = await this.publishedSize(signal);
				}

				let size: bigint;
				let root: Uint8Array;
				try {
					({ size, root } = await this.s.readTreeState());
				} catch (err) {
					throw new Error(`readTreeState: ${errText(err)}`);
				}
				if (cpExists && size === publishedSize) {
					if (minStalenessRepub === 0 || publishedAge < minStalenessRepub) {
						return;
					}
				}

				if (this.newCP === undefined) {
					// Unreachable for appenders built by newAppender, which always sets newCP. Go
					// would call a nil func here.
					throw new Error("newCP: no checkpoint publisher configured");
				}
				let cpRaw: Uint8Array;
				try {
					cpRaw = await this.newCP(size, root, signal);
				} catch (err) {
					throw new Error(`newCP: ${errText(err)}`);
				}
				checkPublishable(cpRaw, size, root);

				try {
					await this.s.createOverwrite(CheckpointPath, cpRaw);
				} catch (err) {
					throw new Error(`createOverwrite(${CheckpointPath}): ${errText(err)}`);
				}
			},
			signal,
		);
	}

	/**
	 * publishedSize returns the size of tree that the currently published checkpoint, if any, commits to.
	 *
	 * If there is no currently published checkpoint zero will be returned without error.
	 */
	async publishedSize(signal?: AbortSignal): Promise<bigint> {
		let cp: Uint8Array;
		try {
			cp = await this.logStorage.readCheckpoint(signal);
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				return 0n;
			}
			throw new Error(`failed to read published checkpoint: ${errText(err)}`);
		}
		try {
			return checkpointUnsafe(cp).size;
		} catch (err) {
			throw new Error(`failed to parse published checkpoint: ${errText(err)}`);
		}
	}

	/**
	 * garbageCollectorJob is a long-running function which handles the removal of obsolete partial tiles
	 * and entry bundles.
	 * Blocks until signal is aborted.
	 */
	async garbageCollectorJob(i: number, signal: AbortSignal): Promise<void> {
		// Entirely arbitrary number.
		const maxBundlesPerRun = 100;

		await ticker(i, signal, async () => {
			// Figure out the size of the latest published checkpoint - we can't be removing partial tiles implied by
			// that checkpoint just because we've done an integration and know about a larger (but as yet unpublished)
			// checkpoint!
			let pubSize: bigint;
			try {
				pubSize = await this.publishedSize(signal);
			} catch {
				// Go: klog.Warningf("GarbageCollect: %v", err); continue
				return;
			}

			try {
				await this.s.garbageCollect(pubSize, maxBundlesPerRun, this.logStorage.entriesPath, signal);
			} catch {
				// Go: klog.Warningf("GarbageCollect failed: %v", err); continue
			}
		});
	}
}

/**
 * logResourceStorage knows how to read and write tiled log resources via an
 * ObjectStoreDriver instance
 *
 * @internal Unexported in Go; exported from this module (not from the package barrel) for
 * the ported files_test.go cases, per docs/decisions/0010-package-private-members.md.
 */
export class logResourceStorage implements LogReader {
	readonly s: ObjectStoreDriver;
	readonly entriesPath: (n: bigint, p: number) => string;

	constructor(s: ObjectStoreDriver, entriesPath: (n: bigint, p: number) => string) {
		this.s = s;
		this.entriesPath = entriesPath;
	}

	async readCheckpoint(_signal?: AbortSignal): Promise<Uint8Array> {
		const r = await this.s.cfg.store.get(CheckpointPath);
		if (r === undefined) {
			throw ErrNotExist;
		}
		return r;
	}

	/** readEntryBundle retrieves the Nth entries bundle for a log of the given size. */
	async readEntryBundle(index: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (p: number) => this.s.readAll(this.entriesPath(index, p)), signal);
	}

	async readTile(level: bigint, index: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (p: number) => this.s.readAll(tilePath(level, index, p)), signal);
	}

	async integratedSize(_signal?: AbortSignal): Promise<bigint> {
		const { size } = await this.s.readTreeState();
		return size;
	}

	async nextIndex(signal?: AbortSignal): Promise<bigint> {
		return this.integratedSize(signal);
	}

	async readTiles(
		tileIDs: readonly TileID[],
		treeSize: bigint,
		signal?: AbortSignal,
	): Promise<(HashTile | undefined)[]> {
		const r: (HashTile | undefined)[] = [];
		for (const id of tileIDs) {
			const t = await this.#readTile(id.level, id.index, partialTileSize(id.level, id.index, treeSize), signal);
			r.push(t);
		}
		return r;
	}

	/**
	 * readTile returns the parsed tile at the given tile-level and tile-index.
	 * If no complete tile exists at that location, it will attempt to find a
	 * partial tile for the given tree size at that location.
	 *
	 * Port note: Go's unexported `readTile` and the exported `ReadTile` above both camelCase
	 * to `readTile`. This one is used only within the class, so it becomes an ECMAScript
	 * private method, which breaks the collision without renaming either.
	 */
	async #readTile(level: bigint, index: bigint, p: number, signal?: AbortSignal): Promise<HashTile | undefined> {
		let t: Uint8Array;
		try {
			t = await this.readTile(level, index, p, signal);
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				// We'll signal to higher levels that it wasn't found by retuning undefined for this tile.
				return undefined;
			}
			throw err;
		}

		const tile = new HashTile();
		try {
			tile.unmarshalText(t);
		} catch (err) {
			throw wrapError("failed to parse tile", err);
		}

		return tile;
	}

	/**
	 * storeTile writes a tile out to disk.
	 * Fully populated tiles are stored at the path corresponding to the level &
	 * index parameters, partially populated (i.e. right-hand edge) tiles are
	 * stored with a .xx suffix where xx is the number of "tile leaves" in hex.
	 *
	 * Port note: upstream's comment above predates the tlog-tiles layout both drivers use: a
	 * partial tile is stored with a `.p/<n>` suffix, n being the number of tile leaves in
	 * decimal (layout.tilePath), and here "disk" is the ObjectStore. Go's
	 * `failed to marshal tile` branch cannot occur (HashTile.marshalText cannot fail) and has
	 * no counterpart.
	 */
	async storeTile(level: bigint, index: bigint, logSize: bigint, tile: HashTile): Promise<void> {
		const tileSize = tile.nodes.length;
		if (tileSize === 0 || tileSize > TileWidth) {
			throw new Error(`tileSize ${tileSize} must be > 0 and <= ${TileWidth}`);
		}
		const t = tile.marshalText();

		return this.writeTile(level, index, partialTileSize(level, index, logSize), t);
	}

	/**
	 * Port note: after writing a full tile, Go tries to replace every partial tile under
	 * `<tile>.p/` with a symlink to the full tile, using a temporary link and a rename for
	 * atomicity; because it globs and links root-relative paths, it only does so when the
	 * process's working directory is the log root (ADR-0101's update, ADR-0162). An object store has no symlinks, and no listing to find the partials with,
	 * and nothing needs them replaced: a partial tile is immutable and stays a correct answer
	 * for the tree size it was written for, readers fall back to the full tile once it is
	 * gone (partialOrFullResource), and garbageCollect removes the same `.p/` prefixes the
	 * symlinks live under in posix. The partials are therefore left in place until GC. See
	 * docs/decisions/0101-objectstore-partial-tiles-not-relinked.md.
	 */
	async writeTile(level: bigint, index: bigint, partial: number, t: Uint8Array): Promise<void> {
		const tPath = tilePath(level, index, partial);

		await this.s.createOverwrite(tPath, t);
	}

	/**
	 * writeBundle takes care of writing out the serialised entry bundle file.
	 *
	 * Port note: Go ignores an os.ErrExist from createOverwrite here, which an overwrite never
	 * reports; ObjectStore.put cannot report it either, so there is nothing to ignore.
	 */
	async writeBundle(index: bigint, partial: number, bundle: Uint8Array): Promise<void> {
		const bf = this.entriesPath(index, partial);
		await this.s.createOverwrite(bf, bundle);
	}
}

/**
 * NewTreeFunc is the signature of a function which receives information about newly integrated trees.
 *
 * Port note: as in Go, nothing in this package uses it; it is kept because posix exports it.
 */
export type NewTreeFunc = (size: bigint, root: Uint8Array) => void;

/** ObjectStoreDriverConfig configures newObjectStoreDriver. Go: `posix.Config`. */
export interface ObjectStoreDriverConfig {
	/** fetch will be used for outgoing HTTP requests. If unset, Tessera will use the global fetch. */
	readonly fetch?: FetchFn;

	/** store is the ObjectStore in which the log should be stored. */
	readonly store: ObjectStore;
}

/**
 * newObjectStoreDriver creates a new ObjectStore storage.
 *
 * Port note: Go's `posix.New(ctx, cfg) (tessera.Driver, error)` uses neither its context nor
 * its error, so both are dropped, and the concrete type is returned rather than the opaque
 * Driver so that callers get its methods' types. The fetch function is always called
 * without a receiver, which the global fetch requires in browsers and workerd. See
 * docs/decisions/0104-objectstore-public-api.md.
 */
export function newObjectStoreDriver(cfg: ObjectStoreDriverConfig): ObjectStoreDriver {
	const f: FetchFn = cfg.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

	return new ObjectStoreDriver({
		fetch: (input: string, init?: RequestInit) => f(input, init),
		store: cfg.store,
	});
}

/** doIntegrate handles integrating new leaf hashes into the log, and returns the new state. */
async function doIntegrate(
	fromSeq: bigint,
	leafHashes: readonly Uint8Array[],
	ls: logResourceStorage,
	signal?: AbortSignal,
): Promise<{ newSize: bigint; newRoot: Uint8Array }> {
	const getTiles: GetTilesFunc = async (tileIDs, treeSize, s) => {
		try {
			return await ls.readTiles(tileIDs, treeSize, s);
		} catch (err) {
			throw wrapError("getTiles", err);
		}
	};

	let r: IntegrateResult;
	try {
		r = await integrate(getTiles, fromSeq, leafHashes, signal);
	} catch (err) {
		throw new Error(`error in Integrate: ${errText(err)}`);
	}
	for (const { id, tile } of r.tiles.values()) {
		try {
			await ls.storeTile(id.level, id.index, r.newSize, tile);
		} catch (err) {
			throw new Error(`failed to set tile({${id.level} ${id.index}}): ${errText(err)}`);
		}
	}

	return { newSize: r.newSize, newRoot: r.rootHash };
}

/**
 * checkPublishable throws unless cpRaw parses as a checkpoint committing to exactly size
 * and root.
 *
 * Port note: no upstream counterpart; see appender.publishCheckpoint and
 * docs/decisions/0205-checkpoint-publication-fails-closed.md. It parses the way
 * publishedSize will read the checkpoint back (checkpointUnsafe: the signature is the
 * publisher's own, and this is the binary that produced it).
 */
function checkPublishable(cpRaw: Uint8Array, size: bigint, root: Uint8Array): void {
	let parsed: { size: bigint; hash: Uint8Array };
	try {
		parsed = checkpointUnsafe(cpRaw);
	} catch (err) {
		throw new Error(`newCP returned a checkpoint that does not parse, refusing to publish it: ${errText(err)}`);
	}
	if (parsed.size !== size || !bytesEqual(parsed.hash, root)) {
		throw new Error(
			`newCP returned a checkpoint for a different tree (size ${parsed.size}, root ${toHex(parsed.hash)}; want size ${size}, root ${toHex(root)}), refusing to publish it`,
		);
	}
}

/**
 * treeState is the integrated tree state stored in `.state/treeState`.
 *
 * @internal Exported for ./json.ts, which encodes it as Go's encoding/json does.
 */
export interface treeState {
	readonly size: bigint;
	readonly root: Uint8Array;
}

/**
 * gcState represents a snapshot of how much of the log tree has been garbage collected.
 * This state structure is serialized into a private (but not sensitive) object in the log's .state directory.
 *
 * @internal Exported for ./json.ts, which encodes it as Go's encoding/json does.
 */
export interface gcState {
	readonly fromSize: bigint;
}

/**
 * isLastLeafInParent returns true if a tile with the provided index is the final child node of a
 * (hypothetical) full parent tile.
 *
 * @internal Exported for driver_test.ts.
 */
export function isLastLeafInParent(i: bigint): boolean {
	return i % tileWidth64 === tileWidth64 - 1n;
}

/** MigrationStorage implements the tessera.MigrationTarget lifecycle contract. */
export class MigrationStorage implements MigrationWriter {
	/** @internal */
	readonly s: ObjectStoreDriver;
	/** @internal */
	readonly logStorage: logResourceStorage;
	/** @internal */
	readonly bundleHasher: (entryBundle: Uint8Array) => Uint8Array[];
	/** @internal */
	curSize = 0n;

	/** @internal Stands in for Go's `&MigrationStorage{...}` composite literal; construct via ObjectStoreDriver.migrationWriter. */
	constructor(
		s: ObjectStoreDriver,
		logStorage: logResourceStorage,
		bundleHasher: (entryBundle: Uint8Array) => Uint8Array[],
	) {
		this.s = s;
		this.logStorage = logStorage;
		this.bundleHasher = bundleHasher;
	}

	/**
	 * Port note: Go's one-second time.Ticker becomes a one-second sleep between attempts,
	 * which rejects with the signal's reason where Go returns ctx.Err().
	 */
	async awaitIntegration(sourceSize: bigint, signal?: AbortSignal): Promise<Uint8Array> {
		for (;;) {
			await sleep(1000, signal);
			try {
				await this.buildTree(sourceSize, signal);
			} catch {
				// Go: klog.Warningf("buildTree: %v", err)
			}
			let s = 0n;
			let r: Uint8Array = new Uint8Array(0);
			try {
				({ size: s, root: r } = await this.s.readTreeState());
			} catch {
				// Go: klog.Warningf("readTreeState: %v", err)
			}
			if (s === sourceSize) {
				return r;
			}
		}
	}

	/** @internal */
	async initialise(signal?: AbortSignal): Promise<void> {
		await this.s.lockFile(
			treeStateLock,
			async () => {
				await this.s.ensureVersion(compatibilityVersion);
				let curSize: bigint;
				try {
					({ size: curSize } = await this.s.readTreeState());
				} catch (err) {
					if (!errorIs(err, ErrNotExist)) {
						throw new Error(`failed to load checkpoint for log: ${errText(err)}`);
					}
					// Create the directory structure and write out an empty checkpoint
					try {
						await this.s.writeTreeState(0n, DefaultHasher.emptyRoot());
					} catch (err) {
						throw new Error(`failed to write tree-state checkpoint: ${errText(err)}`);
					}
					return;
				}
				this.curSize = curSize;
			},
			signal,
		);
	}

	async setEntryBundle(index: bigint, partial: number, bundle: Uint8Array, _signal?: AbortSignal): Promise<void> {
		return this.logStorage.writeBundle(index, partial, bundle);
	}

	async integratedSize(_signal?: AbortSignal): Promise<bigint> {
		const { size } = await this.s.readTreeState();
		return size;
	}

	/** @internal */
	async buildTree(targetSize: bigint, signal?: AbortSignal): Promise<void> {
		await this.s.lockFile(
			treeStateLock,
			async () => {
				let size: bigint;
				try {
					({ size } = await this.s.readTreeState());
				} catch (err) {
					if (!errorIs(err, ErrNotExist)) {
						throw err;
					}
					size = 0n;
				}
				this.curSize = size;

				let lh: Uint8Array[];
				try {
					lh = await this.fetchLeafHashes(size, targetSize, targetSize, signal);
				} catch (err) {
					if (errorIs(err, ErrNotExist)) {
						// We just don't have the bundle yet.
						// Bail quietly and the caller can retry.
						return;
					}
					throw new Error(`fetchLeafHashes(${size}, ${targetSize}): ${errText(err)}`);
				}

				let r: { newSize: bigint; newRoot: Uint8Array };
				try {
					r = await doIntegrate(size, lh, this.logStorage, signal);
				} catch (err) {
					throw new Error(`doIntegrate(${size}, ...): ${errText(err)}`);
				}
				try {
					await this.s.writeTreeState(r.newSize, r.newRoot);
				} catch (err) {
					throw new Error(`failed to write new tree state: ${errText(err)}`);
				}
			},
			signal,
		);
	}

	/**
	 * @internal
	 *
	 * Port note: Go slices `bh[ri.First:ri.First+ri.N]`, which panics if the bundle holds
	 * fewer entries than its path claims; a JavaScript slice would silently come up short and
	 * integrate the wrong number of leaves, so the bound is checked explicitly and thrown.
	 */
	async fetchLeafHashes(from: bigint, to: bigint, sourceSize: bigint, signal?: AbortSignal): Promise<Uint8Array[]> {
		const maxBundles = 300;

		const lh: Uint8Array[] = [];
		let n = 0;
		for (const ri of range(from, to, sourceSize)) {
			let b: Uint8Array;
			try {
				b = await this.logStorage.readEntryBundle(ri.index, ri.partial, signal);
			} catch (err) {
				throw wrapError(`ReadEntryBundle(${ri.index}.${ri.partial})`, err);
			}

			let bh: Uint8Array[];
			try {
				bh = this.bundleHasher(b);
			} catch (err) {
				throw new Error(`bundleHasherFunc for bundle index ${ri.index}: ${errText(err)}`);
			}
			if (bh.length < ri.first + ri.n) {
				throw new Error(
					`bundleHasherFunc for bundle index ${ri.index}: slice bounds out of range [:${ri.first + ri.n}] with capacity ${bh.length}`,
				);
			}
			lh.push(...bh.slice(ri.first, ri.first + ri.n));
			n++;
			if (n >= maxBundles) {
				break;
			}
		}
		return lh;
	}
}

/**
 * notifyChan stands in for the unbuffered `chan struct{}` (cpUpdated) through which
 * sequenceBatch tells the checkpoint publishing loop that the tree has grown.
 */
class notifyChan {
	#receiver: (() => void) | undefined;

	/**
	 * trySend is `select { case c <- struct{}{}: default: }`: it wakes the receiver if one is
	 * blocked in recv, and is a no-op otherwise, exactly as a send on an unbuffered channel
	 * with nobody receiving falls through to the default case.
	 */
	trySend(): void {
		const r = this.#receiver;
		this.#receiver = undefined;
		r?.();
	}

	/**
	 * recv is the publishing loop's `select` over `ctx.Done()`, the channel and
	 * `time.After(timeoutMs)`: it resolves when trySend is called or timeoutMs elapses, and
	 * rejects with the signal's reason if signal aborts first. It leaves no timer or
	 * listener behind whichever way it settles.
	 */
	recv(timeoutMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const finish = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				this.#receiver = undefined;
			};
			const onAbort = (): void => {
				finish();
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				finish();
				resolve();
			}, timeoutMs);
			signal.addEventListener("abort", onAbort, { once: true });
			this.#receiver = (): void => {
				finish();
				resolve();
			};
		});
	}
}

/**
 * fmtDuration renders a duration of ms milliseconds the way Go's `%v` renders the
 * time.Duration it stands for (Duration.String, from the whole number of nanoseconds). A
 * value no Duration can hold (NaN, ±Infinity) is rendered as JavaScript renders it.
 */
function fmtDuration(ms: number): string {
	return Number.isFinite(ms) ? durationString(durationFromMs(ms)) : String(ms);
}

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
