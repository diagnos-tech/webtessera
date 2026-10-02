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

// The harness's report: every step printed as it finishes, with the evidence it produced, and a
// per-backend, per-direction verdict at the end. A failing step stops its scenario (later steps
// depend on it) but not the others, so one run shows everything that is wrong.

/** StepFailed aborts the rest of a scenario once one of its steps has failed and been reported. */
class StepFailed extends Error {}

export class Report {
	#verdicts = [];

	/** line prints a line of the report. */
	line(text = "") {
		process.stdout.write(`${text}\n`);
	}

	/**
	 * scenario runs body, which calls step for each of its steps, and records whether every
	 * step passed. Errors other than a reported step failure are reported as one.
	 */
	async scenario(backend, direction, body) {
		let ok = true;
		try {
			await body((what, fn) => this.#step(direction, what, fn));
		} catch (err) {
			ok = false;
			if (!(err instanceof StepFailed)) {
				this.#fail(direction, "scenario", err);
			}
		}
		this.#verdicts.push({ backend, direction, ok });
	}

	async #step(direction, what, fn) {
		const started = performance.now();
		let detail;
		try {
			detail = await fn();
		} catch (err) {
			this.#fail(direction, what, err);
			throw new StepFailed(what);
		}
		const secs = ((performance.now() - started) / 1000).toFixed(1);
		this.line(`  ok    ${direction}  ${what} (${secs}s)`);
		for (const d of [detail ?? []].flat()) {
			this.line(`                    ${d}`);
		}
		return detail;
	}

	#fail(direction, what, err) {
		this.line(`  FAIL  ${direction}  ${what}`);
		for (const l of String(err instanceof Error ? err.message : err).split("\n")) {
			this.line(`          ${l}`);
		}
	}

	/** summary prints the verdicts and returns whether every scenario passed. */
	summary() {
		this.line();
		this.line("summary");
		const width = Math.max(...this.#verdicts.map((v) => v.backend.length));
		for (const backend of new Set(this.#verdicts.map((v) => v.backend))) {
			const cells = this.#verdicts
				.filter((v) => v.backend === backend)
				.map((v) => `${v.direction} ${v.ok ? "PASS" : "FAIL"}`);
			this.line(`  ${backend.padEnd(width)}   ${cells.join("   ")}`);
		}
		return this.#verdicts.every((v) => v.ok);
	}
}
