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

/* ---------- bending a colour until it is legible ---------- */

/**
 * A colour as OKLCh, and back again.
 *
 * The palette is cut in OKLCh — twelve hues at one lightness — so this is the
 * space the app already thinks in, and it is the only one where "the same
 * colour, lighter" means what it says: moving lightness in sRGB drags
 * saturation with it, and moving it in HSL makes a yellow and a blue of the
 * same nominal lightness look nothing like it. The transform is Björn
 * Ottosson's, spelled out rather than reached for through a library, because it
 * is twenty lines and it runs per account per paint.
 */
type Oklch = { l: number; c: number; h: number }

const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

/** `#rgb` or `#rrggbb` as three 0..1 sRGB channels, or null. */
function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const raw = m[1]
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
}

const hexOf = (rgb: [number, number, number]) =>
  '#' +
  rgb
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
    .join('')

function toOklch(hex: string): Oklch | null {
  const rgb = rgbOf(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(decode)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) }
}

/** OKLCh back to sRGB, unclamped — the caller decides what out of gamut means. */
function toRgb({ l, c, h }: Oklch): [number, number, number] {
  const A = Math.cos(h) * c
  const B = Math.sin(h) * c
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    encode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    encode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    encode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ]
}

const inGamut = (rgb: [number, number, number]) => rgb.every((c) => c >= -0.001 && c <= 1.001)

/**
 * The same hue at a different lightness, kept inside sRGB.
 *
 * A hue at full chroma does not exist at every lightness — there is no
 * near-black saturated yellow — so a lightness that lands outside the gamut has
 * its chroma bisected down until it fits, rather than being clamped channel by
 * channel, which changes the hue and can undo the lightness move it was asked
 * for.
 */
export function withLightness(hex: string, l: number): string | null {
  const base = toOklch(hex)
  if (!base) return null
  const want = { ...base, l: Math.min(1, Math.max(0, l)) }
  if (inGamut(toRgb(want))) return hexOf(toRgb(want))
  let lo = 0
  let hi = want.c
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(toRgb({ ...want, c: mid }))) lo = mid
    else hi = mid
  }
  return hexOf(toRgb({ ...want, c: lo }))
}

/**
 * The same colour, moved just far enough in lightness to be seen on a ground.
 *
 * "Just far enough" rather than "as far as it takes to be safe": the colour is
 * carrying an identity — this account's own colour, beside a badge painted in
 * it — so every step away from it is a step towards a line that no longer says
 * whose it is. The direction is whichever of black and white is further from
 * the ground, which is the theme asked as a measurement rather than as a flag,
 * and the distance is bisected because contrast against a fixed ground is
 * monotone along it.
 *
 * It can fail to reach `min` and says so by handing back the best it managed:
 * a mid-grey ground has no colour at 3:1 against it, and a line drawn in the
 * closest thing available is better than no line and better than a lie.
 */
export function bendToContrast(hex: string, ground: string, min: number): string {
  if (contrast(hex, ground) >= min) return hex
  const base = toOklch(hex)
  if (!base) return hex
  // Away from the ground: the end of the lightness axis that is further from it
  // is the one there is room to travel towards.
  const target = contrast(DARK_INK, ground) > contrast(LIGHT_INK, ground) ? 0 : 1
  let lo = base.l
  let hi = target
  let best = hex
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const candidate = withLightness(hex, mid)
    if (!candidate) break
    if (contrast(candidate, ground) >= min) {
      best = candidate
      hi = mid
    } else lo = mid
  }
  // Nothing along the way cleared the bar, so the far end is the best there is.
  if (best === hex) best = withLightness(hex, target) ?? hex
  return best
}

/**
 * Which of a face's two colours to draw a line in beside it, and how to rescue
 * it when neither will do.
 *
 * An account badge is a solid tile with a mark on it, and until now the line
 * beside it was always painted in the tile. That is right for a palette slot,
 * which is cut to sit at 3.4–4.0:1 against `--surface` — and wrong for the
 * colours people actually reach for a custom colour to get: a bank's white card
 * is a white line on a white row, and its navy is invisible in the dark theme.
 * The mark is the other colour already on the badge and is chosen, by `faceInk`
 * or by measurement, to be legible on the tile — which on a pale tile makes it
 * the dark half of the pair and exactly what the row needs.
 *
 * The tile wins whenever it CLEARS the bar rather than whenever it is ahead,
 * and the difference is the whole feature: the mark is usually black or white,
 * so "whichever measures better" is a comparison black wins on every row in the
 * light theme, and a card of black lines is legible and says nothing. The mark
 * is a rescue, taken only where the tile has failed and the mark has not. Where
 * neither reaches `min` — two mid-tones, or a tile the colour of the row — the
 * better of them is bent in lightness until it does, which spends the part of
 * the colour that is not carrying the identity and keeps the part that is.
 */
export function lineOn(fill: string, mark: string, ground: string, min = GRAPHIC_CONTRAST): string {
  if (contrast(fill, ground) >= min) return fill
  const best = contrast(mark, ground) > contrast(fill, ground) ? mark : fill
  return bendToContrast(best, ground, min)
}
