/**
 * Renewal messages, and the WhatsApp link that sends one.
 *
 * Free by design. This builds a `wa.me` link and lets the operator's own WhatsApp send it — no
 * Business API, no template approval, no per-message charge. The cost is that a human presses
 * send, which for a few dozen shops a month is the right trade and keeps the whole feature
 * working on a phone with no account setup at all.
 *
 * Pure: building the text and the URL is separate from opening it, so the wording can be
 * asserted without a browser.
 */

import { type AdminAccount, describeTimeLeft, formatDate, isLifetime, planLabel, subscriptionState } from './subscription'

/** Prefixed to a bare 10-digit Indian number. Configurable because shops near borders differ. */
export const DEFAULT_COUNTRY_CODE = '91'

/**
 * A phone number reduced to digits, with a country code, or '' when it cannot be used.
 *
 * WhatsApp wants digits only — no `+`, spaces, brackets or hyphens — and silently opens a "number
 * not on WhatsApp" page for anything malformed, which looks identical to the customer not having
 * WhatsApp. So a number that cannot be made sense of returns empty and the caller disables the
 * button instead of offering one that quietly fails.
 */
export function normalisePhone(raw: unknown, countryCode = DEFAULT_COUNTRY_CODE): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return ''

  /* Already carrying a country code — 12 digits for +91, or a leading 0 to drop. */
  if (digits.length === 10) return `${countryCode}${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `${countryCode}${digits.slice(1)}`
  if (digits.length >= 11 && digits.length <= 15) return digits

  /* Too short to be a mobile number at all. */
  return ''
}

export type ReminderTone = 'expiring' | 'expired' | 'receipt'

/**
 * The message text.
 *
 * Written as one person to another, not as a system notice. Three things a shopkeeper needs and
 * nothing else: which shop it is about, what has happened to the licence, and what to do. The
 * amount is left out of the reminders on purpose — prices change and a stale figure in a message
 * is an argument later.
 */
export function reminderMessage(
  account: AdminAccount,
  tone: ReminderTone,
  options: { appName?: string; contact?: string; amount?: number } = {},
): string {
  const appName = options.appName || 'MyStockio'
  const shop = (account.shopName || account.name || '').trim()
  const greeting = shop ? `Hello ${shop}` : 'Hello'
  const contact = options.contact ? `\n\nReply here and I will help: ${options.contact}` : ''

  if (tone === 'receipt') {
    const amount = options.amount != null ? ` of ₹${formatAmount(options.amount)}` : ''
    const until = isLifetime(account)
      ? 'Your licence is now lifetime — it will not expire.'
      : `Your ${appName} licence is active until ${formatDate(account.subscription?.expiresAt) || 'the new date'}.`
    return `${greeting},\n\nThank you — your payment${amount} has been received. ${until}${contact}`
  }

  if (tone === 'expired') {
    return (
      `${greeting},\n\nYour ${appName} licence expired on ` +
      `${formatDate(account.subscription?.expiresAt) || 'a recent date'}. ` +
      `Your data is safe and nothing has been deleted — renewing puts everything back as it was.` +
      `\n\nShall I renew it for you?${contact}`
    )
  }

  return (
    `${greeting},\n\nA reminder that your ${appName} licence (${planLabel(account.subscription?.plan)}) ` +
    `${describeTimeLeft(account).toLowerCase()} — it ends on ` +
    `${formatDate(account.subscription?.expiresAt) || 'the date on your invoice'}.` +
    `\n\nRenew before then and there is no interruption at the counter.${contact}`
  )
}

/** The tone that fits this account right now. */
export function toneFor(account: AdminAccount, now: Date = new Date()): ReminderTone {
  return subscriptionState(account, now) === 'expired' ? 'expired' : 'expiring'
}

/**
 * A `wa.me` link that opens WhatsApp with the message pre-filled, or '' without a usable number.
 *
 * `wa.me` rather than `api.whatsapp.com` because it resolves to the installed app on a phone and
 * to WhatsApp Web on a desktop, from one URL.
 */
export function whatsappLink(
  account: AdminAccount,
  message: string,
  countryCode = DEFAULT_COUNTRY_CODE,
): string {
  const phone = normalisePhone(account.phone, countryCode)
  if (!phone) return ''
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
}

/** Indian grouping — 1,20,000 rather than 120,000. */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value)
}
