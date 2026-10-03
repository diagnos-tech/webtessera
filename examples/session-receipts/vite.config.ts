import { defineConfig } from "vite";

// Serves the browser client (client/) and forwards the server's routes to the session server,
// so that the page, its witness and its uploads share one origin. Start the server first:
// `node server/main.ts` (or Bun, or Deno), listening on SERVER_URL.
const server = process.env.SERVER_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
	root: "client",
	server: {
		proxy: Object.fromEntries(["/session", "/witness", "/sessions", "/api"].map((path) => [path, server])),
	},
	build: { outDir: "dist", emptyOutDir: true },
});
