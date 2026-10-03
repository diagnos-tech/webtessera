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
// Types `env` and `exports` from "cloudflare:workers", which the tests use. The Worker itself
// receives its bindings as the Env its handlers declare.

import type { Env as WorkerEnv } from "./worker.ts";

declare global {
	namespace Cloudflare {
		interface GlobalProps {
			mainModule: typeof import("./worker.ts");
		}
		interface Env extends WorkerEnv {
			/** TEST_LOG_VKEY verifies LOG_SKEY's signatures; vitest.config.ts binds both. */
			readonly TEST_LOG_VKEY: string;
		}
	}
}
