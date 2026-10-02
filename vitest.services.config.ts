import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Runs the `*_services_test.ts` suites, which talk to real external services that
// CI starts as containers: an rqlite node (RQLITE_URL) for the SQLite backend and an
// S3-compatible object store (S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY) for the mirror. They are kept out of the unit suite so that
// `pnpm test:unit` needs nothing but Node; each suite fails, rather than skips, when
// its service is not configured.
export default defineConfig({
	resolve: base.resolve,
	test: {
		include: ["src/**/*_services_test.ts"],
		testTimeout: 60_000,
	},
});
