'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { trustAtLeast, type AccountSummary, type PasskeyListResponse } from '@canutell/protocol';
import { AgeForm, ConsentBlock, ageErrorText } from '@/components/AccountParts';
import {
  ApiError,
  TRUST_MEANING,
  addPasskey,
  answerAge,
  deleteAccount,
  getMe,
  listPasskeys,
  readSession,
  removePasskey,
  setResearchConsent,
  signOut,
  signOutEverywhere,
} from '@/lib/account';

// The player's own account: trust level, research consent, passkeys, sign-out and deletion
// (SPEC §Consent and privacy: research use is a separate opt-in, revocable at any time).

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<AccountSummary | null>(null);
  const [keys, setKeys] = useState<PasskeyListResponse['passkeys']>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!readSession()) return router.replace('/signin');
    try {
      setMe(await getMe());
      setKeys((await listPasskeys()).passkeys);
    } catch {
      router.replace('/signin');
    }
  }, [router]);
  useEffect(() => void load(), [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? ageErrorText(e.code) : 'That didn’t work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!me)
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  return (
    <main>
      <h1>CANUTELL</h1>
      <p>
        <Link href="/">← Play</Link>
      </p>
      <section className="card">
        <h2>Your account</h2>
        <p>
          Trust level <strong data-testid="trust">{me.trustLevel}</strong>: {TRUST_MEANING[me.trustLevel]}
        </p>
        {me.ageConfirmed === null && (
          <>
            <h3>Confirm your age</h3>
            <AgeForm busy={busy} onSubmit={(y, m) => run(async () => setMe(await answerAge(y, m)))} />
          </>
        )}
        {me.ageConfirmed === false && (
          <p className="muted">Under 18: your play is never used for training.</p>
        )}
      </section>

      <section className="card">
        <ConsentBlock type="research" />
        <p>
          Status: <strong data-testid="research">{me.researchConsent ? 'on' : 'off'}</strong>
          {me.researchConsent &&
            !trustAtLeast(me.trustLevel, 'T2') &&
            ' (used only once you are T2 or above)'}
        </p>
        <button
          disabled={busy || me.ageConfirmed === false}
          className={me.researchConsent ? 'secondary' : ''}
          onClick={() => run(async () => setMe(await setResearchConsent(!me.researchConsent)))}
        >
          {me.researchConsent ? 'Turn off' : 'Turn on'}
        </button>
      </section>

      <section className="card">
        <h3>Passkeys</h3>
        <ul>
          {keys.map((k) => (
            <li key={k.id}>
              Added {new Date(k.createdAt).toLocaleDateString()}
              {k.backedUp ? ' · synced' : ' · this device only'}
              {keys.length > 1 && (
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await removePasskey(k.id);
                      setKeys((await listPasskeys()).passkeys);
                    })
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await addPasskey();
              setKeys((await listPasskeys()).passkeys);
            })
          }
        >
          Add another passkey
        </button>
      </section>

      <section className="card">
        <div className="row">
          <button className="secondary" onClick={() => run(async () => (await signOut(), router.push('/')))}>
            Sign out
          </button>
          <button
            className="secondary"
            onClick={() => run(async () => (await signOutEverywhere(), router.push('/')))}
          >
            Sign out everywhere
          </button>
        </div>
        <h3>Delete account</h3>
        <p className="muted">
          Erases your passkeys and sign-ins and turns off research use. Past matches keep your moves only as
          anonymous context for the other players, never linked to you and never used for training.
        </p>
        {!confirmDelete ? (
          <button className="danger" onClick={() => setConfirmDelete(true)}>
            Delete my account
          </button>
        ) : (
          <div className="row">
            <button
              className="danger"
              disabled={busy}
              onClick={() => run(async () => (await deleteAccount(), router.push('/')))}
            >
              Yes, delete it
            </button>
            <button className="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        )}
        {error && <p className="notice">{error}</p>}
      </section>
    </main>
  );
}
