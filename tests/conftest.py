"""
Shared pytest fixtures for the SmileAI backend.

Two things must be true before `main` is imported, and both are handled here:

  1. DATABASE_URL points at a throwaway SQLite file, so a test run never
     touches the developer's smileai.db.
  2. DATA_DIR points into tmp_path, so uploads, referral PDFs and annotated
     images are written somewhere disposable.

The YOLO models are never loaded. `main.upload` imports `predict_all` from
`inference` at call time rather than at module scope, which lets the
`fake_inference` fixture substitute a stub without ultralytics on the path.
"""

import json
import os
import sys
import types
from pathlib import Path

import pytest

# The app modules use flat imports ("from db import ..."), so the package
# directory itself has to be importable.
APP_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP_DIR))


def _stub_absent_cv_modules():
    """
    Stand in for cv2 / ultralytics when they are not installed.

    main.py imports `annotator` at module scope, and annotator imports cv2, so
    without this the whole suite fails to collect on a machine without OpenCV.
    Nothing under test draws boxes or runs a model: annotation is best-effort in
    the approve path, and inference is replaced by the `fake_inference` fixture.
    A real install is always preferred and takes precedence.
    """
    try:
        import cv2  # noqa: F401
    except ImportError:
        cv2_stub = types.ModuleType("cv2")
        cv2_stub.FONT_HERSHEY_SIMPLEX = 0
        cv2_stub.LINE_AA = 16
        for fn in ("imread", "imwrite", "rectangle", "putText", "circle",
                   "line", "addWeighted", "getTextSize", "fillPoly",
                   "polylines", "resize"):
            setattr(cv2_stub, fn, lambda *a, **k: None)
        sys.modules["cv2"] = cv2_stub

    try:
        import ultralytics  # noqa: F401
    except ImportError:
        ultra = types.ModuleType("ultralytics")

        class _YOLO:
            def __init__(self, *a, **k):
                raise RuntimeError("ultralytics is stubbed out in tests")

        ultra.YOLO = _YOLO
        sys.modules["ultralytics"] = ultra


_stub_absent_cv_modules()


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """Point the app at a disposable database and data directory."""
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    # Pin the session secret. auth.py generates a random one when this is unset,
    # and it is regenerated on every module reload below -- which silently
    # invalidates the cookie any already-signed-in TestClient is holding, so a
    # second client in the same test would start 401ing mid-run.
    monkeypatch.setenv("SESSION_SECRET_KEY", "test-only-fixed-secret-do-not-ship")

    # db, main and auth read their env vars at import time. Drop them so the next
    # import picks up the values above instead of a cached engine. auth is
    # included because it caches the secret and the password context.
    for module in ("main", "db", "auth"):
        sys.modules.pop(module, None)

    return tmp_path


# ---------------------------------------------------------------------------
# Authentication
#
# Every /api route except /api/health and /api/login requires a session cookie.
# `anon_api` stays signed out so a test can assert a 401; every other client
# fixture arrives already authenticated.
# ---------------------------------------------------------------------------

TEST_PASSWORD = "TestPassw0rd!x"


def _make_user(client, email, role, full_name):
    """Insert an active user directly, hashing the password the way login expects."""
    from auth import hash_password

    db = client.db_module.SessionLocal()
    try:
        existing = (db.query(client.db_module.User)
                    .filter(client.db_module.User.email == email).first())
        if existing:
            return existing.id
        user = client.db_module.User(
            email=email,
            password_hash=hash_password(TEST_PASSWORD),
            full_name=full_name,
            role=role,
            is_active=True,
        )
        db.add(user)
        db.commit()
        return user.id
    finally:
        db.close()


def _sign_in(client, email):
    """Log the client in, leaving the session cookie on its cookie jar."""
    resp = client.post("/api/login", data={"email": email, "password": TEST_PASSWORD})
    assert resp.status_code == 200, f"login failed for {email}: {resp.text}"
    return resp


@pytest.fixture
def anon_api(app_env):
    """
    A signed-OUT TestClient, for asserting that endpoints require authentication.

    Every /api route except /api/health and /api/login returns 401 here.
    """
    from fastapi.testclient import TestClient

    import db as db_module
    import main as main_module

    db_module.init_db()

    with TestClient(main_module.app) as client:
        client.db_module = db_module
        client.main_module = main_module
        yield client


@pytest.fixture
def api(anon_api):
    """
    The default client, signed in as an ADMIN.

    Admin because that is the role the endpoints most tests exercise belong to --
    upload, delete, the practice-wide queue. Use `anon_api` to assert a 401, and
    `doctor_api` for anything role-scoped to a clinician.
    """
    _make_user(anon_api, "admin@test.local", anon_api.db_module.ROLE_ADMIN, "Test Admin")
    _sign_in(anon_api, "admin@test.local")
    return anon_api


