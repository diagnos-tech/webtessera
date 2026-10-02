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

// The few Node.js APIs the site's build-time code and scripts use. The site package has
// no @types/node of its own, and depending on one only for these signatures is not
// worth it; replace this file with the real types if the site ever needs more.

declare module "node:fs" {
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function readFileSync(path: string): Uint8Array;
	export function readdirSync(path: string): string[];
	export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number };
	export function writeFileSync(path: string, data: string | Uint8Array): void;
	export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:path" {
	export function join(...paths: string[]): string;
	export function relative(from: string, to: string): string;
}

declare module "node:url" {
	export function fileURLToPath(url: URL | string): string;
}

declare module "node:child_process" {
	export function execFileSync(
		file: string,
		args: readonly string[],
		options: { cwd?: string; encoding: "utf8" },
	): string;
}

declare module "node:zlib" {
	export function gzipSync(data: string | Uint8Array, options?: { level?: number }): Uint8Array;
}

declare const process: {
	readonly env: Record<string, string | undefined>;
	readonly argv: readonly string[];
	exitCode: number | undefined;
	readonly stdout: { write(text: string): boolean };
	readonly stderr: { write(text: string): boolean };
};
