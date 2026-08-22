/**
 * Which ink is legible on a coloured fill.
 *
 * Everything else in the app draws text on `--surface`, where the answer is
 * decided once by the theme. A category's colour as a FILL with its own name
 * written on it — the blocks view of a breakdown — is the first place where the
 * ground under a label is a different colour for every label, so the question
 * has to be asked per fill.
 *
 * It has to be asked at RUNTIME rather than written down beside the palette, and
 * the numbers say why: white loses to near-black on nine of the twelve slots in
 * the light theme and on eleven of twelve in the dark one, and the winner is not
 * the same slot in both. A hardcoded table would therefore be a table of two
 * themes' worth of exceptions — and it could not cover `lib/shade.ts` at all,
 * which invents lightnesses that were never in the palette to tell two
 * categories on one slot apart. `useChartColors` already resolves the tokens to
 * concrete hex, so the contrast is simply computable where it is needed.
 *
 * Where that leaves the palette, measured rather than assumed: with the ink
 * chosen per fill, the worst of the twenty-four palette colours is 4.76:1 and
 * the worst of their shaded variants is 4.68:1. So a label may be written
 * straight onto any fill in the palette, at full strength, with nothing between
 * the two — which is what `ink.test.ts` pins, and what makes the alternative
 * (a wash under the text) unnecessary as well as harmful. See `inkOn`.
 */

/** One channel, gamma-decoded. */
function channel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#rgb` or `#rrggbb` colour, or null. */
export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const raw = m[1]
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la == null || lb == null) return 1
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The two inks a fill can carry.
 *
 * Pure black and pure white rather than `--ink` and `--page`: this is text on a
 * saturated colour, where the theme's near-black and off-white are giving away
 * contrast for a softness that is invisible against a fill anyway.
 */
export const LIGHT_INK = '#ffffff'
export const DARK_INK = '#000000'

/**
 * Whether a label on this fill should be light or dark.
 *
 * There is deliberately nothing else here — no scrim, no wash, no shadow behind
 * the text. The first version had one, on the reasoning that a second line of
 * text set below full strength needs help; it was a 22% gradient over the bottom
 * two thirds of the block and it turned every fill into a gradient. Which is the
 * one thing colour on this palette may not do: a faded fill already MEANS
 * something in this app — a month that has not finished yet — and eight blocks
 * each fading towards their own foot read as eight partial figures.
 *
 * The hierarchy is weight instead, which costs no contrast at all: both lines
 * are the chosen ink at full strength, and the name is the semibold one.
 */
export function inkOn(fill: string): { color: string; dark: boolean } {
  const light = contrast(LIGHT_INK, fill)
  const dark = contrast(DARK_INK, fill)
  const useDark = dark > light
  return { color: useDark ? DARK_INK : LIGHT_INK, dark: useDark }
}

/* ---------- a badge drawn as a solid tile ---------- */

/**
 * The ink an account badge carries, chosen or measured.
 *
 * An account badge is a SOLID tile now, and the reason is a failure the tint it
 * replaced could not avoid. The old recipe derived both halves from one value —
 * the icon in the colour, on a 16% mix of that colour into the surface — which
 * is legible for the twelve palette slots, because each of those carries a
 * light-theme and a dark-theme step. A custom colour is one hex for both. So a
 * brand navy became a dark mark on a nearly-black tile the moment the app went
 * dark, and no amount of tuning the 16% saves it: the fill and the mark are the
 * same colour by construction, and in dark mode both are dark.
 *
 * A solid tile has no such failure. It is visible on any ground because it IS a
 * ground, and the mark on it is whichever of black or white measures better —
 * the same question `inkOn` already answers for a category's name written onto
 * its own colour, asked in the one other place the ground differs per badge.
 *
 * An explicit `ink` overrides it, and that exists for the one thing measurement
 * cannot reach: a brand mark in the brand's own colour on a pale tile. `inkOn`
 * of white is black, correctly, and "navy on white" is not a legibility
 * question but a decision. It is never the default, so an illegible pair can
 * only ever be deliberate — which the form measures with `contrast` and says
 * so about.
 */
export function faceInk(fill: string, ink?: string): string {
  return ink && luminance(ink) !== null ? ink : inkOn(fill).color
}

/**
 * How readable a chosen pair is, for a form that wants to say so.
 *
 * Not a veto. It is their app and their bank's colours, and a control that
 * refuses a pair somebody can see perfectly well on their own screen is worse
 * than one that mentions it. AA for large text and graphics is 3:1, which is
 * the right bar for a 19px mark rather than the 4.5:1 body text would want.
 */
export const GRAPHIC_CONTRAST = 3

/**
 * Whether a solid tile needs a hairline around it to be seen at all.
 *
 * The failure a free background introduces, and the only one it introduces: a
 * tile the colour of the card it sits on has no edge, so a white account badge
 * on the light theme is an icon floating in the middle of a row. Measured
 * rather than special-cased on white, because the same is true of the dark
 * theme's near-black and of anything close to either.
 *
 * The threshold is low on purpose. A ring on a tile that is merely PALE is
 * visible as a ring, and the tiles are meant to read as marks rather than as
 * outlined boxes; this fires only where there is essentially no edge to see.
 */
export const RING_BELOW = 1.25

export const needsRing = (fill: string, ground: string) => contrast(fill, ground) < RING_BELOW
