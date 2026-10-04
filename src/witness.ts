// Copyright 2025 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/witness.go @ 4a6d9f9
//
// Port note: `net/http`'s `*http.Client` has no meaning here; witness.go itself never
// uses one (that is internal/witness/witness.go's job, see src/internal/witness/witness.ts).
// `bufio.NewScanner(bytes.NewBuffer(p))` becomes `Scanner` from src/internal/gostd/bufio.ts,
// the shared stand-in, which keeps the scanner's line splitting and its 64 KiB line limit
// (docs/decisions/0224-port-formats-proof-for-tlog-proof.md). `url.Parse`,
// `(*url.URL).JoinPath` and `(*url.URL).String` come from src/internal/gostd/url.ts, a
// transcription of Go's net/url: the platform `URL` type accepts, rejects and normalises
// different URLs (docs/decisions/0241-witness-policy-urls-parsed-as-go-parses-them.md).
//
// Port note: these deliberate hardening divergences from Go live in this file:
// newWitnessGroupFromPolicy rejects a group that names the same child twice, two witnesses
// with the same verifier key, and an explicit group threshold of 0
// (docs/decisions/0184-witness-policy-rejects-ambiguous-quorums.md), and a policy line that
// is not valid UTF-8 (docs/decisions/0242-witness-policy-must-be-utf8.md); and newWitness
// accepts only https witness URLs, or http to a loopback host
// (docs/decisions/0185-witness-urls-require-https.md), that have a host and that the
// platform URL parser, which fetch uses, accepts
// (docs/decisions/0241-witness-policy-urls-parsed-as-go-parses-them.md).

import { Scanner } from "./internal/gostd/bufio.ts";
import { fromBase64, toHex } from "./internal/gostd/bytes.ts";
import { wrapError } from "./internal/gostd/errors.ts";
import { parseUint, quote } from "./internal/gostd/strconv.ts";
import { cut, fields as splitFields, trimSpace } from "./internal/gostd/strings.ts";
import { validUTF8 } from "./internal/gostd/unicode.ts";
import * as url from "./internal/gostd/url.ts";
import { newVerifierForCosignatureV1 } from "./vendor/formats/note/note_cosigv1.ts";
import { open, type Verifier, verifierList } from "./vendor/note/note.ts";

/**
 * policyComponent describes a component that makes up a policy. This is either a
 * single Witness, or a WitnessGroup.
 */
interface policyComponent {
	/**
	 * satisfied returns true if the checkpoint is signed by the quorum of
	 * witnesses involved in this policy component.
	 */
	satisfied(cp: Uint8Array): boolean;

	/**
	 * endpoints returns the details required for updating a witness and checking the
	 * response. The returned result is a map from the URL that should be used to update
	 * the witness with a new checkpoint, to the value which is the verifier to check
	 * the response is well formed.
	 */
	endpoints(): Map<string, Verifier>;
}

/**
 * newWitnessGroupFromPolicy creates a graph of witness objects that represents the
 * policy provided, and which can be passed directly to the WithWitnesses
 * appender lifecycle option.
 *
 * The policy structure is as described by [Sigsum's policy format](https://git.glasklar.is/sigsum/core/sigsum-go/-/blob/main/doc/policy.md)
 * but with the difference that the configured witness keys MUST be signature type `0x04` `vkey`s as specified
 * by C2SP [signed-note](https://github.com/C2SP/C2SP/blob/main/signed-note.md#verifier-keys).
 */
