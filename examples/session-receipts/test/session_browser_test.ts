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
// The browser half, in a real Chromium, against the real server: a device key that cannot be
// exported, a log in IndexedDB, and the page's own fetch, exactly as client/src/main.ts uses
// them. The Node suite (session_test.ts) covers the guardrails; this proves the browser path.

import { describe, expect, it } from "vitest";
import { openDeviceKey, verifyReceipt } from "webtessera/browser";
import { pushLog } from "../client/src/push.ts";
import { recordedFetch } from "../client/src/recorder.ts";
import { openSession, registerSession, witnessPolicy } from "../client/src/session.ts";
import { encodeInteraction } from "../shared/interaction.ts";
import { newSessionOrigin, Routes } from "../shared/protocol.ts";

describe("session receipts in Chromium", () => {
	it("records exchanges in IndexedDB under a device key, cosigned over HTTP, and resumes after a reload", async () => {
		// The test page's origin, whose proxy routes reach the server, as the dev server's do.
		const server = new URL(location.origin);
		const key = await openDeviceKey(newSessionOrigin(location.host));
		expect(key.extractable).toBe(false);
		const info = await registerSession({ server, key });

		const session = await openSession(info, { server, key });
		const r = await recordedFetch(session, `${Routes.notes}x`, { method: "PUT", body: "written in a browser" });
		expect(r.status).toBe(200);
		const v = verifyReceipt(r.receipt, {
			vkey: key.vkey,
			data: encodeInteraction(r.interaction),
			witnesses: witnessPolicy(info),
		});
		expect(v.cosignedBy).toEqual(["witness.localhost"]);
		expect(await pushLog(session)).toBe(1n);
		await session.log.close();

		// What a reload does: the key and the log are found again in IndexedDB.
		const again = await openSession(info, { server, key: await openDeviceKey(info.origin) });
		await recordedFetch(again, `${Routes.notes}x`, { method: "GET" });
		expect((await again.log.latestCheckpoint()).size).toBe(2n);
		expect(await pushLog(again)).toBe(2n);
		await again.log.close();
	});
});
