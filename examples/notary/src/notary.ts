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
// The notary's one route, `POST /notarize`: it checks the submitter's signature over the
// document's digest, appends a record of the two to the log, and answers with a receipt that
// proves the record is in the log. The log's read API is served next to it (see server.ts), so
// anyone can monitor everything the notary ever notarized.

import { TLogProof } from "webtessera/formats/proof";
import { addErrorResponse, type Handler, readEntryBody } from "webtessera/http";
import type { Receipt, ServerLog } from "webtessera/server";
import { encodeRecord } from "./record.ts";
import { parseSubmission, verifySubmission } from "./submission.ts";

/** NotaryOptions configures newNotaryHandler. */
export interface NotaryOptions {
	/** now returns the time to record, in milliseconds since the Unix epoch. Defaults to Date.now. */
	readonly now?: () => number;
	/** onError is told about every failure that becomes a 500 response. */
	readonly onError?: (err: unknown) => void;
}

// maxRequestBytes caps a request body: the JSON of a submission is well under 300 bytes.
const maxRequestBytes = 4096;

/** newNotaryHandler returns the handler for `POST /notarize`. */
export function newNotaryHandler(log: ServerLog, options: NotaryOptions = {}): Handler {
	const now = options.now ?? Date.now;
	return async (request) => {
		if (new URL(request.url).pathname !== "/notarize") {
			return undefined;
		}
		if (request.method !== "POST") {
			return text(405, "method not allowed", { Allow: "POST" });
		}
		const body = await readEntryBody(request, maxRequestBytes);
		if (body === undefined) {
			return text(413, `a request holds at most ${maxRequestBytes} bytes`);
		}
		let submission: ReturnType<typeof parseSubmission>;
		try {
			submission = parseSubmission(JSON.parse(new TextDecoder().decode(body)));
		} catch (err) {
			return text(400, err instanceof Error ? err.message : "malformed request");
		}
		// Only what its key holder vouched for goes in the log: the record is evidence against
		// that key, so the notary must not let anyone else make it.
		if (!(await verifySubmission(submission))) {
			return text(403, "the signature is not the public key's signature over the digest");
		}
		const record = encodeRecord({ notarizedAt: BigInt(now()), ...submission });
		try {
			const receipt = await log.append(record);
			return new Response(withRecord(receipt, record), {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		} catch (err) {
			options.onError?.(err);
			return addErrorResponse(err);
		}
	};
}

/**
 * withRecord returns the receipt with the record in its extra data, so that one
 * `.tlog-proof` file carries everything a verifier needs besides the document.
 *
 * The tlog-proof format does not authenticate extra data, and verifiers must not trust it as
 * such. Nor does this example's: verify_notarization.ts proves that exactly these bytes are an
 * entry of the log before it reads a field of them.
 *
 * The safe API's receipts carry no extra data, so the receipt is re-encoded with the ported
 * tlog-proof encoder from webtessera/formats/proof.
 */
function withRecord(receipt: Receipt, record: Uint8Array): string {
	const { index, hashes, checkpoint } = receipt.proof;
	return new TextDecoder().decode(new TLogProof({ index, hashes, checkpoint, extraData: record }).marshal());
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(`${message}\n`, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