export function newWitnessGroupFromPolicy(p: Uint8Array): WitnessGroup {
	const scanner = new Scanner(p);
	const components = new Map<string, policyComponent>();
	// witnessKeys maps each witness's public key to the witness name it was first given, for
	// the duplicate-key check (ADR-0184).
	const witnessKeys = new Map<string, string>();

	let quorumName = "";
	while (scanner.scan()) {
		// Port note: hardening with no Go counterpart (ADR-0242). Go compares names as the
		// bytes they are; a JavaScript string cannot hold bytes that are not valid UTF-8, and
		// decoding them to U+FFFD would make distinct names, keys and URLs compare equal. So
		// the part of the line Go goes on to read, everything before its first '#', must be
		// valid UTF-8; a comment, which Go discards, may hold any bytes.
		const raw = scanner.bytes();
		const hash = raw.indexOf(0x23);
		if (!validUTF8(hash < 0 ? raw : raw.subarray(0, hash))) {
			throw new Error("witness policy line is not valid UTF-8");
		}
		let line = trimSpace(scanner.text());
		const i = line.indexOf("#");
		if (i >= 0) {
			line = line.slice(0, i);
		}
		if (line === "") {
			continue;
		}

		const fields = splitFields(line);
		const keyword = fields[0] as string;
		switch (keyword) {
			case "log":
				// This keyword is important to clients who might use the policy file, but we don't need to know about it since
				// we _are_ the log, so just ignore it.
				break;
			case "witness": {
				// Strictly, the URL is optional so policy files can be used client-side, where they don't care about the URL.
				// Given this function is parsing to create the graph structure which will be used by a Tessera log to witness
				// new checkpoints we'll ignore that special case here.
				if (fields.length !== 4) {
					throw new Error(`invalid witness definition: ${quote(line)}`);
				}
				const name = fields[1] as string;
				const vkey = fields[2] as string;
				const witnessURLStr = fields[3] as string;
				if (isBadName(name)) {
					throw new Error(`invalid witness name ${quote(name)}`);
				}
				if (components.has(name)) {
					throw new Error(`duplicate component name: ${quote(name)}`);
				}
				let witnessURL: url.URL;
				try {
					witnessURL = url.parse(witnessURLStr);
				} catch (err) {
					throw wrapError(`invalid witness URL ${quote(witnessURLStr)}`, err);
				}
				let w: Witness;
				try {
					w = newWitnessFromRoot(vkey, witnessURL);
				} catch (err) {
					throw wrapError(`invalid witness config ${quote(line)}`, err);
				}
				// Port note: hardening with no Go counterpart (ADR-0184). Two witness names for one
				// key would let that key count twice towards a group's threshold.
				const key = verifierKeyID(vkey);
				const sameKey = witnessKeys.get(key);
				if (sameKey !== undefined) {
					throw new Error(`witness ${quote(name)} has the same verifier key as witness ${quote(sameKey)}`);
				}
				witnessKeys.set(key, name);
				components.set(name, w);
				break;
			}
			case "group": {
				if (fields.length < 3) {
					throw new Error(`invalid group definition: ${quote(line)}`);
				}

				const name = fields[1] as string;
				const N = fields[2] as string;
				const childrenNames = fields.slice(3);
				if (isBadName(name)) {
					throw new Error(`invalid group name ${quote(name)}`);
				}
				if (components.has(name)) {
					throw new Error(`duplicate component name: ${quote(name)}`);
				}
				let n: number;
				switch (N) {
					case "any":
						n = 1;
						break;
					case "all":
						n = childrenNames.length;
						break;
					default: {
						let i: bigint;
						try {
							i = parseUint(N, 10, 8);
						} catch (err) {
							throw wrapError(`invalid threshold ${quote(N)} for group ${quote(name)}`, err);
						}
						// Port note: hardening with no Go counterpart (ADR-0184). A group that needs
						// no signatures is written `quorum none`, not as a threshold of 0.
						if (i === 0n) {
							throw new Error(`invalid threshold ${quote(N)} for group ${quote(name)}: must be at least 1`);
						}
						n = Number(i);
						break;
					}
				}
				const c = childrenNames.length;
				if (n > c) {
					throw new Error(`group with ${c} children cannot have threshold ${n}`);
				}

				const children: policyComponent[] = [];
				// Port note: hardening with no Go counterpart (ADR-0184). A child named twice would
				// count twice towards the group's threshold.
				const seen = new Set<string>();
				for (const cName of childrenNames) {
					if (isBadName(cName)) {
						throw new Error(`invalid component name ${quote(cName)}`);
					}
					const child = components.get(cName);
					if (child === undefined) {
						throw new Error(`unknown component ${quote(cName)} in group definition`);
					}
					if (seen.has(cName)) {
						throw new Error(`repeated component ${quote(cName)} in group definition`);
					}
					seen.add(cName);
					children.push(child);
				}
				const wg = newWitnessGroup(n, ...children);
				components.set(name, wg);
				break;
			}
			case "quorum":
				if (fields.length !== 2) {
					throw new Error(`invalid quorum definition: ${quote(line)}`);
				}
				quorumName = fields[1] as string;
				break;
			default:
				throw new Error(`unknown keyword: ${quote(keyword)}`);
		}
	}
	const scanErr = scanner.err();
	if (scanErr !== undefined) {
		throw scanErr;
	}

	switch (quorumName) {
		case "":
			throw new Error("policy file must define a quorum");
		case "none":
			return newWitnessGroup(0);
		default: {
			if (isBadName(quorumName)) {
				throw new Error(`invalid quorum name ${quote(quorumName)}`);
			}
			const policy = components.get(quorumName);
			if (policy === undefined) {
				throw new Error(`quorum component ${quote(quorumName)} not found`);
			}
			if (!(policy instanceof WitnessGroup)) {
				// A single witness can be a policy. Wrap it in a group.
				return newWitnessGroup(1, policy);
			}
			return policy;
		}
	}
}

