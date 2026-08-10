/**
 * The practice's identity, in one place.
 *
 * Mirrors branding.py on the backend, which owns the copy printed on referral
 * PDFs. Kept as one module so renaming the practice is a single edit rather
 * than a hunt through the rail, the login screen and the page title.
 *
 * VITE_PRACTICE_NAME overrides it at build time, matching the backend's
 * PRACTICE_NAME environment variable, so a second practice deploying this needs
 * no code change.
 */
const DEFAULT_PRACTICE_NAME = 'Passion Dental';

/** A blank override is a misconfiguration, not a request for no name. */
export const PRACTICE_NAME =
  import.meta.env?.VITE_PRACTICE_NAME?.trim() || DEFAULT_PRACTICE_NAME;

/** What the product does, shown under the name on the sign-in card. */
export const PRACTICE_TAGLINE = 'Third molar review portal';

/**
 * The monogram on the rail and sign-in tiles: first letters of the first two
 * words, so "Passion Dental" reads as PD rather than a bare P.
 */
export const PRACTICE_INITIALS = PRACTICE_NAME
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((word) => word[0])
  .join('')
  .toUpperCase();
