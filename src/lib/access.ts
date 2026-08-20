/**
 * The invite code the backend expects on registration.
 *
 * Copied verbatim from MyStockio's `src/lib/legal.ts`, because it is the **same value the same
 * endpoint checks** — `api/v1/auth/register` is shared, so the two must not drift. If it changes on
 * the server, it changes in both places or account creation stops working in one of them.
 *
 * It is sent as `developerCode`. The server is meant to verify it; the client sending it is what
 * makes a server-side gate possible at all, but it is not itself the gate — this value ships in
 * every bundle that holds it.
 */
export const SIGNUP_ACCESS_KEY = 'Srikanta@123'
