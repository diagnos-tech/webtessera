import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Runs the browser half for real, in a headless Chromium: the device key in IndexedDB, the log in
// IndexedDB, and the page's own fetch, against the real server, which test/browser_server.ts
// starts on Node for the run. The test page reaches it through the same proxy routes as
// vite.config.ts, so that it is one origin, as in production.
const port = Number(process.env.TEST_SERVER_PORT ?? "8799");
process.env.TEST_SERVER_PORT = String(port);
const server = `http://127.0.0.1:${port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
	server: {
		proxy: Object.fromEntries(["/session", "/witness", "/sessions", "/api"].map((path) => [path, server])),
	},
	test: {
		include: ["test/**/*_browser_test.ts"],
		globalSetup: ["test/browser_server.ts"],
		testTimeout: 30_000,
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
			instances: [{ browser: "chromium" }],
		},
	},
});
