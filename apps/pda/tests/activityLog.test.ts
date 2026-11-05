import { describe, it, expect, vi } from "vitest";

// activityLog reads sessionStorage at module load — stub it BEFORE import.
const store = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

const { pushLog, getTrail, getSessionId, setLoggedRoute } = await import(
  "../utils/activityLog"
);

describe("activityLog ring buffer", () => {
  it("caps at 150 entries, dropping the oldest", () => {
    for (let i = 0; i < 160; i++) pushLog("api", `small-${i}`);
    const trail = getTrail();
    expect(trail.length).toBeLessThanOrEqual(150);
    expect(trail[0].m).toBe("small-10");
    expect(trail[trail.length - 1].m).toBe("small-159");
  });

  it("caps by total bytes too (large messages)", () => {
    const fat = "x".repeat(300);
    for (let i = 0; i < 200; i++) pushLog("error", `${fat}-${i}`);
    const trail = getTrail();
    expect(trail.length).toBeLessThan(150);
    expect(JSON.stringify(trail).length).toBeLessThanOrEqual(40_000);
  });

  it("stamps the current route on every entry", () => {
    pushLog("route", "/before");
    setLoggedRoute("/put-away/BOX-1");
    pushLog("scan", "broadcast: 123");
    const trail = getTrail();
    const scan = [...trail].reverse().find((e) => e.k === "scan");
    expect(scan?.r).toBe("/put-away/BOX-1");
  });

  it("mirrors the buffer to sessionStorage and keeps a stable session id", () => {
    const id = getSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getSessionId()).toBe(id);
    const raw = store.get("bug-trail");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).length).toBe(getTrail().length);
  });
});
