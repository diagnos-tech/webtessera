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
// The notary's one route, `POST /notarize`: it checks the submitter's signature over the
// document's digest, appends a record of the two to the log, and answers with a receipt that
// proves the record is in the log. The log's read API is served next to it (see server.ts), so
// anyone can monitor everything the notary ever notarized.

import { addErrorResponse, type Handler, readEntryBody } from "webtessera/http";
import type { ServerLog } from "webtessera/server";
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
			// The receipt carries the record in its extra line, so that one `.tlog-proof` file
			// holds everything a verifier needs besides the document. The tlog-proof format does
			// not authenticate extra data, and verify_notarization.ts does not trust it as such:
			// verifyReceipt with dataInExtra proves that exactly these bytes are an entry of the
			// log before the verifier reads a field of them.
			const receipt = await log.append(record, { extraData: record });
			return new Response(receipt.text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
		} catch (err) {
			options.onError?.(err);
			return addErrorResponse(err);
		}
	};
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(`${message}\n`, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
