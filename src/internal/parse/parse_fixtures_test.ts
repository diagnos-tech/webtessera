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

// Cross-check for internal/parse against golden checkpoints.
//
// There is no fixture generated from `parse.CheckpointUnsafe` itself — see the
// TODO(gustavo) in docs/PORTING-MAP.md. What exists is the `checkpoint` fixture,
// emitted by running `formats/log`'s marshaller and parser, and `CheckpointUnsafe`
// is by definition the fast path that must agree with that parser on well-formed
// input. So this asserts exactly that, over real Go-produced checkpoint bodies.
//
// **Only the accepted cases are used.** The two parsers deliberately disagree on
// rejection: `log.UnmarshalCheckpoint` rejects an empty origin line, while
// `CheckpointUnsafe` accepts it — upstream's own parse_test.go has an "Empty origin"
// case asserting success. Asserting the fixture's error cases here would be asserting
// against the wrong function's behaviour.

import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, type Fixture, hexToBytes, loadFixture, u64 } from "../../testonly/fixtures.ts";
import { checkpointUnsafe } from "./parse.ts";

interface CheckpointFixture {
	readonly unmarshal: readonly {
		desc: string;
		raw: string;
		wantOrigin: string;
		wantSize: string;
		wantHash: string;
		wantErr: boolean;
	}[];
}

describe("golden fixtures: checkpoint (cross-check)", () => {
	let fx: Fixture<CheckpointFixture>;

	beforeAll(async () => {
		fx = await loadFixture<CheckpointFixture>("checkpoint");
	});

	it("checkpointUnsafe agrees with formats/log on well-formed checkpoints", () => {
		const accepted = fx.unmarshal.filter((c) => !c.wantErr);
		expect(accepted.length).toBeGreaterThan(0);
		for (const c of accepted) {
			const got = checkpointUnsafe(hexToBytes(c.raw));
			expect(got.origin, `${c.desc}: origin`).toBe(c.wantOrigin);
			expect(got.size, `${c.desc}: size`).toBe(u64(c.wantSize));
			expect(bytesToHex(got.hash), `${c.desc}: hash`).toBe(c.wantHash);
		}
	});
});
