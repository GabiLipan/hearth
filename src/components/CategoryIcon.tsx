/**
 * The icon set, for categories and for accounts.
 *
 * Grouped rather than one long strip, and searchable, because a flat run of
 * forty was already hard to choose from and this is two hundred. The groups are
 * how you browse when you do not know what you want; the search is for when you
 * do.
 *
 * ## Keys are permanent
 *
 * A key is what gets stored on the row — `icon: 'cart'` — and rows on the
 * server outlive any list here. So a key may be ADDED freely and must never be
 * renamed or removed: doing either turns every category using it into the
 * fallback tag, silently, on both devices. The forty-three keys the app shipped
 * with are all still here for exactly that reason, several of them in a group
 * they would not have been put in if they were new.
 *
 * Two keys never point at the same component. It is not a correctness problem,
 * but a picker offering the same picture twice looks broken, and there is no
 * way for anyone to tell which of the two they chose.
 */
import {
  Activity, Apple, ArrowLeftRight, Asterisk, Baby, Backpack, Bandage, Banknote, Bath,
  BatteryCharging, Bed, BedDouble, Beer, Bell, Bike, Bird, Bone, BookMarked, BookOpen, Bookmark,
  Brain, Briefcase, Brush, Bug, Building2, Bus, CakeSlice, Calculator, Calendar, Camera, Car,
  CarTaxiFront, Carrot, Cat, ChartLine, Check, ChefHat, Circle, CircleDot, CircleHelp,
  CircleParking, ClipboardList, Clock, Cloud, CloudRain, Coffee, Coins, Compass, CookingPot,
  CreditCard, Croissant, Crown, CupSoda, Dices, Dog, DoorOpen, Drama, Drill, Droplet, Dumbbell,
  Earth, Egg, Ellipsis, Eye, FileText, Film, Fish, Flag, Flame, Flower, Flower2, Folder,
  Footprints, Fuel, Gamepad2, Gem, Gift, Glasses, Globe, GraduationCap, Guitar, Hammer,
  HandCoins, HandPlatter, Handshake, HardHat, Hash, Headphones, Heart, HeartPulse, Hospital,
  House, IceCreamCone, IdCard, Infinity as InfinityIcon, Info, KeyRound, Lamp, Landmark, Laptop, Leaf,
  Lightbulb, Lock, Luggage, Mail, Map as MapGlyph, MapPin, Mic, Milk, Minus, Mountain, Music, Navigation,
  Package, PaintRoller, Paintbrush, Palette, PartyPopper, PawPrint, PenLine, Percent,
  PersonStanding, PiggyBank, Pill, Pizza, Plane, Plug, Plus, Popcorn, PoundSterling,
  Presentation, Printer, Puzzle, Rabbit, Radio, Receipt, ReceiptText, Recycle, Route, Salad,
  Sandwich, Scale, Scissors, Shield, ShieldCheck, Ship, Shirt, ShoppingBag, ShoppingBasket,
  ShoppingCart, Smartphone, Smile, Snowflake, Sofa, Sparkles, SprayCan, Sprout, Square, Star,
  Stethoscope, Store, Sun, Syringe, Tag, Target, Tent, Thermometer, Ticket, TrainFront,
  TramFront, Trash2, TreePalm, TreePine, TrendingDown, TrendingUp, Triangle, TriangleAlert,
  Trophy, Truck, Tv, Umbrella, User, UserPlus, Users, UsersRound, UtensilsCrossed, Vault,
  Wallet, WalletCards, WashingMachine, Watch, Waves, Weight, Wifi, Wind, Wine, Wrench, X, Zap,
  type LucideIcon,
} from 'lucide-react'

/*
 * `Map` and `Infinity` are imported under other names on purpose: Lucide
 * exports icons called exactly that, and importing them unaliased shadows the
 * GLOBALS of the same name for the whole module — which broke the `new Map()`
 * below with an error naming neither. Any future icon whose Lucide name is also
 * a JS global needs the same treatment.
 */

export interface IconGroup {
  name: string
  icons: Record<string, LucideIcon>
}

