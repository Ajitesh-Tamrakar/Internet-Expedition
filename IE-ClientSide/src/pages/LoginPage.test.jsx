// @vitest-environment jsdom
/**
 * Tests for the login page (planning section 4) against its acceptance
 * criteria: a valid login leads to Search, invalid credentials show a
 * clear error, an unverified account follows the supported email-
 * verification flow (on the same page), the signup link works, the
 * forgot-password option requests a reset link, and no result — success,
 * failure, or network — leaves the form in a broken loading state.
 *
 * The auth module is mocked at its surface (useAuth): the page consumes
 * only the service's result objects, whose shapes are the contract
 * documented in src/auth/authService.js.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import LoginPage from './LoginPage'

const mockActions = vi.hoisted(() => ({
  login: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock('../auth', () => ({
  useAuth: () => ({
    status: 'unauthenticated',
    user: null,
    sessionToken: null,
    isAuthenticated: false,
    isAuthLoading: false,
    actions: mockActions,
  }),
}))

// Result shapes as the auth service produces them.
function authenticated(email) {
  return {
    ok: true,
    status: 'authenticated',
    user: { email },
    sessionToken: 'st-live',
  }
}
function pending(email) {
  return {
    ok: false,
    status: 'verification_pending',
    email,
    sessionToken: 'st-verify',
    error: new Error(
      'This account still needs to verify its email address. Enter the code we just emailed you.'
    ),
  }
}
function fail(status, message) {
  return { ok: false, status, error: new Error(message) }
}

function renderAtLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<div>SIGNUP_MARKER</div>} />
        <Route path="/search" element={<div>SEARCH_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillCredentials(user, { email = 'ada@example.com', password = 'hunter2-secret' } = {}) {
  await user.type(screen.getByLabelText(/^email$/i), email)
  await user.type(screen.getByLabelText(/^password$/i), password)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

describe('the login form', () => {
  it('shows email + password, a Login button, a signup link, and a Forgot password option', () => {
    renderAtLogin()

    expect(screen.getByRole('heading', { name: /log in/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^login$/i })).toBeInTheDocument()
    const signupLink = screen.getByRole('link', { name: /sign up/i })
    expect(signupLink).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument()
  })

  it('blocks an empty submission with field errors and makes no request', async () => {
    const user = userEvent.setup()
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password is required.')).toBeInTheDocument()
    expect(mockActions.login).not.toHaveBeenCalled()
  })

  it('rejects an invalid email client-side without a round-trip', async () => {
    const user = userEvent.setup()
    renderAtLogin()

    await user.type(screen.getByLabelText(/^email$/i), 'not-an-email')
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2-secret')
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(mockActions.login).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Login outcomes
// ---------------------------------------------------------------------------

describe('login outcomes', () => {
  it('leads a valid login to Search', async () => {
    const user = userEvent.setup()
    mockActions.login.mockResolvedValue(authenticated('ada@example.com'))
    renderAtLogin()

    await fillCredentials(user, { email: '  ada@example.com  ' })
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(mockActions.login).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'hunter2-secret',
    })
    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('shows a clear error for invalid credentials and stays usable', async () => {
    const user = userEvent.setup()
    mockActions.login.mockResolvedValue(
      fail(
        'credentials_invalid',
        'The email address and/or password you specified are not correct.'
      )
    )
    renderAtLogin()

    await fillCredentials(user)
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(
      await screen.findByText(/the email address and\/or password/i)
    ).toBeInTheDocument()
    // still on the login form, and the button is re-enabled (no stuck
    // loading state) so the user can retry
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /^login$/i })).toBeEnabled()
    )
    expect(screen.getByRole('heading', { name: /log in/i })).toBeInTheDocument()
  })

  it('treats a 409 (already signed in) as "go to Search"', async () => {
    const user = userEvent.setup()
    mockActions.login.mockResolvedValue(
      fail('already_authenticated', 'You are already signed in.')
    )
    mockActions.getSession.mockResolvedValue(authenticated('ada@example.com'))
    renderAtLogin()

    await fillCredentials(user)
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(mockActions.getSession).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('surfaces a rate-limit response and recovers to a usable form', async () => {
    const user = userEvent.setup()
    mockActions.login.mockResolvedValue(fail('rate_limited', 'Too many attempts.'))
    renderAtLogin()

    await fillCredentials(user)
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(await screen.findByText('Too many attempts.')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /^login$/i })).toBeEnabled()
    )
  })

  it('surfaces a network failure without getting stuck', async () => {
    const user = userEvent.setup()
    mockActions.login.mockResolvedValue(
      fail("error", "Can't reach the server. Check your connection and try again.")
    )
    renderAtLogin()

    await fillCredentials(user)
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /^login$/i })).toBeEnabled()
    )
  })
})

// ---------------------------------------------------------------------------
// Unverified account — the same-page verification handoff
// ---------------------------------------------------------------------------

async function reachVerifyStep(user, email = 'ada@example.com') {
  mockActions.login.mockResolvedValue(pending(email))
  await fillCredentials(user, { email })
  await user.click(screen.getByRole('button', { name: /^login$/i }))
  await screen.findByRole('heading', { name: /verify email/i })
}

describe('unverified accounts', () => {
  it('moves to the verify step (same page) instead of signing the user in', async () => {
    const user = userEvent.setup()
    renderAtLogin()
    await reachVerifyStep(user)

    // the backend's 401 meant "not authenticated yet": the verify step
    // is where the login completes
    expect(screen.getByText(/we sent a 6-digit code to/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resend otp/i })).toBeInTheDocument()
    // and the original login form is gone (exact name: "Sign in" would
    // not collide with anything, but be explicit about the login button)
    expect(screen.queryByRole('button', { name: /^login$/i })).not.toBeInTheDocument()
  })

  it('completes the login with a valid code and leads to Search', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail.mockResolvedValue(authenticated('ada@example.com'))
    renderAtLogin()
    await reachVerifyStep(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(mockActions.verifyEmail).toHaveBeenCalledWith('123456')
    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('refuses a non-6-digit code client-side without calling the API', async () => {
    const user = userEvent.setup()
    renderAtLogin()
    await reachVerifyStep(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument()
    expect(mockActions.verifyEmail).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /verify email/i })).toBeInTheDocument()
  })

  it('shows an invalid-code error and lets the user retry', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail
      .mockResolvedValueOnce(fail('invalid_code', 'Incorrect code.'))
      .mockResolvedValueOnce(authenticated('ada@example.com'))
    renderAtLogin()
    await reachVerifyStep(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '999999')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('Incorrect code.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /verify email/i })).toBeInTheDocument()

    await user.clear(screen.getByLabelText(/6-digit code/i))
    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('offers start over (back to the login form) when the flow is dead', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail.mockResolvedValue(
      fail(
        'flow_expired',
        'This verification has expired or ran out of attempts. Please request a new code or sign in again.'
      )
    )
    renderAtLogin()
    await reachVerifyStep(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText(/this verification has expired/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /start over/i }))

    expect(screen.getByRole('button', { name: /^login$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /verify email/i })).not.toBeInTheDocument()
  })

  it('reports a successful resend and keeps the code field usable', async () => {
    const user = userEvent.setup()
    mockActions.resendVerification.mockResolvedValue({ ok: true, status: 'resent' })
    renderAtLogin()
    await reachVerifyStep(user)

    await user.click(screen.getByRole('button', { name: /resend otp/i }))

    expect(
      await screen.findByText(/a new code was sent to ada@example\.com/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeEnabled()
  })

  it('reports a failed resend while keeping the code field usable', async () => {
    const user = userEvent.setup()
    mockActions.resendVerification.mockResolvedValue(
      fail(
        'flow_expired',
        'You can’t request another code right now. If you have a recent code, you can still try it.'
      )
    )
    renderAtLogin()
    await reachVerifyStep(user)

    await user.click(screen.getByRole('button', { name: /resend otp/i }))

    expect(await screen.findByText(/can’t request another code right now/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeEnabled()
  })

  it('keeps the signup link available on the verify step', async () => {
    const user = userEvent.setup()
    renderAtLogin()
    await reachVerifyStep(user)

    const signupLink = screen.getByRole('link', { name: /sign up/i })
    expect(signupLink).toHaveAttribute('href', '/signup')
    await user.click(signupLink)
    expect(await screen.findByText('SIGNUP_MARKER')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Forgot password (the recovery option)
// ---------------------------------------------------------------------------

describe('forgot password', () => {
  it('swaps the form to a single email field with a reset request', async () => {
    const user = userEvent.setup()
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))

    expect(screen.getByRole('heading', { name: /reset your password/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to log in/i })).toBeInTheDocument()
  })

  it('blocks a missing email without a round-trip', async () => {
    const user = userEvent.setup()
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(mockActions.requestPasswordReset).not.toHaveBeenCalled()
  })

  it('shows the enumeration-safe confirmation on success', async () => {
    const user = userEvent.setup()
    mockActions.requestPasswordReset.mockResolvedValue({
      ok: true,
      status: 'requested',
      email: 'ada@example.com',
    })
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText(/^email$/i), '  ada@example.com  ')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(mockActions.requestPasswordReset).toHaveBeenCalledWith({ email: 'ada@example.com' })
    expect(
      await screen.findByText(/if an account exists for ada@example\.com/i)
    ).toBeInTheDocument()
    // and the button is re-enabled for another request
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /send reset link/i })).toBeEnabled()
    )
  })

  it('surfaces failures (e.g. a rate limit) and recovers to a usable form', async () => {
    const user = userEvent.setup()
    mockActions.requestPasswordReset.mockResolvedValue(
      fail('rate_limited', 'Too many attempts. Please wait a moment and try again.')
    )
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /send reset link/i })).toBeEnabled()
    )
  })

  it('returns to the login form (email kept, password cleared) on "Back to log in"', async () => {
    const user = userEvent.setup()
    renderAtLogin()

    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: /back to log in/i }))

    const email = screen.getByLabelText(/^email$/i)
    expect(email).toHaveValue('ada@example.com')
    expect(screen.getByRole('button', { name: /^login$/i })).toBeInTheDocument()
  })
})
