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
// There is no log_test.go upstream. These tests pin the sentinel identity and exact
// message text of the pushback errors, since ADR-0004 requires message text to match Go
// byte-for-byte and personalities are documented to test for ErrPushback with errorIs
// "whether or not it is wrapped".

import { describe, expect, expectTypeOf, it } from "vitest";
import { errorIs } from "./internal/gostd/errors.ts";
import { type Driver, ErrPushback, ErrPushbackAntispam, ErrPushbackIntegration } from "./log.ts";

describe("log", () => {
	it("ErrPushback has Go's exact message text", () => {
		expect(ErrPushback.message).toBe("pushback");
	});

	it('ErrPushbackAntispam renders like Go\'s fmt.Errorf("antispam %w", ErrPushback)', () => {
		expect(ErrPushbackAntispam.message).toBe("antispam pushback");
	});

	it('ErrPushbackIntegration renders like Go\'s fmt.Errorf("integration %w", ErrPushback)', () => {
		expect(ErrPushbackIntegration.message).toBe("integration pushback");
	});

	it("errorIs(ErrPushbackAntispam, ErrPushback) is true, matching Go's errors.Is contract", () => {
		expect(errorIs(ErrPushbackAntispam, ErrPushback)).toBe(true);
	});

	it("errorIs(ErrPushbackIntegration, ErrPushback) is true, matching Go's errors.Is contract", () => {
		expect(errorIs(ErrPushbackIntegration, ErrPushback)).toBe(true);
	});

	it("ErrPushbackAntispam and ErrPushbackIntegration are distinct errors", () => {
		expect(ErrPushbackAntispam).not.toBe(ErrPushbackIntegration);
	});

	it("a plain error does not match ErrPushback", () => {
		expect(errorIs(new Error("pushback"), ErrPushback)).toBe(false);
	});

	it("Driver is the top type, mirroring Go's `type Driver any`", () => {
		// A compile-time assertion: tsc rejects this file if Driver is ever narrowed (or
		// widened to `any`, which toEqualTypeOf<unknown> also rejects).
		expectTypeOf<Driver>().toEqualTypeOf<unknown>();
	});
});
