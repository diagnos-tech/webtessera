# A browser's own tamper-evident log

A page that keeps a transparency log of its own, entirely in the browser: in IndexedDB, signed by a
key generated on the device that no script can export. Every event the page logs gets a receipt,
a [C2SP tlog-proof](https://c2sp.org/tlog-proof), that anyone holding the log's public key can
verify offline. The log survives reloads, and every tab of the page writes the same log: Web Locks
make them take turns, and without Web Locks the log refuses to open rather than risk a fork.

No server is involved. This is the starting point for logs that a device keeps about itself:
consent records, audit trails of what an app did locally, signed activity histories. To have the
record witnessed by your server, see [`../session-receipts`](../session-receipts).

## How it works

```text
 tab A ──┐                                           ┌── openDeviceKey(origin)
         │  log.append(event) ─▶ Web Lock "…/log" ───┤   non-extractable Ed25519 CryptoKey,
 tab B ──┘   (one writer at a time, across tabs)     │   kept in IndexedDB "webtessera-keys"
                     │                               └── openBrowserLog({ key })
                     ▼                                    tiles, bundles, checkpoint in IndexedDB
          signed checkpoint covers the entry               "webtessera-log:<origin>"
                     │
                     ▼
          receipt (tlog-proof) ─▶ verifyReceipt(receipt, { vkey, data })  ✓ offline, anywhere
```

## Run it

Build the library once at the repository root (`bun run build`), then here:

```sh
bun x vite        # or: npx vite — then open http://localhost:5173
```

Log a few events, open the page in a second tab and log from there too: both tabs list the same
events, each with a verified receipt. Reload: the key and the log are found again. "Under the hood"
re-verifies the newest receipt by hand with the ported API (`webtessera/client`'s proof builder and
`webtessera/merkle/proof`), and shows that it rebuilds the same proof the receipt carries.

**Without Web Locks.** Browsers provide Web Locks in secure contexts (HTTPS and `localhost`). Open
`http://localhost:5173/?no-web-locks` to see a page without them: the log refuses to open, because
two tabs appending at once with nothing to keep them apart would fork it, and the page offers to
open it as this tab's alone (`storage: { indexedDB, singleWriter: true }`). The device's lock scope
then reads "This tab only".

`npx vite build` produces a static site in `dist/` that any static host can serve over HTTPS.

## Trust model

- **The key cannot leave the device.** `openDeviceKey` generates a non-extractable WebCrypto Ed25519
  key and stores the CryptoKey itself in IndexedDB; no script, this library included, can export it.
  A script injected into the page could still *use* it while the page is open: Content Security
  Policy remains the first defence.
- **The log is tamper-evident, not tamper-proof.** The device holds its own key, so it could sign a
  rewritten history; what it cannot do is make that history agree with receipts and checkpoints
  already handed out. Anyone holding an older receipt detects the rewrite. Witnessing makes that
  check happen as the log grows, by someone else: see [`../session-receipts`](../session-receipts).
- **Storage can be lost.** Clearing site data deletes the log and the key, and browsers may evict
  storage under pressure; the page asks for persistent storage (`navigator.storage.persist()`).
  Receipts already handed out keep verifying with the public key, which is public and can be kept
  anywhere.

## Test

```sh
npm run ci        # tsc --noEmit && vitest run (headless Chromium) && vite build
```

The tests run in a real Chromium through Vitest's Playwright provider (`npx playwright install
chromium` once). [`src/device_log_browser_test.ts`](src/device_log_browser_test.ts) checks: a device
key that cannot be exported, and receipts that verify; **a tampered receipt, a receipt for other
data, and one checked with another key, all refused**; a log that survives a reopen; **two tabs (the
page and a worker) appending at once and making one log** with no index handed out twice; **a log
that refuses to open without Web Locks** unless the page promises a single writer; the hand-made
verification agreeing with the receipt; and forgetting the device.

## Files to read first

1. [`src/device_log.ts`](src/device_log.ts): the device key and the log, with the safe API.
2. [`src/main.ts`](src/main.ts): appending, receipts, two tabs, and the no-Web-Locks path.
3. [`src/history.ts`](src/history.ts): reading the log back, and verifying a receipt by hand with the
   ported API underneath.
