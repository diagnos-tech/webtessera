# A client-only log

**Example:** [`examples/client-only`](../../examples/client-only)

A browser can keep a transparency log of its own: what an app did on the device, what a user
consented to, a signed activity history. With the safe API it takes two calls, and the log is
durable, shared safely between tabs, and signed by a key no script can export.

```ts
import { openBrowserLog, openDeviceKey, verifyReceipt } from "webtessera/browser";

const key = await openDeviceKey(origin);     // generated once; non-extractable; kept in IndexedDB
const log = await openBrowserLog({ key });   // kept in IndexedDB, shared by every tab of the page

const receipt = await log.append(entry);     // resolves once a signed checkpoint covers it
verifyReceipt(receipt.text, { vkey: log.vkey, data: entry });   // anyone, offline
```

## Choices to make

- **The origin** names the log, its key and its IndexedDB database. Choose one per device and per
  purpose (the example uses `<host>/device/<random>`), and remember it: it is public.
- **Several tabs** write the same log through Web Locks (`log.lockScope === "origin"`). Without Web
  Locks (outside a secure context), `openBrowserLog` refuses to open rather than let two tabs fork
  the log, and its error names the way out: `storage: { indexedDB: name, singleWriter: true }`, to
  pass only when one tab is certainly the only writer.
- **Persistence.** Ask for `navigator.storage.persist()`: a log the browser evicts can no longer
  prove what it signed (receipts already handed out still verify).
- **Reading entries back**: `log.entries(from?, to?)` streams them in order, each checked against
  the leaf hash the log's tiles hold for it, and `log.entry(index)` reads one. The example's
  `history.ts` lists the newest twenty, proving each with `log.prove(index)`:

  ```ts
  const { size } = await log.latestCheckpoint();
  for await (const { index, data } of log.entries(size > 20n ? size - 20n : 0n)) { … }
  ```

## What it guarantees, and what it does not

The log is **tamper-evident**: once a receipt or checkpoint has left the page, the device cannot
rewrite what came before without every holder noticing. It is not tamper-proof: the device holds its
own key, and could sign a different history for someone who has seen nothing yet. Witnessing closes
that gap: [session receipts](session-receipts.md).

The guardrails the example's Chromium tests cover: a tampered receipt, a receipt for other data and
one checked with another key all fail; two tabs appending at once make one log; the log refuses to
open without Web Locks unless told otherwise. See also [the safe API](safe-api.md#in-a-browser).
