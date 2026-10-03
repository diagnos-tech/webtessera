// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file has no upstream counterpart. In the browser, a key enters the safe API only as
// a CryptoKey. See docs/decisions/0222-key-custody.md.

import { fromCryptoKeyPair, type LogKey } from "../safe/keys.ts";

/**
 * fromCryptoKey makes a LogKey for the log with the given origin from an Ed25519
 * CryptoKeyPair the application already holds, such as one it keeps in a store of its
 * own. The private key is used as it is, so a non-extractable one stays that way; the
 * public key must be extractable. The pair is checked to belong together.
 *
 * A key from fromCryptoKey counts as managed by the application, so openBrowserLog accepts
 * it for a log kept in IndexedDB; saveDeviceKey stores it as the device key instead.
 *
 * ```ts
 * const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
 * const key = await fromCryptoKey("device.example/7f3a", pair);
 * ```
 */
export function fromCryptoKey(origin: string, pair: CryptoKeyPair): Promise<LogKey> {
	return fromCryptoKeyPair(origin, pair);
}
