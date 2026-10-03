// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/witness.go @ 4a6d9f9
//
// Port note: `net/http`'s `*http.Client` has no meaning here; witness.go itself never
// uses one (that is internal/witness/witness.go's job, see src/internal/witness/witness.ts).
// `bufio.Scanner`/`bytes.Buffer` become the scanLines generator below, which keeps the
// scanner's line splitting and its 64 KiB line limit. `url.Parse` and `(*url.URL).JoinPath`
// have no JavaScript/DOM equivalent that keeps a URL as written (the platform `URL` type
// normalises it), so small scoped helpers at the end of this file reproduce what this file
// needs of them -- see their own comments and
// docs/decisions/0078-witness-url-joinpath-reimplemented.md.
//
// Port note: three deliberate hardening divergences from Go live in this file:
// newWitnessGroupFromPolicy rejects a group that names the same child twice, two witnesses
// with the same verifier key, and an explicit group threshold of 0
// (docs/decisions/0184-witness-policy-rejects-ambiguous-quorums.md); and newWitness accepts
// only https witness URLs, or http to a loopback host
// (docs/decisions/0185-witness-urls-require-https.md).

import { fromBase64, fromUTF8, toHex } from "./internal/gostd/bytes.ts";
import { SentinelError, wrapError } from "./internal/gostd/errors.ts";
import { parseUint, quote } from "./internal/gostd/strconv.ts";
import { cut, fields as splitFields, trimSpace } from "./internal/gostd/strings.ts";
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
	const components = new Map<string, policyComponent>();
	// witnessKeys maps each witness's public key to the witness name it was first given, for
	// the duplicate-key check (ADR-0184).
	const witnessKeys = new Map<string, string>();

	let quorumName = "";
	// Port note: a line longer than bufio.Scanner's 64 KiB limit ends the loop with Go's
	// `scanner.Err()`, bufio.ErrTooLong, which scanLines throws when the loop reaches it.
	for (const text of scanLines(p)) {
		let line = trimSpace(text);
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
				let witnessURL: string;
				try {
					witnessURL = parseWitnessURL(witnessURLStr);
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
 * Port note: throws unless the witness URL uses https, or http to a loopback host, as
 * hardening with no Go counterpart (docs/decisions/0185-witness-urls-require-https.md). The
 * endpoint is joined onto `witnessRoot.href`, which the platform URL type has already
 * normalised; newWitnessGroupFromPolicy keeps a policy's URL as written instead.
 */
export function newWitness(vkey: string, witnessRoot: URL): Witness {
	return newWitnessFromRoot(vkey, witnessRoot.href);
}

/**
 * newWitnessFromRoot is newWitness for a witness root URL held as a string, which is how
 * newWitnessGroupFromPolicy keeps it so that the URL is not normalised (see parseWitnessURL).
 *
 * Port note: the https check is hardening with no Go counterpart, see
 * docs/decisions/0185-witness-urls-require-https.md.
 */
function newWitnessFromRoot(vkey: string, witnessRoot: string): Witness {
	const v = newVerifierForCosignatureV1(vkey);

	const u = urlJoinPath(witnessRoot, "/add-checkpoint");
	checkWitnessURL(u);

	return new Witness(v, u);
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
 * scanLines yields the lines of p the way `bufio.NewScanner(bytes.NewBuffer(p))` with its
 * default `ScanLines` split function scans them: one line per `\n`, with the `\n` and a `\r`
 * immediately before it removed, and no empty final line for data that ends with a newline.
 * Like the scanner, it gives up with bufio.ErrTooLong when it reaches a line of
 * bufio.MaxScanTokenSize (64 KiB) bytes or more, counting a `\r` before the newline but not
 * the newline itself, after yielding every line before it.
 */
function* scanLines(p: Uint8Array): Generator<string> {
	let start = 0;
	while (start < p.length) {
		const nl = p.indexOf(0x0a, start);
		const end = nl < 0 ? p.length : nl;
		if (end - start >= maxScanTokenSize) {
			throw errTooLong;
		}
		const lineEnd = end > start && p[end - 1] === 0x0d ? end - 1 : end;
		yield fromUTF8(p.subarray(start, lineEnd));
		start = end + 1;
	}
}

/** maxScanTokenSize is bufio.MaxScanTokenSize, the longest line a default bufio.Scanner accepts. */
const maxScanTokenSize = 64 * 1024;

/** errTooLong stands in for bufio.ErrTooLong, which newWitnessGroupFromPolicy returns unwrapped. */
const errTooLong = new SentinelError("bufio.Scanner: token too long");

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
 * parseWitnessURL checks a witness URL from a policy file and returns it unchanged.
 *
 * Port note: Go parses it with `url.Parse` and later writes it back out with
 * `(*url.URL).String`, which keeps the URL as written apart from lower-casing the scheme.
 * The platform `URL` type normalises far more: it lower-cases the host, drops a default port
 * and rewrites some paths. So the string itself is kept, and the platform parser is used
 * only to reject what is not an absolute URL. That rejection is a narrowing of Go, whose
 * url.Parse accepts relative references too; a witness URL must be absolute and have a
 * `//` authority. Go's own check for control characters is kept, with Go's error text. See
 * docs/decisions/0078-witness-url-joinpath-reimplemented.md.
 */
function parseWitnessURL(rawURL: string): string {
	const [u] = cut(rawURL, "#");
	for (let i = 0; i < u.length; i++) {
		const c = u.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) {
			throw new Error(`parse ${quote(u)}: net/url: invalid control character in URL`);
		}
	}
	const colon = rawURL.indexOf(":");
	if (!URL.canParse(rawURL) || !rawURL.startsWith("//", colon + 1)) {
		throw new Error(`parse ${quote(u)}: not an absolute URL with a "//" authority`);
	}
	return rawURL;
}

/**
 * urlJoinPath reproduces Go's `url.Parse(rawURL)` followed by `.JoinPath(elem...).String()`
 * for an absolute URL with a `//` authority, which is every URL parseWitnessURL accepts and
 * every `URL.href` newWitness can be given: the scheme is lower-cased, the authority, query
 * and fragment are kept as written, and the path is joined with elem the way JoinPath joins
 * it (path.Join, keeping one trailing slash when the last element has one, and making the
 * path rooted when there is a host).
 *
 * Port note: Go also re-escapes a path, userinfo, host or fragment that is not validly
 * percent-encoded (non-ASCII bytes, for example); this keeps such bytes as written. See
 * docs/decisions/0078-witness-url-joinpath-reimplemented.md.
 */
function urlJoinPath(rawURL: string, ...elem: string[]): string {
	const [beforeFragment, fragment] = cut(rawURL, "#");
	const [beforeQuery, query, hasQuery] = cut(beforeFragment, "?");
	const colon = beforeQuery.indexOf(":");
	const scheme = beforeQuery.slice(0, colon).toLowerCase();
	const hierarchical = beforeQuery.slice(colon + 3);
	const slash = hierarchical.indexOf("/");
	const authority = slash < 0 ? hierarchical : hierarchical.slice(0, slash);
	const path = slash < 0 ? "" : hierarchical.slice(slash);
	const host = authority.slice(authority.lastIndexOf("@") + 1);

	const elems = [path, ...elem];
	let p: string;
	if (!path.startsWith("/")) {
		p = goPathJoin(`/${path}`, ...elem).slice(1);
	} else {
		p = goPathJoin(...elems);
	}
	if ((elems[elems.length - 1] as string).endsWith("/") && !p.endsWith("/")) {
		p += "/";
	}

	let out = `${scheme}://${authority}`;
	if (p !== "" && !p.startsWith("/") && host !== "") {
		out += "/";
	}
	out += p;
	if (hasQuery) {
		out += `?${query}`;
	}
	if (fragment !== "") {
		out += `#${fragment}`;
	}
	return out;
}

/**
 * checkWitnessURL throws unless u, as fetch will read it, is an https URL, or an http URL
 * whose host is a loopback address.
 *
 * Port note: hardening with no Go counterpart, see
 * docs/decisions/0185-witness-urls-require-https.md. The check reads u with the platform URL
 * parser because that is the parser fetch uses, so what is checked is where requests go.
 */
function checkWitnessURL(u: string): void {
	let parsed: URL;
	try {
		parsed = new URL(u);
	} catch (err) {
		throw wrapError(`witness URL ${quote(u)} is not a valid URL`, err);
	}
	if (parsed.protocol === "https:") {
		return;
	}
	if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
		return;
	}
	throw new Error(`witness URL ${quote(u)} must use https (http is accepted only for a loopback host)`);
}

/**
 * isLoopbackHost reports whether hostname, as the platform URL parser normalises it, is
 * localhost, an address in 127.0.0.0/8, or ::1.
 */
function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * goPathJoin mirrors Go's `path.Join`: empty elements are ignored, the rest are joined with
 * "/" and the result is Cleaned; if every element is empty the result is "".
 */
function goPathJoin(...elem: string[]): string {
	const first = elem.findIndex((e) => e !== "");
	if (first < 0) {
		return "";
	}
	return goPathClean(elem.slice(first).join("/"));
}
/** goPathClean mirrors Go's `path.Clean`, scoped to the rooted (absolute) paths this file produces. */
function goPathClean(p: string): string {
	if (p === "") {
		return ".";
	}
	const rooted = p.startsWith("/");
	const segments = p.split("/");
	const out: string[] = [];
	for (const seg of segments) {
		if (seg === "" || seg === ".") {
			continue;
		}
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") {
				out.pop();
			} else if (!rooted) {
				out.push("..");
			}
			continue;
		}
		out.push(seg);
	}
	let result = out.join("/");
	if (rooted) {
		result = `/${result}`;
	} else if (result === "") {
		result = ".";
	}
	return result;
}
