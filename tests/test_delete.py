"""
Deletion.

Both endpoints hard-delete: rows go via the cascade already declared on the
relationships, and the files they point at are unlinked from disk. These tests
assert both halves, because a row-only delete would silently leak radiographs
into the store forever.
"""

import os


class TestDeleteXray:
    def test_deletes_the_case_row(self, api, make_case, session):
        db = api.db_module
        xray_id = make_case()

        resp = api.delete(f"/api/xray/{xray_id}")
        assert resp.status_code == 200

        session.expire_all()
        assert session.query(db.XRay).filter(db.XRay.id == xray_id).first() is None

    def test_cascades_to_detections(self, api, make_case, session):
        db = api.db_module
        xray_id = make_case(detections=3)
        assert session.query(db.Detection).filter(db.Detection.xray_id == xray_id).count() == 3

        api.delete(f"/api/xray/{xray_id}")

        session.expire_all()
        assert session.query(db.Detection).filter(db.Detection.xray_id == xray_id).count() == 0

    def test_removes_the_stored_image_from_disk(self, api, make_case, session):
        db = api.db_module
        xray_id = make_case()
        path = session.query(db.XRay).filter(db.XRay.id == xray_id).first().file_path
        assert os.path.exists(path)

        api.delete(f"/api/xray/{xray_id}")

        assert not os.path.exists(path), "the radiograph must not be left in the store"

    def test_keeps_the_patient(self, api, make_case, session):
        """A patient may have other radiographs; deleting one case is not deleting them."""
        db = api.db_module
        first = make_case(mrn="MRN-KEEP")
        second = make_case(mrn="MRN-KEEP")

        api.delete(f"/api/xray/{first}")

        session.expire_all()
        patient = session.query(db.Patient).filter(db.Patient.mrn == "MRN-KEEP").first()
        assert patient is not None
        assert [x.id for x in patient.xrays] == [second]

    def test_survives_an_already_missing_file(self, api, make_case):
        """A case whose image was removed out-of-band must still be deletable."""
        xray_id = make_case(write_file=False)

        assert api.delete(f"/api/xray/{xray_id}").status_code == 200

    def test_deletes_referral_and_its_pdf(self, api, make_case, session, tmp_path):
        db = api.db_module
        xray_id = make_case(status=db.STATUS_APPROVED)
        pdf = tmp_path / "referral_del.pdf"
        pdf.write_bytes(b"%PDF-1.4 test")
        sig = tmp_path / "sig_del.png"
        sig.write_bytes(b"\x89PNG")
        session.add(db.ReferralSlip(
            xray_id=xray_id, pdf_path=str(pdf), signature_path=str(sig),
            doctor_name="Doctor One", prescription_text="Extract 38.",
        ))
        session.commit()

        resp = api.delete(f"/api/xray/{xray_id}")
        assert resp.status_code == 200

        session.expire_all()
        assert session.query(db.ReferralSlip).filter(
            db.ReferralSlip.xray_id == xray_id).count() == 0
        assert not pdf.exists(), "the signed PDF must be removed with the case"
        assert not sig.exists()

    def test_reports_what_it_deleted(self, api, make_case):
        xray_id = make_case(detections=4)

        body = api.delete(f"/api/xray/{xray_id}").json()
        assert body["xray_id"] == xray_id
        assert body["deleted_detections"] == 4

    def test_unknown_case_is_404(self, api):
        assert api.delete("/api/xray/999999").status_code == 404

    def test_deleted_case_leaves_the_queue(self, api, make_case):
        xray_id = make_case()
        assert any(i["id"] == xray_id for i in api.get("/api/queue").json()["items"])

        api.delete(f"/api/xray/{xray_id}")

        assert not any(i["id"] == xray_id for i in api.get("/api/queue").json()["items"])


class TestDeletePatient:
    def test_deletes_the_patient_and_every_xray(self, api, make_case, session):
        db = api.db_module
        make_case(mrn="MRN-GONE", name="Patient One")
        make_case(mrn="MRN-GONE", name="Patient One")

        resp = api.delete("/api/patients/MRN-GONE")
        assert resp.status_code == 200

        session.expire_all()
        assert session.query(db.Patient).filter(db.Patient.mrn == "MRN-GONE").first() is None
        assert session.query(db.XRay).count() == 0

    def test_removes_every_image_from_disk(self, api, make_case, session):
        db = api.db_module
        make_case(mrn="MRN-FILES")
        make_case(mrn="MRN-FILES")
        paths = [
            x.file_path for x in
            session.query(db.Patient).filter(db.Patient.mrn == "MRN-FILES").first().xrays
        ]
        assert all(os.path.exists(p) for p in paths)

        api.delete("/api/patients/MRN-FILES")

        assert not any(os.path.exists(p) for p in paths)

    def test_leaves_other_patients_untouched(self, api, make_case, session):
        db = api.db_module
        make_case(mrn="MRN-DEL")
        keeper = make_case(mrn="MRN-STAY")

        api.delete("/api/patients/MRN-DEL")

        session.expire_all()
        assert session.query(db.Patient).filter(db.Patient.mrn == "MRN-STAY").first() is not None
        assert session.query(db.XRay).filter(db.XRay.id == keeper).first() is not None

    def test_reports_what_it_deleted(self, api, make_case):
        make_case(mrn="MRN-COUNT", detections=2)
        make_case(mrn="MRN-COUNT", detections=3)

        body = api.delete("/api/patients/MRN-COUNT").json()
        assert body["mrn"] == "MRN-COUNT"
        assert body["deleted_xrays"] == 2
        assert body["deleted_detections"] == 5

    def test_unknown_patient_is_404(self, api):
        assert api.delete("/api/patients/MRN-NOBODY").status_code == 404

    def test_stats_reflect_the_deletion(self, api, make_case):
        make_case(mrn="MRN-STATS")
        make_case(mrn="MRN-STATS")
        assert api.get("/api/stats").json()["total"] == 2

        api.delete("/api/patients/MRN-STATS")

        stats = api.get("/api/stats").json()
        assert stats["total"] == 0
        assert stats["patients"] == 0
