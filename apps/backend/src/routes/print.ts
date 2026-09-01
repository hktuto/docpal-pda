import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { dynamicPrint, getPrintJob, listPrinters, printFiles, type DynamicPrintBody } from "../print.js";

export const printRoute = new Hono();

// Print proxy: thin pass-through to the label-printing-center print service
// (src/print.ts; base URL from PRINT_API_BASE_URL) so the admin console / PDA
// never call the print service directly. Upstream failures surface as 502 with
// the upstream error message. No preview endpoints — printing only.

printRoute.get("/print/printers", async (c) => {
  return c.json(await listPrinters());
});

printRoute.post("/print/dynamic", async (c) => {
  let body: DynamicPrintBody;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  if (!body?.templateId) throw new HTTPException(400, { message: "template_id_required" });
  if (!Array.isArray(body.printingParams) || body.printingParams.length === 0) {
    throw new HTTPException(400, { message: "printing_params_required" });
  }
  return c.json(await dynamicPrint(body));
});

printRoute.post("/print/files", async (c) => {
  return c.json(await printFiles(c.req.raw));
});

printRoute.get("/print/jobs/:jobId", async (c) => {
  return c.json(await getPrintJob(c.req.param("jobId")));
});
