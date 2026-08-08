import { Home, User, Layers } from 'lucide-react'
import { BOOK_HINT, BOOK_LABEL, type BookId } from '../lib/books'
import { Segmented } from './ui'

/**
 * Which set of books this page is showing.
 *
 * A lens, not a filter. "Our household" and "Mine" are not two subsets of one
 * total — they are two different accounts of what happened, and the numbers in
 * them are not meant to add up to each other. `Everything` is kept because
 * balances across the lot are a real question, and because it is what every
 * screen used to show; taking it away would make figures people recognise
 * disappear with no way back to them.
 */
export function BookSwitcher({
  book,
  onChange,
  className,
}: {
  book: BookId
  onChange: (next: BookId) => void
  className?: string
}) {
  return (
    <Segmented
      value={book}
      onChange={onChange}
      className={className}
      options={[
        {
          value: 'household' as BookId,
          label: (
            <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT.household}>
              <Home size={14} /> {BOOK_LABEL.household}
            </span>
          ),
        },
        {
          value: 'mine' as BookId,
          label: (
            <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT.mine}>
              <User size={14} /> {BOOK_LABEL.mine}
            </span>
          ),
        },
        {
          value: 'all' as BookId,
          label: (
            <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT.all}>
              <Layers size={14} /> {BOOK_LABEL.all}
            </span>
          ),
        },
      ]}
    />
  )
}
