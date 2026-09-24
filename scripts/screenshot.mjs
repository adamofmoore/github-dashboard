// Renders docs/screenshot.png from DEMO=1 data. Needs playwright (npx playwright install chromium).
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4799;
const server = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, DEMO: "1", PORT: String(PORT), HOST: "127.0.0.1", TZ: "America/Los_Angeles" }, stdio: "inherit" });
try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/me`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.evaluate(() => { localStorage.setItem("ghdash:theme", '"dark"'); localStorage.setItem("ghdash:preset", '"7d"'); localStorage.setItem("ghdash:activeTile", '"7d"'); localStorage.setItem("ghdash:chartH", "150"); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#issueCount").textContent !== "–" && !document.body.classList.contains("busy"), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshot.png" });
  await browser.close();
  console.log("wrote docs/screenshot.png");
} finally {
  server.kill();
}
