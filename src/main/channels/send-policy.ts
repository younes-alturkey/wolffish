/**
 * Delivery guarantee behind the channel send tools' format gates
 * (Telegram and WhatsApp share it; targets are chat ids or JIDs).
 *
 * A gate bounces a broken message so the model can fix its own markup,
 * but it must never be able to LOSE a message: after
 * MAX_CONSECUTIVE_REJECTS bounces for the same chat with no successful
 * send in between (inside the TTL window), the gate stands aside and the
 * message is delivered as composed — worst case the user sees raw markup,
 * never silence. A successful send resets the budget; stale entries
 * expire so this morning's bounces can't force-deliver tonight's digest.
 *
 * Pure and clock-injected so the policy is unit-testable.
 */
export const MAX_CONSECUTIVE_REJECTS = 2
const WINDOW_MS = 15 * 60 * 1000

export class RejectBudget {
  private rejects = new Map<string | number, { count: number; last: number }>()

  constructor(private now: () => number = Date.now) {}

  /** True when the gate must stand aside and let the message deliver. */
  exhausted(target: string | number): boolean {
    const e = this.rejects.get(target)
    if (!e) return false
    if (this.now() - e.last > WINDOW_MS) {
      this.rejects.delete(target)
      return false
    }
    return e.count >= MAX_CONSECUTIVE_REJECTS
  }

  /** Record one gate bounce for this chat. */
  reject(target: string | number): void {
    const e = this.rejects.get(target)
    const priorCount = e && this.now() - e.last <= WINDOW_MS ? e.count : 0
    this.rejects.set(target, { count: priorCount + 1, last: this.now() })
  }

  /** A successful send proves the loop closed — reset the budget. */
  delivered(target: string | number): void {
    this.rejects.delete(target)
  }
}
