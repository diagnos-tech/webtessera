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

// A dedicated module worker for the safe API's Chromium suites. It answers from a second
// JavaScript realm, a browser worker: what runtime it detects, whether webtessera/server
// refuses to load there, and which device key it finds for a log, so that the suites can
// show that a worker is treated as the public environment it is, and shares the page's
// device key. Test-only.

import { openDeviceKey } from "../../browser/device_key.ts";
import { detectRuntime } from "../runtime.ts";

/** RealmRequest is a message from the page to this worker. */
export type RealmRequest =
	| { readonly type: "runtime" }
	| { readonly type: "deviceKey"; readonly origin: string; readonly database: string };

/** RealmReply is a message from this worker to the page. */
export type RealmReply =
	| { readonly type: "runtime"; readonly kind: string; readonly serverImportError: string | undefined }
	| { readonly type: "deviceKey"; readonly vkey: string; readonly extractable: boolean }
	| { readonly type: "error"; readonly message: string };

async function handle(req: RealmRequest): Promise<RealmReply> {
	switch (req.type) {
		case "runtime": {
			let serverImportError: string | undefined;
			try {
				await import("../../server/index.ts");
			} catch (err) {
				serverImportError = err instanceof Error ? err.message : String(err);
			}
			return { type: "runtime", kind: detectRuntime(), serverImportError };
		}
		case "deviceKey": {
			const key = await openDeviceKey(req.origin, { database: req.database });
			return { type: "deviceKey", vkey: key.vkey, extractable: key.extractable };
		}
	}
}

self.onmessage = (event: MessageEvent<RealmRequest>) => {
	handle(event.data).then(
		(reply) => self.postMessage(reply),
		(err: unknown) => self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
	);
};
