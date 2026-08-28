/**
 * Which product a customer is on.
 *
 * Two editions ship: the full **MyStockio** and the cut-down **MyStockio Mini**. A shop is on one of
 * them, and which one is not something this console can work out — it is a commercial fact somebody
 * has to state, which is why it is asked for rather than defaulted.
 *
 * ── Mandatory when creating, defaulted when reading ────────────────────────────
 * Those sound contradictory and are not. **The form refuses to submit without a choice**, because
 * silently picking one for a new customer is the sort of quiet wrongness that surfaces months later
 * as a support call about a feature they never had.
 *
 * But **an account with no `softwareType` reads as MyStockio**, because every account that existed
 * before this field did is on MyStockio — Mini came later. A missing value is history, not a gap,
 * and reading it as "unknown" would put a question mark against the entire existing customer base.
 *
 * ── Staff do not have one of their own ─────────────────────────────────────────
 * A cashier uses whatever the shop uses. So the edition belongs to the **owner**, exactly like the
 * licence and the shop name, and a staff account reads its owner's — resolved live, so an upgrade
 * moves everybody at once rather than leaving the counter on the old edition.
 */

/** The wire values. These go into the database, so they are lower-case and stable. */
export enum SoftwareType {
  Full = 'mystockio',
  Mini = 'mystockio_mini',
}

/** Both editions, full first — the order they appear on the form. */
export const SOFTWARE_TYPES: SoftwareType[] = [SoftwareType.Full, SoftwareType.Mini]

export const SOFTWARE_LABEL: Record<SoftwareType, string> = {
  [SoftwareType.Full]: 'MyStockio',
  [SoftwareType.Mini]: 'MyStockio Mini',
}

/** One line each, so the choice can be made without leaving the form to look it up. */
export const SOFTWARE_NOTE: Record<SoftwareType, string> = {
  [SoftwareType.Full]: 'The full product.',
  [SoftwareType.Mini]: 'The cut-down edition.',
}

/** Whatever the server sent, as a `SoftwareType` — or `null` when it is not one. */
export function asSoftwareType(value: unknown): SoftwareType | null {
  return typeof value === 'string' && (SOFTWARE_TYPES as string[]).includes(value)
    ? (value as SoftwareType)
    : null
}

/**
 * The edition an account is on, defaulting to the full product.
 *
 * The default is load-bearing in the same way `roleOf`'s is: every account created before this field
 * existed is on MyStockio, so a missing value is not a gap to flag but a fact to read.
 */
export function softwareOf(account: { softwareType?: string | null }): SoftwareType {
  return asSoftwareType(account.softwareType) ?? SoftwareType.Full
}

export function softwareLabelOf(account: { softwareType?: string | null }): string {
  return SOFTWARE_LABEL[softwareOf(account)]
}

/**
 * Checks the choice made on the create form.
 *
 * Returns a message, or `null` when it is fine. The server checks this again and is the authority —
 * this only saves a round trip on the obvious omission.
 */
export function checkSoftwareChoice(value: string): string | null {
  if (!value) return 'Choose which software this customer is on.'
  if (!asSoftwareType(value)) return 'That is not an edition this app knows.'
  return null
}
