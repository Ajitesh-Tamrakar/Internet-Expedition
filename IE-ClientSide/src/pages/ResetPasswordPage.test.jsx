// @vitest-environment jsdom
/**
 * Tests for the password-reset completion page (planning section 4, the
 * link half of the login page's recovery flow): the emailed link lands
 * on /account/password/reset?token=…, the page validates the token on
 * mount, takes a new password, and then either lands on Search (reset
 * + auto-login) or tells the user exactly what state they're in (dead
 * link, changed-but-not-signed-in, retryable failure).
 *
 * The auth module is mocked at its surface (useAuth): the page consumes
 * only the service's result objects, whose shapes are the contract
 * documented in src/auth/authService.js (requestPasswordReset /
 * verifyResetLink / resetPassword, including the `resetCompleted`
 * marker the service adds once the password has actually been set).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import ResetPasswordPage from './ResetPasswordPage'

const TOKEN = 'ada-3f9c'

const mockActions = vi.hoisted(() => ({
  verifyResetLink: vi.fn(),
  resetPassword: vi.fn(),
  login: vi.fn(),
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
function linkValid(email = 'ada@example.com') {
  return { ok: true, status: 'link_valid', user: { email } }
}
function linkInvalid(message = 'The password reset link is invalid or expired.') {
  return { ok: false, status: 'link_invalid', error: new Error(message) }
}
function authenticated(email) {
  return {
    ok: true,
    status: 'authenticated',
    user: { email },
    resetCompleted: true,
  }
}
function fail(status, message, { resetCompleted = false } = {}) {
  return { ok: false, status, error: new Error(message), resetCompleted }
}

function renderAt(path = `/account/password/reset?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/account/password/reset" element={<ResetPasswordPage />} />
        <Route path="/login" element={<div>LOGIN_MARKER</div>} />
        <Route path="/search" element={<div>SEARCH_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function waitForForm() {
  // The mount check (GET) resolves first; the form is the observable
  // end state of a live link.
  await screen.findByRole('button', { name: /save new password/i })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// The link check on mount
// ---------------------------------------------------------------------------

describe('the link check', () => {
  it('sends the URL token as the X-Password-Reset-Key of a GET (via the service)', async () => {
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    renderAt()

    await waitForForm()
    expect(mockActions.verifyResetLink).toHaveBeenCalledWith(TOKEN)
  })

  it('offers the form for the account the link belongs to', async () => {
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    renderAt()

    await waitForForm()
    // the email is nested in a <strong>, so the two parts are asserted
    // separately (Testing Library matches direct text nodes only)
    expect(screen.getByText(/choose a new password for/i)).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
  })

  it('a link without a token is invalid without any request', async () => {
    renderAt('/account/password/reset')

    expect(await screen.findByText(/missing its reset token/i)).toBeInTheDocument()
    expect(mockActions.verifyResetLink).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /save new password/i })).not.toBeInTheDocument()
  })

  it('an invalid or expired link is said so, with a way back to login', async () => {
    mockActions.verifyResetLink.mockResolvedValue(linkInvalid())
    renderAt()

    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save new password/i })).not.toBeInTheDocument()
    const back = screen.getByRole('link', { name: /back to log in/i })
    expect(back).toHaveAttribute('href', '/login')
    await userEvent.setup().click(back)
    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('a failed check (backend unreachable) does not strand the user — the form stays', async () => {
    mockActions.verifyResetLink.mockResolvedValue(
      fail('error', "Can't reach the server. Check your connection and try again.")
    )
    renderAt()

    expect(await screen.findByText(/couldn’t verify this link/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save new password/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Completing the reset
// ---------------------------------------------------------------------------

describe('completing the reset', () => {
  it('sends the token and new password; a settled success leads to Search', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    mockActions.resetPassword.mockResolvedValue(authenticated('ada@example.com'))
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(mockActions.resetPassword).toHaveBeenCalledWith({
      key: TOKEN,
      email: 'ada@example.com',
      password: 'brand-new-pass-1',
    })
    expect(await screen.findByText('SEARCH_MARKER')).toBeInTheDocument()
  })

  it('refuses a short password client-side without calling the API', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'short')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(screen.getByText(/password must be at least 8 characters/i)).toBeInTheDocument()
    expect(mockActions.resetPassword).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /save new password/i })).toBeEnabled()
    )
  })

  it('a failed reset (dead token, password rejected, …) stays on the form and is retryable', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    mockActions.resetPassword.mockResolvedValue(
      fail('link_invalid', 'The password reset link is invalid or expired.')
    )
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(await screen.findByText(/invalid or expired/i)).toBeInTheDocument()
    // still on the form (the password is not set), still able to retry
    expect(screen.getByRole('button', { name: /save new password/i })).toBeEnabled()
  })

  it('a reset that changed the password but could not sign the user in says so', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    mockActions.resetPassword.mockResolvedValue(
      fail('rate_limited', 'Too many attempts.', { resetCompleted: true })
    )
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(await screen.findByText(/your password has been changed/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save new password/i })
    ).not.toBeInTheDocument()
    const back = screen.getByRole('link', { name: /back to log in/i })
    expect(back).toHaveAttribute('href', '/login')
    await user.click(back)
    expect(await screen.findByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('a changed password with a still-unverified email points at the login page', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    mockActions.resetPassword.mockResolvedValue(
      fail('verification_pending', 'This account still needs to verify its email address.', {
        resetCompleted: true,
      })
    )
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(await screen.findByText(/still needs to verify its email/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to log in/i })).toBeInTheDocument()
  })

  it('a network failure on the reset itself stays retryable', async () => {
    const user = userEvent.setup()
    mockActions.verifyResetLink.mockResolvedValue(linkValid())
    mockActions.resetPassword.mockResolvedValue(
      fail("error", "Can't reach the server. Check your connection and try again.")
    )
    renderAt()
    await waitForForm()

    await user.type(screen.getByLabelText(/^new password$/i), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: /save new password/i }))

    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /save new password/i })).toBeEnabled()
    )
  })
})
