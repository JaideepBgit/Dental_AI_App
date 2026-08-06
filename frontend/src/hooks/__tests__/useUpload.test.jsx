/**
 * useUpload owns the intake submit: post the file, then poll the case until
 * detection finishes. It takes the api client as an argument (DIP), so these
 * tests drive it with a fake and no network.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpload } from '../useUpload';

function fakeApi(overrides = {}) {
  return {
    uploadXray: vi.fn(async () => ({ xray_id: 11, status: 'PENDING' })),
    fetchXray: vi.fn(async () => ({ id: 11, status: 'PROCESSED', detections: [] })),
    ...overrides,
  };
}

const file = () => new File(['img'], 'pano.png', { type: 'image/png' });

describe('useUpload', () => {
  beforeEach(() => vi.useRealTimers());

  it('starts idle', () => {
    const { result } = renderHook(() => useUpload({ api: fakeApi() }));

    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('forwards patient details to the api', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    await act(async () => {
      await result.current.submit({
        file: file(),
        patientName: 'Patient One',
        mrn: 'MRN-9001',
        appointmentDate: '2026-08-14',
      });
    });

    expect(api.uploadXray).toHaveBeenCalledWith(
      expect.objectContaining({
        patientName: 'Patient One',
        mrn: 'MRN-9001',
        appointmentDate: '2026-08-14',
      }),
    );
  });

  it('polls until the case leaves PENDING, then reports done', async () => {
    const statuses = ['PENDING', 'PENDING', 'PROCESSED'];
    const api = fakeApi({
      fetchXray: vi.fn(async () => ({
        id: 11, status: statuses.shift() || 'PROCESSED', detections: [{ id: 1 }],
      })),
    });
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    await act(async () => {
      await result.current.submit({ file: file(), patientName: 'P' });
    });

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(api.fetchXray.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.current.xrayId).toBe(11);
  });

  it('reports analysing while the backend is still working', async () => {
    let resolveFetch;
    const api = fakeApi({
      fetchXray: vi.fn(() => new Promise((r) => { resolveFetch = r; })),
    });
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    act(() => { result.current.submit({ file: file(), patientName: 'P' }); });

    await waitFor(() => expect(result.current.status).toBe('analysing'));
    await act(async () => {
      resolveFetch({ id: 11, status: 'PROCESSED', detections: [] });
    });
  });

  it('surfaces a backend ERROR status as a failure', async () => {
    const api = fakeApi({
      fetchXray: vi.fn(async () => ({
        id: 11, status: 'ERROR', error_message: 'model file corrupt', detections: [],
      })),
    });
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    await act(async () => {
      await result.current.submit({ file: file(), patientName: 'P' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch('model file corrupt');
  });

  it('surfaces a rejected upload', async () => {
    const api = fakeApi({
      uploadXray: vi.fn(async () => { throw new Error('Empty upload'); }),
    });
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    await act(async () => {
      await result.current.submit({ file: file(), patientName: 'P' });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Empty upload');
    expect(api.uploadXray).toHaveBeenCalled();
  });

  it('gives up after the poll limit instead of looping forever', async () => {
    const api = fakeApi({
      fetchXray: vi.fn(async () => ({ id: 11, status: 'PENDING', detections: [] })),
    });
    const { result } = renderHook(() =>
      useUpload({ api, pollIntervalMs: 1, maxPolls: 3 }));

    await act(async () => {
      await result.current.submit({ file: file(), patientName: 'P' });
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/still processing|timed out/i);
    expect(api.fetchXray.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('reset returns the hook to idle', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useUpload({ api, pollIntervalMs: 1 }));

    await act(async () => {
      await result.current.submit({ file: file(), patientName: 'P' });
    });
    act(() => { result.current.reset(); });

    expect(result.current.status).toBe('idle');
    expect(result.current.xrayId).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
