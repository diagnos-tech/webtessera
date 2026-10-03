import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the `*_workers_test.ts` suites inside the real workerd runtime: the SQLite backend
// on Cloudflare D1 and on SQLite-backed Durable Objects. What is under test there is the
// runtime's own SQLite and its concurrency semantics (D1 batches, transactionSync, input
// and output gates, eviction and restart), which no Node fake reproduces faithfully.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./src/storage/sqlite/testing/workers/wrangler.jsonc" },
		}),
	],
	test: {
		include: ["src/**/*_workers_test.ts"],
		testTimeout: 30_000,
	},
});
