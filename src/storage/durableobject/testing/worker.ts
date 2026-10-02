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

// Test-only Worker for the Durable Object suites (see vitest.workers.config.ts). It
// declares one Durable Object class per storage backend; wrangler.jsonc binds them.
// Excluded from the published build.

import { DurableObject } from "cloudflare:workers";

/**
 * TestObject is the Durable Object the suites run their code in, through
 * runInDurableObject. It has no behaviour of its own.
 */
export class TestObject extends DurableObject {}

/** KvTestObject is KV-backed: wrangler.jsonc declares it under `new_classes`. */
export class KvTestObject extends TestObject {}

/** SqliteTestObject is SQLite-backed: wrangler.jsonc declares it under `new_sqlite_classes`. */
export class SqliteTestObject extends TestObject {}

export default {
	fetch(): Response {
		return new Response("not found", { status: 404 });
	},
};
