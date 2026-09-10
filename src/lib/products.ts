/**
 * The products this console administers, and where each one's API lives.
 *
 * ══ ONE CONSOLE, SEVERAL BACKENDS ════════════════════════════════════════════════
 *
 * This app began as MyStockio's admin and grew into the vendor's admin for every
 * product they sell. Those products do not share a database, a deployment, or
 * even a shape: MyStockio has shops, licences and a payments ledger; MyTransport
 * has haulage companies on plans; MyClinic has practices, branches and per-branch
 * licences. Two backends serve the three of them.
 *
 * So the switcher is not cosmetic. Changing product changes **which server is
 * being talked to, how it authorises, what a "customer" is called, and which job
 * titles exist**. Everything that differs is listed here, once, so a screen can
 * ask this file rather than growing a chain of `if (product === …)`.
 *
 * ── Why the base URLs are constants and not environment variables ──────────────
 * An env value is invisible in the repo, absent from a fresh clone, baked into a
 * build nobody can inspect afterwards, and spelled three different ways across a
 * team. A committed constant is greppable and identical for everybody. Change one
 * and rebuild — the same arrangement `config.ts` already uses for MyStockio, and
 * the one MyClinic's own build spec asks for.
 */

import { normaliseOrigin, PROD_BASE_MYCLINIC, PROD_BASE_MYSTOCKIO, PROD_BASE_MYTRANSPORT } from './config'

export enum ProductId {
  MyStockio = 'mystockio',
  MyTransport = 'mytransport',
  MyClinic = 'myclinic',
}

/**
 * How a product's admin API decides the caller is the vendor.
 *
 * The two backends answer this differently and neither is wrong: MyStockio mints
 * a bearer token from an administrator account, MyTransport checks a shared
 * secret header because its admin surface has no accounts behind it at all.
 */
export type AdminAuth = 'bearer' | 'secret'

export interface Product {
  id: ProductId
  /** What the switcher shows. */
  label: string
  /** One line on what the product is, for the switcher's second row. */
  note: string
  /** Scheme and host only — the client appends the API path itself. */
  baseUrl: string
  auth: AdminAuth
  /**
   * The `module` value this product is on its backend, for the products that
   * share one. Absent for MyStockio, which has a deployment to itself.
   */
  module?: 'transport' | 'clinic'
  /** What a paying customer is called here. "Shop", "Company", "Practice". */
  tenantLabel: string
  /** Plural of the above, for headings. */
  tenantsLabel: string
  /** What a non-owner login is called. */
  staffLabel: string
  /**
   * Whether this product has a **payments ledger** — recorded amounts that add
   * up to revenue.
   *
   * Only MyStockio does. The other two record an *entitlement* (a plan, a licence
   * expiry) and nothing about money, so the money screens are hidden for them
   * rather than shown empty. A revenue chart reading ₹0 because the concept does
   * not exist is indistinguishable from one reading ₹0 because trade stopped.
   */
  hasPayments: boolean
}

export const PRODUCTS: Product[] = [
  {
    id: ProductId.MyStockio,
    label: 'MyStockio',
    note: 'Shops, licences and the money screens.',
    baseUrl: PROD_BASE_MYSTOCKIO,
    auth: 'bearer',
    tenantLabel: 'Shop',
    tenantsLabel: 'Shops',
    staffLabel: 'Staff login',
    hasPayments: true,
  },
  {
    id: ProductId.MyTransport,
    label: 'MyTransport',
    note: 'Haulage companies, their fleet logins and plan.',
    baseUrl: PROD_BASE_MYTRANSPORT,
    auth: 'secret',
    module: 'transport',
    tenantLabel: 'Company',
    tenantsLabel: 'Companies',
    staffLabel: 'Sub-login',
    hasPayments: false,
  },
  {
    id: ProductId.MyClinic,
    label: 'MyClinic',
    note: 'Practices, their branches and per-branch licences.',
    baseUrl: PROD_BASE_MYCLINIC,
    auth: 'secret',
    module: 'clinic',
    tenantLabel: 'Practice',
    tenantsLabel: 'Practices',
    staffLabel: 'Sub-login',
    hasPayments: false,
  },
]

export function productById(id: string): Product {
  /*
   * Falls back to MyStockio rather than throwing. This is read from a stored
   * preference, and a product removed between two releases would otherwise leave
   * the console unable to open at all — on a value nobody typed.
   */
  return PRODUCTS.find((product) => product.id === id) ?? PRODUCTS[0]
}

/** Everything served by one backend, so a screen can say so. */
export function sharesBackendWith(product: Product): Product[] {
  return PRODUCTS.filter(
    (other) => other.id !== product.id && normaliseOrigin(other.baseUrl) === normaliseOrigin(product.baseUrl),
  )
}
