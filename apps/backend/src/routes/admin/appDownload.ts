import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createReadStream } from "node:fs";
import { stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

// Admin APK download: serves the signed release APK + version metadata
// published by `pnpm build:apk` into apps/backend/public/apk/ (gitignored).
// tsc preserves layout (src/routes/admin → dist/routes/admin), so ../../../
// lands on the package root in both dev and the prod image.
const apkDir = fileURLToPath(new URL("../../../public/apk/", import.meta.url));

interface ApkVersionInfo {
  versionName?: string;
  versionCode?: number;
  webUrl?: string;
  builtAt?: string;
  fileName?: string;
  region?: string;
}

// List all published regions by scanning version-{region}.json files.
async function listPublishedRegions(): Promise<string[]> {
  try {
    const files = await readdir(apkDir);
    return files
      .filter((f) => f.startsWith("version-") && f.endsWith(".json"))
      .map((f) => f.replace(/^version-/, "").replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// Resolve the published APK for a region (version-{region}.json + the file
// it names), or null when not published yet.
async function readPublishedApk(region: string): Promise<{ info: ApkVersionInfo; apkPath: string; sizeBytes: number } | null> {
  let info: ApkVersionInfo;
  try {
    info = JSON.parse(await readFile(join(apkDir, `version-${region}.json`), "utf8")) as ApkVersionInfo;
  } catch {
    return null;
  }
  const apkPath = join(apkDir, info.fileName || `warehouse-pda-${region}.apk`);
  try {
    const st = await stat(apkPath);
    return { info, apkPath, sizeBytes: st.size };
  } catch {
    return null;
  }
}

function apkNotAvailable(): never {
  throw new HTTPException(404, { message: "apk_not_available" });
}

export const adminAppDownloadRoute = new Hono();

// List all published regions.
adminAppDownloadRoute.get("/app-download/regions", async (c) => {
  const regions = await listPublishedRegions();
  return c.json({ regions });
});

// Metadata for the admin /app-download page (version.json fields + sizeBytes).
adminAppDownloadRoute.get("/app-download", async (c) => {
  const region = c.req.query("region") || "hk";
  const published = await readPublishedApk(region);
  if (!published) apkNotAvailable();
  return c.json({ ...published.info, sizeBytes: published.sizeBytes });
});

// The APK itself, streamed as an attachment.
adminAppDownloadRoute.get("/app-download/file", async (c) => {
  const region = c.req.query("region") || "hk";
  const published = await readPublishedApk(region);
  if (!published) apkNotAvailable();
  const downloadName = published.info.versionName
    ? `warehouse-pda-${published.info.versionName}.apk`
    : `warehouse-pda-${region}.apk`;
  const body = Readable.toWeb(createReadStream(published.apkPath)) as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Content-Length": String(published.sizeBytes),
    },
  });
});
