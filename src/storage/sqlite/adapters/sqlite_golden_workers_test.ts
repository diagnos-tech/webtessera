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
// ObjectStore inside workerd, on Cloudflare D1 and on a SQLite-backed Durable Object: every
// log_<N> fixture Tessera's POSIX driver wrote must come out byte for byte, and Go-written
// logs must carry on.

import { env } from "cloudflare:workers";
import { describeGoldenCompatibility } from "../../objectstore/testing/golden.ts";
import { storeFactory, uniqueNamespace } from "../testing/stores.ts";
import { inObject } from "../testing/workers/objects.ts";
import { fromD1 } from "./d1.ts";

const d1 = storeFactory(
	() => ({ database: fromD1(env.DB), namespace: uniqueNamespace() }),
	{},
	() => fromD1(env.DB),
);
describeGoldenCompatibility("SqliteObjectStore (D1)", d1.newStore, { reopen: d1.reopen, listKeys: d1.listKeys });

const ns = env.SQLITE_OBJECT;
const durableObject = storeFactory(() => ({ database: inObject(ns.get(ns.newUniqueId())) }));
describeGoldenCompatibility("SqliteObjectStore (Durable Object)", durableObject.newStore, {
	reopen: durableObject.reopen,
	listKeys: durableObject.listKeys,
});
