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

// This file has no upstream counterpart. It is the `webtessera` command, as a function from
// its arguments to what it prints and its exit status, so that it runs, and is tested, the
// same on every runtime; webtessera.ts is the executable that connects it to a terminal.
// See docs/decisions/0245-key-generation-for-secret-stores.md.

import { WebtesseraError } from "../safe/errors.ts";
import { generateLogKeyPair } from "../server/keys.ts";

/** CliResult is what one run of the command prints, and the status it exits with. */
export interface CliResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Usage is the command's help text. */
export const Usage = `usage: webtessera keygen <origin> [--prefix NAME] [--json]

Generates a new Ed25519 key for the log whose origin is <origin> (such as
example.com/log), and prints it as two lines for a .env file or a secret store:

  LOG_SKEY=PRIVATE+KEY+<origin>+<hash>+<key>   the signer key: keep it secret
  LOG_VKEY=<origin>+<hash>+<key>               the verifier key: publish it

Open the log with importLogKey(process.env.LOG_SKEY) from webtessera/server.

Options:
  --prefix NAME   name the variables NAME_SKEY and NAME_VKEY (default: LOG)
  --json          print {"origin":…,"skey":…,"vkey":…} instead

Examples:
  npx webtessera keygen example.com/log >> .env
  bunx webtessera keygen example.com/log --prefix NOTARY
  deno run npm:webtessera keygen example.com/log --json
`;

const prefixPattern = /^[A-Z_][A-Z0-9_]*$/;

/**
 * run runs the command with the given arguments (those after the command's own name) and
 * returns what it prints. It never throws: a mistake in the arguments is exit status 2, any
 * other failure 1. What goes to stdout is only the key, so that it can be redirected into a
 * file; everything said about it goes to stderr.
 */
export function run(args: readonly string[]): CliResult {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		return { code: command === undefined ? 2 : 0, stdout: "", stderr: Usage };
	}
	if (command !== "keygen") {
		return usageError(`unknown command ${JSON.stringify(command)}`);
	}
	let origin: string | undefined;
	let prefix = "LOG";
	let json = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		if (arg === "--json") {
			json = true;
		} else if (arg === "--prefix" || arg.startsWith("--prefix=")) {
			const value = arg === "--prefix" ? rest[++i] : arg.slice("--prefix=".length);
			if (value === undefined || !prefixPattern.test(value)) {
				return usageError("--prefix takes a variable name prefix: capital letters, digits and underscores");
			}
			prefix = value;
		} else if (arg.startsWith("-")) {
			return usageError(`unknown option ${JSON.stringify(arg)}`);
		} else if (origin === undefined) {
			origin = arg;
		} else {
			return usageError("keygen takes one origin");
		}
	}
	if (origin === undefined) {
		return usageError("keygen needs the log's origin, such as example.com/log");
	}
	let pair: { skey: string; vkey: string };
	try {
		pair = generateLogKeyPair(origin);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			code: err instanceof WebtesseraError && err.code !== "WRONG_ENVIRONMENT" ? 2 : 1,
			stdout: "",
			stderr: `webtessera: ${message}\n`,
		};
	}
	const stdout = json
		? `${JSON.stringify({ origin, skey: pair.skey, vkey: pair.vkey })}\n`
		: `${prefix}_SKEY=${pair.skey}\n${prefix}_VKEY=${pair.vkey}\n`;
	const stderr = json
		? "webtessera: skey is the log's private key: keep it in your secret store, never in source control. Publish vkey.\n"
		: `webtessera: ${prefix}_SKEY is the log's private key: keep it in your secret store, never in source control. ` +
			`Publish ${prefix}_VKEY.\n`;
	return { code: 0, stdout, stderr };
}

function usageError(message: string): CliResult {
	return { code: 2, stdout: "", stderr: `webtessera: ${message}\n\n${Usage}` };
}
