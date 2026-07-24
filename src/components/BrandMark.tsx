import { useId } from 'react'

/**
 * Hearth's mark: a warm flame-droplet of light held in a cool glass squircle —
 * warmth at the heart of home, rendered liquid-glass. Ids are per-instance so
 * several marks can render on one page without gradient collisions.
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  const drop = 'M90 50 C110 78 118 94 118 112 a28 28 0 0 1 -56 0 c0 -16 8 -34 28 -62 z'
  return (
    <svg width={size} height={size} viewBox="0 0 180 180" className={className} aria-hidden role="img">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#eef1f6" />
          <stop offset="1" stopColor="#ccd4e2" />
        </linearGradient>
        <radialGradient id={`${id}d`} cx="42%" cy="33%" r="80%">
          <stop offset="0" stopColor="#ffe7ad" />
          <stop offset="0.4" stopColor="#ff9d4d" />
          <stop offset="1" stopColor="#ef4e3a" />
        </radialGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="0.22" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <clipPath id={`${id}c`}>
          <rect width="180" height="180" rx="44" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect width="180" height="180" fill={`url(#${id}g)`} />
        <path d={drop} fill="#ff7a45" opacity="0.35" filter={`url(#${id}b)`} />
        <path d={drop} fill={`url(#${id}d)`} />
        <ellipse cx="79" cy="99" rx="8" ry="13" fill="#fff" opacity="0.5" />
        <path d="M0 0 h180 v54 q-90 24 -180 0 z" fill={`url(#${id}s)`} />
      </g>
      <rect x="1" y="1" width="178" height="178" rx="43" fill="none" stroke="#fff" strokeOpacity="0.55" />
    </svg>
  )
}
