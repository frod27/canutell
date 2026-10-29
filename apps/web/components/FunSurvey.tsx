'use client';

import { useEffect, useState } from 'react';
import { FEEDBACK_COMMENT_MAX, FEEDBACK_TAGS, type FeedbackTag } from '@canutell/protocol';
import { ApiError, readSession, submitFeedback } from '@/lib/account';

// The post-match survey (DECISIONS Phase 6): fun, measured. Optional; signed-in players only; one answer
// per match. Product data only, never used for training. The comment is masked like chat.

const TAG_LABEL: Record<FeedbackTag, string> = {
  too_long: 'Too long',
  too_slow: 'Too slow',
  confusing: 'Confusing',
  great_chat: 'Great chat',
  felt_unfair: 'Felt unfair',
  bugs: 'Bugs',
};

export function FunSurvey({ matchId }: { matchId: string }) {
  const [signedIn, setSignedIn] = useState(false);
  const [fun, setFun] = useState<number | null>(null);
  const [tags, setTags] = useState<FeedbackTag[]>([]);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'open' | 'sending' | 'done' | 'error'>('open');
  useEffect(() => setSignedIn(readSession() !== null), []);
  if (!signedIn) return null;
  if (state === 'done')
    return (
      <section className="card">
        <p data-testid="survey-done">Thanks for the feedback!</p>
      </section>
    );

  const send = async () => {
    if (fun === null) return;
    setState('sending');
    const body = { fun, tags, comment: comment.trim() ? comment.trim() : null };
    try {
      try {
        await submitFeedback(matchId, body);
      } catch (e) {
        // The match may still be being saved for a moment after the reveal appears.
        if (!(e instanceof ApiError && e.code === 'not_completed')) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        await submitFeedback(matchId, body);
      }
      setState('done');
    } catch (e) {
      setState(e instanceof ApiError && e.code === 'already_answered' ? 'done' : 'error');
    }
  };

  return (
    <section className="card">
      <h3>How much fun was this match?</h3>
      <div className="row wrap" role="radiogroup" aria-label="Fun rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            role="radio"
            aria-checked={fun === n}
            className={fun === n ? '' : 'secondary'}
            onClick={() => setFun(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="muted small">1 = not fun, 5 = great. Optional, and never used to train the AI players.</p>
      <div className="row wrap">
        {FEEDBACK_TAGS.map((t) => (
          <label key={t} className="small">
            <input
              type="checkbox"
              checked={tags.includes(t)}
              onChange={(e) => setTags(e.target.checked ? [...tags, t] : tags.filter((x) => x !== t))}
            />{' '}
            {TAG_LABEL[t]}
          </label>
        ))}
      </div>
      <textarea
        aria-label="Comment"
        placeholder="Anything else? (optional)"
        maxLength={FEEDBACK_COMMENT_MAX}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
      />
      <button disabled={fun === null || state === 'sending'} onClick={send}>
        Send feedback
      </button>
      {state === 'error' && <p className="notice">Couldn’t send that. Please try again.</p>}
    </section>
  );
}
