import { useState } from 'react'
import { Cloud, Users, LogOut, KeyRound, MailCheck } from 'lucide-react'
import {
  signIn,
  signUp,
  signOut,
  createHousehold,
  joinHousehold,
  requestPasswordReset,
  resendConfirmation,
  setNewPassword,
} from '../lib/session'
import { useSyncState } from '../hooks/useSync'
import { BrandMark } from '../components/BrandMark'
import { Card, Segmented, Button, Field, TextInput } from '../components/ui'

/**
 * Sign in, then create or join a household.
 *
 * Creating a household is an explicit choice, not something that happens
 * quietly on first sign-in. The old client auto-provisioned one, which meant
 * someone who signed in and *then* entered their partner's invite code had
 * already been given an empty household of their own — and any data they had
 * entered in between was stranded in it.
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark size={44} />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Hearth</h1>
            <p className="text-sm text-ink-3">Money, kept between the people you choose.</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * What the provider said, in the app's own words.
 *
 * Supabase's messages are accurate and written for whoever is holding the API
 * docs — "Invalid login credentials" is not what somebody who has just mistyped
 * their password needs to read. Anything unrecognised is passed through
 * untouched rather than flattened into "something went wrong": a message nobody
 * anticipated is exactly the one worth showing verbatim.
 */
function readable(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'That email and password don’t match.'
  if (m.includes('email not confirmed')) return 'That address hasn’t been confirmed yet — check your inbox.'
  if (m.includes('user already registered')) return 'There is already an account with that address. Try signing in.'
  if (m.includes('password should be')) return 'That password is too short — six characters or more.'
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts just now. Wait a minute and try again.'
  if (m.includes('failed to fetch') || m.includes('networkerror')) return 'Can’t reach the server. Check your connection.'
  return message
}

function useRunner() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? readable(e.message) : 'Something went wrong')
    }
    setBusy(false)
  }
  return { busy, error, notice, setNotice, run }
}

function SignIn() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  /** The forgotten-password detour, which is a different question, not a third tab. */
  const [forgot, setForgot] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, notice, setNotice, run } = useRunner()

  const submit = () =>
    run(async () => {
      if (mode === 'signup') {
        await signUp(email.trim(), password)
        setNotice('Check your email for a confirmation link, then sign in.')
      } else {
        await signIn(email.trim(), password)
      }
    })

  if (forgot) return <ForgotPassword email={email} onEmail={setEmail} onBack={() => setForgot(false)} />

  return (
    <Shell>
      {/* A real form, so Enter signs in from either field and a password
          manager has a submission to recognise and offer to save. This screen
          is the first thing anybody touches, and it used to be the one place in
          the app where the obvious keystroke did nothing at all. */}
      <Card className="p-5">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && email.trim() && password.length >= 6) void submit()
          }}
        >
          <p className="text-sm text-ink-2">
            Your data lives in your own private database, and only you and whoever you invite can read it. Sign in to
            reach it from every device.
          </p>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'signin', label: 'Sign in' },
              { value: 'signup', label: 'Create account' },
            ]}
          />
          <Field label="Email">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 6 characters. Longer is better.' : undefined}>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder="••••••••"
            />
          </Field>
          {error && <p className="text-sm text-critical-text">{error}</p>}
          {/* Only where it is the actual problem. An unconfirmed address cannot
              be fixed by guessing at the password again, and until now the app
              said so without offering the one thing that would help. */}
          {error?.includes('hasn’t been confirmed') && (
            <button
              type="button"
              onClick={() =>
                run(async () => {
                  await resendConfirmation(email.trim())
                  setNotice('Sent. Check your inbox.')
                })
              }
              className="flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
            >
              <MailCheck size={14} /> Send that confirmation again
            </button>
          )}
          {notice && <p className="text-sm text-good-text">{notice}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !email.trim() || password.length < 6}>
            <Cloud size={16} /> {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
          {mode === 'signin' && (
            <button
              type="button"
              onClick={() => setForgot(true)}
              className="w-full text-center text-sm text-ink-3 hover:text-ink-2"
            >
              Forgotten your password?
            </button>
          )}
        </form>
      </Card>
    </Shell>
  )
}

/**
 * The way back in.
 *
 * A forgotten password used to be the end of the road: the data was intact on
 * the server and nothing in the app could reach it again.
 *
 * The confirmation is deliberately the same whether or not the address is one
 * we know. Anything else turns this box into a way of asking which of your
 * friends uses Hearth.
 */
