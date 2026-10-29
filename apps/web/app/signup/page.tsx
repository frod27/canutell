'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { AccountSummary } from '@canutell/protocol';
import { AgeForm, ConsentBlock, ageErrorText } from '@/components/AccountParts';
import { ApiError, answerAge, setResearchConsent, signUp } from '@/lib/account';

// Sign-up, one step per screen (docs/proposals/phase-5.md §3, phase-6.md §2): invite code (closed alpha) →
// terms → passkey (T1) → age (T2) → research opt-in (separate, unticked, skippable) → done.

type Step = 'invite' | 'terms' | 'passkey' | 'age' | 'research' | 'done';

export default function SignUp() {
  const [step, setStep] = useState<Step>('invite');
  const [invite, setInvite] = useState('');
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_invite') {
        setError('That invite code isn’t valid (or has been used up). Check it and try again.');
        setStep('invite');
      } else
        setError(
          e instanceof ApiError ? ageErrorText(e.code) : 'The passkey was not created. Please try again.',
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>CANUTELL</h1>
      <section className="card">
        {step === 'invite' && (
          <>
            <h2>Create an account</h2>
            <p>CANUTELL is in a closed alpha. Enter the invite code you were given.</p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (invite.trim()) setStep('terms');
              }}
            >
              <input
                aria-label="Invite code"
                placeholder="XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={32}
                value={invite}
                onChange={(e) => setInvite(e.target.value.toUpperCase())}
              />
              <button type="submit" disabled={!invite.trim()}>
                Continue
              </button>
            </form>
            <button className="secondary" onClick={() => setStep('terms')}>
              I don’t have a code
            </button>
          </>
        )}
        {step === 'terms' && (
          <>
            <h2>Create an account</h2>
            <ConsentBlock type="terms" />
            <div className="row">
              <button onClick={() => setStep('passkey')}>I agree</button>
              <Link className="button secondary" href="/">
                Not now
              </Link>
            </div>
          </>
        )}
        {step === 'passkey' && (
          <>
            <h2>Create a passkey</h2>
            <p>
              Your account is a passkey on this device (Face ID, fingerprint, screen lock or a security key).
              No password, no email.
            </p>
            {!supported && <p className="notice">This browser doesn’t support passkeys.</p>}
            <button
              disabled={busy || !supported}
              onClick={() =>
                run(async () => {
                  setAccount(await signUp(invite.trim() || undefined));
                  setStep('age');
                })
              }
            >
              Create passkey
            </button>
          </>
        )}
        {step === 'age' && (
          <>
            <h2>Confirm your age</h2>
            <AgeForm
              busy={busy}
              onSubmit={(y, m) =>
                run(async () => {
                  const a = await answerAge(y, m);
                  setAccount(a);
                  setStep(a.ageConfirmed ? 'research' : 'done');
                })
              }
            />
            <button className="secondary" onClick={() => setStep('done')}>
              Skip for now
            </button>
          </>
        )}
        {step === 'research' && (
          <>
            <ConsentBlock type="research" />
            <div className="row">
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setAccount(await setResearchConsent(true));
                    setStep('done');
                  })
                }
              >
                Yes, include my play
              </button>
              <button className="secondary" onClick={() => setStep('done')}>
                No thanks
              </button>
            </div>
          </>
        )}
        {step === 'done' && (
          <>
            <h2>You’re signed in</h2>
            {account?.ageConfirmed === false && (
              <p>Because you’re under 18, nothing from your play is used for training. You can still play.</p>
            )}
            <div className="row">
              <Link className="button" href="/">
                Play
              </Link>
              <Link className="button secondary" href="/account">
                Your account
              </Link>
            </div>
          </>
        )}
        {error && <p className="notice">{error}</p>}
      </section>
    </main>
  );
}
