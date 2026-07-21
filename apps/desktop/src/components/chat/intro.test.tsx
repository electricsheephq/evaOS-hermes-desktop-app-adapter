import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Intro } from './intro'

describe('managed evaOS Agent intro branding', () => {
  it('renders the evaOS wordmark without upstream product branding', () => {
    render(<Intro personality="none" seed={0} />)

    expect(screen.getByLabelText('evaOS AGENT')).not.toBeNull()
    expect(screen.queryByText(/hermes agent/i)).toBeNull()
  })
})
