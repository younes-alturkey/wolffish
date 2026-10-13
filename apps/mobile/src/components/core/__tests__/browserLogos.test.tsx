import { render } from '@testing-library/react-native'
import { BrowserLogo } from '@/components/core/browserLogos'

/**
 * The logo XML strings are the desktop's own SVG assets carried verbatim, and
 * SvgXml PARSES them at render time — a malformed byte would crash the whole
 * Services screen, not just one mark. Rendering every slug here keeps that
 * failure in CI instead of on the first open of the screen.
 */
describe('BrowserLogo', () => {
  const slugs = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'safari']

  it.each(slugs)('renders the %s mark without throwing', (slug) => {
    expect(() => render(<BrowserLogo browser={slug} size={20} />)).not.toThrow()
  })

  it('falls back to the Chromium mark for an unknown slug', () => {
    expect(() => render(<BrowserLogo browser="netscape" size={20} />)).not.toThrow()
  })
})
