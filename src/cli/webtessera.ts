#!/usr/bin/env node
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

// This file has no upstream counterpart. It is the executable behind package.json's `bin`:
//
//     npx webtessera keygen <origin>
//     bunx webtessera keygen <origin>
//     deno run npm:webtessera keygen <origin>
//
// It is the one shipped module that uses `process`, which Node, Bun and Deno all provide to
// npm packages; no other module imports it, so no browser or edge bundle can contain it. The
// command itself is cli.ts. See docs/decisions/0245-key-generation-for-secret-stores.md.

import { run } from "./cli.ts";

/** process is the part of the global the runtimes give npm packages that this file uses. */
declare const process: {
	readonly argv: readonly string[];
	readonly stdout: { write(s: string): unknown };
	readonly stderr: { write(s: string): unknown };
	exitCode: number | undefined;
};

const result = run(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
