"""
Upload contract.

The intake page sends patient name, MRN and appointment date. These tests pin
that contract down, because the current frontend discards all three and the
regression would otherwise be invisible.
"""

import pytest


def _post(api, png_bytes, **fields):
    return api.post(
        "/api/upload",
        files={"file": ("pano.png", png_bytes, "image/png")},
        data=fields,
    )


class TestUploadPatientDetails:
    def test_stores_supplied_patient_name_and_mrn(self, api, fake_inference, png_bytes, session):
        resp = _post(api, png_bytes, patient_name="Patient One", mrn="MRN-9001")
        assert resp.status_code == 202

        xray_id = resp.json()["xray_id"]
        db = api.db_module
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.patient.name == "Patient One"
        assert xray.patient.mrn == "MRN-9001"

    def test_stores_appointment_date(self, api, fake_inference, png_bytes, session):
        resp = _post(
            api, png_bytes,
            patient_name="Patient Three", mrn="MRN-9002",
            appointment_date="2026-08-14",
        )
        xray_id = resp.json()["xray_id"]
        db = api.db_module
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.appointment_date == "2026-08-14"

    def test_reuses_existing_patient_for_repeat_mrn(self, api, fake_inference, png_bytes, session):
        first = _post(api, png_bytes, patient_name="Patient Two", mrn="MRN-SAME")
        second = _post(api, png_bytes, patient_name="Patient Two", mrn="MRN-SAME")
        assert first.status_code == second.status_code == 202

        db = api.db_module
        patients = session.query(db.Patient).filter(db.Patient.mrn == "MRN-SAME").all()
        assert len(patients) == 1, "a repeat MRN must attach to the same patient record"
        assert len(patients[0].xrays) == 2

    def test_generates_mrn_when_omitted(self, api, fake_inference, png_bytes, session):
        resp = _post(api, png_bytes, patient_name="Walk-in Patient")
        xray_id = resp.json()["xray_id"]
        db = api.db_module
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.patient.mrn.startswith("AUTO-")

    def test_rejects_empty_file(self, api, fake_inference, png_bytes):
        resp = api.post(
            "/api/upload",
            files={"file": ("empty.png", b"", "image/png")},
            data={"patient_name": "Nobody"},
        )
        assert resp.status_code == 400


class TestUploadIsAsynchronous:
    """
    The intake page must not block while YOLO runs. Upload should persist the
    case and return immediately with PENDING; a background task runs inference
    and moves it to PROCESSED.
    """

    def test_returns_pending_without_waiting_for_inference(self, api, png_bytes, session, monkeypatch):
        # Inference that would hang if it were awaited inline.
        import sys
        started = {"called": False}

        def _never_finishes(image_path):
            started["called"] = True
            raise AssertionError("inference must not run inside the request")

        fake = type(sys)("inference")
        fake.predict_all = _never_finishes
        monkeypatch.setitem(sys.modules, "inference", fake)
        # Suppress the background runner so only the request path is exercised.
        monkeypatch.setattr(api.main_module, "run_inference_for_xray", lambda *a, **k: None)

        resp = _post(api, png_bytes, patient_name="Async Patient", mrn="MRN-ASYNC")
        assert resp.status_code == 202
        body = resp.json()
        assert body["status"] == "PENDING"
        assert "xray_id" in body
        assert started["called"] is False

    def test_background_task_moves_case_to_processed(self, api, fake_inference, png_bytes, session):
        resp = _post(api, png_bytes, patient_name="Bg Patient", mrn="MRN-BG")
        xray_id = resp.json()["xray_id"]

        # TestClient runs BackgroundTasks synchronously on response teardown,
        # so by now inference has been applied.
        db = api.db_module
        session.expire_all()
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.status == db.STATUS_PROCESSED
        assert len(xray.detections) == 2
        assert fake_inference == [xray.file_path]

    def test_inference_failure_marks_case_error(self, api, png_bytes, session, monkeypatch):
        import sys
        fake = type(sys)("inference")

        def _boom(image_path):
            raise RuntimeError("model file corrupt")

        fake.predict_all = _boom
        monkeypatch.setitem(sys.modules, "inference", fake)

        resp = _post(api, png_bytes, patient_name="Doomed", mrn="MRN-FAIL")
        # The upload itself still succeeds; the case carries the failure.
        assert resp.status_code == 202
        xray_id = resp.json()["xray_id"]

        db = api.db_module
        session.expire_all()
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.status == db.STATUS_ERROR
        assert "model file corrupt" in (xray.error_message or "")


class TestRetryEndpoint:
    """A failed case must be re-runnable without re-uploading the image."""

    def test_retry_reruns_inference_on_errored_case(self, api, fake_inference, make_case, session):
        db = api.db_module
        xray_id = make_case(status=db.STATUS_ERROR, detections=0)

        resp = api.post(f"/api/xray/{xray_id}/retry")
        assert resp.status_code == 202

        session.expire_all()
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert xray.status == db.STATUS_PROCESSED
        assert xray.error_message is None
        assert len(xray.detections) == 2

    def test_retry_replaces_stale_detections(self, api, fake_inference, make_case, session):
        db = api.db_module
        xray_id = make_case(status=db.STATUS_ERROR, detections=3)

        api.post(f"/api/xray/{xray_id}/retry")

        session.expire_all()
        xray = session.query(db.XRay).filter(db.XRay.id == xray_id).first()
        assert len(xray.detections) == 2, "old rows must be cleared, not appended to"

    def test_retry_on_missing_case_is_404(self, api, fake_inference):
        assert api.post("/api/xray/999999/retry").status_code == 404
