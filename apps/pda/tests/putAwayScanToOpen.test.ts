import { describe, expect, it } from "vitest";
import { parsePutAwayOpenScan } from "../utils/putAwayScanToOpen";

const TASK_ID = "8f14e45f-ceea-4a0a-9a6f-4e8f1a2b3c4d";

describe("parsePutAwayOpenScan", () => {
  it("accepts the warehouse://putaway-cn order-link payload from the Excel QR", () => {
    expect(parsePutAwayOpenScan(`warehouse://putaway-cn/${TASK_ID}`)).toEqual({
      taskId: TASK_ID,
    });
  });

  it("accepts the legacy full route payload", () => {
    expect(parsePutAwayOpenScan(`/put-away/ro-cn-1?task=${TASK_ID}`)).toEqual({
      taskId: TASK_ID,
    });
  });

  it("ignores extra query params after the task id", () => {
    expect(parsePutAwayOpenScan(`/put-away/ro-cn-1?task=${TASK_ID}&foo=bar`)).toEqual({
      taskId: TASK_ID,
    });
  });

  it("accepts any order-id segment (the CN detail ignores it)", () => {
    expect(parsePutAwayOpenScan(`/put-away/anything?task=${TASK_ID}`)?.taskId).toBe(TASK_ID);
    expect(parsePutAwayOpenScan(`/put-away/cn?task=${TASK_ID}`)?.taskId).toBe(TASK_ID);
  });

  it("trims surrounding whitespace", () => {
    expect(parsePutAwayOpenScan(`  /put-away/ro-cn-1?task=${TASK_ID}\n`)).toEqual({
      taskId: TASK_ID,
    });
    expect(parsePutAwayOpenScan(`  ${TASK_ID} `)).toEqual({ taskId: TASK_ID });
  });

  it("accepts a bare UUID task id", () => {
    expect(parsePutAwayOpenScan(TASK_ID)).toEqual({ taskId: TASK_ID });
    expect(parsePutAwayOpenScan(TASK_ID.toUpperCase())).toEqual({
      taskId: TASK_ID.toUpperCase(),
    });
  });

  it("rejects values that are neither a put-away route nor a UUID", () => {
    expect(parsePutAwayOpenScan("")).toBeNull();
    expect(parsePutAwayOpenScan("RK73H2ATTD1002F")).toBeNull(); // a part scan
    expect(parsePutAwayOpenScan("C001-CTN")).toBeNull();
    expect(parsePutAwayOpenScan("warehouse://receiving/ro-1")).toBeNull(); // other link kind
  });

  it("rejects put-away paths without a task param", () => {
    expect(parsePutAwayOpenScan("/put-away/ro-cn-1")).toBeNull();
    expect(parsePutAwayOpenScan("/put-away/ro-cn-1?task=")).toBeNull();
    expect(parsePutAwayOpenScan("/put-away?task=abc")).toBeNull();
  });

  it("rejects other routes even with a task param", () => {
    expect(parsePutAwayOpenScan(`/receiving/ro-1?task=${TASK_ID}`)).toBeNull();
    expect(parsePutAwayOpenScan(`/picking/unified/${TASK_ID}`)).toBeNull();
  });
});
