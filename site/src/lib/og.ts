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

// The background of every social image, in the site's dark scheme and fonts: the page colour
// under three soft lights, the brand gradient along the top, and below a rule the mark, the
// wordmark and the body of the checkpoint the build signed. pages/og draws each page's title
// and description over it. It is drawn once per checkpoint and per version of this drawing, and
// kept with astro-og-canvas's cache.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { NoteView } from "../shared/note.ts";

/** ogSize is the size of an Open Graph image. */
export const ogSize = { width: 1200, height: 630 } as const;

/** ogFonts are the font files the social images are set in, under the site's public directory. */
export const ogFonts = ["fonts/inter-latin-opsz-normal.woff2", "fonts/jetbrains-mono-latin-wght-normal.woff2"] as const;

/** ogColors are the colours pages/og sets the title and the description in, on this background. */
export const ogColors = { title: [243, 241, 251], description: [183, 178, 207] } as const;

// drawing names this version of the background: change it with the drawing, so that a cached
// background of an earlier design is not reused.
const drawing = "dark-mosaic-1";

type Rgb = readonly [number, number, number];
const page: Rgb = [15, 14, 23];
const violet: Rgb = [189, 147, 249];
const pink: Rgb = [255, 121, 198];
const cyan: Rgb = [139, 233, 253];
// The mark, as components/Mark.astro draws it: one letter per cell, row by row.
const mark = "aapc" + "apce" + "pcee" + "ceee";
const tone: Record<string, Rgb> = { a: violet, p: pink, c: cyan };

/** ogBackground draws the background for a site whose public files are in `publicDir`, and returns its path. */
export async function ogBackground(publicDir: string, note: NoteView): Promise<string> {
	const lines = note.text.replace(/\n$/, "").split("\n").slice(0, 3);
	const key = createHash("sha256")
		.update(`${drawing}\n${lines.join("\n")}`)
		.digest("hex")
		.slice(0, 16);
	const dir = join(process.cwd(), "node_modules", ".astro-og-canvas");
	const file = join(dir, `background-${key}.png`);
	if (existsSync(file)) {
		return file;
	}
	const require = createRequire(import.meta.url);
	const { default: init } = await import("canvaskit-wasm/full");
	const ck = await init({ locateFile: (f: string) => require.resolve(`canvaskit-wasm/bin/full/${f}`) });
	const fonts = ck.FontMgr.FromData(...ogFonts.map((f) => readFileSync(join(publicDir, f)).buffer));
	if (fonts === null) {
		throw new Error("CanvasKit could not load the site's fonts");
	}
	const surface = ck.MakeSurface(ogSize.width, ogSize.height);
	if (surface === null) {
		throw new Error("CanvasKit could not create a surface");
	}
	const canvas = surface.getCanvas();
	canvas.clear(ck.Color(...page));
	const everything = ck.LTRBRect(0, 0, ogSize.width, ogSize.height);

	// Three soft lights, as on the home page's hero.
	for (const [color, x, y, radius, alpha] of [
		[violet, 180, -40, 620, 0.34],
		[pink, 1080, 20, 520, 0.22],
		[cyan, 640, 700, 520, 0.16],
	] as const) {
		const light = new ck.Paint();
		light.setShader(
			ck.Shader.MakeRadialGradient(
				[x, y],
				radius,
				[ck.Color(...color, alpha), ck.Color(...color, 0)],
				[0, 1],
				ck.TileMode.Clamp,
			),
		);
		canvas.drawRect(everything, light);
		light.delete();
	}

	// The brand gradient along the top edge.
	const band = new ck.Paint();
	band.setShader(
		ck.Shader.MakeLinearGradient(
			[0, 0],
			[ogSize.width, 0],
			[ck.Color(...violet), ck.Color(...pink), ck.Color(...cyan)],
			[0, 0.55, 1],
			ck.TileMode.Clamp,
		),
	);
	canvas.drawRect(ck.LTRBRect(0, 0, ogSize.width, 10), band);
	band.delete();

	const rule = new ck.Paint();
	rule.setColor(ck.Color(69, 63, 99));
	rule.setStrokeWidth(2);
	canvas.drawLine(96, 470, ogSize.width - 96, 470, rule);

	// The mark: filled cells in the brand's colours, the cells still to come as outlines.
	const cell = 10.5;
	const step = 13.5;
	[...mark].forEach((kind, i) => {
		const x = 96 + (i % 4) * step;
		const y = 506 + Math.floor(i / 4) * step;
		const paint = new ck.Paint();
		paint.setAntiAlias(true);
		const color = tone[kind];
		if (color === undefined) {
			paint.setStyle(ck.PaintStyle.Stroke);
			paint.setStrokeWidth(1.5);
			paint.setColor(ck.Color(69, 63, 99));
			canvas.drawRRect(ck.RRectXY(ck.LTRBRect(x + 1, y + 1, x + cell - 1, y + cell - 1), 2, 2), paint);
		} else {
			paint.setColor(ck.Color(...color));
			canvas.drawRRect(ck.RRectXY(ck.LTRBRect(x, y, x + cell, y + cell), 2.5, 2.5), paint);
		}
		paint.delete();
	});

	const text = (content: string, family: string, size: number, color: Rgb, weight = 400) => {
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
	canvas.drawParagraph(text("webtessera", "Inter", 38, ogColors.title, 700), 96 + 4 * step + 12, 505);
	const checkpoint = text(lines.join("\n"), "JetBrains Mono", 20, [147, 141, 174]);
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
