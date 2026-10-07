// Run after: opera-browser-cli emulate --viewport '390x844x1,mobile,touch'
const checks = [];
const check = (condition, label) => {
  if (!condition) throw new Error(label);
  checks.push({ check: label, passed: true });
};
await page.open("http://127.0.0.1:4188/?mode=demo");
await page.wait("#review-order");
check(
  await page.eval(
    () => innerWidth === 390 && document.documentElement.scrollWidth === 390,
  ),
  "390px viewport with no horizontal page overflow",
);
await page.click('[aria-label="Search markets"]');
await page.click(".search-results>button:last-child");
await page.wait(100);
check(
  await page.eval(
    () =>
      document
        .querySelector(".detail-title-line")
        .innerText.includes("Ethereum") &&
      document.querySelector(".ticket-top").innerText.includes("15"),
  ),
  "Mobile search selects ETH 15m",
);
await page.click(".mobile-trade-bar .button");
await page.wait(350);
check(
  await page.eval(() => {
    const bounds = document
      .querySelector("#trade-amount")
      .getBoundingClientRect();
    return (
      bounds.top >= 0 &&
      bounds.bottom < innerHeight - 70 &&
      document.activeElement.id === "trade-amount"
    );
  }),
  "Mobile trade shortcut scrolls to and focuses the amount control",
);
await page.click("#review-order");
check(
  await page.eval(
    () =>
      !!document.querySelector("dialog[open]") &&
      document.querySelector("dialog").getBoundingClientRect().width <=
        innerWidth,
  ),
  "Order review fits the phone viewport",
);
for (let i = 0; i < 5; i++) await page.press("Tab");
check(
  await page.eval(() => !!document.activeElement.closest("dialog")),
  "Native dialog keeps keyboard focus inside",
);
await page.press("Escape");
await page.wait(100);
check(
  await page.eval(
    () =>
      !document.querySelector("dialog[open]") &&
      document.activeElement.id === "review-order",
  ),
  "Escape closes review and restores trigger focus",
);
await page.click(".main-nav button:nth-child(2)");
check(
  await page.eval(
    () =>
      !!document.querySelector(".portfolio-view") &&
      document.documentElement.scrollWidth <= innerWidth,
  ),
  "Mobile portfolio fits without page overflow",
);
await page.click(".main-nav button:nth-child(3)");
check(
  await page.eval(
    () =>
      !!document.querySelector(".history-view") &&
      document.documentElement.scrollWidth <= innerWidth,
  ),
  "Mobile history fits and contains its table scrolling",
);
await page.click(".main-nav button:first-child");
await page.open("http://127.0.0.1:4188/?mode=chain");
await page.wait(".chain-status-banner");
// Let the first network read settle so the final banner text is the one measured.
for (let i = 0; i < 60; i++) {
  const banner = await page.eval(
    () => document.querySelector(".chain-status-banner strong").innerText,
  );
  if (banner !== "Connecting public markets") break;
  await page.wait(500);
}
check(
  await page.eval(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
    return document.documentElement.scrollWidth <= innerWidth;
  }),
  "Mobile chain mode fits without page overflow",
);
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      viewport: [390, 844],
      checks: checks.length,
      results: checks,
    },
    null,
    2,
  ),
);
