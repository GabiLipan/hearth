import { Home, User, Layers, type LucideIcon } from 'lucide-react'
import { BOOK_HINT, type BookId } from '../lib/books'
import { Segmented } from './ui'

/**
 * Three options and a month stepper do not fit "Our household" across a phone,
 * and a wrapped option breaks the control: the sliding thumb takes an equal
 * share of the width arithmetically, so a two-line label makes the track taller
 * than the thumb and the selection stops covering what it selected.
 *
 * The short form is not an abbreviation so much as the same idea in fewer words.
 */
const BOOKS: { id: BookId; icon: LucideIcon; short: string; long: string }[] = [
  // Not BOOK_LABEL: every option is an equal third of the track, so the LONGEST
  // label sets the width the whole control needs. "Our household" made that
  // width bigger than a toolbar can spare, and the label was clipped mid-word
  // rather than overflowing — which looks like a rendering fault rather than a
  // space problem. "Household" is the same idea and fits.
  { id: 'household', icon: Home, short: 'Ours', long: 'Household' },
  { id: 'mine', icon: User, short: 'Mine', long: 'Mine' },
  { id: 'all', icon: Layers, short: 'All', long: 'Everything' },
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
      options={BOOKS.map(({ id, icon: Icon, short, long }) => ({
        value: id,
        label: (
          <span className="flex items-center justify-center gap-1.5" title={BOOK_HINT[id]}>
            <Icon size={14} className="shrink-0" />
            <span className="md:hidden">{short}</span>
            <span className="hidden md:inline">{long}</span>
          </span>
        ),
      }))}
    />
  )
}
