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
// Commits a session to a real S3-compatible bucket and audits it there, through the same
// chooseSink the server uses. It runs when S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID
// and S3_SECRET_ACCESS_KEY name a bucket (MinIO, AWS S3, Cloudflare R2, ...), and is skipped
// otherwise: session_test.ts covers the same flow with an ObjectStore sink, offline.

import { env } from "node:process";
import { describe, expect, it } from "vitest";
import { newSinkTarget } from "webtessera/mirror";
import { MemoryObjectStore } from "webtessera/storage/memory";
import { originHash } from "webtessera/witness";
import { auditSession } from "../audit/audit.ts";
import { pushLog } from "../client/src/push.ts";
import { recordedFetch } from "../client/src/recorder.ts";
import { committedPrefix } from "../server/committer.ts";
import { chooseSink, S3Variables } from "../server/sink.ts";
import { Routes } from "../shared/protocol.ts";
import { newHarness } from "./harness.ts";

const configured = S3Variables.every((name) => (env[name] ?? "") !== "");

describe.runIf(configured)("with a real S3-compatible bucket", () => {
	it("commits a session's log, and an auditor verifies it in the bucket", async () => {
		// A prefix of its own per run, so runs never see each other's objects.
		const prefix = `session-receipts-test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
		const { sink } = chooseSink({ ...env, S3_PREFIX: prefix }, new MemoryObjectStore());
		const h = newHarness(sink);
		const s = await h.newSession();
		await recordedFetch(s, `${Routes.notes}x`, { method: "PUT", body: "in the bucket" });
		await recordedFetch(s, `${Routes.notes}x`, { method: "GET" });
		expect(await pushLog(s)).toBe(2n);
		await s.log.close();

		const session = { origin: s.origin, vkey: s.log.vkey, hash: originHash(s.origin) };
		const audited = await auditSession({
			log: newSinkTarget(sink, { prefix: committedPrefix(session) }),
			origin: s.origin,
			vkey: s.log.vkey,
			witness: h.witnessVkey,
		});
		expect(audited.interactions.map((i) => i.method)).toEqual(["PUT", "GET"]);
	});
});
