"""
db.py - Persistence layer for the SmileAI review portal.

Self-contained copy of the schema so dental_ai_app/ can be deployed on its own.
Mirrors the root database.py; if you change one, change both.

Lifecycle of an X-ray: PENDING -> PROCESSED -> APPROVED
  PENDING    ingested by the watcher, not yet run through the detector
  PROCESSED  detections stored, waiting for a doctor
  APPROVED   doctor signed off, referral PDF written

Schema changes go through Alembic (alembic/versions/). Edit the models here,
then `alembic revision --autogenerate -m "..."` and review the result -- never
hand-edit a database. init_db() applies pending revisions on startup.
"""

import os
from datetime import datetime
from typing import Generator

from sqlalchemy import (
    create_engine, Column, Integer, String, Boolean, DateTime, Float,
    ForeignKey, Text,
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "smileai.db")

# In AWS, DATABASE_URL points at RDS Postgres. Unset locally, so the SQLite
# file above is still used for development -- no behaviour change off-cloud.
DATABASE_URL = os.environ.get("DATABASE_URL") or f"sqlite:///{DB_FILE}"

_IS_SQLITE = DATABASE_URL.startswith("sqlite")

# check_same_thread=False: FastAPI serves requests from a threadpool.
# It is a SQLite-only argument and errors out on Postgres.
engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False} if _IS_SQLITE else {},
    # RDS closes idle connections; without pre-ping the app hands out a dead
    # socket and 500s after a quiet period.
    pool_pre_ping=not _IS_SQLITE,
)
Base = declarative_base()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

STATUS_PENDING = "PENDING"
STATUS_PROCESSED = "PROCESSED"
STATUS_APPROVED = "APPROVED"
STATUS_ERROR = "ERROR"

# Statuses that make up the unworked queue -- a case a clinician still has to
# decide on. PENDING is included so an ingest that has not finished inference yet
# is still visible rather than silently absent.
OPEN_STATUSES = (STATUS_PENDING, STATUS_PROCESSED)

ROLE_ADMIN = "ADMIN"
ROLE_ORTHODONTIST = "ORTHODONTIST"
ROLES = (ROLE_ADMIN, ROLE_ORTHODONTIST)

# Clinical decisions. NO_ACTION_NEEDED is a real decision that gets signed and
# timestamped like any other -- not the absence of one.
DECISION_EXTRACT = "EXTRACT"
DECISION_REFER = "REFER"
DECISION_MONITOR = "MONITOR"
DECISION_NO_ACTION = "NO_ACTION_NEEDED"
DECISIONS = (DECISION_EXTRACT, DECISION_REFER, DECISION_MONITOR, DECISION_NO_ACTION)


class Location(Base):
    """A practice location. Deactivated rather than deleted."""
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), unique=True, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    users = relationship("User", back_populates="primary_location")


class User(Base):
    """
    Admins and orthodontists share one table, distinguished by `role`.

    Orthodontist profile fields stay minimal -- name, primary location, active
    flag -- per the practice's requirement. Rows are never deleted, only
    deactivated, so past sign-offs always resolve to the clinician who made them.
    """
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(120), nullable=False)
    role = Column(String(20), nullable=False, default=ROLE_ORTHODONTIST)

    primary_location_id = Column(Integer, ForeignKey("locations.id"), nullable=True)

    is_active = Column(Boolean, default=True, nullable=False)
    deactivated_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.now)
    last_login_at = Column(DateTime, nullable=True)

    primary_location = relationship("Location", back_populates="users")
    prescriptions = relationship("Prescription", back_populates="clinician")
    assigned_xrays = relationship("XRay", foreign_keys="XRay.assigned_to_id",
                                  back_populates="assigned_to")
    signatures = relationship("Signature", back_populates="owner",
                              cascade="all, delete-orphan")


class Signature(Base):
    """
    A stored e-signature a clinician can reuse instead of re-drawing at every
    sign-off.

    A doctor may keep several -- a full legal signature, initials, one with
    credentials -- and picks per case, so this is a child table rather than a
    column on User. Exactly one may be `is_default`, which is the one the
    sign-off panel preloads.

    Deleting a signature only removes it from the picker. Prescription rows keep
    their own copy of the signature image at `Prescription.signature_path`, so a
    signed record never loses the mark it was signed with.
    """
    __tablename__ = "signatures"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    label = Column(String(60), nullable=False)
    file_path = Column(String(500), nullable=False)
    # 'upload' (image file) or 'drawn' (captured from the canvas). Kept for the
    # audit trail: how a signature entered the system is a compliance question.
    source = Column(String(10), nullable=False, default="upload")

    is_default = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    owner = relationship("User", back_populates="signatures")


