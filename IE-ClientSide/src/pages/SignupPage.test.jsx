// @vitest-environment jsdom
/**
 * Tests for the signup page (planning section 3) against its acceptance
 * criteria: the two-step flow on one page, client validation, the
 * backend's result statuses driving step 2's states, resend, and the
 * navigation outcomes (valid code → Search, login link → Login).
 *
 * The auth module is mocked at its surface (useAuth): the page consumes
 * only the service's result objects, whose shapes are the contract
 * documented in src/auth/authService.js.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import SignupPage from './SignupPage'

const mockActions = vi.hoisted(() => ({
  signup: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
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
function pending(email) {
  return { ok: true, status: 'verification_pending', email, sessionToken: 'st-signup' }
}
function fail(status, message) {
  return { ok: false, status, error: new Error(message) }
}

function renderAtSignup() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login" element={<div>LOGIN_MARKER</div>} />
        <Route path="/search" element={<div>SEARCH_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillDetails(user, { email = 'ada@example.com' } = {}) {
  await user.type(screen.getByLabelText(/first name/i), 'Ada')
  await user.type(screen.getByLabelText(/last name/i), 'Lovelace')
  await user.type(screen.getByLabelText(/email/i), email)
  await user.type(screen.getByLabelText(/^password$/i), 'hunter2-secret')
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Step 1 — details
// ---------------------------------------------------------------------------

describe('step 1 (details)', () => {
  it('shows the four fields, a Send OTP button, and a link to Login', () => {
    renderAtSignup()

    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send otp$/i })).toBeInTheDocument()
    const loginLink = screen.getByRole('link', { name: /log in/i })
    expect(loginLink).toHaveAttribute('href', '/login')
  })

  it('blocks an empty submission with field errors and makes no request', async () => {
    const user = userEvent.setup()
    renderAtSignup()

    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    expect(screen.getByText('First name is required.')).toBeInTheDocument()
    expect(screen.getByText('Last name is required.')).toBeInTheDocument()
    expect(screen.getByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password is required.')).toBeInTheDocument()
    expect(mockActions.signup).not.toHaveBeenCalled()
  })

  it('rejects an invalid email and a short password client-side', async () => {
    const user = userEvent.setup()
    renderAtSignup()

    await user.type(screen.getByLabelText(/first name/i), 'Ada')
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace')
    await user.type(screen.getByLabelText(/email/i), 'not-an-email')
    await user.type(screen.getByLabelText(/^password$/i), 'short')
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText(/password must be at least 8 characters/i)).toBeInTheDocument()
    expect(mockActions.signup).not.toHaveBeenCalled()
  })

  it('advances to step 2 when the backend reports the verification flow can proceed', async () => {
    const user = userEvent.setup()
    mockActions.signup.mockResolvedValue(pending('ada@example.com'))
    renderAtSignup()

    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    // let the async handler run to completion (the step 2 render is the
    // observable end state; the "Sending…" interim state may not paint)
    await vi.waitFor(() => expect(mockActions.signup).toHaveBeenCalledTimes(1))

    expect(mockActions.signup).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'hunter2-secret',
      firstName: 'Ada',
      lastName: 'Lovelace',
    })

    // step 2 — the same page, not a new route
    expect(await screen.findByRole('heading', { name: /verify email/i })).toBeInTheDocument()
    expect(screen.getByText(/we sent a 6-digit code to/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign up$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resend otp/i })).toBeInTheDocument()
    // and step 1's submit control is gone (exact name: /send otp/ would
    // also match step 2's "Resend OTP")
    expect(screen.queryByRole('button', { name: /^send otp$/i })).not.toBeInTheDocument()
  })

  it('stays on step 1 and shows the backend message for a duplicate email', async () => {
    const user = userEvent.setup()
    mockActions.signup.mockResolvedValue(
      fail('account_exists', 'An account with this email already exists.')
    )
    renderAtSignup()

    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    // let the async handler settle, then check the surfaced message
    expect(await screen.findByText(/an account with this email already exists/i)).toBeInTheDocument()
    // the button is re-enabled — the form is usable again
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /^send otp$/i })).toBeEnabled())
    expect(screen.queryByRole('heading', { name: /verify email/i })).not.toBeInTheDocument()
  })

  it('surfaces backend validation and rate-limit messages on step 1', async () => {
    const user = userEvent.setup()
    mockActions.signup.mockResolvedValue(fail('validation', 'Password is too short.'))
    renderAtSignup()
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))
    expect(await screen.findByText('Password is too short.')).toBeInTheDocument()

    cleanup()
    mockActions.signup.mockResolvedValue(fail('rate_limited', 'Too many attempts.'))
    renderAtSignup()
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))
    expect(await screen.findByText('Too many attempts.')).toBeInTheDocument()
  })

  it('surfaces a network failure without getting stuck', async () => {
    const user = userEvent.setup()
    mockActions.signup.mockResolvedValue(
      fail('error', "Can't reach the server. Check your connection and try again.")
    )
    renderAtSignup()
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /^send otp$/i })).toBeEnabled())
  })
})

// ---------------------------------------------------------------------------
// Step 2 — verify email
// ---------------------------------------------------------------------------

async function goToVerify(user) {
  mockActions.signup.mockResolvedValue(pending('ada@example.com'))
  await fillDetails(user)
  await user.click(screen.getByRole('button', { name: /^send otp$/i }))
  await screen.findByRole('heading', { name: /verify email/i })
}

describe('step 2 (verify email)', () => {
  it('completes signup with a valid code and leads to Search', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail.mockResolvedValue({
      ok: true,
      status: 'authenticated',
      user: { email: 'ada@example.com' },
      sessionToken: 'st-live',
    })
    renderAtSignup()
    await goToVerify(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(mockActions.verifyEmail).toHaveBeenCalledWith('123456')
    // the session is live — the page navigates away
    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('refuses a non-6-digit code client-side without calling the API', async () => {
    const user = userEvent.setup()
    renderAtSignup()
    await goToVerify(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument()
    expect(mockActions.verifyEmail).not.toHaveBeenCalled()
    // still on step 2, still able to retry
    expect(screen.getByRole('heading', { name: /verify email/i })).toBeInTheDocument()
  })

  it('shows an invalid-code error and lets the user retry', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail
      .mockResolvedValueOnce(fail('invalid_code', 'Incorrect code.'))
      .mockResolvedValueOnce({
        ok: true,
        status: 'authenticated',
        user: { email: 'ada@example.com' },
        sessionToken: 'st-live',
      })
    renderAtSignup()
    await goToVerify(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '999999')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    // let the first (failed) attempt settle, then check the surfaced error
    expect(await screen.findByText('Incorrect code.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /verify email/i })).toBeInTheDocument()

    // retry with a different code
    await user.clear(screen.getByLabelText(/6-digit code/i))
    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('offers start over when the verification has expired or run out of attempts', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail.mockResolvedValue(
      fail(
        'flow_expired',
        'This verification has expired or ran out of attempts. Please request a new code or sign in again.'
      )
    )
    renderAtSignup()
    await goToVerify(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(
      await screen.findByText(/this verification has expired/i)
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /start over/i }))

    // back on step 1, ready to start the flow again
    expect(screen.getByRole('button', { name: /^send otp$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /verify email/i })).not.toBeInTheDocument()
  })

  it('offers start over when the pending session has vanished (410)', async () => {
    const user = userEvent.setup()
    mockActions.verifyEmail.mockResolvedValue(
      fail('session_gone', 'That session is no longer valid. Please start again.')
    )
    renderAtSignup()
    await goToVerify(user)

    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    // let the failed attempt settle, then check the recovery affordance
    await screen.findByText(/that session is no longer valid/i)
    expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument()
  })

  it('reports a successful resend and keeps the code field usable', async () => {
    const user = userEvent.setup()
    mockActions.resendVerification.mockResolvedValue({ ok: true, status: 'resent' })
    renderAtSignup()
    await goToVerify(user)

    await user.click(screen.getByRole('button', { name: /resend otp/i }))

    expect(mockActions.resendVerification).toHaveBeenCalled()
    expect(
      await screen.findByText(/a new code was sent to ada@example\.com/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeEnabled()
  })

  it('reports a failed resend (quota reached / flow over) while keeping the code field usable', async () => {
    const user = userEvent.setup()
    mockActions.resendVerification.mockResolvedValue(
      fail(
        'flow_expired',
        'You can’t request another code right now. If you have a recent code, you can still try it.'
      )
    )
    renderAtSignup()
    await goToVerify(user)

    await user.click(screen.getByRole('button', { name: /resend otp/i }))

    expect(
      await screen.findByText(/can’t request another code right now/i)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/6-digit code/i)).toBeEnabled()
  })

  it('keeps the login link available on step 2 and navigates to Login', async () => {
    const user = userEvent.setup()
    renderAtSignup()
    await goToVerify(user)

    const loginLink = screen.getByRole('link', { name: /log in/i })
    expect(loginLink).toHaveAttribute('href', '/login')
    await user.click(loginLink)
    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })
})
