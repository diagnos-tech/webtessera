import { defineConfig } from "vitest/config";

// The tests run on Node, against temporary SQLite files, with no network beyond loopback.
export default defineConfig({
	test: {
		include: ["src/**/*_test.ts"],
		testTimeout: 30_000,
	},
});
