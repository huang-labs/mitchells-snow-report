import { writeFile } from "node:fs/promises";
import { createElement } from "react";
import { ImageResponse } from "@cf-wasm/og";
import { BrandedShareCard } from "../src/lib/og/branded-image";
import { SHARE_CARD_FONTS } from "../src/lib/og/image-fonts";

const image = new ImageResponse(createElement(BrandedShareCard), {
  width: 1200, height: 630, fonts: SHARE_CARD_FONTS,
});
const path = new URL("../public/share-brand-v3.png", import.meta.url);
await writeFile(path, new Uint8Array(await image.arrayBuffer()));
console.log(`Rendered ${path.pathname}`);
