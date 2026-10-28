export type RejectionCode =
  | 'invalid_action'
  | 'match_not_started'
  | 'match_over'
  | 'late'
  | 'clock_regression'
  | 'wrong_phase'
  | 'not_active'
  | 'already_acted'
  | 'invalid_target'
  | 'out_of_range'
  | 'insufficient_balance'
  | 'unknown_stake'
  | 'not_receiver'
  | 'stake_closed'
  | 'channel_forbidden'
  | 'empty_message';

/** The action was invalid or late. State is unchanged. The server reports `code` to the client. */
export class ActionRejectedError extends Error {
  constructor(
    public readonly code: RejectionCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ActionRejectedError';
  }
}

/** An engine invariant broke (e.g. coin conservation). This is a bug, never a player error. */
export class InvariantViolationError extends Error {
  constructor(
    public readonly invariant: string,
    message: string,
  ) {
    super(`[${invariant}] ${message}`);
    this.name = 'InvariantViolationError';
  }
}
