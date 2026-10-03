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

// index.ts has no counterpart in Go, where the package itself is the unit of import, so there is
// no upstream test to port. These tests pin the public surface of the package root: the list of
// names is written out in full so that any addition or removal appears in review as a change to
// this file, and a second table checks the surface against the identifiers Go's root package
// exports (docs/decisions/0133-package-root-barrel.md).

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	AddFn,
	Antispam,
	AppenderInit,
	AppendLifecycle,
	Driver,
	Follower,
	Index,
	IndexFuture,
	LogReader,
	NewAppenderResult,
} from "./index.ts";
import * as webtessera from "./index.ts";

describe("package root exports", () => {
	it("exports exactly the documented set of runtime names", () => {
		// Sorted by UTF-16 code unit, which is what Array.prototype.sort does by default: upper-case
		// names first.
		expect(Object.keys(webtessera).sort()).toEqual([
			"AppendOptions",
			"Appender",
			"DefaultAntispamInMemorySize",
			"DefaultBatchMaxAge",
			"DefaultBatchMaxSize",
			"DefaultCheckpointInterval",
			"DefaultCheckpointRepublishInterval",
			"DefaultGarbageCollectionInterval",
			"DefaultPushbackMaxOutstanding",
			"DefaultWitnessTimeout",
			"Entry",
			"ErrNotExist",
			"ErrPushback",
			"ErrPushbackAntispam",
			"ErrPushbackIntegration",
			"MigrationOptions",
			"MigrationTarget",
			"PublicationAwaiter",
			"Witness",
			"WitnessGroup",
			"WitnessOptions",
			"errorIs",
			"newAppendOptions",
			"newAppender",
			"newCertificateTransparencyAppender",
			"newEntry",
			"newMigrationOptions",
			"newMigrationTarget",
			"newPublicationAwaiter",
			"newWitness",
			"newWitnessGroup",
			"newWitnessGroupFromPolicy",
			"withCTLayout",
		]);
	});

	it("exports the type-only names", () => {
		// Types leave no trace at runtime, so these are checked by the type checker: removing or
		// renaming one breaks `tsc`, not this assertion.
		expectTypeOf<AddFn>().toBeFunction();
		expectTypeOf<IndexFuture>().toBeFunction();
		expectTypeOf<Index>().toEqualTypeOf<{ readonly index: bigint; readonly isDup: boolean }>();
		expectTypeOf<Driver>().toBeUnknown();
		expectTypeOf<LogReader>().toHaveProperty("readCheckpoint");
		expectTypeOf<Follower>().toHaveProperty("follow");
		expectTypeOf<Antispam>().toHaveProperty("decorator");
		expectTypeOf<AppendLifecycle>().toHaveProperty("appender");
		expectTypeOf<AppenderInit>().toHaveProperty("reader");
		expectTypeOf<NewAppenderResult>().toHaveProperty("shutdown");
	});

	it("does not export helpers that exist only for tests", () => {
		// Several modules export identifiers that are unexported in Go so that their tests can reach
		// them (docs/decisions/0010-package-private-members.md). None may leak into the public API.
		const testOnly = [
			"identityHash",
			"defaultIDHasher",
			"defaultMerkleLeafHasher",
			"memoizeFuture",
			"convertCTEntry",
			"ctEntriesPath",
			"ctBundleIDHasher",
			"ctMerkleLeafHasher",
			"copyBytes",
			"copyUint16LengthPrefixed",
			"copyUint24LengthPrefixed",
			"awaitFollower",
			"newInMemoryDedup",
			"newCopier",
			"copier",
			"bundle",
			"populateWork",
		];
		for (const name of testOnly) {
			expect(webtessera, name).not.toHaveProperty(name);
		}
	});
});

