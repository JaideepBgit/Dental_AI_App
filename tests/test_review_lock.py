"""
The shared queue and its review locks.

Two properties matter. Visibility: every orthodontist sees every case that is not
directed to a colleague, so work is never invisible. Exclusivity: only the doctor
holding the lock can sign, so a shared queue cannot produce two clinical records
for one radiograph.
"""

import io

import pytest


def _png_bytes():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (60, 20), (7, 7, 7)).save(buf, format="PNG")
    return buf.getvalue()


def _save_signature(client, label="Sig"):
    resp = client.post(
        "/api/signatures",
        files={"file": ("sig.png", _png_bytes(), "image/png")},
        data={"label": label},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _queue_ids(client, **params):
    resp = client.get("/api/queue", params=params)
    assert resp.status_code == 200, resp.text
    return [i["id"] for i in resp.json()["items"]]


def _row(client, xray_id):
    for item in client.get("/api/queue").json()["items"]:
        if item["id"] == xray_id:
            return item
    return None


class TestSharedQueueVisibility:
    def test_unclaimed_cases_are_visible_to_every_doctor(
            self, make_case, doctor_api, second_doctor_api):
        """The core of Mahesh's ask: no admin assignment needed to see work."""
        case_id = make_case()
        assert case_id in _queue_ids(doctor_api)
        assert case_id in _queue_ids(second_doctor_api)

    def test_a_claimed_case_stays_visible_to_colleagues(
            self, make_case, doctor_api, second_doctor_api):
        """Visible but flagged -- hiding it would conceal work that exists."""
        case_id = make_case()
        assert doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 200

        assert case_id in _queue_ids(second_doctor_api)
        row = _row(second_doctor_api, case_id)
        assert row["claimed_by"] == "Dr Test Ortho"
        assert row["claimed_by_me"] is False
        assert "under review" in row["blocked_reason"].lower()

    def test_the_holder_sees_the_case_as_their_own(self, make_case, doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        row = _row(doctor_api, case_id)
        assert row["claimed_by_me"] is True
        # Their own claim must never read as a block against themselves.
        assert row["blocked_reason"] is None

    def test_admin_assignment_hides_the_case_from_other_doctors(
            self, make_case, admin_api, doctor_api, second_doctor_api):
        """Assignment survives as an override: a directed case goes to one doctor."""
        case_id = make_case()
        target = doctor_api.get("/api/me").json()["id"]
        resp = admin_api.post(f"/api/admin/xray/{case_id}/assign",
                              data={"user_id": target})
        assert resp.status_code == 200, resp.text

        assert case_id in _queue_ids(doctor_api)
        assert case_id not in _queue_ids(second_doctor_api)

    def test_mine_filter_narrows_to_held_cases(self, make_case, doctor_api):
        held = make_case()
        make_case()  # left unclaimed, must drop out under ?mine=true
        doctor_api.post(f"/api/xray/{held}/claim")

        assert _queue_ids(doctor_api, mine="true") == [held]


class TestClaiming:
    def test_claiming_an_unclaimed_case_succeeds(self, make_case, doctor_api):
        case_id = make_case()
        resp = doctor_api.post(f"/api/xray/{case_id}/claim")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["claimed_by"] == "Dr Test Ortho"
        assert body["already_held"] is False

    def test_reclaiming_your_own_case_is_idempotent(self, make_case, doctor_api):
        """A refreshed tab or double-click must not be an error."""
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        resp = doctor_api.post(f"/api/xray/{case_id}/claim")
        assert resp.status_code == 200
        assert resp.json()["already_held"] is True

    def test_a_colleagues_case_cannot_be_claimed(
            self, make_case, doctor_api, second_doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = second_doctor_api.post(f"/api/xray/{case_id}/claim")
        assert resp.status_code == 409
        # Naming the holder is deliberate: on a shared queue you need to know
        # who to ask for a hand-over.
        assert "Dr Test Ortho" in resp.json()["detail"]

    def test_a_case_assigned_elsewhere_cannot_be_claimed(
            self, make_case, admin_api, doctor_api, second_doctor_api):
        case_id = make_case()
        target = doctor_api.get("/api/me").json()["id"]
        admin_api.post(f"/api/admin/xray/{case_id}/assign", data={"user_id": target})

        resp = second_doctor_api.post(f"/api/xray/{case_id}/claim")
        assert resp.status_code == 403

    def test_an_admin_cannot_claim(self, make_case, admin_api):
        """Admins do not review; require_orthodontist must reject them."""
        case_id = make_case()
        assert admin_api.post(f"/api/xray/{case_id}/claim").status_code == 403

    def test_claiming_a_missing_case_is_404(self, doctor_api):
        assert doctor_api.post("/api/xray/999999/claim").status_code == 404


class TestReleasing:
    def test_the_holder_can_release(self, make_case, doctor_api, second_doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = doctor_api.post(f"/api/xray/{case_id}/release")
        assert resp.status_code == 200
        assert resp.json()["released"] is True
        # Back in the pool, so a colleague can pick it up.
        assert second_doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 200

    def test_a_colleague_cannot_release_your_claim(
            self, make_case, doctor_api, second_doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = second_doctor_api.post(f"/api/xray/{case_id}/release")
        assert resp.status_code == 403

    def test_an_admin_can_force_release(self, make_case, admin_api, doctor_api):
        """Claims never expire, so an admin must be able to free an abandoned case."""
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = admin_api.post(f"/api/xray/{case_id}/release")
        assert resp.status_code == 200
        assert resp.json()["forced"] is True
        assert resp.json()["was_held_by"] == "Dr Test Ortho"

    def test_releasing_an_unclaimed_case_is_a_no_op(self, make_case, doctor_api):
        case_id = make_case()
        resp = doctor_api.post(f"/api/xray/{case_id}/release")
        assert resp.status_code == 200
        assert resp.json()["released"] is False


class TestAssignmentInteractsWithLocks:
    def test_assigning_elsewhere_drops_a_conflicting_claim(
            self, make_case, admin_api, doctor_api, second_doctor_api):
        """
        Otherwise the case is stranded: the holder can no longer open it, yet
        their claim still blocks the doctor it was just assigned to.
        """
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        other = second_doctor_api.get("/api/me").json()["id"]
        resp = admin_api.post(f"/api/admin/xray/{case_id}/assign", data={"user_id": other})
        assert resp.status_code == 200
        assert resp.json()["claim_dropped_from"] == "Dr Test Ortho"

        # The newly assigned doctor can now take it.
        assert second_doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 200

    def test_assigning_to_the_existing_holder_keeps_their_claim(
            self, make_case, admin_api, doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        target = doctor_api.get("/api/me").json()["id"]
        resp = admin_api.post(f"/api/admin/xray/{case_id}/assign", data={"user_id": target})
        assert resp.json()["claim_dropped_from"] is None
        assert _row(doctor_api, case_id)["claimed_by_me"] is True


class TestSigningRequiresTheLock:
    def _approve(self, client, case_id, signature_id, **extra):
        payload = {
            "xray_id": case_id,
            "decision": "MONITOR",
            "prescription_text": "Review at next recall.",
            "signature_id": signature_id,
        }
        payload.update(extra)
        return client.post("/api/approve", data=payload)

    def test_cannot_sign_without_claiming(self, make_case, doctor_api):
        case_id = make_case()
        sig = _save_signature(doctor_api)

        resp = self._approve(doctor_api, case_id, sig)
        assert resp.status_code == 409
        assert "claim this case" in resp.json()["detail"].lower()

    def test_can_sign_while_holding_the_lock(self, make_case, doctor_api):
        case_id = make_case()
        sig = _save_signature(doctor_api)
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = self._approve(doctor_api, case_id, sig)
        assert resp.status_code == 200, resp.text
        assert resp.json()["decision"] == "MONITOR"

    def test_signing_releases_the_lock(self, make_case, doctor_api):
        """A signed case holding a lock would read as work still in progress."""
        case_id = make_case()
        sig = _save_signature(doctor_api)
        doctor_api.post(f"/api/xray/{case_id}/claim")
        self._approve(doctor_api, case_id, sig)

        detail = doctor_api.get(f"/api/xray/{case_id}").json()
        assert detail["claimed_by_id"] is None
        assert detail["status"] == "APPROVED"

    def test_a_colleague_cannot_sign_a_case_you_hold(
            self, make_case, doctor_api, second_doctor_api):
        """The double-signing the lock exists to prevent."""
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        their_sig = _save_signature(second_doctor_api)

        resp = self._approve(second_doctor_api, case_id, their_sig)
        # Blocked at the access check, before the claim check.
        assert resp.status_code == 403

    def test_cannot_sign_with_another_clinicians_signature(
            self, make_case, doctor_api, second_doctor_api):
        """Signing as somebody else must be impossible, not merely discouraged."""
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        theirs = _save_signature(second_doctor_api, label="Theirs")

        resp = self._approve(doctor_api, case_id, theirs)
        assert resp.status_code == 404

    def test_signing_needs_a_signature(self, make_case, doctor_api):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")

        resp = doctor_api.post("/api/approve", data={
            "xray_id": case_id,
            "decision": "MONITOR",
            "prescription_text": "Review at next recall.",
        })
        assert resp.status_code == 400

    def test_a_saved_signature_is_copied_not_referenced(self, make_case, doctor_api):
        """
        Deleting a reusable signature must not alter an already-signed record, so
        the prescription gets its own copy of the image at signing time.
        """
        case_id = make_case()
        sig = _save_signature(doctor_api)
        doctor_api.post(f"/api/xray/{case_id}/claim")
        assert self._approve(doctor_api, case_id, sig).status_code == 200

        # Read the stored path before deleting the reusable signature.
        import os

        from db import Prescription, SessionLocal

        db = SessionLocal()
        try:
            presc = db.query(Prescription).filter(Prescription.xray_id == case_id).first()
            stored = presc.signature_path
        finally:
            db.close()

        assert stored and os.path.exists(stored)
        assert doctor_api.delete(f"/api/signatures/{sig}").status_code == 200
        # The prescription's own copy survives the delete.
        assert os.path.exists(stored)
