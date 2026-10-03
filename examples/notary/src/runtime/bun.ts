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

// Bun: bun:sqlite for the database, Bun.serve for the server, which takes the fetch handler as is.

import { Database } from "bun:sqlite";
import { fromSqliteSync } from "webtessera/storage/sqlite";
import { listeningURL, type Runtime } from "./runtime.ts";

export const bun: Runtime = {
	name: "bun",
	openSqlite: (path) => {
		const db = new Database(path);
		return { database: fromSqliteSync(db), close: () => db.close() };
	},
	serve: async (handler, { port, hostname }) => {
		const server = Bun.serve({ port, hostname, fetch: handler });
		return {
			url: listeningURL(hostname, server.port),
			close: async () => {
				await server.stop(true);
			},
		};
	},
};
