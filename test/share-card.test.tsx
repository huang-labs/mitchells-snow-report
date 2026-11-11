import { ImageResponse } from "@cf-wasm/og";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { decode } from "fast-png";
import { describe, expect, it } from "vitest";
import { SHARE_CARD_FONTS } from "@/lib/og/image-fonts";
import { BrandedShareCard } from "@/lib/og/branded-image";
import { DailySnowShareCard } from "@/lib/og/daily-snow-image";

function expectDarkImage(png: ReturnType<typeof decode>) {
  expect([png.width, png.height]).toEqual([1200, 630]);
  expect(Array.from(png.data.slice(0, 3))).toEqual([16, 28, 42]);
  let dark = 0;
  let light = 0;
  let headerInk = 0;
  let footerInk = 0;
  for (let i = 0; i < png.data.length; i += png.channels) {
    if (png.data[i] > 130 && png.data[i + 1] > 150 && png.data[i + 2] > 170) {
      light++;
      const y = Math.floor(i / png.channels / png.width);
      if (y >= 48 && y < 95) headerInk++;
      if (y >= 540 && y < 590) footerInk++;
    }
    if (png.data[i] < 60 && png.data[i + 1] < 80 && png.data[i + 2] < 100) dark++;
  }
  expect(light).toBeGreaterThan(5000);
  expect(footerInk).toBeGreaterThan(500);
  expect(dark).toBeGreaterThan(png.width * png.height * 0.7);
  return headerInk;
}

describe("share preview", () => {
  it("ships the same dark branded PNG that its source renders", async () => {
    const response = new ImageResponse(<BrandedShareCard />, { width: 1200, height: 630, fonts: SHARE_CARD_FONTS });
    const rendered = new Uint8Array(await response.arrayBuffer());
    const bundled = await readFile("public/share-brand-v3.png");
    expectDarkImage(decode(bundled));
    expect(bundled.equals(Buffer.from(rendered))).toBe(true);
  });

  it("labels generated prose with AI and its model, and keeps the empty fallback unlabelled", () => {
    const post = { date: "2026-11-01", title: "Snow returns", summary: "Fresh snow.", model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" };
    const html = renderToStaticMarkup(<DailySnowShareCard post={post} />);
    expect(html).toContain(">AI</span>");
    expect(html).toContain("United States West");
    expect(html).not.toContain("Western United States");
    expect(html).toContain("AI-generated forecast · DeepSeek V4.1 Flash");
    expect(html).toContain("November 1, 2026");
    const empty = renderToStaticMarkup(<DailySnowShareCard post={null} />);
    expect(empty).not.toContain("AI-generated");
    expect(empty).toContain("Your United States West snow forecast");
    expect(empty).not.toContain("Western US");
    const regionalEmpty = renderToStaticMarkup(<DailySnowShareCard post={null} channel="utah" />);
    expect(regionalEmpty).toContain("Your Utah snow forecast");
    expect(regionalEmpty).not.toContain("Your United States West snow forecast");
  });

  it.each([
    null,
    { date: "2026-11-01", title: "Snow returns to the Cottonwoods", summary: "A cold front brings fresh snow to both canyons.", model: "@cf/zai-org/glm-5.3-flash" },
    { date: "2026-11-01", title: "A long forecast headline ".repeat(20), summary: "A detailed forecast summary. ".repeat(30), model: "@cf/openai/gpt-oss-120b" },
  ])("renders the daily forecast card with fallback and long copy", async (post) => {
    const response = new ImageResponse(<DailySnowShareCard post={post} />, {
      width: 1200, height: 630, fonts: SHARE_CARD_FONTS,
    });
    const png = decode(new Uint8Array(await response.arrayBuffer()));
    expect([png.width, png.height]).toEqual([1200, 630]);
    expect(expectDarkImage(png)).toBeGreaterThan(1000);
  });
});
