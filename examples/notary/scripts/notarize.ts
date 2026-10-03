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
// Notarizes a document, as a submitter would:
//
//     node scripts/notarize.ts http://127.0.0.1:8081/ contract.pdf
//
// It hashes the document locally (the document itself never leaves this machine), signs the
// digest with the submitter's key (generated into submitter.key on first use), sends the two
// to the notary, and saves the receipt next to the document as contract.pdf.tlog-proof.

import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";
import { fromBase64, sha256, toBase64 } from "../src/encoding.ts";
import { newSubmitter, type Submitter, sign } from "../src/submission.ts";

const [notary, document] = argv.slice(2);
if (notary === undefined || document === undefined) {
	say("usage: node scripts/notarize.ts <notary URL> <document>");
	exit(2);
}

const submitter = await loadOrCreateSubmitter("submitter.key");
const body = await sign(submitter, await sha256(await readFile(document)));
const res = await fetch(new URL("notarize", notary), { method: "POST", body: JSON.stringify(body) });
const answer = await res.text();
if (!res.ok) {
	say(`the notary refused (${res.status}): ${answer.trim()}`);
	exit(1);
}
await writeFile(`${document}.tlog-proof`, answer);
say(`notarized ${document}; receipt saved to ${document}.tlog-proof`);
say(`signed by ${body.publicKey}`);

/**
 * loadOrCreateSubmitter keeps the submitter's key in a file, as PKCS#8. A real submitter keeps
 * it wherever they keep signing keys; it is what makes the record theirs.
 */
async function loadOrCreateSubmitter(path: string): Promise<Submitter> {
	const saved = await readFile(path, "utf8").catch(() => undefined);
	if (saved !== undefined) {
		const { privateKey, publicKey } = JSON.parse(saved) as { privateKey: string; publicKey: string };
		const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), "Ed25519", false, ["sign"]);
		return { privateKey: key, publicKey: fromBase64(publicKey) };
	}
	const created = await newSubmitter(true);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", created.privateKey));
	await writeFile(path, JSON.stringify({ privateKey: toBase64(pkcs8), publicKey: toBase64(created.publicKey) }));
	return created;
}

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: the outcome is this script's output.
	console.log(line);
}
