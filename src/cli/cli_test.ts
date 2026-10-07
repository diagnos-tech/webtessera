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

// Tests for the `webtessera` command: its arguments and output, and the executable on Node.
// scripts/smoke-runtimes.mjs runs the built executable on Node, Bun and Deno.

import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { importLogKey } from "../server/keys.ts";
import { run, Usage } from "./cli.ts";

describe("webtessera keygen", () => {
	it("prints a new key pair as .env lines on stdout, and what to do with them on stderr", async () => {
		const r = run(["keygen", "example.com/log"]);
		expect(r.code).toBe(0);
		const [skeyLine, vkeyLine, rest] = r.stdout.split("\n");
		expect(skeyLine).toMatch(/^LOG_SKEY=PRIVATE\+KEY\+example\.com\/log\+[0-9a-f]{8}\+\S+$/);
		expect(vkeyLine).toMatch(/^LOG_VKEY=example\.com\/log\+[0-9a-f]{8}\+\S+$/);
		expect(rest).toBe("");
		expect(r.stderr).toMatch(/LOG_SKEY is the log's private key: keep it in your secret store/);
		const key = await importLogKey((skeyLine as string).slice("LOG_SKEY=".length));
		expect(key.vkey).toBe((vkeyLine as string).slice("LOG_VKEY=".length));
	});

	it("names the variables after --prefix, and prints JSON with --json", () => {
		expect(run(["keygen", "--prefix", "NOTARY", "notary.example/v1"]).stdout).toMatch(/^NOTARY_SKEY=.*\nNOTARY_VKEY=/);
		expect(run(["keygen", "notary.example/v1", "--prefix=WITNESS_2"]).stdout).toMatch(/^WITNESS_2_SKEY=/);
		const json = JSON.parse(run(["keygen", "example.com/log", "--json"]).stdout) as Record<string, string>;
		expect(Object.keys(json)).toEqual(["origin", "skey", "vkey"]);
		expect(json.origin).toBe("example.com/log");
	});

	it("explains its mistakes with exit status 2, and never prints a key it was given", () => {
		const cases: [string[], RegExp][] = [
			[[], /^usage: webtessera keygen/],
			[["keygen"], /keygen needs the log's origin/],
			[["keygen", "a.example", "b.example"], /keygen takes one origin/],
			[["keygen", "bad origin"], /"bad origin" cannot be a log origin/],
			[["keygen", "--prefix", "lower", "a.example"], /--prefix takes a variable name prefix/],
			[["keygen", "--verbose", "a.example"], /unknown option "--verbose"/],
			[["sign", "a.example"], /unknown command "sign"/],
		];
		for (const [args, want] of cases) {
			const r = run(args);
			expect([r.code, r.stdout], args.join(" ")).toEqual([2, ""]);
			expect(r.stderr, args.join(" ")).toMatch(want);
		}
		const skey = "PRIVATE+KEY+example.com/log+01234567+AU8kTyK0RJFiR8hEREk5X103hoUKgM7BxP0nTyBIuUCY";
		const r = run(["keygen", skey]);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/looks like a private signer key/);
		expect(r.stderr).not.toContain("AU8kTyK0RJFiR8hEREk5X103hoUKgM7BxP0nTyBIuUCY");
		// Nor as a command or an option, which it quotes back.
		for (const args of [[skey], ["keygen", "example.com/log", `--${skey}`]]) {
			const wrong = run(args);
			expect(wrong.code, args[0]).toBe(2);
			expect(wrong.stderr, args[0]).not.toContain("AU8kTyK0RJFiR8hEREk5X103hoUKgM7BxP0nTyBIuUCY");
		}
		expect(run(["help"])).toEqual({ code: 0, stdout: "", stderr: Usage });
	});

	it("runs as an executable, writing only the key to stdout", () => {
		const bin = decodeURIComponent(new URL("./webtessera.ts", import.meta.url).pathname);
		const ok = spawnSync(execPath, ["--no-warnings", bin, "keygen", "example.com/log"], { encoding: "utf8" });
		expect(ok.status).toBe(0);
		expect(ok.stdout).toMatch(/^LOG_SKEY=PRIVATE\+KEY\+example\.com\/log\+.*\nLOG_VKEY=example\.com\/log\+.*\n$/);
		expect(ok.stderr).toMatch(/keep it in your secret store/);
		const bad = spawnSync(execPath, ["--no-warnings", bin, "keygen"], { encoding: "utf8" });
		expect([bad.status, bad.stdout]).toEqual([2, ""]);
	});
});
