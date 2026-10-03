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

// Declares the few Node.js APIs the SQLite backend's Node test suites use. The repository
// installs no @types/node, deliberately: library code must not reach for Node built-ins,
// and their absence from the type environment is what enforces it. Test-only, and
// excluded from the published build.

declare module "node:sqlite" {
	/** StatementSync is node:sqlite's prepared statement. */
	export class StatementSync {
		all(...params: unknown[]): Record<string, unknown>[];
		run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	}

	/** DatabaseSync is a node:sqlite connection. */
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): StatementSync;
		exec(sql: string): void;
		/** location returns the database file's absolute path, or null for an in-memory or temporary database. */
		location(dbName?: string): string | null;
		close(): void;
	}
}

declare module "node:fs" {
	export function mkdtempSync(prefix: string): string;
	export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:process" {
	export const argv: readonly string[];
	export const execPath: string;
	export const stdout: { write(chunk: string): boolean };
}

declare module "node:child_process" {
	/** ChildProcess is the part of a spawned process the tests read. */
	export interface ChildProcess {
		readonly stdout: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void };
		readonly stderr: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void };
		on(event: "close", listener: (code: number | null) => void): void;
		on(event: "error", listener: (err: Error) => void): void;
	}
	export function spawn(
		command: string,
		args: readonly string[],
		options?: { stdio?: readonly ("ignore" | "pipe")[] },
	): ChildProcess;
}
