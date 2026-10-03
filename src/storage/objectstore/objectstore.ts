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

// This file has no upstream counterpart. It defines the persistence contract that
// lets one storage driver (./driver.ts, modelled on tessera/storage/posix/files.go)
// run on top of any key/value backend: memory, IndexedDB, any SQLite engine, or a
// store supplied by the caller. See docs/decisions/0100-objectstore-driver.md.

/**
 * ObjectInfo describes a stored object without reading its contents.
 *
 * It is the subset of POSIX `os.FileInfo` that the storage driver relies on: the
 * POSIX driver uses a file's modification time to decide how stale the published
 * checkpoint is.
 */
export interface ObjectInfo {
	/** modTime is when the object was last written, in milliseconds since the Unix epoch. */
	readonly modTime: number;
	/** size is the length of the object's contents in bytes. */
	readonly size: number;
}

/**
 * ObjectStore is the minimal persistence contract the webtessera storage driver
 * needs from a backend.
 *
 * Keys are slash-separated paths. The driver stores every public log resource at
 * the path the C2SP tlog-tiles spec assigns to it (`checkpoint`,
 * `tile/0/x001/234`, `tile/entries/000.p/7`, ...) and keeps its private state
 * under the `.state/` prefix. A backend therefore holds a byte-for-byte copy of a
 * static tlog-tiles log, and serving the public part of it over HTTP is a matter
 * of mapping request paths to keys.
 *
 * Every method must be atomic with respect to the key(s) it touches: a reader
 * observes either the previous contents of a key or the new ones, never a mix.
 * Methods resolve only once the write is durable for the backend in question
 * (committed to IndexedDB, to a SQLite database, ...).
 *
 * Implementations must not retain or mutate the `data` arrays passed to them, and
 * callers must not mutate the arrays returned to them.
 */
export interface ObjectStore {
	/** get returns the contents of the object stored at key, or undefined if there is none. */
	get(key: string): Promise<Uint8Array | undefined>;

	/** stat returns information about the object stored at key, or undefined if there is none. */
	stat(key: string): Promise<ObjectInfo | undefined>;

	/** put atomically creates or overwrites the object stored at key. */
	put(key: string, data: Uint8Array): Promise<void>;

	/**
	 * create atomically creates the object stored at key, unless one already exists.
	 *
	 * It returns true if the object was created and false, leaving the existing
	 * object untouched, if one was already present. It is the counterpart of POSIX
	 * `O_CREAT|O_EXCL`.
	 */
	create(key: string, data: Uint8Array): Promise<boolean>;

	/**
	 * deletePrefix removes every object whose key starts with prefix. Removing
	 * nothing is not an error. It is the counterpart of `os.RemoveAll` on a
	 * directory.
	 */
	deletePrefix(prefix: string): Promise<void>;

	/**
	 * lock runs fn while holding the exclusive lock called name, and resolves to its
	 * result once the lock has been released.
	 *
	 * The lock must exclude every holder that can reach the same underlying data:
	 * other drivers in the same JavaScript realm and, where the backend is shared
	 * more widely (an IndexedDB database open in several tabs, say), those other
	 * contexts too. It is the counterpart of the POSIX driver's `flock`-based
	 * `lockFile`.
	 *
	 * If signal is aborted while waiting for the lock, lock rejects with the
	 * signal's reason and fn is never called.
	 */
	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
