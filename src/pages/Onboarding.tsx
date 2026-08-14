import { useState } from 'react'
import { Cloud, Users, LogOut } from 'lucide-react'
import { signIn, signUp, signOut, createHousehold, joinHousehold } from '../lib/session'
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
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
    setBusy(false)
  }
  return { busy, error, notice, setNotice, run }
}

function SignIn() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
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
          {notice && <p className="text-sm text-good-text">{notice}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !email.trim() || password.length < 6}>
            <Cloud size={16} /> {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
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
