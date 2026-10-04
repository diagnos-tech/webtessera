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
// Starts the real notary on whichever runtime runs this file, against a temporary SQLite file,
// notarizes a document over HTTP and verifies the receipt offline:
//
//     node scripts/smoke.ts
//     bun scripts/smoke.ts
//     deno run --allow-net --allow-read --allow-write --allow-env scripts/smoke.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey } from "webtessera/note";
import { sha256 } from "../src/encoding.ts";
import { loadRuntime } from "../src/runtime/runtime.ts";
import { startNotary } from "../src/server.ts";
import { newSubmitter, sign } from "../src/submission.ts";
import { verifyNotarization } from "../src/verify_notarization.ts";

const runtime = await loadRuntime();
const dir = await mkdtemp(join(tmpdir(), "webtessera-notary-"));
const { skey, vkey } = generateKey(undefined, "localhost/notary-smoke");
const notary = await startNotary(runtime, {
	notaryKey: skey,
	database: join(dir, "notary.db"),
	port: 0,
	hostname: "127.0.0.1",
});
try {
	const document = new TextEncoder().encode("the contract, as signed");
	const body = await sign(await newSubmitter(), await sha256(document));
	const res = await fetch(new URL("notarize", notary.url), { method: "POST", body: JSON.stringify(body) });
	const receipt = await res.text();
	if (res.status !== 200) {
		throw new Error(`POST /notarize answered ${res.status}: ${receipt}`);
	}
	const n = await verifyNotarization({ receipt, document, vkey, signer: body.publicKey });
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(`smoke: ok on ${runtime.name}: ${notary.url} notarized entry ${n.index}; receipt verified offline`);
} finally {
	await notary.close();
	await rm(dir, { recursive: true, force: true });
}
