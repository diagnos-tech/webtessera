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

// Declares the few runtime-specific APIs this example touches, instead of installing each
// runtime's full type package: what is declared here is exactly the surface the example
// depends on. Each runtime adapter uses only its own part.

declare module "node:sqlite" {
	/** DatabaseSync is a node:sqlite connection (Node.js 22.13+, Deno 2.2+). */
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
		close(): void;
	}
}

declare module "bun:sqlite" {
	/** Database is a bun:sqlite connection. */
	export class Database {
		constructor(path: string);
		prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
		close(): void;
	}
}

declare module "node:http" {
	import type { NodeIncomingMessage, NodeServerResponse } from "webtessera/http";

	/** Server is the part of a node:http server the Node adapter uses. */
	export interface Server {
		listen(port: number, hostname: string, onListening: () => void): void;
		once(event: "error", listener: (err: Error) => void): void;
		address(): { port: number };
		close(onClosed: () => void): void;
	}
	export function createServer(listener: (req: NodeIncomingMessage, res: NodeServerResponse) => void): Server;
}

declare module "node:process" {
	export const env: Record<string, string | undefined>;
	export const argv: readonly string[];
	export const execPath: string;
	export function exit(code?: number): never;
	/** process is the default export; Node exports its EventEmitter methods only through it. */
	const process: { on(event: "SIGINT" | "SIGTERM", listener: () => void): void };
	export default process;
}

declare module "node:fs/promises" {
	export function mkdtemp(prefix: string): Promise<string>;
	export function readFile(path: string): Promise<Uint8Array>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
	export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}

declare module "node:child_process" {
	/** ChildProcess is the part of a spawned process the scripts and tests use. */
	export interface ChildProcess {
		/** stdout is null unless stdio is "pipe", the default. */
		readonly stdout: { on(event: "data", listener: (chunk: Uint8Array | string) => void): void } | null;
		on(event: "close", listener: (code: number | null) => void): void;
	}
	export function spawn(
		command: string,
		args: readonly string[],
		options?: { stdio?: "inherit" | "pipe"; cwd?: string },
	): ChildProcess;
	export function spawnSync(command: string, args: readonly string[]): { status: number | null };
}

/** Bun is Bun's global namespace; only Bun.serve is used. */
declare const Bun: {
	serve(options: { port: number; hostname: string; fetch(request: Request): Promise<Response> }): {
		readonly port: number;
		stop(closeActiveConnections?: boolean): Promise<void>;
	};
};

/** Deno is Deno's global namespace; only Deno.serve is used. */
declare const Deno: {
	serve(
		options: { port: number; hostname: string; onListen?: () => void },
		handler: (request: Request) => Promise<Response>,
	): { readonly addr: { port: number }; shutdown(): Promise<void> };
};
