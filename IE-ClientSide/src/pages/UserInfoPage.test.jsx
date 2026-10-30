// @vitest-environment jsdom
/**
 * Tests for the user information page (planning section 5) against its
 * acceptance criteria: the displayed name and email come from the
 * session's user data (not placeholders), missing user data degrades
 * gracefully, sign out ends the session and leads to Login, and the
 * change-password action follows the backend flow (success keeps the
 * user signed in on the page; a failed follow-up auto-login hands them
 * to Login; validation errors land on the right fields without leaving
 * a stuck form).
 *
 * The auth module is mocked at its surface (useAuth): the page consumes
 * only the service's result objects, whose shapes are the contract
 * documented in src/auth/authService.js.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import UserInfoPage from './UserInfoPage'

// Mutable so each test picks the session state it needs (same pattern as
// guards.test.jsx): the page reads user + actions from useAuth().
const snapshot = vi.hoisted(() => ({
  current: {
    status: 'authenticated',
    user: null,
    sessionToken: null,
    isAuthenticated: true,
    isAuthLoading: false,
  },
}))

const mockActions = vi.hoisted(() => ({
  logout: vi.fn(),
  changePassword: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock('../auth', () => ({
  useAuth: () => ({ ...snapshot.current, actions: mockActions }),
}))

function setUser(user, { isAuthenticated = true, status } = {}) {
  snapshot.current = {
    status: status ?? (isAuthenticated ? 'authenticated' : 'unauthenticated'),
    user,
    sessionToken: null,
    isAuthenticated,
    isAuthLoading: false,
  }
}

function renderAtAccount() {
  return render(
    <MemoryRouter initialEntries={['/account']}>
      <Routes>
        <Route path="/account" element={<UserInfoPage />} />
        <Route path="/login" element={<div>LOGIN_MARKER</div>} />
        <Route path="/search" element={<div>SEARCH_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// The auth service builds ApiError results, not plain Errors; carry the
// backend's errors[] the same way so the page's field mapping is exercised.
function validationError(message, param = null) {
  const error = new Error(message)
  error.code = 'field_rejected'
  error.param = param
  error.errors = param ? [{ message, code: 'field_rejected', param }] : []
  return error
}
function fail(status, error) {
  return { ok: false, status, error }
}

beforeEach(() => {
  vi.clearAllMocks()
  setUser({
    id: 1,
    username: 'ada',
    display: 'ada',
    email: 'ada@example.com',
    has_usable_password: true,
    first_name: 'Ada',
    last_name: 'Lovelace',
  })
  mockActions.logout.mockResolvedValue({ ok: true, status: 'logged_out' })
  mockActions.getSession.mockResolvedValue({ ok: true, status: 'authenticated' })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Displayed identity
// ---------------------------------------------------------------------------

describe('the displayed identity', () => {
  it("shows the user's actual name and email from the session data", () => {
    renderAtAccount()

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
  })

  it('falls back for partial names (first only, username only)', () => {
    setUser({
      id: 1,
      username: 'grace',
      display: 'grace',
      email: 'grace@example.com',
      first_name: 'Grace',
    })
    renderAtAccount()
    expect(screen.getByText('Grace')).toBeInTheDocument()

    cleanup()
    setUser({ id: 2, username: 'alan', display: 'alan', email: 'alan@example.com' })
    renderAtAccount()
    // no first/last stored — the username stands in for the name
    expect(screen.getByText('alan')).toBeInTheDocument()
    expect(screen.getByText('alan@example.com')).toBeInTheDocument()
  })

  it('is driven by the user data, not hardcoded (a different user renders differently)', () => {
    setUser({ id: 3, email: 'other@example.com', first_name: 'Other', last_name: 'Person' })
    renderAtAccount()
    expect(screen.getByText('Other Person')).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
  })

  it('degrades gracefully when authenticated but the user payload is missing', async () => {
    const user = userEvent.setup()
    setUser(null)
    renderAtAccount()

    expect(screen.getByText('Your account')).toBeInTheDocument()
    expect(screen.getByText(/couldn’t load your account details/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(mockActions.getSession).toHaveBeenCalledTimes(1)

    // the button re-enables once the (mock) re-fetch settles
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled()
    )
  })

  it('still offers the account actions when the user payload is missing', () => {
    setUser(null)
    renderAtAccount()
    expect(screen.getByRole('button', { name: /^change password$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

describe('sign out', () => {
  it('ends the session through the API and leads to Login', async () => {
    const user = userEvent.setup()
    renderAtAccount()

    await user.click(screen.getByRole('button', { name: /^sign out$/i }))

    expect(mockActions.logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('does not double-fire on repeated clicks while the request is in flight', async () => {
    const user = userEvent.setup()
    let resolveLogout
    mockActions.logout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogout = () => resolve({ ok: true, status: 'logged_out' })
        })
    )
    renderAtAccount()

    await user.click(screen.getByRole('button', { name: /^sign out$/i }))
    // the button is disabled (and relabeled) while in flight — a second
    // click must not start a second logout
    await user.click(screen.getByRole('button', { name: /signing out/i }))

    expect(mockActions.logout).toHaveBeenCalledTimes(1)
    resolveLogout()
    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

/** Open the form, fill both fields, and submit. (Sequential typing on
 * purpose: userEvent has one pointer — concurrent type() calls interleave
 * and scramble the input.) */
