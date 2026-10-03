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
// A second tab, played by a worker: it has the page's origin, so the same IndexedDB databases and
// the same Web Locks, and openDeviceKey gives it the same device key. It appends the events it is
// asked to and reports the receipts.

import { openDeviceLog } from "../device_log.ts";
import { encodeEvent } from "../events.ts";

/** SecondTabRequest asks the worker to append count events to the log with this origin. */
export interface SecondTabRequest {
	readonly origin: string;
	readonly count: number;
}

/** SecondTabReceipt is one event the worker appended, with its receipt's text. */
export interface SecondTabReceipt {
	readonly index: string;
	readonly data: Uint8Array;
	readonly receipt: string;
}

addEventListener("message", (event: MessageEvent<SecondTabRequest>) => {
	void (async () => {
		const { origin, count } = event.data;
		const { log } = await openDeviceLog({ origin, checkpointIntervalMs: 100 });
		const appended = await Promise.all(
			Array.from({ length: count }, async (_, i) => {
				const data = encodeEvent({ at: new Date().toISOString(), text: `from the second tab, ${i}` });
				const receipt = await log.append(data);
				return { index: receipt.index.toString(), data, receipt: receipt.text } satisfies SecondTabReceipt;
			}),
		);
		await log.close();
		postMessage(appended);
	})();
});
