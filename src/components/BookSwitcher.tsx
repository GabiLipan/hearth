import { Home, User, Layers, type LucideIcon } from 'lucide-react'
import { BOOK_HINT, BOOK_LABEL, type BookId } from '../lib/books'
import { Segmented } from './ui'

/**
 * Three options and a month stepper still do not fit "Our household" across a
 * phone, however the widths are shared out, so there is a short form under
 * `md`. It is not an abbreviation so much as the same idea in fewer words.
 */
const BOOKS: { id: BookId; icon: LucideIcon; short: string }[] = [
  // The long labels are BOOK_LABEL. They fit because `Segmented` sizes each
  // option to its own content now: "Our household" being wider than "Mine" is
  // simply what it is, rather than forcing all three to be that wide.
  { id: 'household', icon: Home, short: 'Ours' },
  { id: 'mine', icon: User, short: 'Mine' },
  { id: 'all', icon: Layers, short: 'All' },
]

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
      options={BOOKS.map(({ id, icon: Icon, short }) => ({
        value: id,
        label: (
          <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT[id]}>
            <Icon size={14} className="shrink-0" />
            <span className="md:hidden">{short}</span>
            <span className="hidden md:inline">{BOOK_LABEL[id]}</span>
          </span>
        ),
      }))}
    />
  )
}
