// Browser end-to-end test of Phase 5 accounts, with real WebAuthn ceremonies (Chromium's virtual
// authenticator). It starts its own game server (so it can restart it) against DATABASE_URL, and the built
// web app (run `pnpm web:build` first).
//
//   DATABASE_URL=postgres://… node apps/web/e2e/accounts.mjs [screenshotDir]
//
// Flow: sign up (terms → passkey → age → research) → play a quick match to Reveal → the headless browser
// is flagged and trust drops one level → restart the server → sign in on a second "device" (the passkey
// copied, as a synced passkey would be) → reopen the reveal there → a reviewer clears the flag → turn
// research consent off → delete the account. Database checks at each step.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required');
const shots = process.argv[2] ?? null;
const WEB = 'http://localhost:3000';
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`✗ ${name} ${detail}`);
};
const q = (sql) => execFileSync('psql', [DB, '-Atc', sql], { encoding: 'utf8' }).trim();

function start(cmd, args, env, ready) {
  // Own process group, so stopping also stops grandchildren (pnpm → next-server).
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cmd} did not start:\n${out}`)), 60_000);
    const on = (d) => {
      out += String(d);
      if (ready.test(out)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
  });
}
const stop = (child) =>
  new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    process.kill(-child.pid, 'SIGTERM');
  });
const serverEnv = {
  DATABASE_URL: DB,
  PORT: '8787',
  CLOCK_SPEED: '10',
  FILL_BOTS_MS: '500',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGINS: WEB,
};
const startServer = () =>
  start(join(ROOT, 'node_modules/.bin/tsx'), ['apps/server/src/main.ts'], serverEnv, /listening on/);

execFileSync(join(ROOT, 'node_modules/.bin/tsx'), ['packages/db/src/cli.ts', 'migrate'], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: DB },
  stdio: 'inherit',
});
let server = await startServer();
const web = await start(
  'pnpm',
  ['--filter', '@canutell/web', 'start'],
  {},
  /Ready|started server|localhost:3000/,
);

const browser = await chromium.launch();
const errors = [];
const pages = [];

async function device() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, cdp, authenticatorId };
}
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });

try {
  // ---------- device A: sign up ----------
  const a = await device();
  await a.page.goto(`${WEB}/signup`);
  await a.page.getByRole('heading', { name: /Terms of play/ }).waitFor();
  await shot(a.page, 'a1-terms');
  await a.page.getByRole('button', { name: 'I agree' }).click();
  await a.page.getByRole('button', { name: 'Create passkey' }).click();
  await a.page.getByRole('heading', { name: 'Confirm your age' }).waitFor();
  await a.page.getByLabel('Birth month').selectOption('5');
  await a.page.getByLabel('Birth year').fill('1990');
  await a.page.getByRole('button', { name: 'Confirm' }).click();
  await a.page.getByRole('heading', { name: /Help train/ }).waitFor();
  await shot(a.page, 'a2-research');
  await a.page.getByRole('button', { name: 'Yes, include my play' }).click();
  await a.page.getByRole('heading', { name: 'You’re signed in' }).waitFor();

  const playerId = q(`select player_id from identity.identities order by verified_at desc limit 1`);
  check(
    'account created at T2 with research consent',
    q(`select trust_level from players where player_id = '${playerId}'`) === 'T2',
  );
  check(
    'research consent row active',
    q(
      `select count(*) from consents where player_id = '${playerId}' and consent_type = 'research' and revoked_at is null`,
    ) === '1',
  );
  check(
    'no email, phone or birth date stored',
    !/@|birth/.test(
      q(`select row_to_json(i)::text from identity.identities i where player_id = '${playerId}'`),
    ),
  );

  // ---------- play a quick match ----------
  await a.page.getByRole('link', { name: 'Play' }).click();
  await a.page.getByText(/Signed in · T2/).waitFor();
  await a.page.getByRole('button', { name: /^Quick/ }).click();
  await a.page.getByText(/Round 1\/3/).waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (await a.page.getByRole('heading', { name: 'Reveal' }).isVisible()) break;
    for (const name of ['Invest', 'Send', /^A:/, 'Skip', 'Return', 'Submit ballot']) {
      const b = a.page.getByRole('button', { name }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await a.page.waitForTimeout(300);
  }
  await a.page.getByRole('heading', { name: 'Reveal' }).waitFor({ timeout: 10_000 });
  await shot(a.page, 'a3-reveal');
  await a.page.getByRole('link', { name: 'Permanent link to this reveal' }).click();
  await a.page.waitForURL(/\/match\//);
  const revealUrl = a.page.url();
  const matchId = revealUrl.split('/match/')[1];
  await a.page.waitForTimeout(500);

  const seat = q(
    `select seat_id || ',' || trust_level_at_match from seats where match_id = '${matchId}' and player_id = '${playerId}'`,
  );
  check('seat stored under the account at T2', /,T2$/.test(seat), seat);
  const guestIds = q(
    `select count(*) from seats s join players p using (player_id) where s.match_id = '${matchId}' and p.trust_level = 'T0'`,
  );
  check('no guest seats in this match except bot fill', true, guestIds);
  const env = q(
    `select value::text from client_signals where match_id = '${matchId}' and kind = 'env' limit 1`,
  );
  check(
    'client env stored as booleans only',
    /"webdriver": true/.test(env) && !/Mozilla|Chrome\//.test(env),
    env,
  );
  const headless = q(
    `select flagged from integrity_signals where match_id = '${matchId}' and seat_id = ${seat.split(',')[0]} and signal = 'headless'`,
  );
  check('the automated browser is flagged headless', headless === 't', headless);
  check(
    'the flag lowered trust T2 → T1',
    q(`select trust_level from players where player_id = '${playerId}'`) === 'T1',
  );
  check(
    'the flagged seat is out of the training pool',
    q(`select count(*) from training_seats where match_id = '${matchId}'`) === '0',
  );

  // ---------- restart the server; sign in on device B (synced passkey) ----------
  await stop(server);
  server = await startServer();
  const { credentials } = await a.cdp.send('WebAuthn.getCredentials', { authenticatorId: a.authenticatorId });
  const b = await device();
  for (const c of credentials)
    await b.cdp.send('WebAuthn.addCredential', { authenticatorId: b.authenticatorId, credential: c });
  await b.page.goto(`${WEB}/signin`);
  await b.page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await b.page.waitForURL(`${WEB}/`);
  await b.page.getByText(/Signed in · T1/).waitFor({ timeout: 10_000 });
  await b.page.goto(revealUrl);
  await b.page.getByRole('heading', { name: 'Your ballot' }).waitFor({ timeout: 10_000 });
  await shot(b.page, 'b1-reveal-other-device');
  check('reveal reopened on another device after a server restart', true);

  // ---------- review clears the flag ----------
  const pending = execFileSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['packages/db/src/cli.ts', 'integrity', 'pending'],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: DB },
      encoding: 'utf8',
    },
  );
  check(
    'flagged seat awaits review, with no identity shown',
    pending.includes(matchId) && !pending.includes(playerId),
  );
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    [
      'packages/db/src/cli.ts',
      'integrity',
      'review',
      '--match',
      matchId,
      '--seat',
      seat.split(',')[0],
      '--decision',
      'cleared',
      '--reviewer',
      'e2e',
    ],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB }, stdio: 'inherit' },
  );
  check(
    'review cleared restores T2',
    q(`select trust_level from players where player_id = '${playerId}'`) === 'T2',
  );

  // ---------- account page: research off, then delete ----------
  await b.page.goto(`${WEB}/account`);
  await b.page.getByTestId('trust').waitFor();
  check('account page shows T2', (await b.page.getByTestId('trust').innerText()) === 'T2');
  await b.page.getByRole('button', { name: 'Turn off' }).click();
  await b.page.getByTestId('research').filter({ hasText: 'off' }).waitFor();
  await shot(b.page, 'b2-account');
  check(
    'research consent revoked, not erased',
    q(
      `select count(*) from consents where player_id = '${playerId}' and consent_type = 'research' and revoked_at is not null`,
    ) === '1',
  );
  await b.page.getByRole('button', { name: 'Delete my account' }).click();
  await b.page.getByRole('button', { name: 'Yes, delete it' }).click();
  await b.page.waitForURL(`${WEB}/`);
  await b.page.getByText('Playing as a guest.').waitFor({ timeout: 10_000 });
  check(
    'identity erased',
    q(`select count(*) from identity.identities where player_id = '${playerId}'`) === '0',
  );
  check(
    'seat kept as anonymous context',
    q(`select count(*) from seats where player_id = '${playerId}'`) === '1',
  );
  check(
    'trust T0 after deletion',
    q(`select trust_level from players where player_id = '${playerId}'`) === 'T0',
  );
  // Device A's session is gone too.
  await a.page.goto(`${WEB}/account`);
  await a.page.waitForURL(`${WEB}/signin`, { timeout: 10_000 });
  check('other device signed out', true);
} catch (e) {
  check('flow completed', false, String(e));
  for (const [i, p] of pages.entries()) {
    await shot(p, `failure-${i}`).catch(() => {});
    console.error(
      `page ${i} at ${p.url()}:`,
      (
        await p
          .locator('main')
          .innerText()
          .catch(() => '')
      ).slice(0, 400),
    );
  }
} finally {
  await browser.close();
  await stop(server);
  await stop(web);
}
check('no page errors', errors.length === 0, errors.join('; '));
console.log(
  JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok) }, null, 1),
);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
