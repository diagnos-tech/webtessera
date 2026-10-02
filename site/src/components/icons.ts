// Copyright 2026 MedDeck. All Rights Reserved.
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

// Inline SVG icons: no icon font, no requests. All are decorative (aria-hidden) and
// take their colour from the surrounding text.

import { raw, type SafeHtml } from "../shared/html.ts";

function icon(body: string, viewBox = "0 0 24 24"): SafeHtml {
	return raw(
		`<svg class="icon" viewBox="${viewBox}" width="18" height="18" aria-hidden="true" focusable="false">${body}</svg>`,
	);
}

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const icons = {
	github: icon(
		'<path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/>',
	),
	npm: icon('<path fill="currentColor" d="M3 3v18h18V3H3Zm14.4 14.4h-2.7V9.3h-2.7v8.1H6.6V6.6h10.8v10.8Z"/>'),
	copy: icon(
		`<rect x="9" y="9" width="11" height="11" rx="2" ${stroke}/><path d="M5 15V6a2 2 0 0 1 2-2h8" ${stroke}/>`,
	),
	check: icon(`<path d="m5 12.5 4.5 4.5L19 7.5" ${stroke}/>`),
	arrow: icon(`<path d="M5 12h14m-6-6 6 6-6 6" ${stroke}/>`),
	external: icon(`<path d="M14 5h5v5m0-5-8 8M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" ${stroke}/>`),
	book: icon(
		`<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5m0-15v15m0 0A1.5 1.5 0 0 0 6.5 21H19" ${stroke}/>`,
	),
	shield: icon(`<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" ${stroke}/>`),
	package: icon(`<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12v9m0-9L4 7.5" ${stroke}/>`),
};

/** logo is the webtessera mark: a Merkle tree drawn as tesserae, a proof path in accent. */
export function logo(size = 28): SafeHtml {
	return raw(`<svg class="logo" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false">
<rect class="lg-a" x="3" y="3" width="26" height="7" rx="2"/>
<rect class="lg-i" x="3" y="12.5" width="12" height="7" rx="2"/><rect class="lg-a" x="17" y="12.5" width="12" height="7" rx="2"/>
<rect class="lg-i" x="3" y="22" width="5" height="7" rx="1.6"/><rect class="lg-i" x="10" y="22" width="5" height="7" rx="1.6"/>
<rect class="lg-a" x="17" y="22" width="5" height="7" rx="1.6"/><rect class="lg-i" x="24" y="22" width="5" height="7" rx="1.6"/>
</svg>`);
}
