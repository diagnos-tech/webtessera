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

// Differential suites for Tessera's root package over
// fixtures/data/differential_{witness_policy,bundle_hashers,checkpoint_publisher}.json
// (fixtures/gen/differential_root.go).

import { describe, it } from "vitest";
import { newAppendOptions } from "../../../append_lifecycle.ts";
import type { FetchFn } from "../../../client/fetcher.ts";
import { ctBundleIDHasher, ctMerkleLeafHasher, withCTLayout } from "../../../ct_only.ts";
import { ErrNotExist } from "../../../internal/gostd/errors.ts";
import { defaultIDHasher, defaultMerkleLeafHasher, type LogReader } from "../../../lifecycle.ts";
import { newMigrationOptions } from "../../../migrate_lifecycle.ts";
import { newSigner } from "../../../vendor/note/note.ts";
import { newWitnessGroupFromPolicy, Witness, WitnessGroup } from "../../../witness.ts";
import { bytesToHex, hexToBytes, loadFixture, textToBytes, u64 } from "../../fixtures.ts";
import {
	attempt,
	attemptAsync,
	canonical,
	DifferentialReport,
	type DivergenceName,
	messageOf,
	sameModuloInvalidUTF8,
} from "../differential.ts";

type Tree = readonly ["group", number, readonly Tree[]] | readonly ["witness", string, number, string];

interface PolicyCorpus {
	readonly cases: readonly (readonly [policy: string, err: string, tree?: Tree, endpoints?: readonly string[]])[];
}

type Hashes = readonly [err: string] | readonly ["", readonly string[]];

interface BundleCorpus {
	readonly tlog: readonly (readonly [bundle: string, id: Hashes, leaf: Hashes])[];
	readonly static: readonly (readonly [bundle: string, id: Hashes, leaf: Hashes, appendID: Hashes])[];
}

interface PublisherCorpus {
	readonly signerConfigs: readonly (readonly string[])[];
	readonly sign: readonly (readonly [config: number, size: string, root: string, err: string, cp: string])[];
	readonly previous: readonly (readonly [old: string, err: string])[];
}

function treeOf(c: unknown): Tree | string {
	if (c instanceof WitnessGroup) {
		return ["group", c.n, c.components.map((x) => treeOf(x) as Tree)];
	}
	if (c instanceof Witness) {
		return ["witness", c.key.name(), c.key.keyHash(), c.url];
	}
	return `unexpected component ${String(c)}`;
}

/**
 * policyHardening names the documented divergence a policy rejection of the port's
 * matches, or undefined: the messages ADR-0184, ADR-0185 and ADR-0078 add.
 */
function policyHardening(message: string): DivergenceName | undefined {
	if (
		/^invalid threshold "0" for group ".*": must be at least 1$/.test(message) ||
		/^repeated component ".*" in group definition$/.test(message) ||
		/^witness ".*" has the same verifier key as witness ".*"$/.test(message)
	) {
		return "witness-quorum-hardening";
	}
	if (
		/^invalid witness config ".*": witness URL ".*" must use https \(http is accepted only for a loopback host\)$/.test(
			message,
		)
	) {
		return "witness-url-https";
	}
	if (/^invalid witness URL "(.*)": parse "\1": not an absolute URL with a "\/\/" authority$/.test(message)) {
		return "witness-url-absolute";
	}
	return undefined;
}

/** unescapeURLs decodes the percent-escapes of every witness URL in a Go policy tree. */
function unescapeURLs(t: Tree | undefined): Tree | undefined {
	if (t === undefined) {
		return undefined;
	}
	if (t[0] === "witness") {
		return ["witness", t[1], t[2], decodeURI(t[3])];
	}
	return ["group", t[1], t[2].map((c) => unescapeURLs(c) as Tree)];
}

function hashes(f: (b: Uint8Array) => Uint8Array[], b: Uint8Array): Hashes {
	const got = attempt(() => f(b));
	return got.ok ? ["", got.value.map(bytesToHex)] : [messageOf(got.error)];
}

/** logReader serves a fixed previous checkpoint, or none, to the checkpoint publisher. */
function logReader(cp: Uint8Array | undefined): LogReader {
	return {
		readCheckpoint: async () => {
			if (cp === undefined) {
				throw ErrNotExist;
			}
			return cp;
		},
		readTile: async () => {
			throw ErrNotExist;
		},
		readEntryBundle: async () => {
			throw ErrNotExist;
		},
		nextIndex: async () => 0n,
		integratedSize: async () => 0n,
	};
}

const noFetch: FetchFn = async () => {
	throw new Error("the differential checkpoint publisher makes no HTTP requests");
};