// goRootExports is every exported identifier of the root `tessera` package at 4a6d9f9, outside
// test files, with the name that stands for it here. `type` entries have no runtime presence and
// are covered by the type-only test above; the rest must be present.
//
// Go's two WithCTLayout methods are not package-level identifiers; they are the one TypeScript
// function withCTLayout.
const goRootExports: { go: string; ts: string; kind: "value" | "type" }[] = [
	{ go: "DefaultAntispamInMemorySize", ts: "DefaultAntispamInMemorySize", kind: "value" },
	{ go: "DefaultBatchMaxAge", ts: "DefaultBatchMaxAge", kind: "value" },
	{ go: "DefaultBatchMaxSize", ts: "DefaultBatchMaxSize", kind: "value" },
	{ go: "DefaultCheckpointInterval", ts: "DefaultCheckpointInterval", kind: "value" },
	{ go: "DefaultCheckpointRepublishInterval", ts: "DefaultCheckpointRepublishInterval", kind: "value" },
	{ go: "DefaultGarbageCollectionInterval", ts: "DefaultGarbageCollectionInterval", kind: "value" },
	{ go: "DefaultPushbackMaxOutstanding", ts: "DefaultPushbackMaxOutstanding", kind: "value" },
	{ go: "DefaultWitnessTimeout", ts: "DefaultWitnessTimeout", kind: "value" },
	{ go: "NewAppendOptions", ts: "newAppendOptions", kind: "value" },
	{ go: "NewAppender", ts: "newAppender", kind: "value" },
	{ go: "AddFn", ts: "AddFn", kind: "type" },
	{ go: "AppendOptions", ts: "AppendOptions", kind: "value" },
	{ go: "Appender", ts: "Appender", kind: "value" },
	{ go: "Index", ts: "Index", kind: "type" },
	{ go: "IndexFuture", ts: "IndexFuture", kind: "type" },
	{ go: "WitnessOptions", ts: "WitnessOptions", kind: "value" },
	{ go: "NewPublicationAwaiter", ts: "newPublicationAwaiter", kind: "value" },
	{ go: "PublicationAwaiter", ts: "PublicationAwaiter", kind: "value" },
	{ go: "NewCertificateTransparencyAppender", ts: "newCertificateTransparencyAppender", kind: "value" },
	{ go: "NewEntry", ts: "newEntry", kind: "value" },
	{ go: "Entry", ts: "Entry", kind: "value" },
	{ go: "Antispam", ts: "Antispam", kind: "type" },
	{ go: "Follower", ts: "Follower", kind: "type" },
	{ go: "LogReader", ts: "LogReader", kind: "type" },
	{ go: "Driver", ts: "Driver", kind: "type" },
	{ go: "ErrPushback", ts: "ErrPushback", kind: "value" },
	{ go: "ErrPushbackAntispam", ts: "ErrPushbackAntispam", kind: "value" },
	{ go: "ErrPushbackIntegration", ts: "ErrPushbackIntegration", kind: "value" },
	{ go: "NewMigrationOptions", ts: "newMigrationOptions", kind: "value" },
	{ go: "NewMigrationTarget", ts: "newMigrationTarget", kind: "value" },
	{ go: "MigrationOptions", ts: "MigrationOptions", kind: "value" },
	{ go: "MigrationTarget", ts: "MigrationTarget", kind: "value" },
	{ go: "NewWitness", ts: "newWitness", kind: "value" },
	{ go: "NewWitnessGroup", ts: "newWitnessGroup", kind: "value" },
	{ go: "NewWitnessGroupFromPolicy", ts: "newWitnessGroupFromPolicy", kind: "value" },
	{ go: "Witness", ts: "Witness", kind: "value" },
	{ go: "WitnessGroup", ts: "WitnessGroup", kind: "value" },
];

describe("package root against Go's root package", () => {
	for (const { go, ts, kind } of goRootExports) {
		if (kind === "value") {
			it(`${go} is exported as ${ts}`, () => {
				expect(webtessera).toHaveProperty(ts);
			});
		}
	}
});
