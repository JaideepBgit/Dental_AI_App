"""
Permission boundaries, end to end.

These assert the rules that must hold no matter what the UI does: an anonymous
caller reaches nothing, a doctor cannot administer, an admin cannot sign, and a
review lock genuinely serialises signing. They exist because the frontend gates
the same rules for usability -- and a UI-only gate is not a permission.
"""

import io
import json
import threading

import pytest

ANON_PROTECTED = [
    "/api/queue",
    "/api/stats",
    "/api/signatures",
    "/api/patients",
    "/api/referrals",
    "/api/admin/users",
    "/api/admin/audit",
    "/api/admin/locations",
]


def _png():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (50, 20), (3, 3, 3)).save(buf, format="PNG")
    return buf.getvalue()


def _save_sig(client, label="Sig"):
    resp = client.post("/api/signatures",
                       files={"file": ("s.png", _png(), "image/png")},
                       data={"label": label})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


class TestAnonymousIsLockedOut:
    @pytest.mark.parametrize("path", ANON_PROTECTED)
    def test_protected_get_returns_401(self, anon_api, path):
        assert anon_api.get(path).status_code == 401

    def test_health_stays_public(self, anon_api):
        """The one endpoint a load balancer must reach without a session."""
        assert anon_api.get("/api/health").status_code == 200

    def test_cannot_claim_or_sign(self, anon_api):
        """
        The case id is hardcoded rather than seeded via `make_case`: that fixture
        pulls in `api`, which signs the shared client in as an admin, so the
        "anonymous" client would no longer be anonymous. A nonexistent id is fine
        here because auth is checked before the row is looked up -- which is
        exactly the ordering being asserted.
        """
        assert anon_api.post("/api/xray/1/claim").status_code == 401
        assert anon_api.post("/api/xray/1/release").status_code == 401
        assert anon_api.post("/api/approve", data={
            "xray_id": 1, "decision": "MONITOR",
            "prescription_text": "x", "signature": "data:image/png;base64,x",
        }).status_code == 401


class TestDoctorCannotAdminister:
    def test_admin_endpoints_are_forbidden(self, doctor_api, make_case):
        case_id = make_case()
        assert doctor_api.get("/api/admin/users").status_code == 403
        assert doctor_api.get("/api/admin/audit").status_code == 403
        assert doctor_api.get("/api/admin/locations").status_code == 403
        assert doctor_api.delete(f"/api/xray/{case_id}").status_code == 403
        assert doctor_api.post(
            "/api/upload", files={"file": ("a.png", _png(), "image/png")}
        ).status_code == 403

    def test_cannot_assign_cases(self, doctor_api, second_doctor_api, make_case):
        """Assignment routes work, so it must be an admin doing the routing."""
        case_id = make_case()
        target = second_doctor_api.get("/api/me").json()["id"]
        assert doctor_api.post(f"/api/admin/xray/{case_id}/assign",
                               data={"user_id": target}).status_code == 403
        assert doctor_api.post("/api/admin/assign_bulk", data={
            "xray_ids": json.dumps([case_id]), "user_id": target,
        }).status_code == 403


class TestAdminCannotSign:
    """Signing is a clinical act. An admin administers; they never prescribe."""

    def test_admin_cannot_claim(self, admin_api, make_case):
        case_id = make_case()
        assert admin_api.post(f"/api/xray/{case_id}/claim").status_code == 403

    def test_admin_cannot_approve(self, admin_api, make_case):
        import base64

        case_id = make_case()
        drawn = "data:image/png;base64," + base64.b64encode(_png()).decode()
        assert admin_api.post("/api/approve", data={
            "xray_id": case_id, "decision": "MONITOR",
            "prescription_text": "x", "signature": drawn,
        }).status_code == 403


