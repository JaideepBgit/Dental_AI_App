import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import VoiceDictator from '../VoiceDictator';
import { makeFakeApi, renderWithProviders } from '../../test/renderWithProviders';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

class FakeMediaRecorder {
  constructor() {
    this.ondataavailable = null;
    this.onstop = null;
  }

  start() {}

  stop() {
    this.ondataavailable?.({ data: new Blob(['recording'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function Harness() {
  const [text, setText] = useState('');
  return <VoiceDictator text={text} setText={setText} whisperReady disabled={false} />;
}

describe('VoiceDictator recording flow', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete navigator.mediaDevices;
    }
  });

  it('starts recording directly and explains when transcription appears', async () => {
    const user = userEvent.setup();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const api = makeFakeApi({ transcribeAudio: vi.fn(async () => 'Referral note') });
    renderWithProviders(<Harness />, { api });

    await user.click(screen.getByRole('button', { name: /^dictate$/i }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /stop & transcribe/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/transcript appears after you stop/i);
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /stop & transcribe/i }));
    await waitFor(() => expect(api.transcribeAudio).toHaveBeenCalledTimes(1));
  });

  it('opens troubleshooting only when direct microphone access fails', async () => {
    const user = userEvent.setup();
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw denied; }) },
    });
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: /^dictate$/i }));

    expect(await screen.findByRole('dialog', { name: /turn on the microphone/i }))
      .toBeInTheDocument();
  });
});
