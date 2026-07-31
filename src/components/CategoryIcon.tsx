import {
  ShoppingCart, House, Car, UtensilsCrossed, ShoppingBag, Tv, HeartPulse, PartyPopper, Package, Wallet, Coins,
  Bus, Plane, Fuel, Coffee, Gift, Shirt, Dumbbell, Pill, Stethoscope, BookOpen, Music, Gamepad2, Film, PawPrint,
  Baby, GraduationCap, Plug, Wifi, Smartphone, CreditCard, PiggyBank, Banknote, TrendingUp, Heart, Sparkles,
  Sprout, Scissors, Wrench, Bike, TrainFront, BedDouble, Tag, type LucideIcon,
} from 'lucide-react'

/** Curated icon set for categories — friendly keys stored on Category.icon. */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  cart: ShoppingCart, home: House, car: Car, dining: UtensilsCrossed, bag: ShoppingBag, tv: Tv, health: HeartPulse,
  fun: PartyPopper, package: Package, wallet: Wallet, coins: Coins, bus: Bus, plane: Plane, fuel: Fuel,
  coffee: Coffee, gift: Gift, shirt: Shirt, dumbbell: Dumbbell, pill: Pill, stethoscope: Stethoscope, book: BookOpen,
  music: Music, gamepad: Gamepad2, film: Film, pet: PawPrint, baby: Baby, education: GraduationCap, plug: Plug,
  wifi: Wifi, phone: Smartphone, card: CreditCard, piggy: PiggyBank, banknote: Banknote, trending: TrendingUp,
  heart: Heart, sparkles: Sparkles, plant: Sprout, scissors: Scissors, wrench: Wrench, bike: Bike, train: TrainFront,
  hotel: BedDouble, tag: Tag,
}

/** Order shown in the category icon picker. */
export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS)

export function CategoryIcon({ icon, size = 18, className }: { icon?: string; size?: number; className?: string }) {
  const Ic = icon ? CATEGORY_ICONS[icon] : undefined
  if (Ic) return <Ic size={size} strokeWidth={2} className={className} aria-hidden />
  // Falls through when a transaction points at a category this device has not
  // pulled yet, or one the other person deleted.
  return <Tag size={size} strokeWidth={2} className={className} aria-hidden />
}
