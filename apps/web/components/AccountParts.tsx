'use client';

import { useState } from 'react';
import { CONSENT_TEXTS, type ConsentType } from '@canutell/protocol';

/** One consent text, exactly as versioned in @canutell/protocol (docs/consent). */
export function ConsentBlock({ type }: { type: ConsentType }) {
  const t = CONSENT_TEXTS[type];
  return (
    <div className="consent">
      <h3>
        {t.title} <span className="muted">v{t.version}</span>
      </h3>
      {t.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </div>
  );
}

/** Self-attested birth month and year (SPEC §Integrity, T2). Only the yes/no is stored, never the date. */
export function AgeForm({
  onSubmit,
  busy,
}: {
  onSubmit: (year: number, month: number) => void;
  busy: boolean;
}) {
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const thisYear = new Date().getFullYear();
  const y = Number(year);
  const m = Number(month);
  const valid = Number.isInteger(y) && y >= 1900 && y <= thisYear && Number.isInteger(m) && m >= 1 && m <= 12;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(y, m);
      }}
    >
      <p>
        When were you born? We keep only whether you are 18 or older, never the date. You can answer once.
      </p>
      <div className="row">
        <select aria-label="Birth month" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">Month</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' })}
            </option>
          ))}
        </select>
        <input
          aria-label="Birth year"
          inputMode="numeric"
          placeholder="Year"
          maxLength={4}
          value={year}
          onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <button type="submit" disabled={!valid || busy}>
        Confirm
      </button>
    </form>
  );
}

export function ageErrorText(code: string): string {
  if (code === 'age_try_later')
    return 'You turn 18 this month, so we can’t tell yet. Please answer again next month.';
  if (code === 'age_already_answered') return 'Age was already answered for this account.';
  return `Something went wrong (${code}).`;
}