const keywords = new Set(["witness", "group", "any", "all", "none", "quorum", "log"]);

function isBadName(n: string): boolean {
	return keywords.has(n);
}

/**
 * newWitness returns a Witness given a verifier key and the root URL for where this
 * witness can be reached.
 *
 * Port note: Go takes a `*url.URL`; this takes the platform URL type and reads its `href`
 * with url.parse, Go's parser, which accepts every href the platform produces except one
 * holding a malformed percent-escape, and then throws Go's error for it. Throws unless the
 * endpoint uses https, or http to a loopback host, as hardening with no Go counterpart
 * (docs/decisions/0185-witness-urls-require-https.md).
 */
export function newWitness(vkey: string, witnessRoot: URL): Witness {
	return newWitnessFromRoot(vkey, url.parse(witnessRoot.href));
}

/**
 * newWitnessFromRoot is newWitness for a witness root URL as Go's url.Parse reads it, which
 * is how newWitnessGroupFromPolicy holds a policy's URL.
 *
 * Port note: the checks on the endpoint are hardening with no Go counterpart, see
 * checkWitnessURL.
 */
function newWitnessFromRoot(vkey: string, witnessRoot: url.URL): Witness {
	const v = newVerifierForCosignatureV1(vkey);

	const u = witnessRoot.joinPath("/add-checkpoint");
	checkWitnessURL(u);

	return new Witness(v, u.string());
}

/**
 * Witness represents a single witness that can be reached in order to perform a witnessing operation.
 * The URLs() method returns the URL where it can be reached for witnessing, and the Satisfied method
 * provides a predicate to check whether this witness has signed a checkpoint.
 */
export class Witness implements policyComponent {
	readonly key: Verifier;
	readonly url: string;

	/** @internal Stands in for Go's `Witness{...}` composite literal; construct via newWitness. */
	constructor(key: Verifier, url: string) {
		this.key = key;
		this.url = url;
	}

	/**
	 * satisfied returns true if the checkpoint provided is signed by this witness.
	 * This will return false if there is no signature, and also if the
	 * checkpoint cannot be read as a valid note. It is up to the caller to ensure
	 * that the input value represents a valid note.
	 */
	satisfied(cp: Uint8Array): boolean {
		try {
			const n = open(cp, verifierList(this.key));
			return (n.sigs?.length ?? 0) === 1;
		} catch {
			return false;
		}
	}

	/**
	 * endpoints returns the details required for updating a witness and checking the
	 * response. The returned result is a map from the URL that should be used to update
	 * the witness with a new checkpoint, to the value which is the verifier to check
	 * the response is well formed.
	 */
	endpoints(): Map<string, Verifier> {
		return new Map([[this.url, this.key]]);
	}
}

/**
 * newWitnessGroup creates a grouping of Witness or WitnessGroup with a configurable threshold
 * of these sub-components that need to be satisfied in order for this group to be satisfied.
 *
 * The threshold should only be set to less than the number of sub-components if these are
 * considered fungible.
 */
export function newWitnessGroup(n: number, ...children: policyComponent[]): WitnessGroup {
	// Port note: Go panics here; the port throws (ADR-0004). Go formats the children slice with
	// %s, which prints each child's fields, including the address of its verifier's function, so
	// that text cannot be reproduced; the port prints how many children there are instead.
	if (n < 0 || n > children.length) {
		throw new Error(`threshold of ${n} outside bounds for children ${children.length}`);
	}
	return new WitnessGroup(children, n);
}

