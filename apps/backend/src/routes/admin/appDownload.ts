import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
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
}

// Resolve the published APK (version.json + the file it names), or null when
// not published yet.
async function readPublishedApk(): Promise<{ info: ApkVersionInfo; apkPath: string; sizeBytes: number } | null> {
  let info: ApkVersionInfo;
  try {
    info = JSON.parse(await readFile(join(apkDir, "version.json"), "utf8")) as ApkVersionInfo;
  } catch {
    return null;
  }
  const apkPath = join(apkDir, info.fileName || "warehouse-pda.apk");
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

// Metadata for the admin /app-download page (version.json fields + sizeBytes).
adminAppDownloadRoute.get("/app-download", async (c) => {
  const published = await readPublishedApk();
  if (!published) apkNotAvailable();
  return c.json({ ...published.info, sizeBytes: published.sizeBytes });
});

// The APK itself, streamed as an attachment.
adminAppDownloadRoute.get("/app-download/file", async (c) => {
  const published = await readPublishedApk();
  if (!published) apkNotAvailable();
  const downloadName = published.info.versionName
    ? `warehouse-pda-${published.info.versionName}.apk`
    : "warehouse-pda.apk";
  const body = Readable.toWeb(createReadStream(published.apkPath)) as ReadableStream;
  return new Response(body, {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Content-Length": String(published.sizeBytes),
    },
  });
});
