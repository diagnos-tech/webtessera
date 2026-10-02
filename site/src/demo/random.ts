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

// Plausible log entries for the demo's bulk buttons: the kinds of records transparency
// logs hold, each with a random digest.

import { toHex } from "../shared/bytes.ts";

const kinds = [
	["release", "app-2.4.1.tar.gz"],
	["commit", "main"],
	["cert", "shop.example"],
	["sbom", "service:api"],
	["build", "ci/run"],
	["key", "alice@example.org"],
	["firmware", "router-fw-9.1"],
	["model", "weights-v3"],
] as const;

/** randomEntries returns n entries such as "release app-2.4.1.tar.gz sha256:3fa1…". */
export function randomEntries(n: number): string[] {
	const out: string[] = [];
	const bytes = new Uint8Array(12);
	for (let i = 0; i < n; i++) {
		crypto.getRandomValues(bytes);
		const [kind, subject] = kinds[(bytes[0] ?? 0) % kinds.length] ?? kinds[0];
		out.push(`${kind} ${subject} sha256:${toHex(bytes.subarray(1))}`);
	}
	return out;
}
