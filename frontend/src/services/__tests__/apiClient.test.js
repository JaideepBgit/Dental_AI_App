/**
 * The API service is the single boundary to the backend.
 *
 * createApiClient takes an HTTP transport rather than importing axios, so these
 * tests assert on the requests it builds without a server or a network mock.
 * That same seam is what lets the hook tests inject a fake client.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../apiClient';

/** Minimal stand-in for the axios instance, recording every call. */
function fakeTransport(responses = {}) {
  const calls = [];
  const respond = (method, url) => {
    const key = `${method} ${url}`;
    const match = Object.keys(responses).find((k) => key.startsWith(k));
    return Promise.resolve({ data: match ? responses[match] : {} });
  };
  return {
    calls,
    get: vi.fn((url, config) => { calls.push({ method: 'get', url, config }); return respond('get', url); }),
    post: vi.fn((url, body, config) => { calls.push({ method: 'post', url, body, config }); return respond('post', url); }),
    delete: vi.fn((url, config) => { calls.push({ method: 'delete', url, config }); return respond('delete', url); }),
  };
}

describe('createApiClient', () => {
  describe('queue', () => {
    it('requests the queue and unwraps items', async () => {
      const transport = fakeTransport({ 'get /api/queue': { count: 1, items: [{ id: 7 }] } });
      const api = createApiClient({ transport });

      const result = await api.fetchQueue();

      expect(transport.get).toHaveBeenCalledWith('/api/queue', expect.anything());
      expect(result.items).toEqual([{ id: 7 }]);
    });

    it('passes status and search as query params', async () => {
      const transport = fakeTransport();
      const api = createApiClient({ transport });

      await api.fetchQueue({ status: 'ERROR', search: 'patient' });

      const { config } = transport.calls[0];
      expect(config.params).toMatchObject({ status: 'ERROR', search: 'patient' });
    });

    it('omits empty filters rather than sending blank params', async () => {
      const transport = fakeTransport();
      const api = createApiClient({ transport });

      await api.fetchQueue({ status: '', search: '   ' });

      const { config } = transport.calls[0];
      expect(config.params.status).toBeUndefined();
      expect(config.params.search).toBeUndefined();
    });
  });

  describe('upload', () => {
    it('sends the file with patient name, mrn and appointment date', async () => {
      const transport = fakeTransport({ 'post /api/upload': { xray_id: 3, status: 'PENDING' } });
      const api = createApiClient({ transport });
      const file = new File(['x'], 'pano.png', { type: 'image/png' });

      const result = await api.uploadXray({
        file,
        patientName: 'Patient One',
        mrn: 'MRN-9001',
        appointmentDate: '2026-08-14',
      });

      const { url, body } = transport.calls[0];
      expect(url).toBe('/api/upload');
      expect(body.get('patient_name')).toBe('Patient One');
      expect(body.get('mrn')).toBe('MRN-9001');
      expect(body.get('appointment_date')).toBe('2026-08-14');
      expect(body.get('file')).toBe(file);
      expect(result).toEqual({ xray_id: 3, status: 'PENDING' });
    });

    it('reports upload progress through the supplied callback', async () => {
      const transport = fakeTransport();
      const api = createApiClient({ transport });
      const onProgress = vi.fn();

      await api.uploadXray({
        file: new File(['x'], 'a.png'),
        patientName: 'P',
        onProgress,
      });

      const { config } = transport.calls[0];
      config.onUploadProgress({ loaded: 50, total: 200 });
      expect(onProgress).toHaveBeenCalledWith(25);
    });

    it('surfaces the FastAPI detail message on failure', async () => {
      const transport = fakeTransport();
      transport.post = vi.fn(() => Promise.reject({
        response: { data: { detail: 'Empty upload' } },
      }));
      const api = createApiClient({ transport });

      await expect(
        api.uploadXray({ file: new File([''], 'a.png'), patientName: 'P' }),
      ).rejects.toThrow('Empty upload');
    });
  });

  describe('new endpoints', () => {
    it('fetches dashboard stats', async () => {
      const transport = fakeTransport({ 'get /api/stats': { pending: 2, total: 9 } });
      const api = createApiClient({ transport });

      expect(await api.fetchStats()).toMatchObject({ pending: 2, total: 9 });
    });

    it('fetches patients and one patient by mrn', async () => {
      const transport = fakeTransport({
        'get /api/patients/MRN-1': { mrn: 'MRN-1', xrays: [] },
        'get /api/patients': { count: 0, items: [] },
      });
      const api = createApiClient({ transport });

      await api.fetchPatients();
      expect(transport.calls[0].url).toBe('/api/patients');

      const one = await api.fetchPatient('MRN-1');
      expect(transport.calls[1].url).toBe('/api/patients/MRN-1');
      expect(one.mrn).toBe('MRN-1');
    });

    it('fetches referrals', async () => {
      const transport = fakeTransport({ 'get /api/referrals': { count: 0, items: [] } });
      const api = createApiClient({ transport });

      await api.fetchReferrals();
      expect(transport.calls[0].url).toBe('/api/referrals');
    });

    it('deletes a case', async () => {
      const transport = fakeTransport({ 'delete /api/xray/8': { status: 'deleted' } });
      const api = createApiClient({ transport });

      const result = await api.deleteXray(8);
      expect(transport.calls[0]).toMatchObject({ method: 'delete', url: '/api/xray/8' });
      expect(result.status).toBe('deleted');
    });

    it('deletes a patient by mrn', async () => {
      const transport = fakeTransport({
        'delete /api/patients/MRN-9': { status: 'deleted', deleted_xrays: 3 },
      });
      const api = createApiClient({ transport });

      const result = await api.deletePatient('MRN-9');
      expect(transport.calls[0]).toMatchObject({
        method: 'delete', url: '/api/patients/MRN-9',
      });
      expect(result.deleted_xrays).toBe(3);
    });

    it('surfaces the api detail when a delete is refused', async () => {
      const transport = fakeTransport();
      transport.delete = vi.fn(() => Promise.reject({
        response: { status: 409, data: { detail: 'a signed referral cannot be deleted' } },
      }));
      const api = createApiClient({ transport });

      await expect(api.deleteXray(8)).rejects.toThrow(/signed referral/);
    });

    it('retries a failed case', async () => {
      const transport = fakeTransport({ 'post /api/xray/5/retry': { status: 'PENDING' } });
      const api = createApiClient({ transport });

      const result = await api.retryXray(5);
      expect(transport.calls[0]).toMatchObject({ method: 'post', url: '/api/xray/5/retry' });
      expect(result.status).toBe('PENDING');
    });
  });

  describe('url builders', () => {
    it('builds absolute image and referral urls from the base url', () => {
      const api = createApiClient({ transport: fakeTransport(), baseUrl: 'http://api.test' });

      expect(api.xrayImageUrl(4)).toBe('http://api.test/api/xray/4/image');
      expect(api.referralUrl(4)).toBe('http://api.test/api/referral/4');
    });

    it('builds relative urls when served same-origin', () => {
      const api = createApiClient({ transport: fakeTransport(), baseUrl: '' });

      expect(api.xrayImageUrl(4)).toBe('/api/xray/4/image');
    });
  });
});
