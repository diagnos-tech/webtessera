# ADR-0221: Keep `webtessera/server` out of browsers, at build time with an export condition and at run time with runtime detection

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** DX guardrails contributor
- **Upstream reference:** n/a

## Context

`webtessera/server` imports signer keys (ADR-0222). In a browser bundle that key is public. A developer who
imports it from shared, "isomorphic" code, or from the wrong file, must find out at once, preferably before the
bundle is built, and the check must not stop it working where it belongs: Node, Deno, Bun, and edge runtimes,
of which workerd (Cloudflare Workers) defines neither `window` nor `document`, and has a `ServiceWorkerGlobalScope`
as its global object.

## Decision

Two independent guards.

**1. Build time: a conditional export.** In `package.json`:

```json
"./server": {
  "workerd": "./dist/server/index.js",
  "edge-light": "./dist/server/index.js",
  "react-native": "./dist/server/browser_guard.js",
  "browser": "./dist/server/browser_guard.js",
  "default": "./dist/server/index.js"
}
```

The first condition a toolchain applies wins (Node's algorithm, which bundlers implement):

| Toolchain | Conditions it applies | Resolves to |
| --- | --- | --- |
| Node, Deno, Bun (runtime) | `node`/`deno`/`bun`, `import`, `default` | `index.js` |
| Vite, esbuild, Rollup, Parcel, Bun.build for browsers | `browser`, … | `browser_guard.js` |
| webpack `web`/`webworker` targets | `browser` (and `worker`) | `browser_guard.js` |
| React Native (Metro) | `react-native` | `browser_guard.js` |
| wrangler / vitest-pool-workers (Cloudflare Workers) | `workerd`, `worker`, `browser` | `index.js` |
| Next.js / Vercel Edge Runtime | `edge-light`, `worker`, `browser` | `index.js` |

`src/server/browser_guard.ts` exports nothing and throws at evaluation with the message *"webtessera/server
holds signing keys and must not be bundled for the browser; use webtessera/browser"*. Because it exports nothing,
a named import (`import { openServerLog } from "webtessera/server"`) fails the build in Rollup, Vite, esbuild and
webpack's strict ESM mode, pointing at the guard file, whose doc comment explains; a TypeScript project that
sets the `browser` custom condition fails to type-check for the same reason. A bare import fails at page load.

There is deliberately no `node` key before `browser`: Node always applies `node`, so with one, Node's resolver
could not be used to test the browser branch, and no browser toolchain needs it.

`package.json` `"sideEffects"` changes from `false` to `["./dist/server/browser_guard.js",
"./dist/server/index.js"]`. With `false`, esbuild dropped a bare `import "webtessera/server"` from a browser bundle
altogether (harmless, but silent) and could drop the entry module's top-level runtime check from a server bundle.
Listing the two modules keeps the guard's `throw` in a browser bundle and the check in a server one; every other
module stays side-effect free, as before.

**2. Run time: runtime detection** (`src/safe/runtime.ts`). `detectRuntime(g = globalThis)` positively
identifies server runtimes first, each by a global only it defines, and only then looks for a browser:

1. `Deno.version.deno` → `deno`; `Bun.version` → `bun` (both also define a Node-like `process`);
2. `navigator.userAgent === "Cloudflare-Workers"` or a `WebSocketPair` class → `workerd` (checked before Node,
   because workerd defines `process` under `nodejs_compat`; `WebSocketPair` covers Workers whose compatibility
   date predates the `navigator` global);
3. `EdgeRuntime` string → `edge-light`;
4. `process.versions.node` with `process.release.name === "node"` → `node` (so Node running jsdom, which
   defines `window` and `document`, is Node; a browser's polyfilled `process` has no `versions.node`);
5. `navigator.product === "ReactNative"` → `react-native`;
6. `window` and `document` both objects → `browser`;
7. the global object an instance of `WorkerGlobalScope` that has `importScripts` → `browser-worker`
   (dedicated, shared and service workers);
8. anything else → `unknown`.

`assertServerRuntime()` throws for `browser`, `browser-worker` and `react-native`, and allows everything else,
`unknown` included: refusing unknown runtimes would break legitimate server runtimes this list does not name,
and the threat is a developer's mistake, not an adversary spoofing globals. It runs at the top of
`src/server/index.ts`, and again inside `openServerLog` and `importLogKey`: a bundler that ignores the
`sideEffects` list may resolve named imports straight to the defining modules and skip the entry module's body,
and a check in the functions themselves cannot be skipped by any bundler.

**Tests.** `src/safe/runtime_test.ts` runs the detector over fake global objects for every case above,
including the misleading ones. `src/server/server_test.ts` resolves a copy of the real `exports` map with
Node's resolver under each toolchain's conditions, and bundles it with esbuild (the bundler inside Vite,
wrangler and Bun's): a named import fails a browser build at the guard, a bare import keeps the guard's `throw`,
and wrangler's conditions bundle the real module. `src/server/guard_browser_test.ts` shows in Chromium that the
guard module throws, that the real entry point refuses to load in a window and in a module worker (detected as
`browser-worker`), and that `importLogKey` and `openServerLog` refuse when imported directly.
`src/server/server_workers_test.ts` imports the entry point in workerd and detects `workerd`.
`scripts/smoke-runtimes.mjs` loads the built entry point on Node, Bun and Deno and checks the detected runtime.

## Consequences

- A server runtime whose bundler applies only `browser` (Fastly Compute through webpack's `webworker` target,
  say) gets the guard. Its developers must add a server condition to their resolver (for example
  `resolve.conditionNames: ["workerd", …]`) or ask for one to be listed here.
- Test runners that resolve with the `browser` condition for DOM environments (Jest's jsdom environment does)
  give server code the guard; test it in a Node environment. Under a DOM environment that keeps Node's
  resolution, the run-time check still identifies Node first, as jsdom does not hide `process`.
- Electron renderers with Node integration are detected as Node. A desktop app ships its code to users, so its
  "server" is not private either; no detector can tell, and the guide says so.
- The guard message is repeated in `browser_guard.ts` so that the module imports nothing; a test keeps the two
  copies equal.

## Alternatives considered

- **Run-time check only.** Rejected: the key would still be bundled and shipped, and the developer would learn of
  it only when the page ran.
- **A top-level `throw` in the real entry point when `window` exists.** Rejected: jsdom, Deno 1.x (which had a
  `window`) and SSR polyfills define `window` on servers, and workerd has neither `window` nor `document` yet a
  worker-like global scope, which a `self instanceof WorkerGlobalScope` check alone would refuse.
- **Refuse unknown runtimes.** Rejected: see above.
- **An unguarded escape-hatch subpath** for unusual toolchains. Rejected: anything a server toolchain can import,
  a browser bundle can import too, which would make the guard advisory.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
