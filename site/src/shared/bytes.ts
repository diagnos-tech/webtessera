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

// Byte formatting shared by the build-time renderer and the live demo.

/** toHex renders bytes as lowercase hexadecimal. */
export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** fragment renders the first n bytes of a hash, the way logs abbreviate hashes for people. */
export function fragment(hash: Uint8Array, n = 4): string {
	return toHex(hash.subarray(0, n));
}

/** shade buckets a hash into one of eight tones, so equal hashes always look alike. */
export function shade(hash: Uint8Array): number {
	return (hash[0] ?? 0) >> 5;
}

/** splitHashes cuts a hash tile's bytes into its 32-byte hashes. */
export function splitHashes(tile: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let i = 0; i + 32 <= tile.length; i += 32) {
		out.push(tile.subarray(i, i + 32));
	}
	return out;
}

/** formatBytes renders a byte count for people. */
export function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`;
}