async function submitChange(user, { current = 'orig-pass-123', next = 'brand-new-999' } = {}) {
  await user.click(screen.getByRole('button', { name: /^change password$/i }))
  await user.type(screen.getByLabelText(/^current password$/i), current)
  await user.type(screen.getByLabelText(/^new password$/i), next)
  await user.click(screen.getByRole('button', { name: /^change password$/i }))
}

/** The (re-enabled) submit button — used to prove no stuck loading state. */
async function submitButtonIsUsableAgain() {
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: /^change password$/i })).toBeEnabled()
  )
}

describe('change password', () => {
  it('reveals current + new password fields behind the action', async () => {
    const user = userEvent.setup()
    renderAtAccount()

    // collapsed: just the action, no fields
    expect(screen.queryByLabelText(/^current password$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^change password$/i }))

    expect(screen.getByLabelText(/^current password$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
  })

  it('closes on cancel', async () => {
    const user = userEvent.setup()
    renderAtAccount()
    await user.click(screen.getByRole('button', { name: /^change password$/i }))
    await user.type(screen.getByLabelText(/^current password$/i), 'whatever')
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(screen.queryByLabelText(/^current password$/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^change password$/i })).toBeInTheDocument()
  })

  it('blocks an empty submission client-side without a round-trip', async () => {
    const user = userEvent.setup()
    renderAtAccount()
    await user.click(screen.getByRole('button', { name: /^change password$/i }))
    await user.click(screen.getByRole('button', { name: /^change password$/i }))

    expect(screen.getByText('Enter your current password.')).toBeInTheDocument()
    expect(screen.getByText('Choose a new password.')).toBeInTheDocument()
    expect(mockActions.changePassword).not.toHaveBeenCalled()
  })

  it('rejects a too-short new password client-side without a round-trip', async () => {
    const user = userEvent.setup()
    renderAtAccount()
    await user.click(screen.getByRole('button', { name: /^change password$/i }))
    await user.type(screen.getByLabelText(/^current password$/i), 'orig-pass-123')
    await user.type(screen.getByLabelText(/^new password$/i), 'short')
    await user.click(screen.getByRole('button', { name: /^change password$/i }))

    expect(screen.getByText(/must be at least 8 characters/i)).toBeInTheDocument()
    expect(mockActions.changePassword).not.toHaveBeenCalled()
  })

  it('sends current + new password to the service on a valid submission', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue({
      ok: true,
      status: 'authenticated',
      user: snapshot.current.user,
      sessionToken: 'st-live',
      passwordChanged: true,
    })
    renderAtAccount()
    await submitChange(user)

    expect(mockActions.changePassword).toHaveBeenCalledWith({
      currentPassword: 'orig-pass-123',
      newPassword: 'brand-new-999',
    })
  })

  it('keeps the user on the page after a successful change (the auto-login kept the session)', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue({
      ok: true,
      status: 'authenticated',
      user: snapshot.current.user,
      sessionToken: 'st-live',
      passwordChanged: true,
    })
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText('Your password has been changed.')).toBeInTheDocument()
    // still signed in, still here — no navigation, form fields cleared
    expect(screen.queryByText('LOGIN_MARKER')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^account$/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/^current password$/i)).toHaveValue('')
    expect(screen.getByLabelText(/^new password$/i)).toHaveValue('')
    await submitButtonIsUsableAgain()
  })

  it('lands a wrong-current-password error on the current-password field', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue(
      fail('validation', validationError('Please type your current password.', 'current_password'))
    )
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText('Please type your current password.')).toBeInTheDocument()
    // the form stays usable — fix the field, retry
    expect(screen.getByLabelText(/^current password$/i)).toBeInTheDocument()
    await submitButtonIsUsableAgain()
  })

  it('lands a rejected-new-password error on the new-password field', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue(
      fail(
        'validation',
        validationError(
          'This password is too short. It must contain at least 8 characters.',
          'new_password'
        )
      )
    )
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText(/this password is too short/i)).toBeInTheDocument()
    await submitButtonIsUsableAgain()
  })

  it('shows an unmappable validation error form-level and stays usable', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue(
      fail('validation', validationError('Something went wrong. Please try again.'))
    )
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
    await submitButtonIsUsableAgain()
  })

  it('hands a changed-but-not-re-signed-in user to Login', async () => {
    const user = userEvent.setup()
    // The password WAS changed; the follow-up auto-login then failed
    // (credentials_invalid) — the session is gone, go to Login.
    mockActions.changePassword.mockResolvedValue({
      ...fail('credentials_invalid', validationError(
        'The email address and/or password you specified are not correct.',
        'password'
      )),
      passwordChanged: true,
    })
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('tells the user to verify the email when the auto-login hit an unverified account', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue(
      Object.assign(
        fail('verification_pending', validationError('This account still needs to verify its email address.')),
        { passwordChanged: true, sessionToken: 'st-verify' }
      )
    )
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('surfaces a dead-session result without getting stuck', async () => {
    const user = userEvent.setup()
    mockActions.changePassword.mockResolvedValue(
      fail('unauthenticated', new Error('Your session is no longer active. Please sign in again.'))
    )
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText(/your session is no longer active/i)).toBeInTheDocument()
    await submitButtonIsUsableAgain()
  })

  it('surfaces a network failure and recovers to a usable form', async () => {
    const user = userEvent.setup()
    const error = new Error("Can't reach the server. Check your connection and try again.")
    error.network = true
    mockActions.changePassword.mockResolvedValue(fail('error', error))
    renderAtAccount()
    await submitChange(user)

    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
    await submitButtonIsUsableAgain()
  })
})
