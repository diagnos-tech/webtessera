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
// The log server's routes: Tessera's conventional `POST /add` for writers, and the
// tlog-tiles read API (https://c2sp.org/tlog-tiles) for everyone else. It is a plain fetch
// handler over a ServerLog, so this one file runs wherever Request and Response do: Node,
// Bun and Deno (see main.ts), and a Cloudflare Worker (see ../../edge).

import {
	addErrorResponse,
	addResponse,
	combineHandlers,
	type Handler,
	MaxEntryBytes,
	readEntryBody,
} from "webtessera/http";
import type { ServerLog } from "webtessera/server";

/** LogServerOptions configures newLogServer. */
export interface LogServerOptions {
	/**
	 * onError is told about every failure that becomes a 500 response. Log it: the response
	 * itself says only that the log failed, since an error's text can describe the server.
	 */
	readonly onError?: (err: unknown) => void;
}

/**
 * newLogServer returns the server's fetch handler: `POST /add`, and `GET`/`HEAD` on the
 * checkpoint, tiles and entry bundles. Anything else is a 404.
 */
export function newLogServer(log: ServerLog, options: LogServerOptions = {}): (request: Request) => Promise<Response> {
	return combineHandlers(newAddHandler(log, options), log.handler);
}

/**
 * newAddHandler answers `POST /add`, whose body is the entry, with the entry's index as a bare
 * decimal: the answer Tessera's own personalities give, so its tooling (the hammer load
 * tester, say) can drive this server unmodified.
 */
export function newAddHandler(log: ServerLog, options: LogServerOptions = {}): Handler {
	return async (request) => {
		if (new URL(request.url).pathname !== "/add") {
			return undefined;
		}
		if (request.method !== "POST") {
			return text(405, "method not allowed", { Allow: "POST" });
		}
		// The body is read as it streams, and abandoned as soon as it is larger than an entry
		// bundle can hold, so an oversized upload is never buffered.
		const entry = await readEntryBody(request);
		if (entry === undefined) {
			return text(413, `an entry holds at most ${MaxEntryBytes} bytes`);
		}
		try {
			// append resolves once a published checkpoint commits to the entry, so a writer that
			// gets an index back can fetch its inclusion proof straight away.
			const receipt = await log.append(entry);
			return addResponse(receipt.index);
		} catch (err) {
			options.onError?.(err);
			// 503 with Retry-After when the log pushes back, so writers slow down; 500 otherwise.
			return addErrorResponse(err);
		}
	};
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(`${message}\n`, {
		status,
		headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
	});
}
