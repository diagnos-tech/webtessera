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

// The one place where Node, Bun and Deno differ for this server: which SQLite binding opens a
// database file, and how a fetch handler is put on a port. Everything else in the example is
// web-standard (Request, Response, fetch, WebCrypto) and runs unchanged on all three.

import { detectRuntime } from "webtessera/server";
import type { SqlDatabase } from "webtessera/storage/sqlite";

/** FetchHandler is what every runtime's HTTP server calls: a web-standard request in, a response out. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** Listening is a running HTTP server. */
export interface Listening {
	/** url is where the server answers, with a trailing slash. */
	readonly url: URL;
	/** close stops accepting connections. */
	close(): Promise<void>;
}

/** SqliteConnection is an open database, adapted for webtessera, and the way to close it. */
export interface SqliteConnection {
	readonly database: SqlDatabase;
	close(): void;
}

/** ServeOptions says where to listen. Port 0 picks a free port. */
export interface ServeOptions {
	readonly port: number;
	readonly hostname: string;
}

/** Runtime adapts the example to the JavaScript runtime it was started on. */
export interface Runtime {
	readonly name: "node" | "bun" | "deno";
	/** openSqlite opens a SQLite database file, or a private in-memory one for ":memory:". */
	openSqlite(path: string): SqliteConnection;
	/** serve answers HTTP requests with handler until closed. */
	serve(handler: FetchHandler, options: ServeOptions): Promise<Listening>;
}

/**
 * loadRuntime returns the adapter for the runtime this code is running on. The adapters are
 * imported lazily, because each one imports modules that only its own runtime has
 * (`bun:sqlite` exists only on Bun, and Bun has no `node:sqlite`).
 */
export async function loadRuntime(): Promise<Runtime> {
	const kind = detectRuntime();
	switch (kind) {
		case "node":
			return (await import("./node.ts")).node;
		case "bun":
			return (await import("./bun.ts")).bun;
		case "deno":
			return (await import("./deno.ts")).deno;
		default:
			throw new Error(`this example runs on Node.js, Bun or Deno, not ${kind}`);
	}
}

/** listeningURL formats the URL of a server listening on hostname and port. */
export function listeningURL(hostname: string, port: number): URL {
	return new URL(`http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}/`);
}
