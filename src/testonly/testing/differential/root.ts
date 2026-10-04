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
import { validUTF8 } from "../../../internal/gostd/unicode.ts";
import { defaultIDHasher, defaultMerkleLeafHasher, type LogReader } from "../../../lifecycle.ts";
import { newMigrationOptions } from "../../../migrate_lifecycle.ts";
import { newSigner } from "../../../vendor/note/note.ts";
import { newWitnessGroupFromPolicy, Witness, WitnessGroup } from "../../../witness.ts";
import { bytesToHex, hexToBytes, loadFixture, textToBytes, u64 } from "../../fixtures.ts";
import {
	attempt,
	attemptAsync,
	DifferentialReport,
	type DivergenceName,
	messageOf,
	sameModuloInvalidUTF8,
} from "../differential.ts";

type Tree = readonly ["group", number, readonly Tree[]] | readonly ["witness", string, number, string];

/**
 * PolicyRow is one recorded policy: Go's error text ("" for none), and then the group tree
 * and endpoints Go built, or, for a policy Go rejects, the line its error comes from (the
 * generator's policyErrLine: counted from 1, 0 when every line is accepted).
 */
type PolicyRow =
	| readonly [policy: string, err: "", tree: Tree | "notUTF8", endpoints?: readonly string[]]
	| readonly [policy: string, err: string, errLine: number];

interface PolicyCorpus {
	readonly cases: readonly PolicyRow[];
	/** binary rows carry the policy in hex: it is not valid UTF-8. */
	readonly binary: readonly PolicyRow[];
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
 * matches, or undefined: the messages ADR-0184, ADR-0185, ADR-0241 and ADR-0242 add.
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
	if (
		/^invalid witness config ".*": witness URL ".*" (has no host|is rejected by the platform URL parser, which fetch uses)$/.test(
			message,
		)
	) {
		return "witness-url-fetchable";
	}
	if (message === "witness policy line is not valid UTF-8") {
		return "witness-policy-utf8";
	}
	return undefined;
}

/**
 * portErrLine returns the line, counted from 1, whose processing gives the port's error
 * message for policy p, found as the generator's policyErrLine finds Go's: by running the
 * port on each prefix of whole lines followed by a valid "quorum none" line. It returns 0
 * if no prefix fails with message.
 */
function portErrLine(p: Uint8Array, message: string): number {
	const quorumNone = textToBytes("\nquorum none\n");
	for (let line = 1, start = 0; start < p.length; line++) {
		const nl = p.indexOf(0x0a, start);
		const end = nl < 0 ? p.length : nl + 1;
		const prefix = new Uint8Array(end + quorumNone.length);
		prefix.set(p.subarray(0, end));
		prefix.set(quorumNone, end);
		const got = attempt(() => newWitnessGroupFromPolicy(prefix));
		if (!got.ok && messageOf(got.error) === message) {
			return line;
		}
		start = end;
	}
	return 0;
}

// laterInGroupLine matches the errors Go reports on a group line after the checks the port
// adds there (its threshold of 0, and a child repeated before the one Go fails on).
const laterInGroupLine = /^(invalid component name ".*"|unknown component ".*" in group definition)$/;

/**
 * goAgrees reports whether Go's verdict on a policy is the one the rule of the divergence
 * the port applied permits: the port refuses line portLine, and Go processed every line
 * before it as the port did (goLine is 0, or after them). For the URL entries, and for a
 * verifier key repeated on a witness line, Go also accepts line portLine itself: its error,
 * if any, comes later in the policy. For a threshold of 0 or a repeated child on a group
 * line, Go may instead fail later on that same line, on a child the port never reaches. For
 * witness-policy-utf8, Go's verdict on the invalid line itself is not constrained.
 */
function goAgrees(
	hardening: DivergenceName,
	message: string,
	portLine: number,
	goLine: number,
	goErr: string,
): boolean {
	if (portLine === 0) {
		return false;
	}
	if (goLine === 0 || goLine > portLine) {
		return true;
	}
	if (goLine < portLine) {
		return false;
	}
	switch (hardening) {
		case "witness-policy-utf8":
			return true;
		case "witness-quorum-hardening":
			return !message.startsWith("witness ") && laterInGroupLine.test(goErr);
		default:
			return false;
	}
}

/**
 * checkPolicy compares the port's verdict on one policy with Go's: the same error text, or
 * the same group tree and endpoints, unless the port's rejection is one a documented
 * divergence permits and Go's verdict is the one that divergence's rule allows.
 */
function checkPolicy(rep: DifferentialReport, rid: string, p: Uint8Array, row: PolicyRow): void {
	const err = row[1];
	const got = attempt(() => newWitnessGroupFromPolicy(p));
	if (!got.ok) {
		const ts = messageOf(got.error);
		if (ts === err) {
			return;
		}
		const hardening = policyHardening(ts);
		if (hardening === undefined) {
			rep.fail(
				rid,
				err === "" ? `go accepted, ts rejected: ${ts}` : `err: go=${JSON.stringify(err)} ts=${JSON.stringify(ts)}`,
			);
			return;
		}
		if (hardening === "witness-policy-utf8" && validUTF8(p)) {
			rep.fail(rid, "witness-policy-utf8 applied to a policy that is valid UTF-8");
			return;
		}
		const portLine = portErrLine(p, ts);
		const goLine = err === "" ? 0 : (row[2] as number);
		if (!goAgrees(hardening, ts, portLine, goLine, err)) {
			rep.fail(
				rid,
				`${hardening} applied on line ${portLine}, but go ${err === "" ? "accepted" : `rejected on line ${goLine}: ${JSON.stringify(err)}`}`,
			);
			return;
		}
		rep.diverge(hardening);
		return;
	}
	if (err !== "") {
		rep.fail(rid, `go rejected (${err}), ts accepted`);
		return;
	}
	rep.equal(rid, "tree", row[2], treeOf(got.value));
	rep.equal(rid, "endpoints", row[3], [...got.value.endpoints().keys()].sort());
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
			for (const row of f.cases) {
				rep.record();
				checkPolicy(rep, `policy=${JSON.stringify(row[0])}`, textToBytes(row[0]), row);
			}
			for (const row of f.binary) {
				rep.record();
				checkPolicy(rep, `policyHex=${row[0]}`, hexToBytes(row[0]), row);
			}
			rep.assertClean(
				800,
				["witness-quorum-hardening", "witness-url-https", "witness-url-fetchable", "witness-policy-utf8"],
				["witness-quorum-hardening", "witness-url-https", "witness-url-fetchable", "witness-policy-utf8"],
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