/**
 * WitnessGroup defines a group of witnesses, and a threshold of
 * signatures that must be met for this group to be satisfied.
 * Witnesses within a group should be fungible, e.g. all of the Armored
 * Witness devices form a logical group, and N should be picked to
 * represent a threshold of the quorum. For some users this will be a
 * simple majority, but other strategies are available.
 * N must be <= len(WitnessKeys).
 */
export class WitnessGroup implements policyComponent {
	readonly components: policyComponent[];
	readonly n: number;

	/**
	 * @internal Stands in for Go's `WitnessGroup{...}` composite literal, including the
	 * zero value `WitnessGroup{}` (`new WitnessGroup()`); construct via newWitnessGroup
	 * for the validated, common case.
	 */
	constructor(components: policyComponent[] = [], n = 0) {
		this.components = components;
		this.n = n;
	}

	/**
	 * satisfied returns true if the checkpoint provided has sufficient signatures
	 * from the witnesses in this group to satisfy the threshold.
	 * This will return false if there are insufficient signatures, and also if the
	 * checkpoint cannot be read as a valid note. It is up to the caller to ensure
	 * that the input value represents a valid note.
	 *
	 * The implementation of this requires every witness in the group to verify the
	 * checkpoint, which is O(N). If this is called every time a witness returns a
	 * checkpoint then this algorithm is O(N^2). To support large N, this may require
	 * some rewriting in order to maintain performance.
	 */
	satisfied(cp: Uint8Array): boolean {
		if (this.n <= 0) {
			return true;
		}
		let satisfaction = 0;
		for (const c of this.components) {
			if (c.satisfied(cp)) {
				satisfaction++;
			}
			if (satisfaction >= this.n) {
				return true;
			}
		}
		return false;
	}

	/**
	 * endpoints returns the details required for updating a witness and checking the
	 * response. The returned result is a map from the URL that should be used to update
	 * the witness with a new checkpoint, to the value which is the verifier to check
	 * the response is well formed.
	 */
	endpoints(): Map<string, Verifier> {
		const endpoints = new Map<string, Verifier>();
		for (const c of this.components) {
			for (const [k, v] of c.endpoints()) {
				endpoints.set(k, v);
			}
		}
		return endpoints;
	}
}

/**
 * verifierKeyID identifies the Ed25519 public key in an already-validated cosignature/v1
 * vkey, whatever name and algorithm byte it is published under: both algorithm bytes
 * newVerifierForCosignatureV1 accepts verify the same signatures for a given key.
 */
function verifierKeyID(vkey: string): string {
	const [, afterName] = cut(vkey, "+");
	const [, key64] = cut(afterName, "+");
	return toHex(fromBase64(key64).subarray(1));
}

/**
 * checkWitnessURL throws unless the witness endpoint u is one fetch will send to the host Go
 * would: an https URL, or an http URL whose host is a loopback address; with a host; and
 * accepted by the platform URL parser.
 *
 * Port note: hardening with no Go counterpart. The scheme rule is
 * docs/decisions/0185-witness-urls-require-https.md; the scheme is Go's reading of it. The
 * other two refuse a URL Go's url.Parse accepts but fetch cannot use as Go's HTTP client
 * would (docs/decisions/0241-witness-policy-urls-parsed-as-go-parses-them.md): one without a
 * host, which Go's client refuses to send and the platform parser reads differently
 * (`https:///x` as host `x`), and one the platform parser rejects (a port above 65535, an
 * IPv6 zone, a host of `256.1.1.1` or with `<` in it). The loopback check reads the URL with
 * the platform parser because that is the parser fetch uses, so what is checked is where
 * requests go.
 */
function checkWitnessURL(u: url.URL): void {
	const s = u.string();
	const mustUseHTTPS = `witness URL ${quote(s)} must use https (http is accepted only for a loopback host)`;
	if (u.scheme !== "https" && u.scheme !== "http") {
		throw new Error(mustUseHTTPS);
	}
	if (u.host === "") {
		throw new Error(`witness URL ${quote(s)} has no host`);
	}
	if (!URL.canParse(s)) {
		throw new Error(`witness URL ${quote(s)} is rejected by the platform URL parser, which fetch uses`);
	}
	const parsed = new URL(s);
	if (parsed.protocol === "https:") {
		return;
	}
	if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
		return;
	}
	throw new Error(mustUseHTTPS);
}

/**
 * isLoopbackHost reports whether hostname, as the platform URL parser normalises it, is
 * localhost, an address in 127.0.0.0/8, or ::1.
 */
function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}
