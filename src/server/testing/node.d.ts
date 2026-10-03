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

// Declares the few Node.js APIs the safe API's Node test suites use beyond those
// src/storage/sqlite/testing/node.d.ts declares (these declarations merge with its own).
// The repository installs no @types/node, deliberately: library code must not reach for
// Node built-ins. Test-only, and excluded from the published build.

declare module "node:child_process" {
	export function execFileSync(
		file: string,
		args: readonly string[],
		options: { cwd?: string; encoding: "utf8"; stdio?: readonly ("pipe" | "ignore" | "inherit")[] },
	): string;
}

declare module "node:fs" {
	export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
	export function readdirSync(path: string): string[];
	export function readFileSync(path: string | URL, encoding: "utf8"): string;
	export function writeFileSync(path: string, data: string): void;
}

declare module "node:module" {
	export function createRequire(path: string | URL): (id: string) => unknown;
}

declare module "node:path" {
	export function join(...paths: string[]): string;
}

declare module "node:process" {
	export const execPath: string;
}

declare module "node:util" {
	export function inspect(value: unknown, options?: { depth?: number; showHidden?: boolean }): string;
}
