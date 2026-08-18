/**
 * The customer-facing URL of a waitlist offer.
 *
 * One line, in a file of its own, because both ends of an offer need it and
 * neither may import the other: waitlist.matcher.ts puts this address in the
 * email, and publicWaitlist.service.ts answers the request that email produces.
 * A helper on either side would be an import cycle through waitlist.service.ts.
 *
 * The invariant it holds is that the two agree. An offer email whose link does
 * not resolve to a claimable offer is worse than no email at all — the customer
 * is told a slot is theirs, finds nothing at the other end, and the hold lapses
 * while they wait.
 */
import { env } from '../../config/env';

/**
 * The page an offered customer lands on, addressed by the entry's opaque
 * `wlt_…` handle exactly as an appointment's manage page is addressed by its
 * `apt_…` one. The claim itself is a POST from that page, so the address stays
 * safe to put in an email: opening it shows the offer, it does not accept it.
 *
 * `PUBLIC_APP_URL` may or may not carry a trailing slash, so it is trimmed —
 * without that, a configured `https://app.example.com/` yields `//waitlist/…`,
 * which most routers treat as a different path and some proxies drop entirely.
 */
export function waitlistOfferUrl(publicId: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/+$/, '')}/waitlist/${publicId}`;
}
