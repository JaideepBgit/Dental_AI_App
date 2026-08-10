/**
 * The practice name reaches the user in three places: the nav rail, the sign-in
 * card, and the browser tab. All three read one module.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AppRoutes from '../AppRoutes';
import { PRACTICE_INITIALS, PRACTICE_NAME } from '../branding';
import {
  FAKE_ADMIN, makeFakeApi, renderWithProviders,
} from '../test/renderWithProviders';

describe('practice branding', () => {
  it('names the practice', () => {
    expect(PRACTICE_NAME).toBe('Passion Dental');
  });

  it('builds a two-letter monogram from the practice name', () => {
    expect(PRACTICE_INITIALS).toBe('PD');
  });

  it('brands the nav rail with the practice, not the old product name', async () => {
    renderWithProviders(<AppRoutes />, {
      route: '/', api: makeFakeApi(), user: FAKE_ADMIN,
    });

    const nav = await screen.findByRole('navigation');
    // The brand block sits above the nav list, inside the same rail.
    expect(screen.getAllByText(PRACTICE_NAME).length).toBeGreaterThan(0);
    expect(screen.queryByText('SmileAI')).toBeNull();
    expect(nav).toBeInTheDocument();
  });

  it('brands the sign-in card with the practice', async () => {
    renderWithProviders(<AppRoutes />, {
      route: '/login', api: makeFakeApi(), user: null,
    });

    expect(await screen.findByText(PRACTICE_NAME)).toBeInTheDocument();
    expect(screen.queryByText('SmileAI')).toBeNull();
  });
});
