"""
db.py - Persistence layer for the SmileAI review portal.

Self-contained copy of the schema so dental_ai_app/ can be deployed on its own.
Mirrors the root database.py; if you change one, change both.

Lifecycle of an X-ray: PENDING -> PROCESSED -> APPROVED
  PENDING    ingested by the watcher, not yet run through the detector
  PROCESSED  detections stored, waiting for a doctor
  APPROVED   doctor signed off, referral PDF written
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

    # Which orthodontist is responsible for this case. NULL means unassigned:
    # the case sits in the admin's pool and appears in no doctor's queue, so work
    # is never silently invisible to everyone.
    assigned_to_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    assigned_at = Column(DateTime, nullable=True)
    assigned_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)

    patient = relationship("Patient", back_populates="xrays")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id],
                               back_populates="assigned_xrays")
    assigned_by = relationship("User", foreign_keys=[assigned_by_id])
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


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


def _add_missing_columns() -> None:
    """
    Additive migration for columns introduced after a database was created.

    create_all() only ever creates missing *tables*, so an existing detections
    table would keep its old shape and every query naming a new column would
    fail. There is no Alembic in this project; ALTER TABLE ADD COLUMN is
    supported by both SQLite and Postgres and is safe to re-run.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    # SQLite accepts DATETIME; Postgres does not. Emit the right spelling for
    # whichever backend is attached, so an existing RDS database can be migrated
    # rather than only a freshly created one.
    timestamp_type = "DATETIME" if _IS_SQLITE else "TIMESTAMP"

    # Table -> {column: ALTER TABLE type/constraint clause}. Each is added only
    # when absent, so this stays correct whichever version created the database.
    additive = {
        "detections": {
            "source": "VARCHAR(10) NOT NULL DEFAULT 'detect'",
            "disease": "VARCHAR(50)",
        },
        "referral_slips": {
            # Links a slip back to the signed decision that produced it.
            "prescription_id": "INTEGER",
        },
        "xrays": {
            # Case ownership: which orthodontist must work this case.
            "assigned_to_id": "INTEGER",
            "assigned_at": timestamp_type,
            "assigned_by_id": "INTEGER",
        },
    }

    for table, columns in additive.items():
        if table not in tables:
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for column, clause in columns.items():
            if column in existing:
                continue
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {clause}"))
            print(f"[db] migrated: {table}.{column} added")


def get_db_session() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    print(f"[db] Schema initialised at {DB_FILE}")
