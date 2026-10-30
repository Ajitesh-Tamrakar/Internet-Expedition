// @vitest-environment jsdom
/**
 * Tests for the top navigation (planning section 7): the brand and a
 * link to each protected page, with the current page marked active.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import Nav from './Nav'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
})

describe('the links', () => {
  it('shows the brand (linking to the app root) and one link per protected page', () => {
    renderAt('/search')

    expect(screen.getByRole('link', { name: /internet expedition/i })).toHaveAttribute(
      'href',
      '/'
    )
    expect(screen.getByRole('link', { name: /^search$/i })).toHaveAttribute('href', '/search')
    expect(screen.getByRole('link', { name: /^account$/i })).toHaveAttribute('href', '/account')
  })

  it('marks the page the user is on as active (and the others as not)', () => {
    renderAt('/account')

    expect(screen.getByRole('link', { name: /^account$/i })).toHaveClass('active')
    expect(screen.getByRole('link', { name: /^search$/i })).not.toHaveClass('active')
  })
})
