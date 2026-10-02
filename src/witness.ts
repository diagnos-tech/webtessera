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
// `bufio.Scanner`/`bytes.Buffer` become a plain string split; `url.URL.JoinPath` has no
// JavaScript/DOM equivalent (the platform `URL` type does not implement it), so a small
// scoped `pathJoin` helper reproduces Go's `path.Join`/`path.Clean` semantics for exactly
// the shapes this file needs -- see that helper's own comment.

import { fromUTF8 } from "./internal/gostd/bytes.ts";
import { parseUint, quote } from "./internal/gostd/strconv.ts";
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

	let quorumName = "";
	for (const rawLine of scanLines(p)) {
		let line = rawLine.trim();
		const hashIdx = line.indexOf("#");
		if (hashIdx >= 0) {
			line = line.slice(0, hashIdx);
		}
		if (line === "") {
			continue;
		}

		const fields = line.split(/\s+/).filter((s) => s.length > 0);
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
				let witnessURL: URL;
				try {
					witnessURL = new URL(witnessURLStr);
				} catch (err) {
					throw new Error(`invalid witness URL ${quote(witnessURLStr)}: ${errText(err)}`);
				}
				let w: Witness;
				try {
					w = newWitness(vkey, witnessURL);
				} catch (err) {
					throw new Error(`invalid witness config ${quote(line)}: ${errText(err)}`);
				}
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
							throw new Error(`invalid threshold ${quote(N)} for group ${quote(name)}: ${errText(err)}`);
						}
						n = Number(i);
						break;
					}
				}
				if (childrenNames.length < n) {
					throw new Error(`group with ${childrenNames.length} children cannot have threshold ${n}`);
				}

				const children: policyComponent[] = [];
				for (const cName of childrenNames) {
					if (isBadName(cName)) {
						throw new Error(`invalid component name ${quote(cName)}`);
					}
					const child = components.get(cName);
					if (child === undefined) {
						throw new Error(`unknown component ${quote(cName)} in group definition`);
					}
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

/**
 * scanLines splits p into lines the way `bufio.NewScanner(bytes.NewBuffer(p))`'s default
 * `ScanLines` split function does: one entry per line, the trailing `\n` (and a `\r`
 * immediately before it) stripped, and no trailing empty entry for data that ends with a
 * final newline.
 */
function scanLines(p: Uint8Array): string[] {
	const text = fromUTF8(p);
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const keywords = new Set(["witness", "group", "any", "all", "none", "quorum", "log"]);

function isBadName(n: string): boolean {
	return keywords.has(n);
}

/**
 * newWitness returns a Witness given a verifier key and the root URL for where this
 * witness can be reached.
 */
export function newWitness(vkey: string, witnessRoot: URL): Witness {
	const v = newVerifierForCosignatureV1(vkey);
	const u = urlJoinPath(witnessRoot, "/add-checkpoint");
	return new Witness(v, u.toString());
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
 * urlJoinPath reproduces Go's `(*url.URL).JoinPath` for the shapes this file needs: an
 * absolute `u` (path already starting with "/", which every witness root URL is, since it
 * came from `new URL(...)`) joined with further path elements.
 *
 * Port note: the platform `URL` type has no `.JoinPath` equivalent. This is *not* a
 * general port of Go's `path` package (no other file in this port needs one) -- it
 * implements exactly `path.Join` followed by `path.Clean`'s slash-collapsing and `.`/`..`
 * resolution, which is all `JoinPath` calls internally, scoped to the one call site below
 * (`newWitness` joining `/add-checkpoint` onto a witness root that may itself already have
 * a path prefix, per witness_test.go's `TestWitnessGroup_URLs`). See
 * docs/decisions/0078-witness-url-joinpath-reimplemented.md.
 */
function urlJoinPath(u: URL, ...elem: string[]): URL {
	const joined = goPathJoin(u.pathname, ...elem);
	const out = new URL(u.toString());
	out.pathname = joined;
	return out;
}

/** goPathJoin mirrors Go's `path.Join`: join elements with "/", then Clean the result. */
function goPathJoin(...elem: string[]): string {
	return goPathClean(elem.join("/"));
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
