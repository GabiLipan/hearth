import { displayName, reference } from '../lib/rules'
import { cx } from './ui'

/**
 * What a transaction is called, and — muted, after it — what the bank called it.
 *
 * One component rather than the same two spans written out in nine places,
 * because the pair has a rule and the rule is easy to get half right: the name
 * is `title` where there is one and the payee otherwise, and the reference is
 * shown ONLY where it is not already the name. A list that printed both
 * unconditionally would say "Tesco Tesco" on every row nobody has renamed.
 *
 * The muted half is never truncated separately: both live inside one truncating
 * line, so a narrow card loses the end of the reference rather than wrapping to
 * a second row and making every row a different height.
 */
export function TxnName({
  txn,
  className,
}: {
  txn: { payee: string; title?: string }
  className?: string
}) {
  const ref = reference(txn)
  return (
    <span className={cx('min-w-0 truncate', className)}>
      {displayName(txn)}
      {ref && <span className="ml-1.5 font-normal text-ink-3">{ref}</span>}
    </span>
  )
}
