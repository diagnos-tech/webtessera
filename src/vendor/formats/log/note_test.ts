// Copyright 2021 Google LLC. All Rights Reserved.
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
//
// Ported from github.com/transparency-dev/formats/log/note_test.go
// @ v0.0.0-20251017110053-404c0d5b696c

import { describe, expect, it } from "vitest";
import { fromUTF8, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { type Note, newSigner, newVerifier, type Signer, sign } from "../../note/note.ts";
import { Checkpoint } from "./checkpoint.ts";
import { ParseCheckpointError, parseCheckpoint } from "./note.ts";

const logVK = "Log+2271c621+AemuH5ooBpEPcr+W8onrjA1NfuzBVHdezakU81Ekarvs";
const logSK = "PRIVATE+KEY+Log+2271c621+AdEIq9FLRQni54Wg68T96VJO+iayOaulswav2DUMKgvQ";

const known1VK = "Known+451c786d+AXAQ0T7lbwuY4ABJ9/MYY9bWV3hmSyOGVt2x42NkmdUH";
const known1SK = "PRIVATE+KEY+Known+451c786d+AQPRoE2+Z+Ed1HaHBA9F/FfracvcZ2rDU39kCecMEoci";

const known2VK = "KnownAgain+4893b26c+AQ+LR7BFF/F/dkpIBjBpSvT0crkteizuUkavAoGeaYMj";
const known2SK = "PRIVATE+KEY+KnownAgain+4893b26c+ARhZda/l25zjGZswYLDZsLNRzNpmv5wYTN9IoTr1OJ2+";

const unknownSK = "PRIVATE+KEY+Unknown+fdbb2e08+Aav2knTC6orbhXX8pMWuNiWgO+Wwk2DB+h1eU2Q1W1nU";

describe("formats/log note", () => {
	describe("TestParseCheckpoint", () => {
		const logVerifier = newVerifier(logVK);
		const known1Verifier = newVerifier(known1VK);
		const known2Verifier = newVerifier(known2VK);

		const cp = new Checkpoint({
			origin: "TestParseCheckpoint",
			size: 42n,
			hash: toUTF8("abcdef"),
		});
		const noteBody = fromUTF8(cp.marshal());

		const lns = newSigner(logSK);
		const k1ns = newSigner(known1SK);
		const k2ns = newSigner(known2SK);
		const uns = newSigner(unknownSK);

		const tests: Array<{
			desc: string;
			logID: string;
			noteBody: string;
			sigs: Signer[];
			wantErr: boolean;
			wantSigs: number;
		}> = [
			{ desc: "no sigs", logID: "TestParseCheckpoint", noteBody, sigs: [], wantErr: true, wantSigs: 0 },
			{
				desc: "just log sig",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns],
				wantErr: false,
				wantSigs: 1,
			},
			{
				desc: "bad body good sigs",
				logID: "TestParseCheckpoint",
				noteBody: "if this is a valid checkpoint then I'll eat my hat\n",
				sigs: [lns],
				wantErr: true,
				wantSigs: 1,
			},
			{
				desc: "log and known1 sig",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns],
				wantErr: false,
				wantSigs: 2,
			},
			{
				desc: "log and known2 sig",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns],
				wantErr: false,
				wantSigs: 2,
			},
			{
				desc: "log, known1, and unknown sig",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns, uns],
				wantErr: false,
				wantSigs: 2,
			},
			{
				desc: "just required sigs",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns, k2ns],
				wantErr: false,
				wantSigs: 3,
			},
			{
				desc: "one verifier signs twice",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns, k1ns],
				wantErr: false,
				wantSigs: 2,
			},
			{
				desc: "just required sigs in mixed order",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [k2ns, lns, k1ns],
				wantErr: false,
				wantSigs: 3,
			},
			{
				desc: "all sigs",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [lns, k1ns, k2ns, uns],
				wantErr: false,
				wantSigs: 3,
			},
			{
				desc: "just known",
				logID: "TestParseCheckpoint",
				noteBody,
				sigs: [k1ns, k2ns],
				wantErr: true,
				wantSigs: 2,
			},
			{
				desc: "all sigs but wrong logID",
				logID: "this is not the logID you are looking for",
				noteBody,
				sigs: [lns, k1ns, k2ns, uns],
				wantErr: true,
				wantSigs: 3,
			},
		];

		for (const test of tests) {
			it(test.desc, () => {
				const nBs = sign({ text: test.noteBody }, ...test.sigs);

				// Now parse what we have created.
				let n: Note | undefined;
				let gotErr = false;
				try {
					n = parseCheckpoint(nBs, test.logID, logVerifier, known1Verifier, known2Verifier).note;
				} catch (err) {
					gotErr = true;
					expect(err, "unexpected error type").toBeInstanceOf(ParseCheckpointError);
					n = (err as ParseCheckpointError).note;
				}
				expect(gotErr, "gotErr != wantErr").toBe(test.wantErr);
				expect(n?.sigs?.length ?? 0, "signature count").toBe(test.wantSigs);
			});
		}
	});

	describe("TestSumDBNoteParsing", () => {
		// A real checkpoint issued by sum.golang.org: the strongest interoperability
		// evidence in this package, since nothing about it was produced here.
		const logVerifier = newVerifier("sum.golang.org+033de0ae+Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8");
		const noteString =
			"go.sum database tree\n" +
			"6476701\n" +
			"mb8QLQIs0Z0yP5Cstq6guj87oXWeC9gEM8oVikmm9Wk=\n" +
			"\n" +
			"— sum.golang.org Az3grsLX85Gz+s1SiTbgkuqxgItqFq7gsMUEyVnrsa9LM7Us9S+1xbFIGu95949rj4nPRYfvimWEPWL+o3GeoWwOoAw=\n";

		const tests: Array<{ desc: string; logID: string; wantErr: boolean }> = [
			{ desc: "hunky dory", logID: "go.sum database tree", wantErr: false },
			{ desc: "wrong logID", logID: "Go rocks but I might have the wrong ID", wantErr: true },
		];

		for (const test of tests) {
			it(test.desc, () => {
				if (test.wantErr) {
					expect(() => parseCheckpoint(toUTF8(noteString), test.logID, logVerifier)).toThrow(ParseCheckpointError);
					return;
				}
				const { checkpoint: cp } = parseCheckpoint(toUTF8(noteString), test.logID, logVerifier);
				expect(cp.size).toBe(6476701n);
				expect(cp.origin).toBe("go.sum database tree");
			});
		}
	});
});
