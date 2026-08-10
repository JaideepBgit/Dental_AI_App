import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import Viewer from '../Viewer';
import { renderWithProviders } from '../../test/renderWithProviders';

const props = {
  imageUrl: '/xray.png',
  detections: [],
  extractionIds: [],
  isAnalyzing: false,
  hoveredId: null,
  onHover: vi.fn(),
  showAll: false,
};

describe('Viewer zoom controls', () => {
  it('zooms in and returns to the fitted image', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Viewer {...props} />);

    const canvas = screen.getByTestId('xray-zoom-canvas');
    const zoomOut = screen.getByRole('button', { name: /zoom out/i });

    expect(canvas).toHaveStyle({ width: '100%' });
    expect(zoomOut).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(canvas).toHaveStyle({ width: '150%' });
    expect(zoomOut).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /fit image/i }));
    expect(canvas).toHaveStyle({ width: '100%' });
    expect(zoomOut).toBeDisabled();
  });

  it('caps magnification at three times', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Viewer {...props} />);

    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);
    await user.click(zoomIn);

    expect(screen.getByTestId('xray-zoom-canvas')).toHaveStyle({ width: '300%' });
    expect(zoomIn).toBeDisabled();
  });
});
