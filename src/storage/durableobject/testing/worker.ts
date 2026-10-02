// Test-only Worker for the Durable Object driver suite (see vitest.workers.config.ts).
// It is excluded from the published build.

export class TestLog {
	readonly #state: { storage: unknown };

	constructor(state: { storage: unknown }) {
		this.#state = state;
	}

	fetch(): Response {
		return new Response(typeof this.#state.storage);
	}
}

export default {
	fetch(): Response {
		return new Response("ok");
	},
};
