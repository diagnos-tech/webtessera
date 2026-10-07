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

// One Open Graph image per page, drawn at build time in the site's font and colours: the page's
// title and description, over the wordmark and the checkpoint the build signed (lib/og.ts).
// og/docs/safe-api.png is the image of /docs/safe-api/, og/index.png the home page's
// (components/Seo.astro links them).

import { join } from "node:path";
import { OGImageRoute } from "astro-og-canvas";
import { ogBackground, ogColors, ogFonts } from "../../lib/og.ts";
import { allPages, meta } from "../../lib/pages.ts";
import { getSiteData } from "../../lib/site.ts";

const publicDir = join(process.cwd(), "public");
const background = await ogBackground(publicDir, (await getSiteData()).sample.note);
const pages = Object.fromEntries(
	(await allPages()).map((p) =>
		p.path === ""
			? ["index", { title: meta.home.headline, description: p.description }]
			: [p.path.replace(/\/$/, ""), { title: p.title, description: p.description }],
	),
);

export const { getStaticPaths, GET } = await OGImageRoute({
	pages,
	getImageOptions: (_path, page: { title: string; description: string }) => ({
		title: page.title,
		description: page.description,
		bgImage: { path: background, fit: "none", position: "start" },
		padding: 96,
		fonts: [join(publicDir, ogFonts[0])],
		font: {
			title: { families: ["Inter"], weight: "Bold", size: 66, lineHeight: 1.08, color: [...ogColors.title] },
			description: {
				families: ["Inter"],
				weight: "Normal",
				size: 30,
				lineHeight: 1.45,
				color: [...ogColors.description],
			},
		},
	}),
});
