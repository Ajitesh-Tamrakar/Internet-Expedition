// @vitest-environment jsdom
/**
 * Tests for the Search page (planning section 6): the placeholder shows
 * only the centered "Search" heading — no search input, results, filters,
 * or other UI.
 *
 * "Centered" is a CSS property (the `.app-shell` rule in src/index.css
 * flex-centers its content), which jsdom does not apply — so these tests
 * pin the contract the style relies on: a single heading, inside the
 * app-shell container, and nothing else on the page.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import SearchPage from './SearchPage'

afterEach(() => {
  cleanup()
})

describe('the Search heading', () => {
  it('is visible', () => {
    render(<SearchPage />)
    expect(screen.getByRole('heading', { name: 'Search', level: 1 })).toBeInTheDocument()
  })

  it('lives in the centered app-shell container', () => {
    const { container } = render(<SearchPage />)

    // The page is exactly the app-shell (the .app-shell rule is what
    // centers its content), and the heading is its content.
    expect(container.children).toHaveLength(1)
    const shell = container.firstElementChild
    expect(shell).toHaveClass('app-shell')
    expect(shell).toContainElement(screen.getByRole('heading', { name: 'Search' }))
  })
})

describe('nothing beyond the heading', () => {
  it('renders no search UI (no input, button, form, or results)', () => {
    const { container } = render(<SearchPage />)
    expect(
      container.querySelectorAll('input, textarea, select, button, a, form, table, output'),
    ).toHaveLength(0)
  })

  it('renders no unrelated content — the only text on the page is the heading', () => {
    const { container } = render(<SearchPage />)
    expect(
      container.querySelectorAll('p, ul, ol, li, img, figure, blockquote, pre'),
    ).toHaveLength(0)
    expect(container.textContent).toBe('Search')
  })
})
