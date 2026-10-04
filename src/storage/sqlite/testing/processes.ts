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

// The multi-process append test, shared by the engines that keep a database in a file:
// several child processes (append_process.ts) append to one file at once with the store's
// default options, and the log they leave must be one consistent log. Test-only, Node-only.

import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { expect } from "vitest";
import { newFsck } from "../../../fsck/fsck.ts";
import { defaultMerkleLeafHasher } from "../../../lifecycle.ts";
import { newSinkTarget } from "../../../mirror/sink.ts";
import { parseCheckpoint } from "../../../vendor/formats/log/note.ts";
import { generateKey, newVerifier } from "../../../vendor/note/note.ts";
import type { ObjectStore } from "../../objectstore/objectstore.ts";

/** Engine names the engines append_process.ts can open a file with. */
export type Engine = "node:sqlite" | "libsql";

/**
 * appendFromProcesses has three child processes append perProcess entries each to the log
 * in the SQLite file at path, opened with engine, all at once. It then checks that every
 * entry got a distinct index below the total, and that the log reopen gives back, read as
 * any static tlog-tiles reader would, has a checkpoint of that size and passes fsck.
 */
export async function appendFromProcesses(
	engine: Engine,
	path: string,
	perProcess: number,
	reopen: () => Promise<ObjectStore>,
): Promise<void> {
	const origin = "example.com/webtessera-sqlite-processes";
	const { skey, vkey } = generateKey(undefined, origin);
	const script = decodeURIComponent(new URL("./append_process.ts", import.meta.url).pathname);
	const tags = ["p0", "p1", "p2"];
	const outputs = await Promise.all(
		tags.map(
			(tag) =>
				new Promise<string[]>((resolve, reject) => {
					const child = spawn(execPath, ["--no-warnings", script, engine, path, tag, String(perProcess), skey], {
						stdio: ["ignore", "pipe", "pipe"],
					});
					let out = "";
					let err = "";
					child.stdout.on("data", (d) => {
						out += String(d);
					});
					child.stderr.on("data", (d) => {
						err += String(d);
					});
					child.on("error", reject);
					child.on("close", (code) =>
						code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`${tag} exited ${code}: ${err}`)),
					);
				}),
		),
	);
	const total = tags.length * perProcess;
	const indices = outputs.flat();
	expect(new Set(indices).size).toBe(total);
	expect(indices.every((i) => BigInt(i) < BigInt(total))).toBe(true);

	// Read the log back as any static tlog-tiles reader would.
	const reader = newSinkTarget(await reopen());
	const verifier = newVerifier(vkey);
	const { checkpoint } = parseCheckpoint(await reader.readCheckpoint(), origin, verifier);
	expect(checkpoint.size).toBe(BigInt(total));
	await newFsck(origin, verifier, reader, defaultMerkleLeafHasher, { n: 4 }).check();
}
