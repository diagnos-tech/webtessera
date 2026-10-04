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

import { describe, expect, it } from "vitest";
import { formatType } from "./fmt.ts";

describe("gostd/fmt formatType", () => {
	class MyDriver {}
	it("renders a nil interface as Go does", () => {
		expect(formatType(null)).toBe("<nil>");
		expect(formatType(undefined)).toBe("<nil>");
	});
	it("names a value by its constructor", () => {
		expect(formatType(new MyDriver())).toBe("MyDriver");
		expect(formatType({})).toBe("Object");
		expect(formatType([])).toBe("Array");
	});
	it("falls back to typeof where there is no constructor name", () => {
		expect(formatType(Object.create(null))).toBe("object");
		expect(formatType(5)).toBe("number");
		expect(formatType("x")).toBe("string");
		expect(formatType(() => undefined)).toBe("Function");
	});
});
