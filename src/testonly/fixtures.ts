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

// Loader for the golden fixtures in fixtures/data/, which are emitted by
// running the real Tessera Go implementation. See fixtures/README.md and
// docs/decisions/0006-golden-fixtures-from-go.md.
//
// The encoding contract (AGENTS.md §5) is:
//   - byte arrays are lower-case hex strings,
//   - uint64 values are decimal strings, decoded here to bigint,
//   - uint8/int/small counts are plain JSON numbers.
//
// This module has no dependencies. The decoders are deliberately strict: a
// fixture that has been hand-edited, re-encoded by a different tool, or
// truncated should fail loudly at load time rather than produce a subtly wrong
// Uint8Array that a test then happily asserts against.

/** FixtureHeader is the self-describing preamble every fixture file carries. */
export interface FixtureHeader {
	/** description says what behaviour the fixture pins down. */
	readonly description: string;
	/** upstream is the Go package the values were produced by. */
	readonly upstream: string;
	/** commit is the pinned Tessera revision the generator ran against. */
	readonly commit: string;
}

/**
 * Fixture is a loaded fixture file: the header plus the shape the caller
 * declares. Callers describe the JSON they expect; nothing here validates that
 * shape beyond the header, because the generator is the authority on it.
 */
export type Fixture<T> = FixtureHeader & T;

/** fixtureNamePattern is the set of names loadFixture will accept. */
const fixtureNamePattern = /^[a-z0-9_]+$/;

/** hexPattern matches an even-length lower-case hex string. */
const hexPattern = /^(?:[0-9a-f]{2})*$/;

/** decimalPattern matches an unsigned decimal integer with no leading zeros. */
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;

/** maxUint64 is the largest value a Go uint64 can hold. */
const maxUint64 = 2n ** 64n - 1n;

const cache = new Map<string, FixtureHeader>();

/**
 * loadFixture reads the named fixture from fixtures/data/<name>.json.
 *
 * The name is the file's basename without the extension, for example
 * "layout_paths" or "log_5000". Results are cached: fixture files are
 * immutable within a test run.
 */
export async function loadFixture<T>(name: string): Promise<Fixture<T>> {
	if (!fixtureNamePattern.test(name)) {
		throw new Error(
			`invalid fixture name ${JSON.stringify(name)}: expected lower-case letters, digits and underscores`,
		);
	}

	const cached = cache.get(name);
	if (cached !== undefined) {
		return cached as Fixture<T>;
	}

	let mod: { default?: unknown };
	try {
		mod = (await import(`../../fixtures/data/${name}.json`)) as { default?: unknown };
	} catch (cause) {
		throw new Error(`failed to load fixture ${JSON.stringify(name)}`, { cause });
	}

	const data: unknown = mod.default ?? mod;
	if (!isFixtureHeader(data)) {
		throw new Error(
			`fixture ${JSON.stringify(name)} is missing its description/upstream/commit header; ` +
				`regenerate it with "bun run fixtures"`,
		);
	}

	cache.set(name, data);
	return data as Fixture<T>;
}

function isFixtureHeader(v: unknown): v is FixtureHeader {
	if (typeof v !== "object" || v === null) {
		return false;
	}
	const o = v as Record<string, unknown>;
	return typeof o.description === "string" && typeof o.upstream === "string" && typeof o.commit === "string";
}

/**
 * hexToBytes decodes a lower-case hex string from a fixture into a Uint8Array.
 * An empty string decodes to an empty Uint8Array.
 */
export function hexToBytes(s: string): Uint8Array {
	if (!hexPattern.test(s)) {
		throw new Error(
			`invalid fixture hex ${JSON.stringify(truncate(s))}: expected an even number of lower-case hex digits`,
		);
	}
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) {
		// parseInt is avoided here because it silently accepts "0x" prefixes and
		// trailing junk; the pattern above has already proved every character is a
		// hex digit, so a direct nibble lookup is both faster and stricter.
		out[i] = (nibble(s.charCodeAt(i * 2)) << 4) | nibble(s.charCodeAt(i * 2 + 1));
	}
	return out;
}

function nibble(code: number): number {
	// '0'..'9'
	if (code <= 0x39) {
		return code - 0x30;
	}
	// 'a'..'f'
	return code - 0x57;
}

const hexDigits = "0123456789abcdef";

/** bytesToHex encodes bytes the way the fixtures spell them: lower-case hex. */
export function bytesToHex(b: Uint8Array): string {
	let out = "";
	for (const v of b) {
		out += hexDigits[v >> 4];
		out += hexDigits[v & 0x0f];
	}
	return out;
}

/**
 * u64 decodes a fixture's uint64 field. Fixtures carry uint64 values as decimal
 * strings precisely so that values above 2^53 survive the round trip, so this
 * rejects anything that is not an exact unsigned decimal in uint64 range.
 * See docs/decisions/0003-uint64-as-bigint.md.
 */
export function u64(s: string): bigint {
	if (!decimalPattern.test(s)) {
		throw new Error(`invalid fixture uint64 ${JSON.stringify(truncate(s))}: expected an unsigned decimal string`);
	}
	const v = BigInt(s);
	if (v > maxUint64) {
		throw new Error(`fixture uint64 ${s} exceeds 2^64-1`);
	}
	return v;
}

/** hexList decodes a fixture's [][]byte field. */
export function hexList(v: readonly string[]): Uint8Array[] {
	return v.map(hexToBytes);
}

/** u64List decodes a fixture's []uint64 field. */
export function u64List(v: readonly string[]): bigint[] {
	return v.map(u64);
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

/**
 * bytesToText decodes fixture bytes that are known to be UTF-8 text, such as a
 * checkpoint body. It throws on invalid UTF-8 rather than substituting
 * replacement characters.
 */
export function bytesToText(b: Uint8Array): string {
	return textDecoder.decode(b);
}

/** textToBytes encodes a string as UTF-8, the way Go's []byte(s) does. */
export function textToBytes(s: string): Uint8Array {
	return textEncoder.encode(s);
}

function truncate(s: string): string {
	return s.length > 32 ? `${s.slice(0, 32)}…` : s;
}
