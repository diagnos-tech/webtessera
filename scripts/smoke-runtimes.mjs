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

// End-to-end smoke test of the built package (dist/) on whichever JavaScript
// runtime executes this file. CI runs it under Node, Bun and Deno, which is what
// backs the README's claim that webtessera runs on all three.
//
// Usage, after `bun run build`:
//
//     node scripts/smoke-runtimes.mjs
//     bun scripts/smoke-runtimes.mjs
//     deno run --allow-read scripts/smoke-runtimes.mjs
//
// It appends a few hundred entries to an in-memory log, waits for a checkpoint
// that commits to the last one, verifies the log's signature on that checkpoint,
// and verifies an inclusion proof for the entry against it. Then it does the same
// through the safe API's entry points, webtessera/server and webtessera/browser,
// which must load on every server runtime and recognise it as one, and generates a
// key pair with generateLogKeyPair and with the `webtessera keygen` command. It uses only
// runtime-neutral APIs, so it needs no permissions beyond reading the package.

import { verifyReceipt } from "../dist/browser/index.js";
import { run as runCommand } from "../dist/cli/cli.js";
import { fetchCheckpoint, newProofBuilder } from "../dist/client/index.js";
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "../dist/index.js";
import { detectRuntime, generateLogKeyPair, importLogKey, openServerLog } from "../dist/server/index.js";
import { newMemoryDriver } from "../dist/storage/memory/index.js";
import { verifyInclusion } from "../dist/vendor/merkle/proof/index.js";
import { DefaultHasher } from "../dist/vendor/merkle/rfc6962/rfc6962.js";
import { generateKey, newSigner, newVerifier } from "../dist/vendor/note/note.js";

const entries = 300;
const enc = new TextEncoder();

const { skey, vkey } = generateKey(undefined, "example.com/smoke");
const ac = new AbortController();
const opts = newAppendOptions().withCheckpointSigner(newSigner(skey)).withBatching(256, 10).withCheckpointInterval(100);
const { appender, shutdown, reader } = await newAppender(newMemoryDriver(), opts, ac.signal);
const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 20, ac.signal);

for (let i = 0; i < entries; i++) {
	appender.add(newEntry(enc.encode(`entry ${i}`)));
}
const data = enc.encode("the last entry");
const [index] = await awaiter.await(appender.add(newEntry(data)));

const verifier = newVerifier(vkey);
const { checkpoint } = await fetchCheckpoint((s) => reader.readCheckpoint(s), verifier, verifier.name());
const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => reader.readTile(l, i, p, s));
const proof = await proofs.inclusionProof(index.index);
verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);

await shutdown();
ac.abort();

if (index.index !== BigInt(entries) || checkpoint.size < index.index + 1n) {
	throw new Error(`unexpected result: index ${index.index}, checkpoint size ${checkpoint.size}`);
}

// The safe API: the same key, imported into WebCrypto where the runtime supports Ed25519,
// signs a log whose receipt verifies offline through the browser entry point.
const runtime = detectRuntime();
if (!["node", "bun", "deno"].includes(runtime)) {
	throw new Error(`webtessera/server detected the runtime as ${runtime}`);
}
const key = await importLogKey(skey);
const safeLog = await openServerLog({ key, storage: { memory: true } });
const receipt = await safeLog.append(data);
const verified = verifyReceipt(receipt.text, { vkey, data });
await safeLog.close();
if (verified.index !== 0n || receipt.checkpoint.size !== 1n) {
	throw new Error(`unexpected receipt: index ${verified.index}, checkpoint size ${receipt.checkpoint.size}`);
}

// A key pair for a secret store, from code and from the `webtessera keygen` command (whose
// executable is cli.js's run, given process.argv), opens as the same key.
const pair = generateLogKeyPair("example.com/smoke-keygen");
if ((await importLogKey(pair.skey)).vkey !== pair.vkey) {
	throw new Error("generateLogKeyPair: the signer key does not open as its verifier key");
}
const keygen = runCommand(["keygen", "example.com/smoke-keygen", "--json"]);
const generated = JSON.parse(keygen.stdout);
if (keygen.code !== 0 || (await importLogKey(generated.skey)).vkey !== generated.vkey) {
	throw new Error(`webtessera keygen: exit ${keygen.code}: ${keygen.stderr}`);
}

// biome-ignore lint/suspicious/noConsole: the script's output is its report; console is the one sink every runtime shares.
console.log(
	`smoke-runtimes: ok (index ${index.index} proven in a tree of ${checkpoint.size}; ` +
		`safe API on ${runtime} with a ${key.extractable ? "extractable" : "non-extractable"} ${key.backend} key; ` +
		"keygen ok)",
);
