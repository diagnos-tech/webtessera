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

// Deno: Deno's node:sqlite for the database, Deno.serve for the server, which takes the fetch
// handler as is.

import { DatabaseSync } from "node:sqlite";
import { fromSqliteSync } from "webtessera/storage/sqlite";
import { listeningURL, type Runtime } from "./runtime.ts";

export const deno: Runtime = {
	name: "deno",
	openSqlite: (path) => {
		const db = new DatabaseSync(path);
		return { database: fromSqliteSync(db), close: () => db.close() };
	},
	serve: async (handler, { port, hostname }) => {
		const server = Deno.serve({ port, hostname, onListen: () => {} }, handler);
		return { url: listeningURL(hostname, server.addr.port), close: () => server.shutdown() };
	},
};
