// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/testonly/testlog.go @ 4a6d9f9
//
// Port note: upstream roots the log in a POSIX temporary directory that `testing.T` removes
// after the test. A browser or edge runtime has no filesystem, so the log lives in a
// MemoryObjectStore instead, which the garbage collector reclaims once the test drops it;
// `TestLog.Root` (the directory path) becomes `TestLog.store`. `t *testing.T` is dropped:
// failures throw, which fails the calling test exactly as `t.Fatalf` would, and
// `t.Context()` becomes the optional trailing signal (docs/decisions/0004). See
// docs/decisions/0140-testonly-and-readme-test-on-the-memory-driver.md.

import { type Appender, type AppendOptions, newAppender } from "../append_lifecycle.ts";
import type { LogReader } from "../lifecycle.ts";
import { MemoryObjectStore, newMemoryDriver } from "../storage/memory/index.ts";
import { generateKey, newSigner, newVerifier, type Verifier } from "../vendor/note/note.ts";

/**
 * NewTestLogResult is what newTestLog returns.
 *
 * Port note: Go returns `(*TestLog, func(context.Context) error)` positionally; a named
 * readonly object is used per docs/decisions/0031-multi-value-returns.md.
 */
export interface NewTestLogResult {
	readonly testLog: TestLog;
	/** shutdown MUST be called when the test has finished with the log. */
	readonly shutdown: (signal?: AbortSignal) => Promise<void>;
}

/**
 * newTestLog creates an in-memory log instance in Appender mode with the provided options.
 *
 * Returns an instance of TestLog containing the various structures created, and a shutdown function
 * which MUST be called when the test has finished with the log.
 */
export async function newTestLog(opts: AppendOptions, signal?: AbortSignal): Promise<NewTestLogResult> {
	const { skey, vkey } = generateKey(undefined, "test");
	const s = newSigner(skey);
	const v = newVerifier(vkey);

	const store = new MemoryObjectStore();
	const driver = newMemoryDriver({ store });

	opts.withCheckpointSigner(s);
	const { appender, shutdown, reader } = await newAppender(driver, opts, signal);

	const testLog: TestLog = {
		store,
		sigVerifier: v,
		logReader: reader,
		appender,
	};

	return { testLog, shutdown };
}

/** TestLog represents an ephemeral in-memory log instance intended for use in tests. */
export interface TestLog {
	/** store holds the log data. */
	readonly store: MemoryObjectStore;
	/** sigVerifier can verify log signatures on its checkpoints. */
	readonly sigVerifier: Verifier;
	/** logReader reads from the log storage directly. */
	readonly logReader: LogReader;
	/** appender provides access to the Appender lifecycle mode for this log. */
	readonly appender: Appender;
}