@pytest.fixture
def session(api):
    """An open Session on the test database. Caller is responsible for commit."""
    db = api.db_module.SessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def admin_api(api):
    """Alias for `api`, which is already an admin. Reads clearly at call sites."""
    return api


@pytest.fixture
def doctor_api(api):
    """
    A SECOND client signed in as an orthodontist.

    A separate TestClient, not the `api` fixture re-authenticated: the shared-queue
    and review-lock tests need an admin and a doctor holding sessions at the same
    time, which one cookie jar cannot represent. Both clients talk to the same app
    and database.
    """
    from fastapi.testclient import TestClient

    uid = _make_user(api, "doctor@test.local",
                     api.db_module.ROLE_ORTHODONTIST, "Dr Test Ortho")
    client = TestClient(api.main_module.app)
    client.db_module = api.db_module
    client.main_module = api.main_module
    client.user_id = uid
    _sign_in(client, "doctor@test.local")
    return client


@pytest.fixture
def second_doctor_api(api):
    """Another orthodontist, for the colleague side of a review-lock conflict."""
    from fastapi.testclient import TestClient

    uid = _make_user(api, "doctor2@test.local",
                     api.db_module.ROLE_ORTHODONTIST, "Dr Second Ortho")
    client = TestClient(api.main_module.app)
    client.db_module = api.db_module
    client.main_module = api.main_module
    client.user_id = uid
    _sign_in(client, "doctor2@test.local")
    return client


@pytest.fixture
def fake_inference(api, monkeypatch):
    """
    Replace the detector with a deterministic stub.

    Returns the list of file paths it was called with, so a test can assert
    that inference ran (or did not run) without loading ultralytics.
    """
    calls = []

    def _predict_all(image_path):
        calls.append(image_path)
        return {
            "width": 1200,
            "height": 600,
            "num_detections": 2,
            "detections": [
                {
                    "class_name": "3rd_Molar", "source": "detect",
                    "fdi_number": "38", "universal_number": "17",
                    "quadrant": "Lower-Left", "bbox": [10, 20, 60, 80],
                    "polygon": None, "confidence": 0.91, "disease": None,
                },
                {
                    "class_name": "Tooth", "source": "detect",
                    "fdi_number": "36", "universal_number": "19",
                    "quadrant": "Lower-Left", "bbox": [90, 20, 140, 80],
                    "polygon": None, "confidence": 0.88, "disease": None,
                },
            ],
        }

    fake_module = type(sys)("inference")
    fake_module.predict_all = _predict_all
    monkeypatch.setitem(sys.modules, "inference", fake_module)
    return calls


@pytest.fixture
def png_bytes():
    """A minimal valid 1x1 PNG, enough for a non-empty upload body."""
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
        "z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
    )


@pytest.fixture
def make_case(api, session, png_bytes):
    """
    Seed a case directly in the database, bypassing upload and inference.

    Returns a factory: make_case(status=..., mrn=..., detections=N) -> XRay id.
    """
    db_module = api.db_module
    store = Path(os.environ["DATA_DIR"]) / "xray_store"
    store.mkdir(parents=True, exist_ok=True)
    counter = {"n": 0}

    def _make(status=None, mrn=None, name="Test Patient",
              appointment_date=None, detections=1, source="detect",
              fdi_number="38", write_file=True):
        counter["n"] += 1
        n = counter["n"]
        effective_mrn = mrn or f"MRN-{n:04d}"

        patient = (
            session.query(db_module.Patient)
            .filter(db_module.Patient.mrn == effective_mrn).first()
        )
        if not patient:
            patient = db_module.Patient(mrn=effective_mrn, name=name)
            session.add(patient)
            session.flush()

        image_path = store / f"case_{n}.png"
        if write_file:
            image_path.write_bytes(png_bytes)

        xray = db_module.XRay(
            patient_id=patient.id,
            original_filename=f"case_{n}.png",
            file_path=str(image_path),
            status=status or db_module.STATUS_PROCESSED,
            appointment_date=appointment_date,
            image_width=1200,
            image_height=600,
        )
        session.add(xray)
        session.flush()

        for i in range(detections):
            session.add(db_module.Detection(
                xray_id=xray.id,
                class_name="3rd_Molar" if fdi_number in ("18", "28", "38", "48") else "Tooth",
                source=source,
                fdi_number=fdi_number,
                quadrant="Lower-Left",
                bbox_json=json.dumps([10 + i * 80, 20, 60 + i * 80, 80]),
                confidence=0.9,
            ))
        session.commit()
        return xray.id

    return _make
