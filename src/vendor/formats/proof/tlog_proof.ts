// Copyright 2026 Google LLC. All Rights Reserved.
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
//
// Ported from github.com/transparency-dev/formats/proof/tlog_proof.go @ v0.1.1
//
// Port note: the rest of the port follows formats at the version Tessera pins
// (v0.0.0-20251017110053-404c0d5b696c), which predates this package; it is taken from the
// first tagged release that has it. See docs/decisions/0224-port-formats-proof-for-tlog-proof.md.

import { assertUint64 } from "../../../internal/gostd/bits.ts";
import { Scanner } from "../../../internal/gostd/bufio.ts";
import { concatBytes, fromBase64, toBase64, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { wrapError } from "../../../internal/gostd/errors.ts";
import { parseUint } from "../../../internal/gostd/strconv.ts";

const tlogProofHeaderV1 = "c2sp.org/tlog-proof@v1";

/** sha256Size is Go's `sha256.Size`, the length of every hash in a proof. */
const sha256Size = 32;

/**
 * TLogProof represents a transparency log proof as described in https://c2sp.org/tlog-proof
 *
 * Port note: Go's `Hashes` is a `[][sha256.Size]byte`, whose element type cannot hold
 * anything but 32 bytes. A `Uint8Array[]` can, so {@link marshal} checks the length that
 * Go's type system guarantees.
 */
export class TLogProof {
	/**
	 * index is the index of an entry in the log
	 *
	 * Port note: `uint64` in Go, so `bigint` here. See docs/decisions/0003-uint64-as-bigint.md.
	 */
	index: bigint;
	/** hashes is the Merkle inclusion proof as described in https://www.rfc-editor.org/rfc/rfc6962.html#section-2.1.1 */
	hashes: Uint8Array[];
	/** checkpoint is the signed note as described in https://c2sp.org/tlog-checkpoint */
	checkpoint: Uint8Array;
	/**
	 * extraData contains optional application-specific data
	 *
	 * Port note: Go's nil slice, which means "no extra line", is `undefined` here; an
	 * empty Uint8Array is present, zero-length extra data, as an empty non-nil slice is
	 * in Go.
	 */
	extraData: Uint8Array | undefined;

	/**
	 * Port note: Go builds a TLogProof with a composite literal, or declares the zero value
	 * to unmarshal into (`var p TLogProof`). The optional initialiser gives both:
	 * `new TLogProof()` is the zero value. index must be a uint64; anything else throws a
	 * RangeError (docs/decisions/0207-uint64-domain-guards.md).
	 */
	constructor(init?: { index?: bigint; hashes?: Uint8Array[]; checkpoint?: Uint8Array; extraData?: Uint8Array }) {
		const index = init?.index ?? 0n;
		assertUint64(index, "index");
		this.index = index;
		this.hashes = init?.hashes ?? [];
		this.checkpoint = init?.checkpoint ?? new Uint8Array(0);
		this.extraData = init?.extraData;
	}

	/**
	 * marshal returns the tlog-proof encoding of this proof.
	 *
	 * Port note: Go's Marshal cannot fail. This throws a RangeError if index is not a
	 * uint64, and an Error if a hash is not 32 bytes; neither value can exist in Go.
	 */
	marshal(): Uint8Array {
		assertUint64(this.index, "index");
		let proof = `${tlogProofHeaderV1}\n`;
		if (this.extraData !== undefined) {
			proof += "extra ";
			proof += `${toBase64(this.extraData)}\n`;
		}
		proof += `index ${this.index}\n`;
		for (const h of this.hashes) {
			if (h.length !== sha256Size) {
				throw new Error(`tlog proof hash length was ${h.length}, expected ${sha256Size}`);
			}
			proof += `${toBase64(h)}\n`;
		}
		proof += "\n";
		// Port note: Go writes everything into one bytes.Buffer. The text lines are ASCII
		// and assembled as a string; the checkpoint is appended as the bytes it is, so a
		// checkpoint that is not valid UTF-8 still round-trips exactly.
		return concatBytes(toUTF8(proof), this.checkpoint);
	}

	/**
	 * unmarshal parses the tlog-proof encoding in data and stores the result in this proof.
	 *
	 * Port note: Go returns an error and assigns to the receiver only on success. This
	 * throws instead, and likewise assigns nothing until it can no longer fail. The hashes,
	 * the checkpoint and the extra data are copies, never views of data.
	 *
	 * Port note: C2SP tlog-proof requires that "decoders MUST reject non-canonical
	 * encodings" of base64. Go's base64.StdEncoding accepts non-zero padding bits and
	 * skips `\r` and `\n`, so after each decode that Go accepts, this also checks that the
	 * input is the canonical encoding of what it decoded to. The first such line is
	 * remembered, the parse carries on as Go's does, and only once it has finished without
	 * an error of Go's does this throw "tlog proof extra data not canonically base64
	 * encoded" or "tlog proof hash not canonically base64 encoded" for that line. So
	 * everything Go rejects is rejected with Go's error, and everything else Go accepts (an
	 * index with leading zeros, CRLF line endings, a checkpoint without a final newline) is
	 * accepted as Go accepts it.
	 * See docs/decisions/0224-port-formats-proof-for-tlog-proof.md.
	 */
	unmarshal(data: Uint8Array): void {
		const b = new Scanner(data);
		// nonCanonical is the error for the first base64 line that Go accepts but C2SP
		// does not, thrown only if Go's parse ends without an error (see above).
		let nonCanonical: Error | undefined;

		b.scan();
		if (b.text() !== tlogProofHeaderV1) {
			throw new Error("tlog proof missing expected header");
		}

		// Handle optional extra line
		let extra: Uint8Array | undefined;
		b.scan();
		if (b.text().startsWith("extra ")) {
			const e = b.text().slice("extra ".length);
			try {
				extra = fromBase64(e);
			} catch (err) {
				throw wrapError("tlog proof extra data not base64 encoded", err);
			}
			if (toBase64(extra) !== e) {
				nonCanonical ??= new Error("tlog proof extra data not canonically base64 encoded");
			}
			extra = extra.slice();
			b.scan();
		}

		let idx: bigint;
		const [idxStr, ok] = cutPrefix(b.text(), "index ");
		if (!ok) {
			throw new Error("tlog proof missing required index");
		}
		try {
			idx = parseUint(idxStr, 10, 64);
		} catch (err) {
			throw wrapError("tlog proof index not a valid uint64", err);
		}

		const hashes: Uint8Array[] = [];
		while (b.scan()) {
			if (b.text() === "") {
				break;
			}
			let hash: Uint8Array;
			try {
				hash = fromBase64(b.text());
			} catch (err) {
				throw wrapError("tlog proof hash not base64 encoded", err);
			}
			if (hash.length !== sha256Size) {
				throw new Error(`tlog proof hash length was ${hash.length}, expected ${sha256Size}`);
			}
			if (toBase64(hash) !== b.text()) {
				nonCanonical ??= new Error("tlog proof hash not canonically base64 encoded");
			}
			hashes.push(hash.slice());
		}

		const newline = new Uint8Array([0x0a]);
		const checkpoint: Uint8Array[] = [];
		while (b.scan()) {
			// Port note: Bytes is a view of the scanner's buffer, which the next scan may
			// overwrite; Go's checkpoint.Write copies it, and so does slice.
			checkpoint.push(b.bytes().slice(), newline);
		}

		const err = b.err();
		if (err !== undefined) {
			throw wrapError("scanning tlog proof", err);
		}
		if (nonCanonical !== undefined) {
			throw nonCanonical;
		}

		this.index = idx;
		this.hashes = hashes;
		this.checkpoint = concatBytes(...checkpoint);
		this.extraData = extra;
	}
}

/**
 * cutPrefix is Go's `strings.CutPrefix`: s without the provided leading prefix string and
 * true, or s and false if s does not start with prefix.
 */
function cutPrefix(s: string, prefix: string): [after: string, found: boolean] {
	if (!s.startsWith(prefix)) {
		return [s, false];
	}
	return [s.slice(prefix.length), true];
}
