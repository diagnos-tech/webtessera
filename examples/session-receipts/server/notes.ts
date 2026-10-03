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
// The application under audit: a tiny note store per session, at `/api/notes/<name>`. It stands
// for whatever your server does in the user's space. Nothing in it knows about the log: the
// browser records every exchange with it on its own (client/src/recorder.ts). Notes are kept in
// memory, since they are not the point of the example.

import type { Handler } from "webtessera/http";
import { originHash } from "webtessera/witness";
import { Routes } from "../shared/protocol.ts";
import type { Sessions } from "./sessions.ts";

const maxNoteBytes = 16 << 10;

export function newNotesHandler(sessions: Sessions): Handler {
	const notes = new Map<string, Map<string, string>>();
	return async (request) => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith(Routes.notes)) {
			return undefined;
		}
		const name = url.pathname.slice(Routes.notes.length);
		if (!/^[\w.-]{1,64}$/.test(name)) {
			return text(400, "a note's name is 1 to 64 letters, digits, dots, dashes and underscores");
		}
		// The session is named in a header, since a note path carries no session.
		const session = await sessions.authorize(request, originHash(request.headers.get("Session-Origin") ?? ""));
		if (session === undefined) {
			return text(401, "unknown session, or not its token", { "WWW-Authenticate": "Bearer" });
		}
		const mine = notes.get(session.hash) ?? new Map<string, string>();
		notes.set(session.hash, mine);

		switch (request.method) {
			case "GET": {
				const note = mine.get(name);
				return note === undefined ? text(404, "no such note") : text(200, note);
			}
			case "PUT": {
				const body = await request.text();
				if (body.length > maxNoteBytes) {
					return text(413, `a note holds at most ${maxNoteBytes} characters`);
				}
				mine.set(name, body);
				return text(200, "saved");
			}
			case "DELETE":
				return mine.delete(name) ? text(200, "deleted") : text(404, "no such note");
			default:
				return text(405, "method not allowed", { Allow: "GET, PUT, DELETE" });
		}
	};
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(`${message}\n`, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
