import type { HouseholdMember } from '../lib/db'
import { cx } from './ui'

/**
 * Somebody's face, or their initials.
 *
 * A household is small enough that a name alone identifies everyone, so the
 * picture is decoration — which is why a missing one falls back to initials
 * rather than to a generic silhouette that tells you nothing.
 */

/** "Anna Kaminska" → "AK", "gabi" → "G". Never more than two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * A display name that is always something.
 *
 * `??` is not enough: a `display_name` of `''` is falsy but not nullish, and
 * that is exactly what an account created before the name backfill carried —
 * which is how the permissions list came to show two blank rows.
 */
export function nameOf(member?: Pick<HouseholdMember, 'displayName'>): string {
  return member?.displayName?.trim() || 'Someone'
}

export function PersonDot({
  member,
  size = 28,
  className,
}: {
  member?: Pick<HouseholdMember, 'displayName' | 'avatarUrl'>
  size?: number
  className?: string
}) {
  const name = nameOf(member)
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 font-medium text-ink-2',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {member?.avatarUrl ? (
        <img src={member.avatarUrl} alt="" className="size-full object-cover" />
      ) : (
        initialsOf(name)
      )}
    </span>
  )
}
