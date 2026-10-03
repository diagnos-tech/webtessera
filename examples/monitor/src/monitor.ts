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
// A monitor follows a log it does not trust. On every check it fetches the log's checkpoint,
// verifies the log's signature, and proves that the new tree contains the last one it verified,
// with a consistency proof built from the log's own tiles. A log that forked (showed two
// different histories) or rolled back (showed an older one) cannot pass, and the monitor keeps
// the two signed checkpoints that prove it.
//
// The proving is webtessera/client's LogStateTracker, a port of Tessera's; this file decides what
// to remember, and what to report.

import {
	type ConsensusCheckpointFunc,
	ErrInconsistency,
	type FetchFn,
	newHTTPFetcher,
	newLogStateTracker,
	unilateralConsensus,
} from "webtessera/client";
import { newVerifier } from "webtessera/note";
import type { StateStore } from "./state.ts";

/** MonitorEvent is the outcome of one check. */
export type MonitorEvent =
	| { readonly kind: "grew"; readonly from: bigint; readonly to: bigint }
	| { readonly kind: "unchanged"; readonly size: bigint }
	| { readonly kind: "rollback"; readonly verified: bigint; readonly served: bigint }
	| { readonly kind: "fork"; readonly evidence: string; readonly detail: string }
	| { readonly kind: "error"; readonly detail: string };

/** MonitorOptions says which log to follow, and where to keep what was verified. */
export interface MonitorOptions {
	/** url is the URL prefix the log serves the tlog-tiles API at. */
	readonly url: URL;
	/** vkey is the log's published verifier key. */
	readonly vkey: string;
	readonly state: StateStore;
	/** fetch makes the HTTP requests; tests pass a fake log's handler. */
	readonly fetch?: FetchFn;
}

/** Monitor checks a log, one check at a time. */
export interface Monitor {
	/** started says what the monitor trusted when it opened: a saved checkpoint, or the log's latest. */
	readonly started: { readonly size: bigint; readonly resumed: boolean };
	check(signal?: AbortSignal): Promise<MonitorEvent>;
}

/**
 * openMonitor resumes from the saved checkpoint, or, on the first run, trusts the log's current
 * checkpoint (trust on first use: start from a checkpoint you got elsewhere to avoid that).
 */
export async function openMonitor(options: MonitorOptions): Promise<Monitor> {
	const verifier = newVerifier(options.vkey);
	const log = newHTTPFetcher(new URL(options.url), options.fetch);
	// Remember the size of the checkpoint each check was served, to tell a rollback (an older
	// checkpoint) from a log that simply did not grow.
	let served: bigint | undefined;
	const fetchLatest = unilateralConsensus((s) => log.readCheckpoint(s));
	const consensus: ConsensusCheckpointFunc = async (v, origin, signal) => {
		const fetched = await fetchLatest(v, origin, signal);
		served = fetched.checkpoint.size;
		return fetched;
	};

	// On the first run the log's current checkpoint is fetched (and its signature verified)
	// here rather than inside the tracker, because the tracker keeps the raw checkpoint to
	// itself, and the raw checkpoint is what must be saved.
	const saved = await options.state.load();
	const initial = saved ?? (await fetchLatest(verifier, verifier.name())).raw;
	const tracker = await newLogStateTracker(
		(l, i, p, s) => log.readTile(l, i, p, s),
		initial,
		verifier,
		verifier.name(),
		consensus,
	);
	if (saved === undefined) {
		await options.state.save(initial);
	}
	return {
		started: { size: tracker.latest().size, resumed: saved !== undefined },
		async check(signal) {
			const verified = tracker.latest().size;
			served = undefined;
			try {
				const { old, newer } = await tracker.update(signal);
				if (served !== undefined && served < verified) {
					return { kind: "rollback", verified, served };
				}
				if (newer === old || newer === undefined) {
					return { kind: "unchanged", size: verified };
				}
				await options.state.save(newer);
				return { kind: "grew", from: verified, to: tracker.latest().size };
			} catch (err) {
				if (err instanceof ErrInconsistency) {
					return fork(options.state, err);
				}
				// An older checkpoint that the log cannot even prove consistent with the newer one
				// (it no longer has the tiles) is still a rollback.
				if (served !== undefined && served < verified) {
					return { kind: "rollback", verified, served };
				}
				return { kind: "error", detail: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}

/**
 * fork keeps the evidence: two checkpoints, both validly signed by the log, that no consistency
 * proof can join. Anyone holding the log's vkey can check that this file proves misbehaviour.
 * The saved checkpoint is left as it was, so every later check fails too.
 */
async function fork(state: StateStore, err: ErrInconsistency): Promise<MonitorEvent> {
	const dec = new TextDecoder();
	const evidence = [
		...err.message.split("\n").map((line) => `# ${line}`),
		"# The log signed both checkpoints below, and no consistency proof joins them.",
		"",
		"## checkpoint 1",
		dec.decode(err.smallerRaw),
		"## checkpoint 2",
		dec.decode(err.largerRaw),
		"## consistency proof served by the log (base64, one hash per line)",
		...err.proof.map((h) => btoa(String.fromCharCode(...h))),
		"",
	].join("\n");
	const path = await state.keepEvidence(`fork-${new Date().toISOString().replaceAll(":", "")}.txt`, evidence);
	return { kind: "fork", evidence: path, detail: err.message };
}
