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

// Node.js: node:sqlite for the database, node:http for the server. Node has no fetch-style
// server of its own, so webtessera/http's toNodeListener adapts the handler.

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { toNodeListener } from "webtessera/http";
import { fromSqliteSync } from "webtessera/storage/sqlite";
import { listeningURL, type Runtime } from "./runtime.ts";

export const node: Runtime = {
	name: "node",
	openSqlite: (path) => {
		const db = new DatabaseSync(path);
		return { database: fromSqliteSync(db), close: () => db.close() };
	},
	serve: (handler, { port, hostname }) =>
		new Promise((resolve, reject) => {
			const server = createServer(toNodeListener(handler));
			server.once("error", reject);
			server.listen(port, hostname, () => {
				resolve({
					url: listeningURL(hostname, server.address().port),
					close: () => new Promise((done) => server.close(() => done())),
				});
			});
		}),
};
