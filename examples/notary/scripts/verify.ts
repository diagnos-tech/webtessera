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
// Verifies a notarization offline, with no network:
//
//     node scripts/verify.ts contract.pdf.tlog-proof contract.pdf "$NOTARY_VKEY" [signer key]
//
// It exits 0 if the receipt proves that the notary logged this document's digest, signed by
// the submitter (and by the expected signer, if one is given), and 1 with the reason otherwise.

import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";
import { NotarizationError, verifyNotarization } from "../src/verify_notarization.ts";

const [receiptFile, documentFile, vkey, signer] = argv.slice(2);
if (receiptFile === undefined || documentFile === undefined || vkey === undefined) {
	say("usage: node scripts/verify.ts <receipt.tlog-proof> <document> <notary vkey> [signer public key]");
	exit(2);
}

try {
	const n = await verifyNotarization({
		receipt: await readFile(receiptFile),
		document: await readFile(documentFile),
		vkey,
		...(signer === undefined ? {} : { signer }),
	});
	say(`OK: ${documentFile} is entry ${n.index} of the notary's log, notarized at ${n.notarizedAt.toISOString()}`);
	say(`    signed by ${n.signer}, proven against a checkpoint of ${n.logSize} entries`);
} catch (err) {
	if (!(err instanceof NotarizationError)) {
		throw err;
	}
	say(`FAIL (${err.reason}): ${err.message}`);
	exit(1);
}

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(line);
}
