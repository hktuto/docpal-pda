// Shared helpers for user-guide screenshot capture (docs/user-guide/capture-runbook.md).
// Uses the machine's installed Chrome via Playwright channel:'chrome' — no browser download.
import { chromium } from "../../node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs";

export const PDA_BASE = "http://127.0.0.1:3103";
export const ADMIN_BASE = "http://localhost:3100";
const API = "http://127.0.0.1:3002";

export async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Administrator", password: "2'KMzF}zK2ZmwQe" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json(); // { user, token }
}

export async function launch() {
  return chromium.launch({ channel: "chrome", headless: true });
}

export async function pdaContext(browser, { token, user }) {
  const ctx = await browser.newContext({
    baseURL: PDA_BASE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(
    ([t, u]) => {
      localStorage.setItem("warehouse-token", t);
      localStorage.setItem("warehouse-user", JSON.stringify(u));
      localStorage.setItem("warehouse-user-id", u.id);
      localStorage.setItem("warehouse-locale", "zh-HK");
      // hide the dev-only scan simulator in every capture
      const css = document.createElement("style");
      css.textContent = ".dev-scan-sim{display:none!important}";
      document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css));
    },
    [token, user]
  );
  return ctx;
}

export async function adminContext(browser, { token }) {
  const ctx = await browser.newContext({
    baseURL: ADMIN_BASE,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript((t) => {
    localStorage.setItem("admin_token", t);
    localStorage.setItem("warehouse-locale", "zh-HK");
  }, token);
  return ctx;
}

/** Hardware-scanner keyboard wedge: type every char, then Enter. */
export async function wedge(page, text, { settle = 600 } = {}) {
  await page.keyboard.type(text, { delay: 6 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settle);
}

export async function shot(page, path, { settle = 400 } = {}) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path });
  console.log("shot:", path);
}

/** Dismiss any toast/overlays by pressing Escape; safe no-op. */
export async function settle(page, ms = 500) {
  await page.waitForTimeout(ms);
}
