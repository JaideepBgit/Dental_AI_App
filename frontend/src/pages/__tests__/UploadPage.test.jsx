/**
 * The intake page — the flow that did not exist before.
 *
 * A user picks an image, fills in who it belongs to, and clicks Next. Detection
 * runs in the background while the page reports progress.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import UploadPage from '../UploadPage';
import { makeFakeApi, renderWithProviders } from '../../test/renderWithProviders';

const pngFile = (name = 'pano.png') =>
  new File(['fake-image-bytes'], name, { type: 'image/png' });

/** Put a file into the page's hidden input, which is how MUI wires the zone. */
async function chooseFile(user, file = pngFile()) {
  const input = document.querySelector('input[type="file"]');
  await user.upload(input, file);
}

describe('UploadPage', () => {
  it('starts on the file-selection step', () => {
    renderWithProviders(<UploadPage />);

    expect(screen.getByRole('heading', { name: /new case/i })).toBeInTheDocument();
    expect(screen.getByText(/drag and drop/i)).toBeInTheDocument();
  });

  it('does not show the patient form until a file is chosen', () => {
    renderWithProviders(<UploadPage />);

    expect(screen.queryByLabelText(/patient name/i)).not.toBeInTheDocument();
  });

  it('reveals the patient form once a file is chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadPage />);

    await chooseFile(user);

    expect(await screen.findByLabelText(/patient name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mrn|record number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/appointment/i)).toBeInTheDocument();
  });

  it('keeps the appointment-date label clear of the mm/dd/yyyy placeholder', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<UploadPage />);

    await chooseFile(user);
    await screen.findByLabelText(/appointment/i);

    // A date input always renders mm/dd/yyyy, so there is no empty state for
    // MUI to detect: without an explicit shrink the label sits on top of it.
    const label = [...container.querySelectorAll('label')]
      .find((l) => /appointment/i.test(l.textContent));
    expect(label.className).toMatch(/MuiInputLabel-shrink/);
  });

  it('shows the chosen filename so the user can confirm the image', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UploadPage />);

    await chooseFile(user, pngFile('patient-42-pano.png'));

    expect(await screen.findByText(/patient-42-pano\.png/)).toBeInTheDocument();
  });

  it('rejects a non-image file', async () => {
    renderWithProviders(<UploadPage />);
    const input = document.querySelector('input[type="file"]');

    // userEvent.upload honours the input's accept="image/*" and drops a PDF
    // before onChange fires, so it cannot exercise this guard. Fire the change
    // directly — which is also the path a drag-and-drop takes, where the
    // browser does not filter by accept.
    const pdf = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [pdf], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(/not an image/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/patient name/i)).not.toBeInTheDocument();
  });

  it('will not submit without a patient name', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi();
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.click(await screen.findByRole('button', { name: /next|analyse|analyze/i }));

    expect(api.uploadXray).not.toHaveBeenCalled();
    expect(await screen.findByText(/name is required|enter.*name/i)).toBeInTheDocument();
  });

  it('submits the file with the patient details entered', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      uploadXray: vi.fn(async () => ({ xray_id: 77, status: 'PENDING' })),
      fetchXray: vi.fn(async () => ({ id: 77, status: 'PROCESSED', detections: [] })),
    });
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.type(await screen.findByLabelText(/patient name/i), 'Patient One');
    await user.type(screen.getByLabelText(/mrn|record number/i), 'MRN-9001');
    await user.click(screen.getByRole('button', { name: /next|analyse|analyze/i }));

    await waitFor(() => {
      expect(api.uploadXray).toHaveBeenCalledWith(
        expect.objectContaining({ patientName: 'Patient One', mrn: 'MRN-9001' }),
      );
    });
  });

  it('reports that analysis is running after submit', async () => {
    const user = userEvent.setup();
    // Never resolves, so the analysing state stays on screen to be asserted.
    const api = makeFakeApi({
      uploadXray: vi.fn(async () => ({ xray_id: 77, status: 'PENDING' })),
      fetchXray: vi.fn(() => new Promise(() => {})),
    });
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.type(await screen.findByLabelText(/patient name/i), 'Patient One');
    await user.click(screen.getByRole('button', { name: /next|analyse|analyze/i }));

    expect(await screen.findByText(/analysing|analyzing|processing/i)).toBeInTheDocument();
  });

  it('shows a failure message when detection fails', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      uploadXray: vi.fn(async () => ({ xray_id: 77, status: 'PENDING' })),
      fetchXray: vi.fn(async () => ({
        id: 77, status: 'ERROR', error_message: 'model file corrupt', detections: [],
      })),
    });
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.type(await screen.findByLabelText(/patient name/i), 'Patient One');
    await user.click(screen.getByRole('button', { name: /next|analyse|analyze/i }));

    expect(await screen.findByText(/model file corrupt/i)).toBeInTheDocument();
  });

  it('offers a link to the finished case on success', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      uploadXray: vi.fn(async () => ({ xray_id: 77, status: 'PENDING' })),
      fetchXray: vi.fn(async () => ({
        id: 77, status: 'PROCESSED', detections: [{ id: 1, source: 'detect' }],
      })),
    });
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.type(await screen.findByLabelText(/patient name/i), 'Patient One');
    await user.click(screen.getByRole('button', { name: /next|analyse|analyze/i }));

    const link = await screen.findByRole('link', { name: /review|open case/i });
    expect(link).toHaveAttribute('href', '/case/77');
  });

  it('lets the user start another case after finishing one', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      uploadXray: vi.fn(async () => ({ xray_id: 77, status: 'PENDING' })),
      fetchXray: vi.fn(async () => ({ id: 77, status: 'PROCESSED', detections: [] })),
    });
    renderWithProviders(<UploadPage />, { api });

    await chooseFile(user);
    await user.type(await screen.findByLabelText(/patient name/i), 'Patient One');
    await user.click(screen.getByRole('button', { name: /next|analyse|analyze/i }));

    await user.click(await screen.findByRole('button', { name: /another|new case|upload another/i }));

    expect(screen.queryByLabelText(/patient name/i)).not.toBeInTheDocument();
  });
});
