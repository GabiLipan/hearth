import { Home, User, Layers, Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { BOOK_HINT, BOOK_LABEL, type BookId } from '../lib/books'
import { useBook } from '../lib/cache'
import { Popover, cx } from './ui'
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

/**
 * The same lens, in the phone's header.
 *
 * It is one setting for the whole app — `useBook` is a single value with
 * subscribers, not a copy per screen — so drawing it inside each page was a
 * claim the app never meant, and an expensive one: a full-width 44px row on six
 * pages, and on Home, Bills and Goals it WAS the toolbar. In the header it is
 * both cheaper and more findable, because it is the one control that is now
 * always in the same place.
 *
 * Tinted rather than plain, so "you are looking at your own money" reads
 * without opening anything — which is the whole job of a lens indicator.
 *
 * Phone only. A wide screen keeps the segmented control in the page: it has the
 * room, all three options are visible at once there, and hiding two of them
 * behind a menu would be a downgrade bought with space nobody needed.
 */
export function BookLens() {
  const [book, setBook] = useBook()
  const current = BOOKS.find((b) => b.id === book) ?? BOOKS[0]
  const Icon = current.icon

  return (
    <Popover
      align="right"
      width="w-56"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label={`Showing ${BOOK_LABEL[book]}`}
          className="flex h-8 items-center gap-1.5 rounded-full bg-accent/12 px-2.5 text-sm font-semibold text-accent"
        >
          <Icon size={14} className="shrink-0" />
          {current.short}
          <ChevronDown size={13} className={cx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
        </button>
      )}
    >
      {(close) => (
        <div>
          {BOOKS.map(({ id, icon: Each }) => (
            <button
              key={id}
              onClick={() => {
                setBook(id)
                close()
              }}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <Check size={15} className={cx('mt-0.5 shrink-0', id === book ? 'text-accent' : 'opacity-0')} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Each size={14} className="shrink-0 text-ink-3" />
                  {BOOK_LABEL[id]}
                </span>
                <span className="mt-0.5 block text-xs text-ink-3">{BOOK_HINT[id]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}
