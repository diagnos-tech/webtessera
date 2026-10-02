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

// Moving logs between a store and a directory, and comparing two log directories. A store holds
// a log under the same paths a POSIX log directory does (ObjectStore keys are tlog-tiles paths,
// with private state under .state/), so loading and exporting are one file per key, verbatim.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * recordKeys wraps store so that every key put or created through it is remembered in the
 * returned `keys` set. Reads, deletes and locks pass straight through.
 *
 * It is how the harness exports a store without asking backends for a listing operation the
 * ObjectStore contract does not have: every store starts empty and is only written through the
 * wrapper, and exporting reads each recorded key back from the backend itself.
 */
export function recordKeys(store) {
	const keys = new Set();
	const wrapped = {
		get: (k) => store.get(k),
		stat: (k) => store.stat(k),
		put: (k, d) => {
			keys.add(k);
			return store.put(k, d);
		},
		create: (k, d) => {
			keys.add(k);
			return store.create(k, d);
		},
		deletePrefix: (p) => store.deletePrefix(p),
		lock: (n, fn, s) => store.lock(n, fn, s),
	};
	return { store: wrapped, keys };
}

/** listFiles returns the paths, relative to dir and slash-separated, of every entry below dir that is not a directory. */
function listFiles(dir) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((d) => !d.isDirectory())
		.map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join("/"))
		.sort();
}

/**
 * isLockFile reports whether path is one of the POSIX driver's flock(2) targets, empty files
 * that carry no state. A store has no counterpart: ObjectStore.lock is not backed by objects.
 */
function isLockFile(path) {
	return path.startsWith(".state/") && path.endsWith(".lock");
}

/**
 * loadDir copies every file of a POSIX log directory into store, .state/ included, under its
 * path. Lock files are left behind (see isLockFile). A symlink is refused: see symlinkError.
 */
export async function loadDir(dir, store) {
	let n = 0;
	for (const path of listFiles(dir)) {
		if (lstatSync(join(dir, path)).isSymbolicLink()) {
			throw symlinkError(dir, path);
		}
		if (!isLockFile(path)) {
			await store.put(path, new Uint8Array(readFileSync(join(dir, path))));
			n++;
		}
	}
	return n;
}

/** exportStore writes every recorded key the store still holds into dir as a file, and returns how many it wrote. */
export async function exportStore(recorded, dir) {
	let n = 0;
	for (const key of [...recorded.keys].sort()) {
		const data = await recorded.store.get(key);
		if (data !== undefined) {
			const file = join(dir, ...key.split("/"));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, data);
			n++;
		}
	}
	return n;
}

/**
 * compareLogDirs compares the log under test (got: written by webtessera, or by webtessera and
 * then Go) with the reference log Go's POSIX driver wrote alone for the same entries and batch
 * boundaries (want), and returns every difference found.
 *
 * Both must hold exactly the same paths, lock files aside, with exactly the same bytes: every
 * tile, entry bundle and superseded partial, the signed checkpoint, and .state/'s treeState and
 * version files.
 */
export function compareLogDirs(got, want) {
	const diffs = [];
	const gotFiles = listFiles(got).filter((p) => !isLockFile(p));
	const wantFiles = listFiles(want).filter((p) => !isLockFile(p));
	const gotSet = new Set(gotFiles);
	const wantSet = new Set(wantFiles);
	for (const p of wantFiles) {
		if (!gotSet.has(p)) {
			diffs.push(`${p}: only in Go's reference log`);
		}
	}
	for (const p of gotFiles) {
		if (!wantSet.has(p)) {
			diffs.push(`${p}: only in the log under test`);
			continue;
		}
		if (lstatSync(join(want, p)).isSymbolicLink()) {
			diffs.push(symlinkError(want, p).message);
			continue;
		}
		const a = readFileSync(join(got, p));
		const b = readFileSync(join(want, p));
		if (!a.equals(b)) {
			diffs.push(
				`${p}: ${a.length} bytes under test, ${b.length} in Go's reference, first difference at byte ${firstDifference(a, b)}`,
			);
		}
	}
	return diffs;
}

/**
 * symlinkError explains a symlink in a Go log directory. posix's writeTile replaces superseded
 * partial tiles with symlinks found by a glob relative to the process's working directory, not
 * the log root, and creates them with a target that only resolves from the working directory:
 * when Go runs from inside the log root it leaves dangling links. The harness always runs Go
 * from elsewhere, so a symlink means that assumption broke.
 */
function symlinkError(dir, path) {
	return new Error(
		`${join(dir, path)} is a symlink: Go's POSIX driver relinks partial tiles relative to its working ` +
			"directory, so produce must not run from inside the log directory",
	);
}

function firstDifference(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) {
		i++;
	}
	return i;
}

/** writeHistory records raw as the checkpoint published at size, as interop/internal/history does. */
export function writeHistory(dir, size, raw) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `checkpoint.${size}`), raw);
}

/**
 * compareHistories checks that every checkpoint recorded in got is byte-identical to the one
 * Go's reference run recorded at the same size in want. Both sign with the same key, checkpoints carry
 * no timestamp, and Ed25519 is deterministic, so equal trees must give equal bytes. It returns
 * the differences and the number of checkpoints compared.
 */
export function compareHistories(got, want) {
	const diffs = [];
	let compared = 0;
	for (const name of readdirSync(got).sort()) {
		let b;
		try {
			b = readFileSync(join(want, name));
		} catch {
			diffs.push(`${name}: Go's reference run never published a checkpoint at that size`);
			continue;
		}
		compared++;
		if (!readFileSync(join(got, name)).equals(b)) {
			diffs.push(`${name}: the signed checkpoints differ`);
		}
	}
	return { diffs, compared };
}
