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

// fromRqlite's requests as workerd sees them: the test Worker's own fetch handler stands in
// for the rqlite node, so every request goes through workerd's fetch, which refuses request
// options it does not support.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fromRqlite } from "./rqlite.ts";

const fetchVia = (input: string, init?: RequestInit) => SELF.fetch(input, init);

describe("fromRqlite in workerd", () => {
	it("sends requests workerd accepts, refusing redirects unless told to follow them", async () => {
		const plain = fromRqlite({ url: "http://rqlite.test", fetch: fetchVia });
		await expect(plain.query({ sql: "SELECT 1", params: [] })).rejects.toThrow(/HTTP 404: not found/);

		const refusing = fromRqlite({
			url: "http://rqlite.test",
			fetch: (_input, init) => fetchVia("http://rqlite.test/redirect", init),
		});
		await expect(refusing.query({ sql: "SELECT 1", params: [] })).rejects.toThrow(
			/replied with a redirect, which is not followed: 307/,
		);

		const following = fromRqlite({ url: "http://rqlite.test", fetch: fetchVia, followRedirects: true });
		await expect(following.query({ sql: "SELECT 1", params: [] })).rejects.toThrow(/HTTP 404: not found/);
	});
});
