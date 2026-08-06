/** Smoke test: proves jsdom, RTL and jest-dom matchers are wired up. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('renders a component and matches with jest-dom', () => {
    render(<button type="button">Upload</button>);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });
});
