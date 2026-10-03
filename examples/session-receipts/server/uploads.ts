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
// Where a browser uploads its log for the server to commit: `PUT <uploads><tlog-tiles path>`,
// in the order webtessera/mirror writes a log, tiles and entry bundles first and the checkpoint
// last. Uploads are staged unverified; the checkpoint is the signal to commit them, which
// verifies everything (committer.ts). `GET <uploads>checkpoint` answers with the committed
// checkpoint, so that the browser uploads only what is new since.

import { type Handler, parseLogPath } from "webtessera/http";
import type { ObjectStore } from "webtessera/storage/objectstore";
import { Routes } from "../shared/protocol.ts";
import { type Committer, stagingPrefix } from "./committer.ts";
import type { Sessions } from "./sessions.ts";

/** UploadOptions configures newUploadHandler. */
export interface UploadOptions {
	readonly sessions: Sessions;
	readonly staging: ObjectStore;
	readonly committer: Committer;
	/** onError is told why a commit failed. */
	readonly onError?: (err: unknown) => void;
}

// maxUploadBytes caps an uploaded resource. A tile is 8 KiB, and a full bundle of interaction
// entries, a few hundred bytes each, well under 1 MiB.
const maxUploadBytes = 1 << 20;

export function newUploadHandler(options: UploadOptions): Handler {
	return async (request) => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith(Routes.sessions)) {
			return undefined;
		}
		const [, hash = "", path = ""] = /^([0-9a-f]{64})\/(.*)$/.exec(url.pathname.slice(Routes.sessions.length)) ?? [];
		const resource = parseLogPath(path);
		if (resource === undefined || resource.kind === "malformed") {
			return text(404, "not a tlog-tiles resource of a session");
		}
		const session = await options.sessions.authorize(request, hash);
		if (session === undefined) {
			return text(401, "unknown session, or not its token", { "WWW-Authenticate": "Bearer" });
		}

		if (resource.kind === "checkpoint" && request.method === "GET") {
			const committed = await options.committer.committed(session);
			return committed === undefined ? text(404, "nothing committed yet") : new Response(committed.slice());
		}
		if (request.method !== "PUT") {
			return text(405, "method not allowed", { Allow: resource.kind === "checkpoint" ? "GET, PUT" : "PUT" });
		}
		if (resource.kind === "checkpoint") {
			try {
				return text(200, `committed ${await options.committer.commit(session)}`);
			} catch (err) {
				options.onError?.(err);
				// Usually an upload the commit could not verify yet: the browser published (and
				// the server cosigned) a newer checkpoint than it uploaded. Uploading again fixes it.
				return text(409, `not committed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const body = await readCapped(request);
		if (body === undefined) {
			return text(413, `an upload holds at most ${maxUploadBytes} bytes`);
		}
		await options.staging.put(stagingPrefix(session) + path, body);
		return new Response(null, { status: 204 });
	};
}

async function readCapped(request: Request): Promise<Uint8Array | undefined> {
	if (Number(request.headers.get("Content-Length") ?? "0") > maxUploadBytes) {
		return undefined;
	}
	const body = new Uint8Array(await request.arrayBuffer());
	return body.length > maxUploadBytes ? undefined : body;
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(`${message}\n`, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
