/**
 * Bank and card-brand marks, drawn in the icon set's own hand.
 *
 * The rest of the picker is Lucide, which has no brands in it at all — so an
 * account for the Amex or the Halifax current account had to wear a generic
 * card or a generic bank building, which is exactly the moment a list of eight
 * accounts stops being scannable.
 *
 * ## These are evocations, not logos
 *
 * Every one of these is a simplified line drawing in the same 24×24, 2px,
 * round-capped stroke as everything beside it: the SHAPE the brand is known by
 * — Mastercard's two circles, NatWest's three cubes, the Halifax X — and never
 * a traced copy of the artwork, a wordmark, or a brand colour. That is the
 * point rather than a shortcut. A real logo dropped into this grid would be the
 * one flat, full-colour, differently-weighted thing among two hundred strokes,
 * and it would take a category's palette colour (`Face` paints the icon in the
 * slot colour) and look broken doing it. Drawing them as strokes makes them
 * members of the set, and it keeps the app clear of anybody's trade dress.
 *
 * The shapes were checked against the real marks rather than drawn from memory:
 * Simple Icons (CC0) has nine of these, and comparing at 19px — the size `Face`
 * actually renders an icon at — is what caught Barclays' eagle being a moth,
 * Monzo's M being a tile, Starling's swirl being a gull and HSBC's hexagon
 * pointing the wrong way. It is not a dependency, and it cannot be: it has no
 * Lloyds, Halifax, Bank of Scotland, NatWest, RBS, Santander or Nationwide —
 * the whole British high street — and the marks it does have for Visa, Amex and
 * Discover are wordmarks, which at this size are a smudge. Where a brand has no
 * symbol at all, the drawing here is a stand-in (Visa's V, Amex's boxed A)
 * rather than a claim to be the logo.
 *
 * The same rule that governs the rest of the registry governs these: **a key is
 * permanent.** A bank that renames itself gets its label changed and keeps its
 * key, because the key is what is written on rows in the database.
 *
 * `displayName` is load-bearing here and not merely tidy — `CategoryIcon`'s
 * search terms are derived from it, so it is what makes "american express" find
 * `amex` and "royal bank" find `rbs`. Write the words somebody would actually
 * type, not the component's name.
 */
import type { ComponentType, SVGProps } from 'react'

/**
 * What the registry can hold.
 *
 * Lucide's own components satisfy this, so the two kinds sit in one record and
 * every call site — the picker, `Face`, `CategoryIcon` — stays unaware of which
 * it has.
 */
export type IconComponent = ComponentType<{
  size?: number | string
  strokeWidth?: number | string
  className?: string
  'aria-hidden'?: boolean
}>

type MarkProps = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }

/**
 * The shared frame. Every mark below is paths only, so the viewBox, the stroke
 * and the joins are stated once and cannot drift from Lucide's — which is what
 * makes an Amex sit next to a coffee cup without either looking wrong.
 */
function Mark({ size = 24, strokeWidth = 2, children, ...rest }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ── Card networks ─────────────────────────────────────────────────────── */

/** Two interlocking circles. */
export const MastercardMark = (p: MarkProps) => (
  <Mark {...p}>
    <circle cx="9" cy="12" r="6.5" />
    <circle cx="15" cy="12" r="6.5" />
  </Mark>
)
MastercardMark.displayName = 'Mastercard Debit Credit Card'

/** The V, with the flash over it. */
export const VisaMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M4.5 8.5 11.75 19 19 8.5" />
    <path d="M14 4.4c1.8-1.1 3.6-1.1 5.5 0" />
  </Mark>
)
VisaMark.displayName = 'Visa Debit Credit Card'

/** The boxed frame, with an A in it. */
export const AmexMark = (p: MarkProps) => (
  <Mark {...p}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
    <path d="M9 15.5 12 8.5l3 7" />
    <path d="M10.2 13h3.6" />
  </Mark>
)
AmexMark.displayName = 'Amex American Express Card'

/** One P behind another. */
export const PaypalMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M5 20.5V3.5h4.6a4 4 0 0 1 0 8H5.6" />
    <path d="M10.5 20.5V8.5h4a4 4 0 0 1 0 8h-3.4" />
  </Mark>
)
PaypalMark.displayName = 'Paypal Wallet Online Payment'

/** The four waves. */
export const ContactlessMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M7 9a5 5 0 0 1 0 6" />
    <path d="M11 7.5a8 8 0 0 1 0 9" />
    <path d="M15 6a11 11 0 0 1 0 12" />
    <path d="M19 4.5a14 14 0 0 1 0 15" />
  </Mark>
)
ContactlessMark.displayName = 'Contactless Tap Card Payment'

