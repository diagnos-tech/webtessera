import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { generateKey } from "webtessera/note";

// A throwaway signing key for the log under test. The verifier key is bound too, as a
// test-only binding, so that the tests can check the checkpoints' signatures.
const { skey, vkey } = generateKey(undefined, "example.com/webtessera-test-log");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: { LOG_SKEY: skey, TEST_LOG_VKEY: vkey },
				// The Worker itself needs no flags; @cloudflare/vitest-pool-workers needs
				// nodejs_compat to run Vitest inside workerd.
				compatibilityFlags: ["nodejs_compat"],
			},
		}),
	],
	test: {
		include: ["src/**/*_test.ts"],
		testTimeout: 30_000,
	},
});
