"""
Reusable clinician e-signatures.

The security property under test is ownership: a signature is a credential, so it
must be impossible to list, read, delete or sign with one belonging to another
clinician -- and a signed record must keep its own copy of the image so deleting
the reusable signature cannot alter history.
"""

import base64
import io
import os

import pytest


def _png_bytes(color=(10, 20, 30)):
    """A small real PNG. The endpoint verifies decodability, so this must be valid."""
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (60, 20), color).save(buf, format="PNG")
    return buf.getvalue()


def _upload(client, label="Full signature", make_default=False, data=None):
    return client.post(
        "/api/signatures",
        files={"file": ("sig.png", data or _png_bytes(), "image/png")},
        data={"label": label, "make_default": str(make_default).lower()},
    )


class TestCreateSignature:
    def test_uploads_an_image_signature(self, doctor_api):
        resp = _upload(doctor_api, label="Wet signature")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["label"] == "Wet signature"
        assert body["source"] == "upload"
        # First one saved is the default, so sign-off preloads it with no extra step.
        assert body["is_default"] is True

    def test_saves_a_drawn_signature(self, doctor_api):
        drawn = "data:image/png;base64," + base64.b64encode(_png_bytes()).decode()
        resp = doctor_api.post("/api/signatures",
                               data={"label": "Initials", "image_data": drawn})
        assert resp.status_code == 201, resp.text
        assert resp.json()["source"] == "drawn"

    def test_rejects_supplying_both_a_file_and_a_drawing(self, doctor_api):
        drawn = "data:image/png;base64," + base64.b64encode(_png_bytes()).decode()
        resp = doctor_api.post(
            "/api/signatures",
            files={"file": ("sig.png", _png_bytes(), "image/png")},
            data={"label": "Both", "image_data": drawn},
        )
        assert resp.status_code == 400
        assert "not both" in resp.json()["detail"].lower()

    def test_rejects_neither_file_nor_drawing(self, doctor_api):
        resp = doctor_api.post("/api/signatures", data={"label": "Empty"})
        assert resp.status_code == 400

    def test_rejects_a_blank_label(self, doctor_api):
        resp = _upload(doctor_api, label="   ")
        assert resp.status_code == 400

    def test_rejects_a_non_image_file(self, doctor_api):
        """An extension is not proof: the bytes have to decode as an image."""
        resp = doctor_api.post(
            "/api/signatures",
            files={"file": ("sig.png", b"this is not a png", "image/png")},
            data={"label": "Bogus"},
        )
        assert resp.status_code == 400
        assert "not a readable image" in resp.json()["detail"].lower()

    def test_rejects_an_unsupported_extension(self, doctor_api):
        resp = doctor_api.post(
            "/api/signatures",
            files={"file": ("sig.pdf", _png_bytes(), "application/pdf")},
            data={"label": "PDF"},
        )
        assert resp.status_code == 400
        assert "unsupported" in resp.json()["detail"].lower()

    def test_enforces_the_per_user_cap(self, doctor_api):
        from main import MAX_SIGNATURES_PER_USER

        for i in range(MAX_SIGNATURES_PER_USER):
            assert _upload(doctor_api, label=f"Sig {i}").status_code == 201
        resp = _upload(doctor_api, label="One too many")
        assert resp.status_code == 409

    def test_requires_authentication(self, anon_api):
        resp = _upload(anon_api)
        assert resp.status_code == 401


class TestDefaultSignature:
    def test_only_one_default_at_a_time(self, doctor_api):
        first = _upload(doctor_api, label="First").json()
        second = _upload(doctor_api, label="Second", make_default=True).json()

        items = {s["id"]: s for s in doctor_api.get("/api/signatures").json()["items"]}
        assert items[second["id"]]["is_default"] is True
        assert items[first["id"]]["is_default"] is False

    def test_promoting_via_patch_demotes_the_previous_default(self, doctor_api):
        first = _upload(doctor_api, label="First").json()
        second = _upload(doctor_api, label="Second").json()
        assert first["is_default"] is True

        resp = doctor_api.patch(f"/api/signatures/{second['id']}",
                                data={"make_default": "true"})
        assert resp.status_code == 200
        assert resp.json()["is_default"] is True

        items = {s["id"]: s for s in doctor_api.get("/api/signatures").json()["items"]}
        assert items[first["id"]]["is_default"] is False

    def test_deleting_the_default_promotes_another(self, doctor_api):
        """A clinician must never be silently left with no default."""
        first = _upload(doctor_api, label="First").json()
        second = _upload(doctor_api, label="Second").json()

        resp = doctor_api.delete(f"/api/signatures/{first['id']}")
        assert resp.status_code == 200
        assert resp.json()["promoted_id"] == second["id"]

        remaining = doctor_api.get("/api/signatures").json()["items"]
        assert [s["id"] for s in remaining] == [second["id"]]
        assert remaining[0]["is_default"] is True

    def test_renaming_keeps_the_default_flag(self, doctor_api):
        sig = _upload(doctor_api, label="Original").json()
        resp = doctor_api.patch(f"/api/signatures/{sig['id']}", data={"label": "Renamed"})
        assert resp.status_code == 200
        assert resp.json()["label"] == "Renamed"
        assert resp.json()["is_default"] is True


class TestSignatureIsolation:
    """A signature belonging to another clinician must be entirely unreachable."""

    def test_list_shows_only_your_own(self, doctor_api, second_doctor_api):
        _upload(doctor_api, label="Mine")
        _upload(second_doctor_api, label="Theirs")

        mine = doctor_api.get("/api/signatures").json()["items"]
        assert [s["label"] for s in mine] == ["Mine"]

    def test_cannot_read_another_clinicians_image(self, doctor_api, second_doctor_api):
        theirs = _upload(second_doctor_api, label="Theirs").json()
        # 404 not 403: whether that id exists is not this caller's business.
        assert doctor_api.get(f"/api/signatures/{theirs['id']}/image").status_code == 404

    def test_cannot_delete_another_clinicians_signature(self, doctor_api, second_doctor_api):
        theirs = _upload(second_doctor_api, label="Theirs").json()
        assert doctor_api.delete(f"/api/signatures/{theirs['id']}").status_code == 404
        # Still there for its owner.
        assert len(second_doctor_api.get("/api/signatures").json()["items"]) == 1

    def test_cannot_rename_another_clinicians_signature(self, doctor_api, second_doctor_api):
        theirs = _upload(second_doctor_api, label="Theirs").json()
        resp = doctor_api.patch(f"/api/signatures/{theirs['id']}", data={"label": "Hijacked"})
        assert resp.status_code == 404

    def test_own_image_is_served(self, doctor_api):
        sig = _upload(doctor_api).json()
        resp = doctor_api.get(f"/api/signatures/{sig['id']}/image")
        assert resp.status_code == 200
        # Never cached: a signature is credential-grade and a shared browser must
        # not retain it after sign-out.
        assert resp.headers["cache-control"] == "no-store"