function ForgotPassword({
  email,
  onEmail,
  onBack,
}: {
  email: string
  onEmail: (v: string) => void
  onBack: () => void
}) {
  const { busy, error, notice, setNotice, run } = useRunner()
  const sent = !!notice

  return (
    <Shell>
      <Card className="p-5">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || !email.trim()) return
            void run(async () => {
              await requestPasswordReset(email.trim())
              setNotice('If that address has an account, a link to set a new password is on its way.')
            })
          }}
        >
          <p className="text-sm text-ink-2">
            We’ll email you a link that lets you set a new one.
          </p>
          <Field label="Email">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => onEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </Field>
          {error && <p className="text-sm text-critical-text">{error}</p>}
          {notice && <p className="text-sm text-good-text">{notice}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !email.trim()}>
            <KeyRound size={16} /> {busy ? 'Sending…' : sent ? 'Send it again' : 'Send the link'}
          </Button>
          <button type="button" onClick={onBack} className="w-full text-center text-sm text-ink-3 hover:text-ink-2">
            Back to sign in
          </button>
        </form>
      </Card>
    </Shell>
  )
}

/**
 * Choosing a new password, having arrived on a recovery link.
 *
 * The link has already signed this device in, which is the part that makes a
 * screen necessary rather than optional: without it the recovery ends with
 * somebody looking at their own dashboard, still not knowing their password,
 * and with nothing anywhere offering to set one.
 */
export function NewPassword() {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const { busy, error, run } = useRunner()
  const mismatch = again.length > 0 && again !== password
  const ok = password.length >= 6 && password === again

  return (
    <Shell>
      <Card className="p-5">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (ok && !busy) void run(() => setNewPassword(password))
          }}
        >
          <p className="text-sm text-ink-2">Choose a new password for this account.</p>
          <Field label="New password" hint="At least 6 characters. Longer is better.">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="••••••••"
            />
          </Field>
          <Field label="Again">
            <TextInput
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              autoComplete="new-password"
              placeholder="••••••••"
            />
          </Field>
          {mismatch && <p className="text-sm text-critical-text">Those two don’t match.</p>}
          {error && <p className="text-sm text-critical-text">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={!ok || busy}>
            <KeyRound size={16} /> {busy ? 'Saving…' : 'Set password'}
          </Button>
        </form>
      </Card>
    </Shell>
  )
}

function ChooseHousehold() {
  const { email } = useSyncState()
  const [code, setCode] = useState('')
  const { busy, error, run } = useRunner()

  return (
    <Shell>
      <Card className="space-y-4 p-5">
        <p className="text-sm text-ink-2">
          Signed in as <span className="font-medium text-ink">{email}</span>. One last step.
        </p>

        <div className="space-y-2">
          <p className="text-sm font-medium">Starting fresh?</p>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => run(async () => void (await createHousehold()))}>
            <Users size={16} /> Create a household
          </Button>
          <p className="text-xs text-ink-3">
            You'll get an invite code to share with anyone whenever you're ready.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-ink-3">
          <span className="h-px flex-1 bg-hairline" /> or <span className="h-px flex-1 bg-hairline" />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Been given a code?</p>
          {/* A code is typed and then submitted, so Enter is the natural way to
              send it — the button is the alternative, not the only way. */}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy && code.trim().length >= 6) void run(async () => void (await joinHousehold(code)))
            }}
          >
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="INVITE CODE"
              className="flex-1 uppercase tracking-widest"
              autoComplete="one-time-code"
            />
            <Button type="submit" variant="subtle" disabled={busy || code.trim().length < 6}>
              Join
            </Button>
          </form>
        </div>

        {error && <p className="text-sm text-critical-text">{error}</p>}
        <button type="button" onClick={() => void signOut()} className="flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink-2">
          <LogOut size={14} /> Sign out
        </button>
      </Card>
    </Shell>
  )
}

export function Onboarding({ stage }: { stage: 'auth' | 'household' }) {
  return stage === 'auth' ? <SignIn /> : <ChooseHousehold />
}

/** Shown when the app has not been pointed at a Supabase project yet. */
export function NotConfigured() {
  return (
    <Shell>
      <Card className="space-y-2 p-5">
        <p className="text-sm font-medium">Not connected to a database yet</p>
        <p className="text-sm text-ink-2">
          Copy <code className="rounded bg-surface-2 px-1">.env.example</code> to{' '}
          <code className="rounded bg-surface-2 px-1">.env</code> and fill in your Supabase project URL and publishable
          key, then restart the dev server.
        </p>
      </Card>
    </Shell>
  )
}

export function Splash() {
  return (
    <Shell>
      <p className="text-center text-sm text-ink-3">Opening…</p>
    </Shell>
  )
}
