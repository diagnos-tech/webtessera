#!/usr/bin/env node
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

// Publishes one tarball to one npm registry, and is safe to run again.
//
// Usage:
//
//     node scripts/release/publish.mjs <tarball.tgz> --registry <url> --tag <dist-tag> \
//         [--expect-version <x.y.z>] [--access public] [--provenance] [--dry-run]
//
// Authentication is not this script's business: the workflow configures npm (setup-node's
// registry-url and NODE_AUTH_TOKEN, or npm's trusted-publishing OIDC exchange), and the npm
// commands below inherit that.
//
// Why a wrapper around `npm publish`: a release touches two registries, so it can half
// succeed, and re-running it must then finish the job instead of failing on the registry
// that already has the version. Before publishing, the script asks the registry what it
// holds for name@version:
//
//   - nothing: publish;
//   - the same bytes (equal sha512 integrity): report "already published" and succeed;
//   - different bytes: fail, because a version is immutable and the registry now holds
//     something other than what this run built. Cut a new version.
//
// If the publish itself fails, the registry is asked once more, so that a lost race
// (published a moment ago by another run, or by this one before its connection dropped) is
// still a success when the bytes match. Every other failure is passed on unchanged.
//
// --dry-run does the lookup and then `npm publish --dry-run`, which validates the package
// and shows what would be uploaded without uploading it.
//
// Zero dependencies; needs Node >= 20, and tar and npm on PATH.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const out = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
	process.stderr.write(`::error title=Publish failed::${message}\n`);
	process.exit(1);
};

const args = process.argv.slice(2);
const takeFlag = (name) => {
	const i = args.indexOf(name);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
};
const takeValue = (name) => {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const [, value] = args.splice(i, 2);
	return value;
};

const registry = takeValue("--registry");
const distTag = takeValue("--tag");
const access = takeValue("--access");
const expectVersion = takeValue("--expect-version");
const provenance = takeFlag("--provenance");
const dryRun = takeFlag("--dry-run");
const [input, ...extra] = args;
if (!input || extra.length > 0 || !registry || !distTag) {
	fail(
		"usage: publish.mjs <tarball.tgz> --registry <url> --tag <dist-tag> [--expect-version <x.y.z>] [--access public] [--provenance] [--dry-run]",
	);
}

const tarball = resolve(input);
if (!existsSync(tarball)) {
	fail(`${tarball} does not exist`);
}

// What this run built, from the tarball itself rather than from the checkout.
const manifest = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
const spec = `${manifest.name}@${manifest.version}`;
if (expectVersion !== undefined && manifest.version !== expectVersion) {
	fail(`the tarball holds version ${manifest.version}, but ${expectVersion} was expected`);
}
const localIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;

/** lookup returns the integrity the registry holds for spec, or null if it holds no such version. */
function lookup() {
	try {
		const stdout = execFileSync("npm", ["view", spec, "dist.integrity", "--json", "--registry", registry], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return JSON.parse(stdout);
	} catch (err) {
		// With --json, npm prints the error as JSON on stdout. Only a 404 means "not there";
		// anything else (401, 403, 5xx, no network) says nothing about the version and must
		// not be mistaken for it.
		try {
			if (JSON.parse(String(err.stdout)).error.code === "E404") {
				return null;
			}
		} catch {
			// Not JSON: fall through to the generic failure.
		}
		throw new Error(`could not look up ${spec} on ${registry}:\n${String(err.stderr || err.message).trim()}`);
	}
}

function summarize(line) {
	out(line);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
	}
}

/** settle reports an existing version: success if it is our bytes, failure otherwise. */
function settle(remoteIntegrity) {
	if (remoteIntegrity === localIntegrity) {
		summarize(`${spec} is already on ${registry} with identical contents; nothing to publish`);
		return;
	}
	fail(
		`${spec} already exists on ${registry} with different contents.\n` +
			`  registry: ${remoteIntegrity}\n  this run: ${localIntegrity}\n` +
			"A published version is immutable. If this build is the one that should ship, bump the version.",
	);
}

let existing;
try {
	existing = lookup();
} catch (err) {
	fail(err.message);
}
if (existing !== null) {
	settle(existing);
	process.exit(0);
}

const publishArgs = ["publish", tarball, "--registry", registry, "--tag", distTag];
if (access) publishArgs.push("--access", access);
if (provenance) publishArgs.push("--provenance");
if (dryRun) publishArgs.push("--dry-run");

out(`npm ${publishArgs.join(" ")}`);
try {
	execFileSync("npm", publishArgs, { stdio: "inherit" });
} catch (err) {
	if (dryRun) {
		fail(`npm publish --dry-run failed: ${err.message}`);
	}
	let after;
	try {
		after = lookup();
	} catch {
		after = null;
	}
	if (after === null) {
		fail(`npm publish failed (see above): ${err.message}`);
	}
	settle(after);
	process.exit(0);
}

summarize(
	dryRun
		? `${spec}: dry run passed for ${registry} (dist-tag ${distTag}); nothing was uploaded`
		: `${spec} published to ${registry} (dist-tag ${distTag})`,
);
