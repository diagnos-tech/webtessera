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

// The S3 sink's requests as workerd sees them: the test Worker's own fetch handler stands in
// for the service, so every request goes through workerd's fetch, which refuses request
// options it does not support.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newS3Sink } from "./s3.ts";

const options = {
	bucket: "logs",
	region: "auto",
	accessKeyId: "AKID",
	secretAccessKey: "secret",
	fetch: (input: string, init?: RequestInit) => SELF.fetch(input, init),
	attempts: 1,
};

describe("newS3Sink in workerd", () => {
	it("sends requests workerd accepts, and refuses redirects", async () => {
		const sink = newS3Sink({ ...options, endpoint: "http://s3.test" });
		expect(await sink.get("checkpoint")).toBeUndefined();
		await expect(sink.put("tile/0/000", new Uint8Array(32))).rejects.toThrow(/S3 PUT logs\/tile\/0\/000: 404/);

		const redirecting = newS3Sink({ ...options, endpoint: "http://s3.test", prefix: "x/", bucket: "redirect" });
		await expect(redirecting.put("redirect", new Uint8Array(1))).rejects.toThrow(/redirect refused/);
	});
});