class Prescription(Base):
    """
    A clinician's signed decision on one x-ray: who decided, what, when, and what
    they dictated. This is the auditable clinical record.

    Immutable once written -- a correction is a new row whose `amends_id` points
    at the superseded one, so the original decision and its timestamp survive.
    """
    __tablename__ = "prescriptions"

    id = Column(Integer, primary_key=True, index=True)
    xray_id = Column(Integer, ForeignKey("xrays.id"), nullable=False, index=True)

    # Attribution comes from the authenticated session, never the request body.
    clinician_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    # Snapshots of the clinician's name and location AS OF signing, so renaming
    # or relocating a user later cannot rewrite a historical record.
    clinician_name_snapshot = Column(String(120), nullable=False)
    location_name_snapshot = Column(String(120), nullable=True)

    decision = Column(String(30), nullable=False)  # one of DECISIONS
    prescription_text = Column(Text, nullable=True)
    # Kept apart from prescription_text so the raw dictation stays auditable even
    # if the clinician edits the note before signing.
    dictation_text = Column(Text, nullable=True)

    signature_path = Column(String(500), nullable=True)
    pdf_path = Column(String(500), nullable=True)

    reviewed_at = Column(DateTime, nullable=True)   # when the case was opened
    signed_at = Column(DateTime, default=datetime.now, nullable=False)
    amends_id = Column(Integer, ForeignKey("prescriptions.id"), nullable=True)
    is_superseded = Column(Boolean, default=False, nullable=False)

    xray = relationship("XRay", back_populates="prescriptions")
    clinician = relationship("User", back_populates="prescriptions")


class AuditLog(Base):
    """
    Append-only record of security- and record-relevant events: logins, user
    administration, case views, sign-offs. Separate from Prescription so failed
    logins and read access are captured too.
    """
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    at = Column(DateTime, default=datetime.now, nullable=False, index=True)
    actor_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    actor_email = Column(String(255), nullable=True)  # kept even if user removed
    action = Column(String(60), nullable=False, index=True)
    target_type = Column(String(40), nullable=True)
    target_id = Column(String(40), nullable=True)
    detail = Column(Text, nullable=True)
    ip_address = Column(String(64), nullable=True)


class Patient(Base):
    __tablename__ = "patients"

    id = Column(Integer, primary_key=True, index=True)
    mrn = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=datetime.now)

    xrays = relationship("XRay", back_populates="patient", cascade="all, delete-orphan")


class XRay(Base):
    __tablename__ = "xrays"

    id = Column(Integer, primary_key=True, index=True)
    patient_id = Column(Integer, ForeignKey("patients.id"), nullable=False)
    original_filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    status = Column(String(20), default=STATUS_PENDING, index=True)

    # Panoramic pixel dimensions, needed to scale overlays in the browser
    # without the client re-reading the source image.
    image_width = Column(Integer, nullable=True)
    image_height = Column(Integer, nullable=True)

    # Appointment this X-ray was pulled for. Mahesh's RPA downloads 3 days
    # ahead, so the queue sorts on this rather than on ingest time.
    appointment_date = Column(String(20), nullable=True, index=True)

    uploaded_at = Column(DateTime, default=datetime.now)
    processed_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)

    # Optional admin override. NULL is the normal case: an unassigned case is
    # visible to every orthodontist in the shared queue and worked by whoever
    # claims it. When an admin does assign a case, it is directed to that one
    # doctor and drops out of everybody else's queue.
    assigned_to_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    assigned_at = Column(DateTime, nullable=True)
    assigned_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    # Review lock. A doctor claims a case to work it; while held, colleagues see
    # it as under review and cannot open or sign it. Released explicitly by the
    # holder, automatically on sign-off, or force-released by an admin -- there is
    # no time-based expiry, so a claim never lapses under a doctor mid-review.
    claimed_by_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    claimed_at = Column(DateTime, nullable=True)

    patient = relationship("Patient", back_populates="xrays")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id],
                               back_populates="assigned_xrays")
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
    claimed_by = relationship("User", foreign_keys=[claimed_by_id])
    detections = relationship("Detection", back_populates="xray", cascade="all, delete-orphan")
    referrals = relationship("ReferralSlip", back_populates="xray", cascade="all, delete-orphan")
    prescriptions = relationship("Prescription", back_populates="xray", cascade="all, delete-orphan")


