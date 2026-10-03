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
// The server as committer: once a browser has uploaded its log, the server copies the log, as of
// the latest checkpoint its own witness cosigned, into the commit sink (an S3 bucket, say). It
// writes nothing it cannot verify: every uploaded tile and entry bundle is checked against that
// checkpoint first, and the checkpoint against what was committed before. So the bucket only
// ever holds the history the server witnessed, which neither side can later rewrite alone.

import { ErrNotExist, errorIs } from "webtessera";
import { parseCheckpoint } from "webtessera/formats/log";
import { newSinkTarget, newVerifiedMirror, type Sink, type Source } from "webtessera/mirror";
import { newVerifier } from "webtessera/note";
import type { ObjectStore } from "webtessera/storage/objectstore";
import type { WitnessServer } from "webtessera/witness";
import type { Session } from "./sessions.ts";

/** Committer commits sessions' logs. */
export interface Committer {
	/** commit copies the session's log, as witnessed, into the sink, and returns the committed size. */
	commit(session: Session, signal?: AbortSignal): Promise<bigint>;
	/** committed returns the session's committed checkpoint, or undefined before the first commit. */
	committed(session: Session): Promise<Uint8Array | undefined>;
}

/** CommitterOptions says where uploads are staged, who witnessed them, and where they go. */
export interface CommitterOptions {
	readonly witness: WitnessServer;
	/** staging holds what browsers upload, unverified, under stagingPrefix(session). */
	readonly staging: ObjectStore;
	readonly sink: Sink;
}

/** stagingPrefix is where a session's uploads are kept until they are committed. */
export function stagingPrefix(session: Session): string {
	return `staging/${session.hash}/`;
}

/** committedPrefix is where a session's log is committed in the sink: a static tlog-tiles log. */
export function committedPrefix(session: Session): string {
	return `sessions/${session.hash}/`;
}

export function newCommitter(options: CommitterOptions): Committer {
	const target = (session: Session) => newSinkTarget(options.sink, { prefix: committedPrefix(session) });
	return {
		commit: (session, signal) =>
			// One commit per session at a time: two would write the same objects.
			options.staging.lock(
				`commit:${session.hash}`,
				async () => {
					const witnessed = await options.witness.latestCheckpoint(session.origin);
					if (witnessed === undefined) {
						throw new Error("the server has not witnessed this log yet");
					}
					const uploaded = newSinkTarget(options.staging, { prefix: stagingPrefix(session) });
					// The browser's uploads, read under the checkpoint the server cosigned rather than
					// any checkpoint the browser uploaded.
					const source: Source = {
						readCheckpoint: async () => witnessed,
						readTile: (l, i, p, s) => uploaded.readTile(l, i, p, s),
						readEntryBundle: (i, p, s) => uploaded.readEntryBundle(i, p, s),
					};
					const verifier = newVerifier(session.vkey);
					const mirror = newVerifiedMirror({ source, target: target(session), origin: session.origin, verifier });
					await mirror.run(signal);
					return parseCheckpoint(witnessed, session.origin, verifier).checkpoint.size;
				},
				signal,
			),
		committed: (session) =>
			target(session)
				.readCheckpoint()
				.catch((err: unknown) => {
					if (errorIs(err, ErrNotExist)) {
						return undefined;
					}
					throw err;
				}),
	};
}
