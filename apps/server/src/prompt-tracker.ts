import { SEAT_COUNT, promptKey, type SeatId, type SeatView } from '@canutell/protocol';

/**
 * CLAUDE.md invariant 6: latency runs from the moment a phase prompt is sent to a seat until its
 * choice arrives. "Sent" = the first time a view containing that prompt was written to the seat's
 * socket. A seat that was disconnected when the prompt opened gets its clock started on reconnect.
 */
export class PromptTracker {
  private readonly sent: Map<string, number>[] = Array.from({ length: SEAT_COUNT }, () => new Map());

  /** Call after a view is written to the seat's socket. */
  onViewSent(seat: SeatId, view: SeatView, at: number): void {
    const map = this.sent[seat]!;
    const live = new Set(view.prompts.map((p) => promptKey(p, view.round)));
    for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key); // prompt closed
    for (const key of live) if (!map.has(key)) map.set(key, at);
  }

  /** When the seat first saw `key`, or null if it never did. Forgets the key. */
  take(seat: SeatId, key: string): number | null {
    const map = this.sent[seat]!;
    const at = map.get(key);
    map.delete(key);
    return at ?? null;
  }
}