class Detection(Base):
    """
    One detected tooth.

    needs_extraction is the DOCTOR's decision, not the model's — it defaults to
    False and only changes when a human ticks the box in the portal. Likewise
    impaction_type stays NULL until a model that actually classifies impaction
    fills it in. Nothing here is inferred from detection confidence.
    """
    __tablename__ = "detections"

    id = Column(Integer, primary_key=True, index=True)
    xray_id = Column(Integer, ForeignKey("xrays.id"), nullable=False, index=True)

    class_name = Column(String(50), nullable=False)   # raw model class, e.g. '3rd_Molar'
    # Which model produced this row: 'detect' (tooth/3rd-molar detector),
    # 'segment' (pathology seg model), or 'hier' (128-class full-dentition
    # model). Each tab filters on it so no model's output shows up under
    # another's heading.
    source = Column(String(10), nullable=False, default="detect", server_default="detect")
    # Pathology token from a hierarchical class name, e.g. 'deep caries'.
    # Model output for display; never drives needs_extraction.
    disease = Column(String(50), nullable=True)
    # Seg-model findings overlapping this tooth's box, as JSON:
    # [{"class_name": "Caries", "confidence": 0.82, "containment": 0.91}, ...].
    # Produced by joining the seg model's output onto tooth boxes spatially, so
    # a tooth row can name its own pathology. Correlation, not diagnosis — like
    # `disease`, it is display-only and never drives needs_extraction.
    findings_json = Column(Text, nullable=True)
    fdi_number = Column(String(10), nullable=True)    # e.g. '38'
    universal_number = Column(String(10), nullable=True)  # e.g. '17'
    quadrant = Column(String(30), nullable=True)      # Upper-Right, Lower-Left, ...

    bbox_json = Column(Text, nullable=False)          # "[x1, y1, x2, y2]" in source pixels
    polygon_json = Column(Text, nullable=True)        # segmentation mask, when available
    confidence = Column(Float, nullable=False)

    impaction_type = Column(String(50), nullable=True)
    needs_extraction = Column(Boolean, default=False, nullable=False)
    marked_by = Column(String(100), nullable=True)    # who ticked the box
    notes = Column(Text, nullable=True)

    xray = relationship("XRay", back_populates="detections")


class ReferralSlip(Base):
    __tablename__ = "referral_slips"

    id = Column(Integer, primary_key=True, index=True)
    xray_id = Column(Integer, ForeignKey("xrays.id"), nullable=False, index=True)
    prescription_id = Column(Integer, ForeignKey("prescriptions.id"), nullable=True)
    pdf_path = Column(String(500), nullable=False)
    doctor_name = Column(String(100), nullable=True)
    prescription_text = Column(Text, nullable=True)
    signature_path = Column(String(500), nullable=True)
    generated_at = Column(DateTime, default=datetime.now)

    xray = relationship("XRay", back_populates="referrals")


# The revision that captures the schema as it was just before Alembic was
# introduced. A database created by the old create_all() path is at exactly this
# point without knowing it, so it gets stamped here rather than upgraded -- see
# _stamp_legacy_database().
_BASELINE_REVISION = "2a9de32687b8"

ALEMBIC_INI = os.path.join(BASE_DIR, "alembic.ini")


def _alembic_config():
    """Alembic config pointed at this package, whatever the working directory.

    The app is started from systemd, Docker and the repo root at different
    times; resolving script_location relative to this file keeps all three
    working.
    """
    from alembic.config import Config

    cfg = Config(ALEMBIC_INI)
    cfg.set_main_option("script_location", os.path.join(BASE_DIR, "alembic"))
    # env.py reads the URL from this module, so nothing to set here.
    return cfg


def _stamp_legacy_database(connection) -> bool:
    """Mark a pre-Alembic database as being at the baseline revision.

    Databases built by the old create_all() path have most baseline tables but
    no alembic_version row. Running `upgrade` on one would fail at the first
    CREATE TABLE, so it is stamped instead and only later revisions apply.

    Stamping skips the baseline, so any table the legacy database never had --
    `signatures` on a deployment that predates reusable e-signatures -- would
    never be created by any revision. create_all() fills exactly those gaps: it
    only issues CREATE TABLE for tables that are absent and leaves existing ones
    untouched. Columns missing from tables that DO exist are not its problem;
    the revisions guard for those individually.

    Returns True if a stamp was written.
    """
    from alembic.migration import MigrationContext
    from sqlalchemy import inspect

    context = MigrationContext.configure(connection)
    if context.get_current_revision() is not None:
        return False  # Already under Alembic control.

    tables = set(inspect(connection).get_table_names())
    if "users" not in tables:
        return False  # Genuinely empty; upgrade will build it from scratch.

    missing = {t for t in Base.metadata.tables if t not in tables}
    if missing:
        Base.metadata.create_all(bind=connection, checkfirst=True)
        print(f"[db] created tables absent from the legacy schema: "
              f"{sorted(missing)}")

    from alembic.script import ScriptDirectory
    script = ScriptDirectory.from_config(_alembic_config())
    context.stamp(script, _BASELINE_REVISION)
    print(f"[db] existing schema detected; stamped as {_BASELINE_REVISION}")
    return True


def init_db() -> None:
    """Bring the database up to the latest revision.

    Replaces the old create_all() + hand-rolled ALTER TABLE pair. Alembic owns
    the schema now, which is why this can add indexes and foreign keys -- things
    ALTER TABLE ADD COLUMN could never do, and which the legacy path silently
    skipped (see revision 1d1fe49baabb).

    Safe to run on every boot: it is a no-op once the database is at head.
    """
    from alembic import command

    with engine.begin() as connection:
        _stamp_legacy_database(connection)

    command.upgrade(_alembic_config(), "head")


def get_db_session() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    print(f"[db] Schema at head for {DATABASE_URL}")
