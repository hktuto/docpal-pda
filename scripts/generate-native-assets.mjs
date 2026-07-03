import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const sourceDir = join(root, "assets");
const outDir = join(root, "resources");

const TEAL = { r: 0, g: 191, b: 165, alpha: 1 };
const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

function solidBackground(width, height) {
  return sharp({
    create: { width, height, channels: 4, background: TEAL },
  }).png();
}

async function main() {
  await ensureDir(outDir);

  await solidBackground(ICON_SIZE, ICON_SIZE).toFile(
    join(outDir, "icon-background.png")
  );

  await sharp(join(sourceDir, "logo.png"))
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(join(outDir, "icon-foreground.png"));

  const logoBuffer = await sharp(join(sourceDir, "logo.png"))
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await solidBackground(ICON_SIZE, ICON_SIZE)
    .composite([{ input: logoBuffer, gravity: "center" }])
    .toFile(join(outDir, "icon-only.png"));

  const logoWithNameMeta = await sharp(join(sourceDir, "logoWithName.png")).metadata();
  const maxSplashLogoWidth = Math.round(SPLASH_SIZE * 0.7);
  const scale = Math.min(1, maxSplashLogoWidth / (logoWithNameMeta.width ?? 1));
  const splashLogoWidth = Math.round((logoWithNameMeta.width ?? 1) * scale);
  const splashLogoHeight = Math.round((logoWithNameMeta.height ?? 1) * scale);

  const splashLogoBuffer = await sharp(join(sourceDir, "logoWithName.png"))
    .resize(splashLogoWidth, splashLogoHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: TEAL,
    },
  })
    .composite([{ input: splashLogoBuffer, gravity: "center" }])
    .png()
    .toFile(join(outDir, "splash.png"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
