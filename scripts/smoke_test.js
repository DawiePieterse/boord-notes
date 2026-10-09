// Opens the app in headless Chromium at phone and desktop sizes, visits every
// tab and a note's detail sheet, and fails on any page error, console error
// or horizontal overflow. Run with the server up on BASE (default
// http://localhost:8821): `node scripts/smoke_test.js`. Needs playwright.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:8821";

async function seed() {
  for (const i of [1, 2]) {
    await fetch(`${BASE}/api/entries`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `smoke-${i}`, title: `Irrigation pump quirk ${i}`, body: "Pump in block 8a loses pressure after noon.",
        block: "8a", tags: ["Irrigation", "Pumps"], actions: [{ id: `smoke-a${i}`, kind: "Fertilise", detail: "LAN" }],
      }),
    });
  }
}

(async () => {
  await seed();
  const browser = await chromium.launch();
  const problems = [];
  const sizes = [
    ["phone", { width: 390, height: 844 }, true],
    ["desktop", { width: 1440, height: 900 }, false],
  ];
  for (const [name, viewport, mobile] of sizes) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`${name} console: ${m.text()}`); });
    await page.goto(`${BASE}/app/`);
    await page.waitForSelector("#actionKinds .chip");
    for (const tab of ["todo", "dashboard", "entries", "settings", "capture"]) {
      await page.click(`.tab-btn[data-tab=${tab}]`);
      await page.waitForTimeout(400);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        problems.push(`${name}: horizontal overflow on ${tab}`);
      }
      // A stylesheet ordered wrongly lets .btn's display beat .hidden.
      const shown = await page.$$eval(".hidden", (els) => els.filter((el) => getComputedStyle(el).display !== "none").map((el) => el.id || el.className));
      if (shown.length) problems.push(`${name}: .hidden elements showing on ${tab}: ${shown.join(", ")}`);
    }
    await page.click(".tab-btn[data-tab=entries]");
    await page.waitForSelector("#entriesList .entry-card");
    await page.click("#entriesList .entry-card");
    await page.waitForSelector("#detailModal:not(.hidden)");
    await page.keyboard.press("Escape");
    if (!await page.$eval("#detailModal", (el) => el.classList.contains("hidden"))) {
      problems.push(`${name}: Escape did not close the detail sheet`);
    }
    await ctx.close();
  }
  await browser.close();
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("smoke test passed");
})();
