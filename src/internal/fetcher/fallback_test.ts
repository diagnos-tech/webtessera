// Copyright 2025 Google LLC. All Rights Reserved.
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
//
// Ported from tessera/internal/fetcher/fallback_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { ErrNotExist } from "../gostd/errors.ts";
import { partialOrFullResource } from "./fallback.ts";

describe("TestFetchPartialOrFullResource", () => {
	const tests: {
		name: string;
		p: number;
		responses: (unknown | undefined)[];
		wantErr: boolean;
	}[] = [
		{
			name: "partial resource found",
			p: 23,
			responses: [undefined],
			wantErr: false,
		},
		{
			name: "partial resource missing, full resource found",
			p: 23,
			responses: [ErrNotExist, undefined],
			wantErr: false,
		},
		{
			name: "partial resource missing, full resource missing",
			p: 23,
			responses: [ErrNotExist, ErrNotExist],
			wantErr: true,
		},
		{
			name: "full resource found",
			p: 0,
			responses: [undefined],
			wantErr: false,
		},
		{
			name: "full resource missing",
			p: 0,
			responses: [ErrNotExist],
			wantErr: true,
		},
	];

	for (const test of tests) {
		it(test.name, async () => {
			let i = 0;
			const run = async (): Promise<Uint8Array> => {
				const response = test.responses[i];
				i++;
				if (response !== undefined) {
					throw response;
				}
				return new Uint8Array([0x72, 0x65, 0x74]); // "ret"
			};

			let gotErr = false;
			try {
				await partialOrFullResource(test.p, run);
			} catch {
				gotErr = true;
			}
			expect(gotErr).toBe(test.wantErr);
		});
	}
});
