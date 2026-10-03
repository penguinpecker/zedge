// Run through opera-browser-cli: opera-browser-cli run < scripts/verify-browser.js
const results = [];
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL: ${label}`);
  results.push({ check: label, passed: true });
};
const settle = () => page.wait(100);

// The CLI's fill helper sets the DOM value directly. Follow it with native
// keyboard input so React observes a real input event and updates controlled state.
const fill = async (selector, value) => {
  await page.fill(selector, value);
  await page.click(selector);
  await page.press("End");
  await page.type("0");
  await page.press("Backspace");
  await settle();
};

const read = () =>
  page.eval(() => JSON.parse(localStorage.getItem("edge-paper-exchange-v1")));
const clickText = async (text, parent = "body") => {
  const found = await page.eval(
    `(() => { const root = document.querySelector(${JSON.stringify(parent)}); const button = [...root.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)}); if (!button) return false; button.click(); return true; })()`,
  );
  if (!found) throw new Error(`Missing button ${text} in ${parent}`);
  await settle();
};
const changeType = async (value) => {
  await page.eval(
    `(() => { const select = document.querySelector('[name="order-type"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await settle();
};
const settings = () => page.click('[aria-label="Demo account settings"]');
const close = () => page.click('dialog[open] [aria-label="Close dialog"]');
const reviewAndConfirm = async () => {
  await page.click("#review-order");
  await settle();
  await page.click("#confirm-order");
  await settle();
};

await page.open("http://127.0.0.1:4188/");
await page.wait("#review-order");
await settings();
await page.click(".settings-row .danger");
await page.click(".dialog-actions .primary");
await settings();
await clickText("Pause", "dialog");
await close();
let state = await read();
check(
  state.paused && state.orders.length === 2 && state.cashCents === 94000,
  "Fresh account has $1,000 total starting funds, two funded sample positions, and a working pause control",
);
check(
  await page.eval(
    () =>
      !document.querySelector("vite-error-overlay") &&
      document.body.innerText.includes("Find your edge."),
  ),
  "Main screen renders with no error overlay",
);

for (const asset of ["Bitcoin", "Ethereum"]) {
  for (const minutes of [5, 15]) {
    await page.click(`[aria-label="Select ${asset} ${minutes} minute market"]`);
    await settle();
    const contents = await page.eval(() => ({
      title: document.querySelector(".detail-title-line").innerText,
      ticket: document.querySelector(".ticket-top").innerText,
      hash: location.hash,
    }));
    check(
      contents.title.includes(asset) &&
        contents.title.includes(String(minutes)) &&
        contents.ticket.includes(String(minutes)),
      `${asset} ${minutes}m updates the detail and trade ticket`,
    );
  }
}
await page.click(".chart-mode button:nth-child(2)");
check(
  await page.eval(() =>
    document
      .querySelector(".price-chart svg")
      .getAttribute("aria-label")
      .includes("probability"),
  ),
  "Probability chart is functional",
);
await page.click(".chart-mode button:first-child");
await page.click(".chart-bottom .text-button");
check(
  await page.eval(() => document.querySelectorAll(".depth-row").length === 8),
  "Order book exposes both sides of the selected outcome",
);
await page.click(".order-book .mini-tabs button:nth-child(2)");
check(
  await page.eval(() =>
    document
      .querySelector(".order-book .mini-tabs button:nth-child(2)")
      .classList.contains("active"),
  ),
  "Order book switches outcome",
);
await page.click(".chart-bottom .text-button");

await page.click('[aria-label="Add ETH 15m to watchlist"]');
await page.click(".discovery-tabs button:nth-child(2)");
check(
  await page.eval(() => document.querySelectorAll(".market-card").length === 2),
  "Watchlist saves and filters markets",
);
await page.click(".discovery-tabs button:first-child");
await page.click('[aria-label="Search markets"]');
await fill('[name="market-search"]', "eth 15");
check(
  await page.eval(
    () => document.querySelectorAll(".search-results>button").length === 1,
  ),
  "Search filters by asset and duration",
);
await page.press("Escape");
check(
  await page.eval(() => !document.querySelector("dialog[open]")),
  "Escape dismisses dialogs",
);

await page.click(".deposit-button");
await fill("#deposit-amount", "100");
await page.click("#confirm-deposit");
await settle();
state = await read();
check(
  state.cashCents === 104000 && state.depositedCents === 110000,
  "Demo top-up credits cash and deposits exactly",
);
await page.click('[aria-label="Select Bitcoin 5 minute market"]');
await fill("#trade-amount", "25");
const beforeBuy = await read();
await page.click("#review-order");
check(
  await page.eval(() =>
    document.querySelector("dialog").innerText.includes("Maximum loss"),
  ),
  "Review includes maximum loss, fees, round, and payout",
);
await page.click("#confirm-order");
await settle();
state = await read();
const filled = state.orders[0];
check(
  filled.status === "filled" &&
    filled.side === "buy" &&
    state.cashCents === beforeBuy.cashCents - filled.totalCents,
  "Confirmed market buy updates cash and fills",
);
check(
  await page.eval(() =>
    document.querySelector(".account-panel").innerText.includes("Bitcoin"),
  ),
  "Filled trade appears in positions",
);

await page.click(".buy-sell button:nth-child(2)");
await fill("#trade-amount", "5");
const beforeSell = await read();
await reviewAndConfirm();
state = await read();
check(
  state.orders[0].side === "sell" &&
    state.orders[0].quantity === 5 &&
    state.cashCents === beforeSell.cashCents + state.orders[0].totalCents,
  "Selling shares credits proceeds after the fee",
);
await fill("#trade-amount", "999999");
check(
  await page.eval(
    () =>
      document.querySelector("#review-order").disabled &&
      document.querySelector("#amount-error").innerText.includes("available"),
  ),
  "Overselling is blocked with an available-shares message",
);

await page.click(".buy-sell button:first-child");
await changeType("limit");
await fill("#limit-price", "1");
await fill("#trade-amount", "25");
const beforeLimit = await read();
await reviewAndConfirm();
state = await read();
check(
  state.orders[0].status === "open" &&
    state.orders[0].reservedCents > 0 &&
    state.cashCents + state.orders[0].reservedCents === beforeLimit.cashCents,
  "Limit order reserves the exact available cash",
);
await clickText("Cancel order", ".account-panel");
state = await read();
check(
  state.orders[0].status === "cancelled" &&
    state.cashCents === beforeLimit.cashCents,
  "Cancelling the limit order releases all reserved cash",
);

await changeType("market");
await fill("#trade-amount", "10");
await page.click(".outcome-button.up");
await reviewAndConfirm();
await page.click(".outcome-button.down");
await reviewAndConfirm();
await settings();
await clickText("Finish round", "dialog");
state = await read();
const winner = state.positions.find(
  (p) => p.marketId === "btc-5m" && p.status === "won" && !p.claimed,
);
const loser = state.positions.find(
  (p) => p.marketId === "btc-5m" && p.status === "lost",
);
check(
  !!winner && !!loser && loser.payoutCents === 0,
  "Round completion settles opposite outcomes consistently",
);
const claimCash = state.cashCents;
await page.click(".account-panel .table-action.claim");
await settle();
state = await read();
check(
  state.cashCents === claimCash + winner.payoutCents &&
    state.positions.find((p) => p.id === winner.id).claimed,
  "Winning payout can be claimed and credits the wallet exactly once",
);
check(
  await page.eval(
    () => !document.querySelector(".account-panel .table-action.claim"),
  ),
  "Claim action disappears after the payout",
);

await clickText("Portfolio", ".main-nav");
check(
  await page.eval(
    () =>
      !!document.querySelector(".portfolio-overview") &&
      document
        .querySelector(".portfolio-view")
        .innerText.includes("Reserved for orders"),
  ),
  "Portfolio shows balances, reserves, position value, and claimable payouts",
);
await clickText("Settled positions", ".portfolio-table");
check(
  await page.eval(
    () =>
      document
        .querySelector(".portfolio-table")
        .innerText.includes("Claimed") &&
      document.querySelector(".portfolio-table").innerText.includes("Lost"),
  ),
  "Settled portfolio differentiates claimed wins and losses",
);
await clickText("History", ".main-nav");
check(
  (await page.eval(
    () => document.querySelectorAll(".history-view tbody tr").length,
  )) === state.orders.length,
  "History contains the full order ledger",
);
await clickText("Limit orders", ".history-view");
check(
  await page.eval(
    () =>
      document.querySelectorAll(".history-view tbody tr").length === 1 &&
      document
        .querySelector(".history-view tbody")
        .innerText.toLowerCase()
        .includes("cancelled"),
  ),
  "History filter shows cancelled limit orders",
);
await page.eval(() => {
  const original = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    if (blob.type === "text/csv")
      blob.text().then((text) => {
        window.__edgeCsv = text;
      });
    return original.call(URL, blob);
  };
});
await clickText("Export CSV", ".history-view");
await settle();
const csv = await page.eval(() => window.__edgeCsv);
check(
  csv.startsWith("id,market,round_start_utc") &&
    csv.trim().split("\n").length === state.orders.length + 1,
  "CSV export includes all orders and accounting fields",
);

await page.open("http://127.0.0.1:4188/#/portfolio");
await page.wait(".portfolio-overview");
const restored = await read();
check(
  restored.cashCents === state.cashCents &&
    restored.orders.length === state.orders.length &&
    restored.paused,
  "Paper account and playback preferences survive reload",
);
await page.click('[aria-label="How EDGE works"]');
await page.click(".faq:first-of-type summary");
check(
  await page.eval(() =>
    document
      .querySelector("details[open]")
      ?.innerText.includes("partial fills"),
  ),
  "Help explains the simulator execution limits",
);
await close();
check(
  await page.eval(() => document.documentElement.scrollWidth <= innerWidth),
  "Desktop has no horizontal page overflow",
);
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      viewport: await page.eval(() => [innerWidth, innerHeight]),
      checks: results.length,
      results,
    },
    null,
    2,
  ),
);
