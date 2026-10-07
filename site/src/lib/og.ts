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

// The background of every social image: paper, a rule, the wordmark, and the body of the
// checkpoint the build signed, in the site's fonts. pages/og draws each page's title and
// description over it. It is drawn once per checkpoint and kept with astro-og-canvas's cache.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NoteView } from "../shared/note.ts";

/** ogSize is the size of an Open Graph image. */
export const ogSize = { width: 1200, height: 630 } as const;

/** ogBackground draws the background for a site whose public files are in `publicDir`, and returns its path. */
export async function ogBackground(publicDir: string, note: NoteView): Promise<string> {
	const lines = note.text.replace(/\n$/, "").split("\n").slice(0, 3);
	const key = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
	const dir = join(process.cwd(), "node_modules", ".astro-og-canvas");
	const file = join(dir, `background-${key}.png`);
	if (existsSync(file)) {
		return file;
	}
	const require = createRequire(import.meta.url);
	const { default: init } = await import("canvaskit-wasm/full");
	const ck = await init({ locateFile: (f: string) => require.resolve(`canvaskit-wasm/bin/full/${f}`) });
	const fonts = ck.FontMgr.FromData(
		readFileSync(join(publicDir, "fonts/source-serif-4-latin-opsz-normal.woff2")).buffer,
		readFileSync(join(publicDir, "fonts/go-mono-latin.woff2")).buffer,
	);
	if (fonts === null) {
		throw new Error("CanvasKit could not load the site's fonts");
	}
	const surface = ck.MakeSurface(ogSize.width, ogSize.height);
	if (surface === null) {
		throw new Error("CanvasKit could not create a surface");
	}
	const canvas = surface.getCanvas();
	canvas.clear(ck.WHITE);
	const rule = new ck.Paint();
	rule.setColor(ck.Color(214, 218, 225));
	rule.setStrokeWidth(2);
	canvas.drawLine(96, 470, ogSize.width - 96, 470, rule);
	const text = (content: string, family: string, size: number, color: [number, number, number], weight = 400) => {
		const style = new ck.ParagraphStyle({
			textStyle: {
				color: ck.Color(...color),
				fontFamilies: [family],
				fontSize: size,
				heightMultiplier: 1.35,
				fontStyle: { weight: { value: weight } },
			},
		});
		const builder = ck.ParagraphBuilder.Make(style, fonts);
		builder.addText(content);
		const paragraph = builder.build();
		paragraph.layout(ogSize.width - 192);
		return paragraph;
	};
	canvas.drawParagraph(text("webtessera", "Source Serif 4", 40, [29, 35, 48], 600), 96, 500);
	const checkpoint = text(lines.join("\n"), "Go Mono", 22, [77, 85, 102]);
	canvas.drawParagraph(checkpoint, ogSize.width - 96 - checkpoint.getLongestLine(), 496);
	const png = surface.makeImageSnapshot().encodeToBytes();
	if (png === null) {
		throw new Error("CanvasKit could not encode the background");
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, png);
	surface.delete();
	return file;
}