class TestDeactivationRevokesAccessImmediately:
    def test_deactivated_doctor_is_signed_out(self, admin_api, doctor_api, make_case):
        """
        Role and active status are re-read per request, so deactivating a user
        must not wait for their cookie to expire.
        """
        make_case()
        assert doctor_api.get("/api/queue").status_code == 200

        uid = doctor_api.get("/api/me").json()["id"]
        assert admin_api.delete(f"/api/admin/users/{uid}").status_code == 200

        assert doctor_api.get("/api/queue").status_code == 401

    def test_their_claim_survives_and_admin_can_free_it(
            self, admin_api, doctor_api, second_doctor_api, make_case):
        """A doctor off-shift holding a case must not strand it forever."""
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        uid = doctor_api.get("/api/me").json()["id"]
        admin_api.delete(f"/api/admin/users/{uid}")

        # The lock outlives the session -- otherwise deactivation would silently
        # hand a half-reviewed case to someone else.
        assert second_doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 409
        assert admin_api.post(f"/api/xray/{case_id}/release").status_code == 200
        assert second_doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 200


class TestApproveRejectsTamperedInput:
    def _sign(self, client, case_id, sig, **extra):
        payload = {"xray_id": case_id, "decision": "MONITOR",
                   "prescription_text": "Recall.", "signature_id": sig}
        payload.update(extra)
        return client.post("/api/approve", data=payload)

    @pytest.fixture
    def held_case(self, doctor_api, make_case):
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        return case_id

    def test_unknown_decision(self, doctor_api, held_case):
        sig = _save_sig(doctor_api)
        assert self._sign(doctor_api, held_case, sig, decision="DESTROY").status_code == 400

    def test_blank_note(self, doctor_api, held_case):
        sig = _save_sig(doctor_api)
        assert self._sign(doctor_api, held_case, sig,
                          prescription_text="   ").status_code == 400

    def test_detection_id_from_another_case(self, doctor_api, held_case):
        sig = _save_sig(doctor_api)
        assert self._sign(doctor_api, held_case, sig, decision="EXTRACT",
                          extraction_ids=json.dumps([999999])).status_code == 400

    def test_no_action_cannot_carry_extractions(self, doctor_api, held_case):
        """A record saying "nothing to do" plus teeth to pull is self-contradictory."""
        sig = _save_sig(doctor_api)
        detail = doctor_api.get(f"/api/xray/{held_case}").json()
        real_id = detail["detections"][0]["id"]
        assert self._sign(doctor_api, held_case, sig, decision="NO_ACTION_NEEDED",
                          extraction_ids=json.dumps([real_id])).status_code == 400

    def test_unknown_signature_id(self, doctor_api, held_case):
        assert self._sign(doctor_api, held_case, 999999).status_code == 404


class TestSignatureUploadIsValidated:
    def test_rejects_a_disguised_binary(self, doctor_api):
        """A .png extension is not proof; the bytes must decode as an image."""
        resp = doctor_api.post("/api/signatures",
                               files={"file": ("s.png", b"MZ\x90\x00evil", "image/png")},
                               data={"label": "exe"})
        assert resp.status_code == 400

    def test_rejects_svg(self, doctor_api):
        """SVG can carry script, and is not in the allowed set."""
        resp = doctor_api.post("/api/signatures",
                               files={"file": ("s.svg", b"<svg/>", "image/svg+xml")},
                               data={"label": "svg"})
        assert resp.status_code == 400

    def test_rejects_an_oversized_image(self, doctor_api):
        payload = b"\x89PNG\r\n\x1a\n" + b"0" * (3 * 1024 * 1024)
        resp = doctor_api.post("/api/signatures",
                               files={"file": ("s.png", payload, "image/png")},
                               data={"label": "big"})
        assert resp.status_code in (400, 413)

    def test_rejects_an_overlong_label(self, doctor_api):
        resp = doctor_api.post("/api/signatures",
                               files={"file": ("s.png", _png(), "image/png")},
                               data={"label": "x" * 61})
        assert resp.status_code == 400


