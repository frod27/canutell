'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIn } from '@/lib/account';

export default function SignIn() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main>
      <h1>CANUTELL</h1>
      <section className="card">
        <h2>Sign in</h2>
        <p>Use the passkey you created for CANUTELL.</p>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await signIn();
              router.push('/');
            } catch {
              setError('Sign-in didn’t complete. Please try again.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign in with a passkey
        </button>
        {error && <p className="notice">{error}</p>}
        <p className="muted">
          No account? <Link href="/signup">Create one</Link> · <Link href="/">Play as a guest</Link>
        </p>
      </section>
    </main>
  );
}
