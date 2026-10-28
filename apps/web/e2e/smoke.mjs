// Browser smoke test: lobby → quick match → act in every phase type → Reveal, through the real UI.
// Needs a running server with dev bot fill (e.g. CLOCK_SPEED=10 FILL_BOTS_MS=500 pnpm serve) and the web
// app (pnpm --filter @canutell/web start). With EXPECT_DB=1 (server has DATABASE_URL) it also reopens the
// reveal from the database via its permanent link. Usage: node apps/web/e2e/smoke.mjs [url] [screenshotDir]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const url = process.argv[2] ?? 'http://localhost:3000';
const shots = process.argv[3] ?? null;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // phone-sized
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });

await page.goto(url);
await page.getByText('This match may contain AI players.').waitFor();
await shot('1-lobby');
await page.getByRole('button', { name: /^Quick/ }).click();
await page.getByText(/Round 1\/3/).waitFor({ timeout: 20000 });
await page.getByRole('button', { name: 'Invest' }).click();
await shot('2-invest');

const seen = new Set();
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (await page.getByRole('heading', { name: 'Reveal' }).isVisible()) break;
  const tryClick = async (name, label) => {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      seen.add(label);
    }
  };
  await tryClick('Send', 'stake'); // stake form's Send (also chat Send; harmless)
  await tryClick(/^A:/, 'gamble');
  await tryClick('Skip', 'vote');
  await tryClick('Return', 'return');
  if (
    await page
      .getByRole('button', { name: 'Submit ballot' })
      .isVisible()
      .catch(() => false)
  ) {
    await shot('3-ballot');
    await page.getByRole('button', { name: 'Submit ballot' }).click();
    seen.add('ballot');
  }
  await page.waitForTimeout(300);
}
await page.getByRole('heading', { name: 'Reveal' }).waitFor({ timeout: 5000 });
await page.getByRole('heading', { name: 'Your ballot' }).waitFor();
await shot('4-reveal');
const norm = (t) => t.replace('Back to lobby', '').replace(/\s+/g, ' ').trim();
const liveText = norm(await page.locator('main').innerText());

// Reopen from the database through the permanent link; a browser without the player's token is refused.
let reopened = null;
if (process.env.EXPECT_DB === '1') {
  await page.getByRole('link', { name: 'Permanent link to this reveal' }).click();
  await page.waitForURL(/\/match\//);
  await page.getByRole('heading', { name: 'Your ballot' }).waitFor({ timeout: 10000 });
  await shot('5-reopened');
  const dbText = norm(await page.locator('main').innerText());
  if (shots)
    (await import('node:fs')).writeFileSync(
      `${shots}/texts.json`,
      JSON.stringify({ liveText, dbText }, null, 1),
    );
  reopened = { url: page.url(), sameAsLive: dbText === liveText };
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(page.url());
  await stranger.getByText(/only visible to players from that match/).waitFor({ timeout: 10000 });
  reopened.strangerRefused = true;
}
await browser.close();
console.log(JSON.stringify({ reachedReveal: true, actedOn: [...seen].sort(), reopened, pageErrors: errors }));
if (errors.length || (reopened && !(reopened.sameAsLive && reopened.strangerRefused))) process.exit(1);