/** describeRootDifferential registers the root-package differential tests. */
export function describeRootDifferential(): void {
	describe("tessera root package differential (differential_{witness_policy,bundle_hashers,checkpoint_publisher}.json)", () => {
		it("newWitnessGroupFromPolicy reaches Go's verdict, error text, group tree and endpoints", async () => {
			const f = await loadFixture<PolicyCorpus>("differential_witness_policy");
			const rep = new DifferentialReport("newWitnessGroupFromPolicy");
			for (const [policy, err, tree, endpoints] of f.cases) {
				rep.record();
				const rid = `policy=${JSON.stringify(policy)}`;
				const got = attempt(() => newWitnessGroupFromPolicy(textToBytes(policy)));
				const badEscape = /^invalid witness URL "(.*)": parse "\1": invalid URL escape "%[^"]{0,2}"$/.exec(err);
				if (badEscape !== null && !(got.ok === false && messageOf(got.error) === err)) {
					// ADR-0078: the port keeps a malformed escape as written. It either accepts the
					// policy, with that URL among its endpoints, or stops at an independent later line.
					const u = badEscape[1] as string;
					const asWritten = u.slice(u.indexOf("://"));
					if (!got.ok || [...got.value.endpoints().keys()].some((e) => e.includes(asWritten))) {
						rep.diverge("witness-url-escaping");
					} else {
						rep.fail(rid, `malformed escape: ts accepted but no endpoint keeps ${JSON.stringify(u)} as written`);
					}
					continue;
				}
				if (!got.ok) {
					const ts = messageOf(got.error);
					if (ts === err) {
						continue;
					}
					const hardening = policyHardening(ts);
					if (hardening !== undefined) {
						rep.diverge(hardening);
						continue;
					}
					rep.fail(
						rid,
						err === "" ? `go accepted, ts rejected: ${ts}` : `err: go=${JSON.stringify(err)} ts=${JSON.stringify(ts)}`,
					);
					continue;
				}
				if (err !== "") {
					rep.fail(rid, `go rejected (${err}), ts accepted`);
					continue;
				}
				const tsTree = treeOf(got.value);
				const tsEndpoints = [...got.value.endpoints().keys()].sort();
				if (canonical(tree) === canonical(tsTree) && canonical(endpoints) === canonical(tsEndpoints)) {
					continue;
				}
				if (
					canonical(unescapeURLs(tree)) === canonical(tsTree) &&
					canonical((endpoints ?? []).map(decodeURI).sort()) === canonical(tsEndpoints)
				) {
					rep.diverge("witness-url-escaping");
					continue;
				}
				rep.equal(rid, "tree", tree, tsTree);
				rep.equal(rid, "endpoints", endpoints, tsEndpoints);
			}
			rep.assertClean(
				650,
				["witness-quorum-hardening", "witness-url-https", "witness-url-absolute", "witness-url-escaping"],
				["witness-quorum-hardening", "witness-url-https", "witness-url-absolute", "witness-url-escaping"],
			);
		});

		it("the tlog-tiles and static-ct bundle hashers return Go's hashes or error text", async () => {
			const f = await loadFixture<BundleCorpus>("differential_bundle_hashers");
			const rep = new DifferentialReport("bundle hashers");
			const migrationLeaf = newMigrationOptions().leafHasher();
			const ctMigrationLeaf = withCTLayout(newMigrationOptions()).leafHasher();
			for (const [bundle, id, leaf] of f.tlog) {
				rep.record();
				const b = hexToBytes(bundle);
				rep.equal(`tlog ${bundle}`, "identity", id, hashes(defaultIDHasher, b));
				rep.equal(`tlog ${bundle}`, "leaf", leaf, hashes(defaultMerkleLeafHasher, b));
				rep.equal(`tlog ${bundle}`, "MigrationOptions.leafHasher", leaf, hashes(migrationLeaf, b));
			}
			for (const [bundle, id, leaf, appendID] of f.static) {
				rep.record();
				const b = hexToBytes(bundle);
				rep.equal(`static ${bundle}`, "identity", id, hashes(ctBundleIDHasher, b));
				rep.equal(`static ${bundle}`, "identity (AppendOptions)", appendID, hashes(ctBundleIDHasher, b));
				rep.equal(`static ${bundle}`, "leaf", leaf, hashes(ctMerkleLeafHasher, b));
				rep.equal(`static ${bundle}`, "MigrationOptions.leafHasher", leaf, hashes(ctMigrationLeaf, b));
			}
			rep.assertClean(400);
		});

		it("checkpointPublisher signs Go's checkpoint bytes and rejects each previous checkpoint Go rejects", async () => {
			const f = await loadFixture<PublisherCorpus>("differential_checkpoint_publisher");
			const rep = new DifferentialReport("checkpointPublisher");
			for (const [config, size, root, err, cp] of f.sign) {
				rep.record();
				const [first, ...rest] = (f.signerConfigs[config] as readonly string[]).map((k) => newSigner(k));
				const opts = newAppendOptions();
				if (first === undefined) {
					throw new Error("empty signer configuration");
				}
				opts.withCheckpointSigner(first, ...rest);
				const pub = opts.checkpointPublisher(logReader(undefined), noFetch);
				const got = await attemptAsync(() => pub(u64(size), hexToBytes(root)));
				rep.equal(
					`config=${config} size=${size} root=${root}`,
					"checkpoint",
					err === "" ? `ok:${cp}` : `err:${err}`,
					got.ok ? `ok:${bytesToHex(got.value)}` : `err:${messageOf(got.error)}`,
				);
			}
			const signer = newSigner((f.signerConfigs[0] as readonly string[])[0] as string);
			for (const [old, err] of f.previous) {
				rep.record();
				const opts = newAppendOptions();
				opts.withCheckpointSigner(signer);
				const pub = opts.checkpointPublisher(logReader(hexToBytes(old)), noFetch);
				const got = await attemptAsync(() => pub(9n, new Uint8Array(32)));
				const rid = `previous=${old}`;
				const ts = got.ok ? "" : messageOf(got.error);
				if (err === ts) {
					continue;
				}
				if (err !== "" && ts !== "" && sameModuloInvalidUTF8(err, ts)) {
					rep.diverge("invalid-utf8-text");
					continue;
				}
				rep.fail(rid, `go=${JSON.stringify(err)} ts=${JSON.stringify(ts)}`);
			}
			rep.assertClean(400, ["invalid-utf8-text"]);
		});
	});
}
