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
// The entries of this device's log: one small JSON record per event the page logs. The keys are
// always written in the same order, so that the same event always makes the same bytes, which
// is what a receipt proves.

/** DeviceEvent is something that happened on this device, worth a tamper-evident record. */
export interface DeviceEvent {
	/** at is when it happened, by this device's clock (ISO 8601). */
	readonly at: string;
	readonly text: string;
}

const version = "webtessera-example-device-event/v1";

export function encodeEvent(e: DeviceEvent): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ v: version, at: e.at, text: e.text }));
}

/** decodeEvent parses an entry, and throws if it is not an event. */
export function decodeEvent(entry: Uint8Array): DeviceEvent {
	const { v, at, text } = JSON.parse(new TextDecoder().decode(entry)) as Record<string, unknown>;
	if (v !== version || typeof at !== "string" || typeof text !== "string") {
		throw new TypeError("not a device event entry");
	}
	return { at, text };
}
