'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = safeNext(params.get('next'))
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.auth
      .session()
      .then((s) => {
        if (!s.required || s.authenticated) router.replace(next)
      })
      .catch(() => undefined)
  }, [router, next])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.auth.login({ password })
      router.replace(next)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong password' : errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-4">
        <h1 className="text-lg font-medium">Valet</h1>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy || password.length === 0}>
          Sign in
        </Button>
      </form>
    </div>
  )
}