/** A card with its chip, for a card that is not any particular brand. */
export const ChipCardMark = (p: MarkProps) => (
  <Mark {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <rect x="5" y="9" width="6" height="5" rx="1" />
    <path d="M8 9v5" />
    <path d="M15 16h4" />
  </Mark>
)
ChipCardMark.displayName = 'Chip Card Debit Credit Bank'

/** A cash machine. */
export const AtmMark = (p: MarkProps) => (
  <Mark {...p}>
    <rect x="4" y="2.5" width="16" height="19" rx="2.5" />
    <rect x="7" y="6" width="10" height="5" rx="1" />
    <path d="M7.5 15h9" />
    <path d="M7.5 18h4.5" />
  </Mark>
)
AtmMark.displayName = 'Atm Cashpoint Cash Machine Withdrawal'

/** A cheque, signed. */
export const ChequeMark = (p: MarkProps) => (
  <Mark {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M5.5 9h7" />
    <path d="M5.5 12.5h4.5" />
    <path d="M12.5 16.2c1-1.8 2-1.8 3 0s2 1.8 3 0" />
  </Mark>
)
ChequeMark.displayName = 'Cheque Check Paying In'

/* ── Banks ─────────────────────────────────────────────────────────────── */

/** The horse, rearing. */
export const LloydsMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M4.4 12.2 7 9.4l4.4-2.6 1-3.2 1.6 2.6 1.6-1.6v3.2c1.8 1.8 2.6 4.2 2.4 6.8L17.2 21h-7c-.6-3-.8-4.6-1.8-5.8-1.2-.6-2.8-1.4-4-3z" />
    <path d="M10.6 10.2h.01" />
  </Mark>
)
LloydsMark.displayName = 'Lloyds Bank Horse'

/** The X. */
export const HalifaxMark = (p: MarkProps) => (
  <Mark {...p}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="3" />
    <path d="M8 8l8 8" />
    <path d="M16 8l-8 8" />
  </Mark>
)
HalifaxMark.displayName = 'Halifax Bank Cross'

/** The saltire, on a shield. */
export const BankOfScotlandMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M12 21.5c-4.3-1.8-7-5.4-7-9.6V5.2l7-2.7 7 2.7v6.7c0 4.2-2.7 7.8-7 9.6z" />
    <path d="M8.5 8.5l7 7" />
    <path d="M15.5 8.5l-7 7" />
  </Mark>
)
BankOfScotlandMark.displayName = 'Bank Of Scotland Saltire Shield'

/** The three cubes. */
export const NatwestMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M12 3l3.2 3.2L12 9.4 8.8 6.2z" />
    <path d="M7.2 12.6l3.2 3.2-3.2 3.2L4 15.8z" />
    <path d="M16.8 12.6l3.2 3.2-3.2 3.2-3.2-3.2z" />
  </Mark>
)
NatwestMark.displayName = 'Natwest National Westminster Bank Cubes'

/** The daisy wheel. */
export const RbsMark = (p: MarkProps) => (
  <Mark {...p}>
    <circle cx="12" cy="8" r="3.4" />
    <circle cx="12" cy="16" r="3.4" />
    <circle cx="8" cy="12" r="3.4" />
    <circle cx="16" cy="12" r="3.4" />
  </Mark>
)
RbsMark.displayName = 'Rbs Royal Bank Of Scotland Daisy'

/** The hexagon, with its bowtie. */
export const HsbcMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M7.4 3.6h9.2L22 12l-5.4 8.4H7.4L2 12z" />
    <path d="M7.4 3.6 12 12l4.6-8.4" />
    <path d="M7.4 20.4 12 12l4.6 8.4" />
  </Mark>
)
HsbcMark.displayName = 'Hsbc Bank Hexagon'

/** The eagle, wings spread. */
export const BarclaysMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M11.2 8.6C8.4 7.2 5.2 7 2.2 8.2c1.6 3.5 4.6 5.7 8.8 6.5z" />
    <path d="M12.8 8.6c2.8-1.4 6-1.6 9-.4-1.6 3.5-4.6 5.7-8.8 6.5z" />
    <path d="M12 7.2v10" />
    <path d="M10.2 17.2 12 21.2l1.8-4" />
    <circle cx="12" cy="5.2" r="1.5" />
    <path d="M10.4 5.4 8.4 5.8" />
  </Mark>
)
BarclaysMark.displayName = 'Barclays Bank Eagle'

/** The flame. */
export const SantanderMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M12 2.5c3.1 4.2 4.6 7.3 4.6 9.5s-1.5 5.3-4.6 9.5c-3.1-4.2-4.6-7.3-4.6-9.5s1.5-5.3 4.6-9.5z" />
    <path d="M12 2.5c-1.2 4.2-1.8 7.3-1.8 9.5s.6 5.3 1.8 9.5" />
  </Mark>
)
SantanderMark.displayName = 'Santander Bank Flame'

/** The arch. */
export const NationwideMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M4.5 20v-6.5a7.5 7.5 0 0 1 15 0V20" />
    <path d="M9 20v-6.5a3 3 0 0 1 6 0V20" />
    <path d="M2.5 20h19" />
  </Mark>
)
NationwideMark.displayName = 'Nationwide Building Society Arch'

/** The octagon, turning. */
export const ChaseMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z" />
    <rect x="9.2" y="9.2" width="5.6" height="5.6" />
  </Mark>
)
ChaseMark.displayName = 'Chase Bank Octagon'

/** The rounded tile, with its m. */
export const MonzoMark = (p: MarkProps) => (
  <Mark {...p}>
    <path d="M3.5 20V4.6l8.5 8.6 8.5-8.6V20" />
  </Mark>
)
MonzoMark.displayName = 'Monzo Bank App'

/** The bird, in the circle. */
export const StarlingMark = (p: MarkProps) => (
  <Mark {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M15.2 8.4c-1.1-1.1-2.9-1.3-4.2-.4-1.5 1-1.6 3.1-.2 4.2l2.4 1.8c1.4 1.1 1.3 3.2-.2 4.2-1.3.9-3.1.7-4.2-.4" />
  </Mark>
)
StarlingMark.displayName = 'Starling Bank Bird App'
