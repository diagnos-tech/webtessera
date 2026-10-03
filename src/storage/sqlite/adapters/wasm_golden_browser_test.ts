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

// Runs the golden compatibility suite (../../objectstore/testing/golden.ts) over the SQLite
// ObjectStore in Chromium, on SQLite's WebAssembly build: every log_<N> fixture Tessera's
// POSIX driver wrote must come out byte for byte, and Go-written logs must carry on.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describeGoldenCompatibility } from "../../objectstore/testing/golden.ts";
import { storeFactory } from "../testing/stores.ts";
import { fromSqliteWasm } from "./wasm.ts";

const sqlite3 = await sqlite3InitModule();

const f = storeFactory(() => ({ database: fromSqliteWasm(new sqlite3.oo1.DB(":memory:")) }));
describeGoldenCompatibility("SqliteObjectStore (sqlite-wasm in memory)", f.newStore, {
	reopen: f.reopen,
	listKeys: f.listKeys,
});
