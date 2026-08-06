"""
Queue and stats.

The queue currently hides PENDING cases, so a case being processed is invisible
between upload and completion. The dashboard needs aggregate counts that no
endpoint provides yet.
"""


class TestQueueContents:
    def test_empty_queue(self, api):
        body = api.get("/api/queue").json()
        assert body["count"] == 0
        assert body["items"] == []

    def test_includes_pending_cases(self, api, make_case):
        db = api.db_module
        make_case(status=db.STATUS_PENDING, name="Waiting Patient")

        body = api.get("/api/queue").json()
        statuses = [i["status"] for i in body["items"]]
        assert db.STATUS_PENDING in statuses, "a case being processed must be visible"

    def test_includes_processed_error_and_approved(self, api, make_case):
        db = api.db_module
        make_case(status=db.STATUS_PROCESSED)
        make_case(status=db.STATUS_ERROR)
        make_case(status=db.STATUS_APPROVED)

        body = api.get("/api/queue").json()
        statuses = {i["status"] for i in body["items"]}
        assert statuses == {db.STATUS_PROCESSED, db.STATUS_ERROR, db.STATUS_APPROVED}

    def test_include_approved_false_excludes_signed_cases(self, api, make_case):
        db = api.db_module
        make_case(status=db.STATUS_PROCESSED)
        make_case(status=db.STATUS_APPROVED)

        body = api.get("/api/queue?include_approved=false").json()
        statuses = {i["status"] for i in body["items"]}
        assert db.STATUS_APPROVED not in statuses
        assert db.STATUS_PROCESSED in statuses

    def test_filters_by_status(self, api, make_case):
        db = api.db_module
        make_case(status=db.STATUS_PROCESSED)
        make_case(status=db.STATUS_ERROR)

        body = api.get(f"/api/queue?status={db.STATUS_ERROR}").json()
        assert body["count"] == 1
        assert body["items"][0]["status"] == db.STATUS_ERROR

    def test_searches_by_patient_name(self, api, make_case):
        make_case(name="Patient One", mrn="MRN-A")
        make_case(name="Patient Three", mrn="MRN-B")

        body = api.get("/api/queue?search=patient").json()
        assert body["count"] == 1
        assert body["items"][0]["patient_name"] == "Patient One"

    def test_searches_by_mrn(self, api, make_case):
        make_case(name="Patient One", mrn="MRN-FINDME")
        make_case(name="Patient Three", mrn="MRN-OTHER")

        body = api.get("/api/queue?search=FINDME").json()
        assert body["count"] == 1
        assert body["items"][0]["mrn"] == "MRN-FINDME"

    def test_sorts_soonest_appointment_first(self, api, make_case):
        make_case(name="Later", appointment_date="2026-09-01")
        make_case(name="Sooner", appointment_date="2026-08-10")
        make_case(name="Undated", appointment_date=None)

        items = api.get("/api/queue").json()["items"]
        assert [i["patient_name"] for i in items] == ["Sooner", "Later", "Undated"]

    def test_counts_only_detector_rows_in_teeth_total(self, api, make_case):
        """Segmentation rows must not inflate the queue's tooth badge."""
        xray_id = make_case(detections=2, source="detect")
        db = api.db_module
        s = api.db_module.SessionLocal()
        try:
            import json as _json
            s.add(db.Detection(
                xray_id=xray_id, class_name="caries", source="segment",
                bbox_json=_json.dumps([0, 0, 5, 5]), confidence=0.7,
            ))
            s.commit()
        finally:
            s.close()

        item = next(i for i in api.get("/api/queue").json()["items"] if i["id"] == xray_id)
        assert item["num_detections"] == 2


class TestQueueStats:
    """Aggregate counts for the dashboard landing page."""

    def test_stats_endpoint_reports_counts_per_status(self, api, make_case):
        db = api.db_module
        make_case(status=db.STATUS_PENDING)
        make_case(status=db.STATUS_PROCESSED)
        make_case(status=db.STATUS_PROCESSED)
        make_case(status=db.STATUS_APPROVED)
        make_case(status=db.STATUS_ERROR)

        body = api.get("/api/stats").json()
        assert body["pending"] == 1
        assert body["awaiting_review"] == 2
        assert body["approved"] == 1
        assert body["failed"] == 1
        assert body["total"] == 5

    def test_stats_on_empty_database(self, api):
        body = api.get("/api/stats").json()
        assert body == {
            "pending": 0, "awaiting_review": 0, "approved": 0,
            "failed": 0, "total": 0, "third_molars_flagged": 0,
            "patients": 0,
        }

    def test_stats_counts_third_molars(self, api, make_case):
        make_case(detections=1, fdi_number="38")
        make_case(detections=1, fdi_number="36")

        body = api.get("/api/stats").json()
        assert body["third_molars_flagged"] == 1

    def test_stats_counts_distinct_patients(self, api, make_case):
        make_case(mrn="MRN-P1")
        make_case(mrn="MRN-P1")
        make_case(mrn="MRN-P2")

        assert api.get("/api/stats").json()["patients"] == 2


class TestPatientEndpoints:
    """The Patient table has no API at all; the patients page needs one."""

    def test_lists_patients_with_case_counts(self, api, make_case):
        make_case(mrn="MRN-X", name="Patient One")
        make_case(mrn="MRN-X", name="Patient One")
        make_case(mrn="MRN-Y", name="Patient Three")

        body = api.get("/api/patients").json()
        by_mrn = {p["mrn"]: p for p in body["items"]}
        assert by_mrn["MRN-X"]["num_xrays"] == 2
        assert by_mrn["MRN-Y"]["num_xrays"] == 1

    def test_patient_detail_lists_their_xrays(self, api, make_case):
        make_case(mrn="MRN-DETAIL", name="Patient One", appointment_date="2026-08-10")
        make_case(mrn="MRN-DETAIL", name="Patient One", appointment_date="2026-09-01")

        body = api.get("/api/patients/MRN-DETAIL").json()
        assert body["name"] == "Patient One"
        assert len(body["xrays"]) == 2

    def test_unknown_patient_is_404(self, api):
        assert api.get("/api/patients/MRN-NOPE").status_code == 404


class TestReferralsList:
    def test_lists_signed_referrals(self, api, make_case, session):
        db = api.db_module
        xray_id = make_case(status=db.STATUS_APPROVED, name="Signed Patient")
        pdf = __import__("pathlib").Path(__import__("os").environ["DATA_DIR"]) / "ref.pdf"
        pdf.write_bytes(b"%PDF-1.4 test")
        session.add(db.ReferralSlip(
            xray_id=xray_id, pdf_path=str(pdf),
            doctor_name="Doctor One", prescription_text="Extract 38.",
        ))
        session.commit()

        body = api.get("/api/referrals").json()
        assert body["count"] == 1
        assert body["items"][0]["doctor_name"] == "Doctor One"
        assert body["items"][0]["patient_name"] == "Signed Patient"

    def test_empty_referrals_list(self, api):
        assert api.get("/api/referrals").json() == {"count": 0, "items": []}