class TestAmendmentRequiresAFreshClaim:
    def test_full_amendment_cycle(self, doctor_api, make_case):
        """
        Signing releases the lock, so amending needs it back. The original record
        must survive as superseded rather than being overwritten.
        """
        case_id = make_case()
        sig = _save_sig(doctor_api)
        doctor_api.post(f"/api/xray/{case_id}/claim")

        first = doctor_api.post("/api/approve", data={
            "xray_id": case_id, "decision": "MONITOR",
            "prescription_text": "first", "signature_id": sig})
        assert first.status_code == 200
        pid = first.json()["prescription_id"]

        amend = {"xray_id": case_id, "decision": "EXTRACT",
                 "prescription_text": "amended", "signature_id": sig, "amends_id": pid}
        assert doctor_api.post("/api/approve", data=amend).status_code == 409

        assert doctor_api.post(f"/api/xray/{case_id}/claim").status_code == 200
        assert doctor_api.post("/api/approve", data=amend).status_code == 200

        history = doctor_api.get(f"/api/xray/{case_id}").json()["prescription_history"]
        assert len(history) == 2
        assert history[0]["prescription_text"] == "first"
        assert history[0]["is_superseded"] is True


class TestAuditTrailRecords:
    def test_lock_and_signing_events_are_logged(
            self, admin_api, doctor_api, make_case):
        """
        A self-release is logged distinctly from an admin force-release: "the
        doctor handed it back" and "an admin took it away" are different events.
        """
        case_id = make_case()
        doctor_api.post(f"/api/xray/{case_id}/claim")
        doctor_api.post(f"/api/xray/{case_id}/release")

        other = make_case()
        doctor_api.post(f"/api/xray/{other}/claim")
        admin_api.post(f"/api/xray/{other}/release")

        actions = {r["action"] for r in admin_api.get("/api/admin/audit?limit=500").json()}
        assert "XRAY_CLAIMED" in actions
        assert "XRAY_RELEASED" in actions
        assert "XRAY_FORCE_RELEASED" in actions


class TestConcurrentDoctorsCannotDoubleSign:
    """
    The property the whole lock exists for. A shared queue means simultaneous
    clicks are normal, not exotic, so this races real threads rather than
    trusting the sequential path.
    """

    def _make_doctors(self, api, count):
        from fastapi.testclient import TestClient

        from conftest import TEST_PASSWORD, _make_user, _sign_in

        clients = []
        for i in range(count):
            email = f"race{i}@test.local"
            _make_user(api, email, api.db_module.ROLE_ORTHODONTIST, f"Dr Race {i}")
            client = TestClient(api.main_module.app)
            client.db_module = api.db_module
            client.main_module = api.main_module
            _sign_in(client, email)
            clients.append(client)
        return clients

    def test_only_one_doctor_wins_the_claim(self, api, make_case):
        case_id = make_case()
        doctors = self._make_doctors(api, 5)
        results = [None] * len(doctors)

        def claim(i):
            results[i] = doctors[i].post(f"/api/xray/{case_id}/claim").status_code

        threads = [threading.Thread(target=claim, args=(i,)) for i in range(len(doctors))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(200) == 1, results
        assert results.count(409) == len(doctors) - 1, results

    def test_only_one_prescription_is_written(self, api, make_case):
        case_id = make_case()
        doctors = self._make_doctors(api, 5)
        sigs = [_save_sig(d, f"S{i}") for i, d in enumerate(doctors)]

        # Everyone claims first; exactly one holds the lock afterwards.
        for d in doctors:
            d.post(f"/api/xray/{case_id}/claim")

        results = [None] * len(doctors)

        def sign(i):
            results[i] = doctors[i].post("/api/approve", data={
                "xray_id": case_id, "decision": "MONITOR",
                "prescription_text": f"note {i}", "signature_id": sigs[i],
            }).status_code

        threads = [threading.Thread(target=sign, args=(i,)) for i in range(len(doctors))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(200) == 1, results

        db = api.db_module.SessionLocal()
        try:
            total = (db.query(api.db_module.Prescription)
                     .filter(api.db_module.Prescription.xray_id == case_id).count())
        finally:
            db.close()
        # One radiograph, one clinical record -- the whole point of the lock.
        assert total == 1