export const ICON_GROUPS: IconGroup[] = [
  {
    name: "Money",
    icons: {
      wallet: Wallet, coins: Coins, banknote: Banknote, card: CreditCard, piggy: PiggyBank,
      trending: TrendingUp, trendingDown: TrendingDown, receipt: Receipt,
      calculator: Calculator, vault: Vault, handCoins: HandCoins, pound: PoundSterling,
      percent: Percent, scales: Scale, bank: Landmark, transfer: ArrowLeftRight,
      bill: ReceiptText, chart: ChartLine, wallet2: WalletCards,
    },
  },
  {
    name: "Home",
    icons: {
      home: House, plug: Plug, wifi: Wifi, water: Droplet, gas: Flame, light: Lightbulb,
      heating: Thermometer, wrench: Wrench, hammer: Hammer, paint: PaintRoller, sofa: Sofa,
      bed: Bed, bath: Bath, laundry: WashingMachine, bin: Trash2, key: KeyRound,
      door: DoorOpen, insurance: ShieldCheck, tools: Drill, lamp: Lamp,
    },
  },
  {
    name: "Food",
    icons: {
      cart: ShoppingCart, dining: UtensilsCrossed, coffee: Coffee, beer: Beer, wine: Wine,
      pizza: Pizza, sandwich: Sandwich, iceCream: IceCreamCone, cake: CakeSlice,
      apple: Apple, carrot: Carrot, fish: Fish, egg: Egg, milk: Milk, pot: CookingPot,
      chef: ChefHat, popcorn: Popcorn, cup: CupSoda, bread: Croissant, salad: Salad,
      takeaway: HandPlatter, basket: ShoppingBasket,
    },
  },
  {
    name: "Transport",
    icons: {
      car: Car, bus: Bus, train: TrainFront, bike: Bike, fuel: Fuel, plane: Plane,
      taxi: CarTaxiFront, parking: CircleParking, ship: Ship, tram: TramFront, truck: Truck,
      road: Route, ticket: Ticket, pin: MapPin, navigate: Navigation,
      charge: BatteryCharging, helmet: HardHat,
    },
  },
  {
    name: "Shopping",
    icons: {
      bag: ShoppingBag, shirt: Shirt, shoe: Footprints, watch: Watch, glasses: Glasses,
      gem: Gem, gift: Gift, package: Package, store: Store, tag: Tag, scissors: Scissors,
      brush: Paintbrush, perfume: SprayCan, backpack: Backpack,
    },
  },
  {
    name: "Health",
    icons: {
      health: HeartPulse, pill: Pill, stethoscope: Stethoscope, dumbbell: Dumbbell,
      syringe: Syringe, brain: Brain, eye: Eye, bandage: Bandage, hospital: Hospital,
      spa: Flower2, yoga: PersonStanding, weight: Weight, activity: Activity,
    },
  },
  {
    name: "Leisure",
    icons: {
      fun: PartyPopper, music: Music, film: Film, tv: Tv, gamepad: Gamepad2, book: BookOpen,
      camera: Camera, palette: Palette, theatre: Drama, headphones: Headphones,
      guitar: Guitar, dice: Dices, puzzle: Puzzle, chess: Crown, trophy: Trophy, mic: Mic,
      radio: Radio, paint2: Brush, bowling: CircleDot,
    },
  },
  {
    name: "Work",
    icons: {
      work: Briefcase, education: GraduationCap, laptop: Laptop, printer: Printer,
      mail: Mail, phone: Smartphone, calendar: Calendar, clock: Clock,
      clipboard: ClipboardList, folder: Folder, file: FileText, pen: PenLine,
      building: Building2, present: Presentation, target: Target, team: Users, id: IdCard,
      handshake: Handshake,
    },
  },
  {
    name: "People",
    icons: {
      pet: PawPrint, baby: Baby, user: User, heart: Heart, dog: Dog, cat: Cat, bird: Bird,
      bone: Bone, smile: Smile, userPlus: UserPlus, family: UsersRound, rabbit: Rabbit,
    },
  },
  {
    name: "Travel",
    icons: {
      hotel: BedDouble, luggage: Luggage, globe: Globe, map: MapGlyph, compass: Compass,
      palm: TreePalm, mountain: Mountain, tent: Tent, sun: Sun, umbrella: Umbrella,
      passport: BookMarked, sea: Waves,
    },
  },
  {
    name: "Nature",
    icons: {
      plant: Sprout, tree: TreePine, leaf: Leaf, flower: Flower, cloud: Cloud,
      snow: Snowflake, rain: CloudRain, recycle: Recycle, earth: Earth, bug: Bug, wind: Wind,
    },
  },
  {
    name: "Symbols",
    icons: {
      sparkles: Sparkles, star: Star, flag: Flag, bookmark: Bookmark, bell: Bell, zap: Zap,
      shield: Shield, lock: Lock, infinity: InfinityIcon, circle: Circle, square: Square,
      triangle: Triangle, hash: Hash, asterisk: Asterisk, plus: Plus, minus: Minus,
      check: Check, cross: X, alert: TriangleAlert, question: CircleHelp, info: Info,
      more: Ellipsis,
    },
  },
]

/** Every icon, flattened. The order is the groups' order. */
export const CATEGORY_ICONS: Record<string, LucideIcon> = Object.fromEntries(
  ICON_GROUPS.flatMap((g) => Object.entries(g.icons)),
)

/** Order shown in the picker when nothing is being searched for. */
export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS)

/**
 * What a search matches against, per key.
 *
 * Derived rather than hand-written: the key, the group, and the Lucide
 * component name split on its capitals. That last one is doing most of the
 * work — searching "shopping" finds `cart`, `bag` and `basket` through
 * ShoppingCart / ShoppingBag / ShoppingBasket, none of which say "shopping" in
 * their key. A hand-kept synonym list would be better still and would rot the
 * first time somebody added an icon without updating it.
 */
const TERMS: Map<string, string> = new Map(
  ICON_GROUPS.flatMap((g) =>
    Object.entries(g.icons).map(([key, Ic]) => {
      const component = (Ic as { displayName?: string }).displayName ?? ''
      const words = component.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+/g, ' ')
      return [key, `${key} ${g.name} ${words}`.toLowerCase()] as const
    }),
  ),
)

/** Keys matching a query, in picker order. An empty query matches everything. */
export function searchIcons(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return CATEGORY_ICON_KEYS
  // Every word has to appear somewhere, so "food cup" narrows rather than
  // widens — the opposite of what a single `includes` over the joined query
  // would do.
  const words = q.split(/\s+/)
  return CATEGORY_ICON_KEYS.filter((key) => {
    const terms = TERMS.get(key) ?? key
    return words.every((w) => terms.includes(w))
  })
}

export function CategoryIcon({ icon, size = 18, className }: { icon?: string; size?: number; className?: string }) {
  const Ic = icon ? CATEGORY_ICONS[icon] : undefined
  if (Ic) return <Ic size={size} strokeWidth={2} className={className} aria-hidden />
  // Falls through when a transaction points at a category this device has not
  // pulled yet, or one the other person deleted.
  return <Tag size={size} strokeWidth={2} className={className} aria-hidden />
}
