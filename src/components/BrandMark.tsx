import { useId } from 'react'

/**
 * Hearth's mark: the mouth of a fireplace, lit from within, standing on a
 * hearthstone.
 *
 * Geometry is deliberate. The arch runs from y41 to y127 and the stone to y136,
 * putting the visual centre at 88.5 on a 180 tile — a couple of pixels above
 * the true centre, because a shape centred by measurement reads as sinking.
 * Both are centred on x90.
 *
 * Ids are per-instance so several marks can render on one page without their
 * gradients colliding.
 */
const ARCH = 'M52 127 V79 a38 38 0 0 1 76 0 v48 z'

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 180 180" className={className} aria-hidden role="img">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#2A2320" />
          <stop offset="1" stopColor="#14100E" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx="50%" cy="58%" r="62%">
          <stop offset="0" stopColor="#FFD08A" />
          <stop offset="0.42" stopColor="#F4813A" />
          <stop offset="1" stopColor="#C0361A" />
        </radialGradient>
        <filter id={`${id}b`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="13" />
        </filter>
        <clipPath id={`${id}c`}>
          <rect width="180" height="180" rx="40" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect width="180" height="180" fill={`url(#${id}bg)`} />
        {/* The fire spilling past the opening, so the glow reads as light rather than paint. */}
        <path d={ARCH} fill="#F4813A" opacity="0.55" filter={`url(#${id}b)`} />
        <path d={ARCH} fill={`url(#${id}glow)`} />
        <rect x="34" y="127" width="112" height="9" rx="4.5" fill="#F6E3CB" opacity="0.22" />
      </g>
    </svg>
  )
}
