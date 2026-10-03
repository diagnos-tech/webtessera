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
// Declares the few node: modules the monitor uses. Node, Bun and Deno all provide them, so the
// monitor needs no runtime adapter: fetch, the only other thing it uses, is global everywhere.

declare module "node:fs/promises" {
	/** FileHandle is the part of an open file the state store uses. */
	export interface FileHandle {
		writeFile(data: Uint8Array): Promise<void>;
		sync(): Promise<void>;
		close(): Promise<void>;
	}
	export function open(path: string, flags: "w"): Promise<FileHandle>;
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function readFile(path: string): Promise<Uint8Array>;
	export function readdir(path: string): Promise<string[]>;
	export function rename(from: string, to: string): Promise<void>;
	export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}

declare module "node:process" {
	export const argv: readonly string[];
	export function exit(code?: number): never;
}
