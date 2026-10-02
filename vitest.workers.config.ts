import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs only the Durable Object driver suite, inside the real workerd runtime.
// What is under test is precisely Durable Object storage and concurrency
// semantics (input/output gates, transactional storage, eviction and restart),
// which no Node fake reproduces faithfully enough for an append-only log.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./src/storage/durableobject/testing/wrangler.jsonc" },
		}),
	],
	test: {
		include: ["src/storage/durableobject/**/*_test.ts"],
		testTimeout: 30_000,
	},
});
