"""
main.py - FastAPI backend for the SmileAI review portal.

Endpoints
    GET  /api/health                model + backend status
    GET  /api/queue                 X-rays awaiting / completed review
    GET  /api/xray/{id}             one case with its detections
    GET  /api/xray/{id}/image       the radiograph bytes
    POST /api/upload                manual upload (ad-hoc cases)
    POST /api/transcribe            audio -> text via local Whisper
    POST /api/approve               sign off, write referral PDF

Design note: extraction and impaction are supplied by the doctor on approval.
The model contributes detection and tooth numbering only.
"""

import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from typing import Optional

from fastapi import (
    BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request,
    Response, UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from annotator import annotate
from auth import (
    audit, clear_session_cookie, get_current_user_optional, hash_password,
    require_admin, require_orthodontist, require_user, set_session_cookie,
    validate_password_strength, verify_password,
)
from db import (
    AuditLog, DECISIONS, DECISION_NO_ACTION, Detection, Location, OPEN_STATUSES,
    Patient, Prescription, ROLE_ADMIN, ROLE_ORTHODONTIST, ROLES, ReferralSlip,
    SessionLocal, User, XRay, get_db_session, init_db, STATUS_APPROVED,
    STATUS_ERROR, STATUS_PENDING, STATUS_PROCESSED,
)
from referral import generate_referral

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# DATA_DIR is the mounted EBS volume in AWS so radiographs and referral PDFs
# survive instance replacement. Unset locally -> everything stays beside the
# source, exactly as before.
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)

XRAY_STORE = os.path.join(DATA_DIR, "xray_store")
OUTPUT_DIR = os.path.join(DATA_DIR, "output_prescriptions")
ANNOTATED_DIR = os.path.join(DATA_DIR, "annotated")

for _d in (XRAY_STORE, OUTPUT_DIR, ANNOTATED_DIR):
    os.makedirs(_d, exist_ok=True)

# FDI codes for the four wisdom teeth: upper-right, upper-left, lower-left,
# lower-right third molars.
THIRD_MOLAR_FDI = ("18", "28", "38", "48")

app = FastAPI(title="SmileAI Dental Review Portal")

# Browsers refuse to send credentials to a wildcard origin, so with session
# cookies "*" would silently break every authenticated request. Origins are
# therefore explicit. In dev the Vite proxy makes requests same-origin anyway
# (see frontend/vite.config.js); this list covers direct :5173 -> :8000 calls.
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
CORS_ORIGINS = [
    o.strip() for o in
    os.environ.get("CORS_ORIGINS", _default_origins).split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_whisper_model = None


def _get_whisper():
    """Load Whisper lazily; a missing install must not take the API down.

    Retried on every call rather than latched: the first attempt can fail for
    transient reasons (a half-written weight cache, GPU memory held by the YOLO
    models) and latching would pin the endpoint to 503 for the whole process.
    """
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    try:
        import whisper
        size = os.environ.get("SMILEAI_WHISPER_MODEL", "base")
        # CPU on purpose. The YOLO detectors already hold the GPU, and loading
        # Whisper beside them risks a CUDA OOM that reads as "unavailable".
        # transcribe() below runs fp16=False, which is CPU-only anyway.
        print(f"[backend] loading Whisper '{size}' on CPU...")
        _whisper_model = whisper.load_model(size, device="cpu")
        print("[backend] Whisper ready")
    except Exception as exc:
        print(f"[backend] Whisper unavailable ({exc}); clients fall back to browser speech API")
        _whisper_model = None
    return _whisper_model


def _model_info():
    """
    Describe the detection model, plus the seg model under 'segmentation'.

    supports_pathology is reported across BOTH models: the detector alone only
    finds teeth, but with the seg model loaded the system as a whole does assess
    disease, and the UI keys its pathology affordances off this flag.
    """
    try:
        from inference import get_engine, get_seg_engine
        info = get_engine().describe()
    except Exception as exc:
        return {"error": str(exc), "supports_pathology": False}

    try:
        seg = get_seg_engine()
        if seg is not None:
            seg_info = seg.describe()
            info["segmentation"] = seg_info
            info["supports_pathology"] = (
                info.get("supports_pathology") or seg_info.get("supports_pathology", False)
            )
    except Exception as exc:
        info["segmentation"] = {"error": str(exc)}

    try:
        from inference import get_hier_engine

        hier = get_hier_engine()
        if hier is not None:
            hier_info = hier.describe()
            info["hierarchical"] = hier_info
            info["supports_pathology"] = (
                info.get("supports_pathology") or hier_info.get("supports_pathology", False)
            )
    except Exception as exc:
        info["hierarchical"] = {"error": str(exc)}

    return info


@app.on_event("startup")
def _startup():
    init_db()
    print("[backend] database ready")


def _safe_name(value: str, fallback: str = "case") -> str:
    """Filesystem-safe token from user-supplied text."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    return cleaned.strip("._-") or fallback


def _detection_dict(det: Detection, third_molar_ids: Optional[set] = None) -> dict:
    """
    Serialise one detection for the UI.

    third_molar_ids is the per-x-ray set from _third_molar_ids(); pass it so the
    one-per-quadrant rule is applied. Omitted, each row is judged on its own,
    which is right for a single detection but can over-report across a full set.
    """
    is_third = (
        det.id in third_molar_ids if third_molar_ids is not None
        else _is_third_molar(det)
    )
    return {
        "id": det.id,
        "class_name": det.class_name,
        "source": det.source or "detect",
        "fdi_number": det.fdi_number,
        "universal_number": det.universal_number,
        "quadrant": det.quadrant,
        "bbox": json.loads(det.bbox_json),
        "polygon": json.loads(det.polygon_json) if det.polygon_json else None,
        "confidence": det.confidence,
        "impaction_type": det.impaction_type,
        "needs_extraction": bool(det.needs_extraction),
        "is_third_molar": is_third,
        "disease": det.disease,
        "notes": det.notes,
    }


def _require_case_access(x: XRay, user: User) -> None:
    """
    An orthodontist may only touch cases assigned to them.

    403 with an explanatory message, rather than a bare 404: the doctor needs to
    understand that the case exists but is not theirs to work, otherwise the UI
    can only report "not found", which reads as a broken link. The message
    deliberately never names the colleague who holds it -- who else is working
    what is not this doctor's business.
    """
    if user.role != ROLE_ORTHODONTIST or x.assigned_to_id == user.id:
        return

    detail = (
        "This case has not been assigned to you yet. An administrator assigns "
        "cases from the review queue."
        if x.assigned_to_id is None
        else "This case is assigned to another orthodontist."
    )
    raise HTTPException(status_code=403, detail=detail)


def _prescription_dto(p) -> dict:
    """Serialise one signed decision for the UI, including its audit trail."""
    return {
        "id": p.id,
        "decision": p.decision,
        "prescription_text": p.prescription_text,
        "dictation_text": p.dictation_text,
        "clinician": p.clinician_name_snapshot,
        "location": p.location_name_snapshot,
        "reviewed_at": p.reviewed_at.isoformat() if p.reviewed_at else None,
        "signed_at": p.signed_at.isoformat() if p.signed_at else None,
        "amends_id": p.amends_id,
        "is_superseded": p.is_superseded,
        "has_pdf": bool(p.pdf_path),
    }


def _is_third_molar(det: Detection) -> bool:
    """
    A wisdom tooth is either named as one by the model ('3rd_Molar') or numbered
    as one (FDI x8). Segmentation rows are pathology findings, never teeth, so
    they are excluded regardless of what their class happens to contain.
    """
    from inference import _class_says_third_molar

    if (det.source or "detect") == "segment":
        return False
    return (
        det.fdi_number in THIRD_MOLAR_FDI
        or _class_says_third_molar(det.class_name)
    )


def _third_molar_ids(dets) -> set:
    """
    Ids of the third molars on one x-ray, at most one per quadrant.

    Inference already enforces this, but rows stored before that rule existed
    can still hold two 3rd_Molar detections in a quadrant. Applying the same
    anatomical constraint on read keeps old cases from displaying six or eight
    wisdom teeth, without rewriting stored data.
    """
    by_quadrant = {}
    for det in dets:
        if not _is_third_molar(det):
            continue
        # Prefer an explicit FDI code, then confidence. Unlike inference this
        # has no box geometry loaded, so distality is not available here.
        rank = (det.fdi_number in THIRD_MOLAR_FDI, det.confidence or 0.0)
        # Keyed by source as well as quadrant: two models each legitimately
        # report the same wisdom tooth, and they are shown on separate tabs.
        # A shared key would let one model's row suppress the other's and
        # leave a tab blank.
        key = ((det.source or "detect"), det.quadrant or det.fdi_number or det.id)
        if key not in by_quadrant or rank > by_quadrant[key][0]:
            by_quadrant[key] = (rank, det.id)
    return {det_id for _, det_id in by_quadrant.values()}


@app.get("/api/health")
def health():
    whisper_ready = _get_whisper() is not None
    return {
        "status": "ok",
        "model": _model_info(),
        "whisper": "ready" if whisper_ready else "unavailable",
    }


# ===========================================================================
# Authentication
# ===========================================================================

def _user_dto(u: User) -> dict:
    return {
        "id": u.id,
        "full_name": u.full_name,
        "email": u.email,
        "role": u.role,
        "primary_location_id": u.primary_location_id,
        "primary_location": u.primary_location.name if u.primary_location else None,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "deactivated_at": u.deactivated_at.isoformat() if u.deactivated_at else None,
    }


@app.post("/api/login")
def login(response: Response, request: Request,
          email: str = Form(...), password: str = Form(...),
          db: Session = Depends(get_db_session)):
    email_norm = email.strip().lower()
    user = db.query(User).filter(User.email == email_norm).first()

    # Identical response for unknown email, wrong password and deactivated
    # account: distinguishing them tells an attacker which emails are valid.
    if user is None or not verify_password(password, user.password_hash) or not user.is_active:
        audit(db, "LOGIN_FAILED", detail=f"email={email_norm}", request=request)
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    user.last_login_at = datetime.now()
    db.commit()

    set_session_cookie(response, user.id)
    audit(db, "LOGIN_SUCCESS", actor=user, request=request)
    return _user_dto(user)


@app.post("/api/logout")
def logout(response: Response, request: Request,
           user=Depends(get_current_user_optional),
           db: Session = Depends(get_db_session)):
    if user:
        audit(db, "LOGOUT", actor=user, request=request)
    clear_session_cookie(response)
    return {"status": "ok"}


@app.get("/api/me")
def me(user=Depends(get_current_user_optional)):
    if user is None:
        return JSONResponse({"authenticated": False}, status_code=401)
    return {"authenticated": True, **_user_dto(user)}


@app.post("/api/change_password")
def change_password(request: Request,
                    current_password: str = Form(...),
                    new_password: str = Form(...),
                    user: User = Depends(require_user),
                    db: Session = Depends(get_db_session)):
    if not verify_password(current_password, user.password_hash):
        audit(db, "PASSWORD_CHANGE_FAILED", actor=user, request=request)
        raise HTTPException(status_code=403, detail="Current password is incorrect.")

    err = validate_password_strength(new_password)
    if err:
        raise HTTPException(status_code=400, detail=err)

    user.password_hash = hash_password(new_password)
    db.commit()
    audit(db, "PASSWORD_CHANGED", actor=user, request=request)
    return {"status": "ok"}


# ===========================================================================
# Admin: locations
# ===========================================================================

@app.get("/api/admin/locations")
def list_locations(include_inactive: bool = False,
                   admin: User = Depends(require_admin),
                   db: Session = Depends(get_db_session)):
    q = db.query(Location)
    if not include_inactive:
        q = q.filter(Location.is_active.is_(True))
    return [{"id": l.id, "name": l.name, "is_active": l.is_active}
            for l in q.order_by(Location.name).all()]


@app.post("/api/admin/locations")
def create_location(request: Request, name: str = Form(...),
                    admin: User = Depends(require_admin),
                    db: Session = Depends(get_db_session)):
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Location name is required.")
    if db.query(Location).filter(Location.name == name).first():
        raise HTTPException(status_code=409, detail="That location already exists.")

    loc = Location(name=name)
    db.add(loc)
    db.commit()
    db.refresh(loc)
    audit(db, "LOCATION_CREATED", actor=admin, target_type="location",
          target_id=loc.id, detail=name, request=request)
    return {"id": loc.id, "name": loc.name, "is_active": loc.is_active}


@app.patch("/api/admin/locations/{location_id}")
def update_location(location_id: int, request: Request,
                    name: Optional[str] = Form(None),
                    is_active: Optional[bool] = Form(None),
                    admin: User = Depends(require_admin),
                    db: Session = Depends(get_db_session)):
    loc = db.query(Location).filter(Location.id == location_id).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found.")

    changes = []
    if name is not None and name.strip():
        changes.append(f"name:{loc.name}->{name.strip()}")
        loc.name = name.strip()
    if is_active is not None:
        changes.append(f"active:{loc.is_active}->{is_active}")
        loc.is_active = is_active

    db.commit()
    audit(db, "LOCATION_UPDATED", actor=admin, target_type="location",
          target_id=loc.id, detail="; ".join(changes), request=request)
    return {"id": loc.id, "name": loc.name, "is_active": loc.is_active}


# ===========================================================================
# Admin: orthodontists
# ===========================================================================

@app.get("/api/admin/users")
def list_users(include_inactive: bool = True,
               admin: User = Depends(require_admin),
               db: Session = Depends(get_db_session)):
    q = db.query(User)
    if not include_inactive:
        q = q.filter(User.is_active.is_(True))
    return [_user_dto(u) for u in q.order_by(User.full_name).all()]


@app.post("/api/admin/users")
def create_user(request: Request,
                full_name: str = Form(...), email: str = Form(...),
                password: str = Form(...),
                role: str = Form(ROLE_ORTHODONTIST),
                primary_location_id: Optional[int] = Form(None),
                admin: User = Depends(require_admin),
                db: Session = Depends(get_db_session)):
    full_name, email_norm = full_name.strip(), email.strip().lower()
    if not full_name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Role must be one of {list(ROLES)}.")
    if db.query(User).filter(User.email == email_norm).first():
        raise HTTPException(status_code=409, detail="A user with that email already exists.")

    err = validate_password_strength(password)
    if err:
        raise HTTPException(status_code=400, detail=err)

    if primary_location_id is not None:
        if not db.query(Location).filter(Location.id == primary_location_id).first():
            raise HTTPException(status_code=400, detail="Unknown location.")

    u = User(full_name=full_name, email=email_norm,
             password_hash=hash_password(password), role=role,
             primary_location_id=primary_location_id)
    db.add(u)
    db.commit()
    db.refresh(u)
    audit(db, "USER_CREATED", actor=admin, target_type="user", target_id=u.id,
          detail=f"{u.email} role={u.role}", request=request)
    return _user_dto(u)


def _guard_last_admin(db: Session, target: User, acting: User,
                      new_active: Optional[bool], new_role: Optional[str]) -> None:
    """
    Refuses changes that would leave nobody able to administer the practice, and
    stops an admin locking themselves out -- both unrecoverable without CLI access.
    """
    if target.id == acting.id and new_active is False:
        raise HTTPException(status_code=400,
                            detail="You cannot deactivate your own account.")

    losing_admin = target.role == ROLE_ADMIN and (
        new_active is False or (new_role is not None and new_role != ROLE_ADMIN))
    if not losing_admin:
        return

    remaining = (db.query(User)
                 .filter(User.role == ROLE_ADMIN, User.is_active.is_(True),
                         User.id != target.id)
                 .count())
    if remaining == 0:
        raise HTTPException(status_code=400,
                            detail="This is the last active administrator.")


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: int, request: Request,
                full_name: Optional[str] = Form(None),
                primary_location_id: Optional[int] = Form(None),
                is_active: Optional[bool] = Form(None),
                role: Optional[str] = Form(None),
                password: Optional[str] = Form(None),
                admin: User = Depends(require_admin),
                db: Session = Depends(get_db_session)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")

    _guard_last_admin(db, u, admin, is_active, role)

    changes = []
    if full_name is not None and full_name.strip():
        changes.append(f"name:{u.full_name}->{full_name.strip()}")
        u.full_name = full_name.strip()
    if primary_location_id is not None:
        if not db.query(Location).filter(Location.id == primary_location_id).first():
            raise HTTPException(status_code=400, detail="Unknown location.")
        changes.append(f"location:{u.primary_location_id}->{primary_location_id}")
        u.primary_location_id = primary_location_id
    if role is not None:
        if role not in ROLES:
            raise HTTPException(status_code=400, detail=f"Role must be one of {list(ROLES)}.")
        changes.append(f"role:{u.role}->{role}")
        u.role = role
    if password:
        err = validate_password_strength(password)
        if err:
            raise HTTPException(status_code=400, detail=err)
        u.password_hash = hash_password(password)
        changes.append("password:reset")
    if is_active is not None:
        changes.append(f"active:{u.is_active}->{is_active}")
        u.is_active = is_active
        u.deactivated_at = None if is_active else datetime.now()

    db.commit()
    db.refresh(u)
    audit(db, "USER_UPDATED", actor=admin, target_type="user", target_id=u.id,
          detail="; ".join(changes), request=request)
    return _user_dto(u)


@app.delete("/api/admin/users/{user_id}")
def deactivate_user(user_id: int, request: Request,
                    admin: User = Depends(require_admin),
                    db: Session = Depends(get_db_session)):
    """
    Deactivates rather than deletes. Past prescriptions must always resolve to
    the clinician who signed them, so the row is never removed.
    """
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")

    _guard_last_admin(db, u, admin, False, None)

    u.is_active = False
    u.deactivated_at = datetime.now()
    db.commit()
    audit(db, "USER_DEACTIVATED", actor=admin, target_type="user",
          target_id=u.id, detail=u.email, request=request)
    return {"status": "deactivated", "id": u.id}


@app.post("/api/admin/xray/{xray_id}/assign")
def assign_xray(xray_id: int, request: Request,
                user_id: Optional[int] = Form(None),
                admin: User = Depends(require_admin),
                db: Session = Depends(get_db_session)):
    """
    Assign a case to an orthodontist, or unassign it by omitting user_id.

    Only an active orthodontist can hold a case: assigning to an admin would put
    the case in a queue nobody works, and assigning to a deactivated user would
    hide it entirely.
    """
    x = db.query(XRay).filter(XRay.id == xray_id).first()
    if not x:
        raise HTTPException(status_code=404, detail="X-ray not found")

    if user_id is None:
        previous = x.assigned_to.full_name if x.assigned_to else None
        x.assigned_to_id = None
        x.assigned_at = None
        x.assigned_by_id = None
        db.commit()
        audit(db, "XRAY_UNASSIGNED", actor=admin, target_type="xray",
              target_id=x.id, detail=f"was={previous}", request=request)
        return {"xray_id": x.id, "assigned_to_id": None, "assigned_to": None}

    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.role != ROLE_ORTHODONTIST:
        raise HTTPException(status_code=400,
                            detail="Cases can only be assigned to an orthodontist.")
    if not target.is_active:
        raise HTTPException(status_code=400,
                            detail="That orthodontist is deactivated.")

    x.assigned_to_id = target.id
    x.assigned_at = datetime.now()
    x.assigned_by_id = admin.id
    db.commit()

    audit(db, "XRAY_ASSIGNED", actor=admin, target_type="xray", target_id=x.id,
          detail=f"to={target.email}", request=request)
    return {
        "xray_id": x.id,
        "assigned_to_id": target.id,
        "assigned_to": target.full_name,
        "assigned_at": x.assigned_at.isoformat(),
    }


@app.post("/api/admin/assign_bulk")
def assign_bulk(request: Request,
                xray_ids: str = Form(...),
                user_id: Optional[int] = Form(None),
                admin: User = Depends(require_admin),
                db: Session = Depends(get_db_session)):
    """Assign several cases at once. xray_ids is a JSON array of ids."""
    try:
        ids = [int(i) for i in json.loads(xray_ids or "[]")]
    except (ValueError, TypeError):
        raise HTTPException(status_code=400,
                            detail="xray_ids must be a JSON array of ids")
    if not ids:
        raise HTTPException(status_code=400, detail="No cases selected.")

    target = None
    if user_id is not None:
        target = db.query(User).filter(User.id == user_id).first()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        if target.role != ROLE_ORTHODONTIST or not target.is_active:
            raise HTTPException(
                status_code=400,
                detail="Cases can only be assigned to an active orthodontist.")

    rows = db.query(XRay).filter(XRay.id.in_(ids)).all()
    found = {r.id for r in rows}
    missing = sorted(set(ids) - found)

    now = datetime.now()
    for x in rows:
        x.assigned_to_id = target.id if target else None
        x.assigned_at = now if target else None
        x.assigned_by_id = admin.id if target else None
    db.commit()

    audit(db, "XRAY_ASSIGNED_BULK", actor=admin, target_type="xray",
          target_id=",".join(str(i) for i in sorted(found)),
          detail=f"to={target.email if target else 'unassigned'} n={len(rows)}",
          request=request)

    return {
        "assigned": len(rows),
        "assigned_to": target.full_name if target else None,
        "not_found": missing,
    }


@app.get("/api/admin/audit")
def get_audit_log(limit: int = 200, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db_session)):
    rows = (db.query(AuditLog).order_by(AuditLog.at.desc())
            .limit(min(limit, 1000)).all())
    return [{
        "at": r.at.isoformat() if r.at else None,
        "actor": r.actor_email,
        "action": r.action,
        "target": f"{r.target_type}:{r.target_id}" if r.target_type else None,
        "detail": r.detail,
        "ip": r.ip_address,
    } for r in rows]


@app.get("/api/queue")
def queue(
    db: Session = Depends(get_db_session),
    include_approved: bool = True,
    status: Optional[str] = None,
    search: Optional[str] = None,
    scope: Optional[str] = None,
    assigned: Optional[str] = None,
    user: User = Depends(require_user),
):
    """
    Review queue. Soonest appointment first — that's the doctor's priority.

    PENDING cases are included so a radiograph is visible while it is being
    processed rather than vanishing between upload and completion.

    scope     'unworked' (awaiting a clinical decision) or 'completed' (signed).
              Takes precedence over status/include_approved when given.
    status    restrict to one lifecycle status (overrides include_approved)
    search    case-insensitive match on patient name or MRN
    assigned  admin only: 'unassigned', 'mine', or a user id to filter by owner.

    An orthodontist sees ONLY cases assigned to them -- enforced here, not in the
    UI, so a hand-crafted request cannot widen the result. Admins see everything.
    """
    if scope == "unworked":
        statuses = list(OPEN_STATUSES) + [STATUS_ERROR]
    elif scope == "completed":
        statuses = [STATUS_APPROVED]
    elif status:
        statuses = [status.upper()]
    else:
        statuses = [STATUS_PENDING, STATUS_PROCESSED, STATUS_ERROR]
        if include_approved:
            statuses.append(STATUS_APPROVED)

    query = db.query(XRay).filter(XRay.status.in_(statuses))

    if user.role == ROLE_ORTHODONTIST:
        # Hard scope: a doctor's queue is their own caseload, nothing else.
        query = query.filter(XRay.assigned_to_id == user.id)
    elif assigned == "unassigned":
        query = query.filter(XRay.assigned_to_id.is_(None))
    elif assigned == "mine":
        query = query.filter(XRay.assigned_to_id == user.id)
    elif assigned:
        try:
            query = query.filter(XRay.assigned_to_id == int(assigned))
        except ValueError:
            raise HTTPException(status_code=400,
                                detail="assigned must be 'unassigned', 'mine' or a user id.")

    if search and search.strip():
        term = f"%{search.strip()}%"
        # join(Patient) so the filter can reach name and mrn. collate NOCASE is
        # SQLite-only, so ilike is used instead: it lowers both sides on any
        # backend and behaves the same on Postgres in AWS.
        query = query.join(Patient).filter(
            or_(Patient.name.ilike(term), Patient.mrn.ilike(term))
        )

    xrays = (
        query
        .order_by(XRay.appointment_date.is_(None), XRay.appointment_date.asc(),
                  XRay.uploaded_at.desc())
        .limit(200)
        .all()
    )

    # One query for every active decision on the page, keyed by xray_id, rather
    # than a per-row lookup inside the loop.
    xray_ids = [x.id for x in xrays]
    active_by_xray = {}
    if xray_ids:
        for p in (db.query(Prescription)
                  .filter(Prescription.xray_id.in_(xray_ids),
                          Prescription.is_superseded.is_(False))
                  .order_by(Prescription.signed_at.asc()).all()):
            active_by_xray[p.xray_id] = p

    items = []
    for x in xrays:
        dets = x.detections
        active = active_by_xray.get(x.id)
        items.append({
            "id": x.id,
            "patient_name": x.patient.name if x.patient else "Unknown",
            "mrn": x.patient.mrn if x.patient else "—",
            "filename": x.original_filename,
            "status": x.status,
            "appointment_date": x.appointment_date,
            "uploaded_at": x.uploaded_at.isoformat() if x.uploaded_at else None,
            # Who signed and what they decided, so the queue shows outcome and
            # attribution without a second request per row.
            "decision": active.decision if active else None,
            "signed_by": active.clinician_name_snapshot if active else None,
            "signed_at": (active.signed_at.isoformat()
                          if active and active.signed_at else None),
            "assigned_to_id": x.assigned_to_id,
            "assigned_to": x.assigned_to.full_name if x.assigned_to else None,
            "assigned_at": x.assigned_at.isoformat() if x.assigned_at else None,
            "num_detections": sum(1 for d in dets if (d.source or "detect") == "detect"),
            # Detector rows only: the queue badge tracks the Detection tab, and
            # counting both models would double it for every case.
            "num_third_molars": len(_third_molar_ids(
                [d for d in dets if (d.source or "detect") == "detect"]
            )),
            "marked_for_extraction": sum(1 for d in dets if d.needs_extraction),
            "error_message": x.error_message,
        })
    return {"count": len(items), "items": items}


@app.get("/api/stats")
def stats(db: Session = Depends(get_db_session),
          user: User = Depends(require_user)):
    """
    Aggregate counts for the dashboard and the queue badge.

    Scoped per role: an orthodontist's counts cover only their own assigned
    caseload, so the nav badge matches the queue they can actually open. Admins
    see practice-wide totals plus how many cases are still unassigned.
    """
    is_doctor = user.role == ROLE_ORTHODONTIST

    def _scoped(query):
        return query.filter(XRay.assigned_to_id == user.id) if is_doctor else query

    def _count(status_value):
        return _scoped(
            db.query(func.count(XRay.id)).filter(XRay.status == status_value)
        ).scalar() or 0

    # One pass over candidate rows: the one-per-quadrant rule needs the
    # detections grouped by x-ray, which a COUNT cannot express.
    third_molars = 0
    flagged = _scoped(
        db.query(XRay).filter(XRay.status.in_([STATUS_PROCESSED, STATUS_APPROVED]))
    ).all()
    for xray in flagged:
        detector_rows = [d for d in xray.detections if (d.source or "detect") == "detect"]
        third_molars += len(_third_molar_ids(detector_rows))

    out = {
        "pending": _count(STATUS_PENDING),
        "awaiting_review": _count(STATUS_PROCESSED),
        "approved": _count(STATUS_APPROVED),
        "failed": _count(STATUS_ERROR),
        "total": _scoped(db.query(func.count(XRay.id))).scalar() or 0,
        "third_molars_flagged": third_molars,
        # Patient totals are practice-wide information; a doctor's view is their
        # caseload, so report the patients they actually hold cases for.
        "patients": (
            db.query(func.count(func.distinct(XRay.patient_id)))
              .filter(XRay.assigned_to_id == user.id).scalar() or 0
            if is_doctor
            else db.query(func.count(Patient.id)).scalar() or 0
        ),
    }

    if not is_doctor:
        out["unassigned"] = (
            db.query(func.count(XRay.id))
              .filter(XRay.assigned_to_id.is_(None),
                      XRay.status.in_(list(OPEN_STATUSES) + [STATUS_ERROR]))
              .scalar() or 0
        )

    return out


@app.get("/api/patients")
def list_patients(db: Session = Depends(get_db_session), search: Optional[str] = None,
                  admin: User = Depends(require_admin)):
    """Every patient with a radiograph count, most recently added first."""
    query = db.query(Patient)
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(or_(Patient.name.ilike(term), Patient.mrn.ilike(term)))

    patients = query.order_by(Patient.created_at.desc()).limit(500).all()

    items = []
    for p in patients:
        xrays = p.xrays
        last = max((x.uploaded_at for x in xrays if x.uploaded_at), default=None)
        items.append({
            "mrn": p.mrn,
            "name": p.name,
            "num_xrays": len(xrays),
            "num_approved": sum(1 for x in xrays if x.status == STATUS_APPROVED),
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "last_xray_at": last.isoformat() if last else None,
        })
    return {"count": len(items), "items": items}


@app.get("/api/patients/{mrn}")
def get_patient(mrn: str, db: Session = Depends(get_db_session),
                admin: User = Depends(require_admin)):
    """One patient's history: every radiograph, newest appointment first."""
    patient = db.query(Patient).filter(Patient.mrn == mrn).first()
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    xrays = sorted(
        patient.xrays,
        key=lambda x: (x.appointment_date or "", x.uploaded_at or datetime.min),
        reverse=True,
    )

    return {
        "mrn": patient.mrn,
        "name": patient.name,
        "created_at": patient.created_at.isoformat() if patient.created_at else None,
        "xrays": [{
            "id": x.id,
            "filename": x.original_filename,
            "status": x.status,
            "appointment_date": x.appointment_date,
            "uploaded_at": x.uploaded_at.isoformat() if x.uploaded_at else None,
            "num_detections": sum(
                1 for d in x.detections if (d.source or "detect") == "detect"),
            "marked_for_extraction": sum(1 for d in x.detections if d.needs_extraction),
        } for x in xrays],
    }


def _unlink(path: Optional[str]) -> None:
    """
    Best-effort file removal.

    A file that is already gone, or locked by another process, must not abort a
    deletion that has otherwise succeeded -- the database rows are the record of
    truth and leaving them behind would be worse than leaving a stray file.
    """
    if not path:
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError as exc:
        print(f"[backend] could not remove {path}: {exc}")


def _purge_xray_files(xray: XRay) -> None:
    """Remove every file one x-ray owns: the radiograph, its referral PDFs and signatures."""
    _unlink(xray.file_path)
    for slip in xray.referrals:
        _unlink(slip.pdf_path)
        _unlink(slip.signature_path)


@app.delete("/api/xray/{xray_id}")
def delete_xray(xray_id: int, db: Session = Depends(get_db_session),
                admin: User = Depends(require_admin)):
    """
    Permanently delete one case: its detections, referrals and stored files.

    The patient record is kept -- they may have other radiographs, and removing
    a single case is not the same as removing the person. Use
    DELETE /api/patients/{mrn} for that.
    """
    xray = db.query(XRay).filter(XRay.id == xray_id).first()
    if xray:
        _require_case_access(xray, user)
    if not xray:
        raise HTTPException(status_code=404, detail="X-ray not found")

    detection_count = len(xray.detections)
    referral_count = len(xray.referrals)

    # Files first: once the rows are gone the paths are unrecoverable.
    _purge_xray_files(xray)

    # detections and referrals go via cascade="all, delete-orphan" on XRay.
    db.delete(xray)
    db.commit()

    return {
        "status": "deleted",
        "xray_id": xray_id,
        "deleted_detections": detection_count,
        "deleted_referrals": referral_count,
    }


@app.delete("/api/patients/{mrn}")
def delete_patient(mrn: str, db: Session = Depends(get_db_session),
                   admin: User = Depends(require_admin)):
    """
    Permanently delete a patient and every radiograph they have.

    This is the widest destructive action in the API: it removes the person, all
    their cases, all detections, and every referral PDF issued for them.
    """
    patient = db.query(Patient).filter(Patient.mrn == mrn).first()
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    xrays = list(patient.xrays)
    detection_count = sum(len(x.detections) for x in xrays)
    referral_count = sum(len(x.referrals) for x in xrays)

    for xray in xrays:
        _purge_xray_files(xray)

    # xrays -> detections -> referrals all cascade from Patient.
    db.delete(patient)
    db.commit()

    return {
        "status": "deleted",
        "mrn": mrn,
        "name": patient.name,
        "deleted_xrays": len(xrays),
        "deleted_detections": detection_count,
        "deleted_referrals": referral_count,
    }


@app.get("/api/referrals")
def list_referrals(db: Session = Depends(get_db_session), search: Optional[str] = None,
                   user: User = Depends(require_user)):
    """
    Signed referrals, newest first, with a link to each PDF.

    An orthodontist sees only referrals for cases assigned to them -- their own
    work, not the practice's. Admins see all of them.
    """
    query = db.query(ReferralSlip)

    if user.role == ROLE_ORTHODONTIST:
        # Join through the x-ray so the filter is on case ownership rather than
        # on the doctor_name string, which is display text and not an identity.
        query = query.join(XRay, ReferralSlip.xray_id == XRay.id).filter(
            XRay.assigned_to_id == user.id)

    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(ReferralSlip.doctor_name.ilike(term))

    slips = query.order_by(ReferralSlip.generated_at.desc()).limit(500).all()

    items = []
    for slip in slips:
        xray = slip.xray
        patient = xray.patient if xray else None
        items.append({
            "id": slip.id,
            "xray_id": slip.xray_id,
            "patient_name": patient.name if patient else "Unknown",
            "mrn": patient.mrn if patient else "—",
            "doctor_name": slip.doctor_name,
            "prescription_text": slip.prescription_text,
            "generated_at": slip.generated_at.isoformat() if slip.generated_at else None,
            "pdf_url": f"/api/referral/{slip.xray_id}",
            "pdf_available": bool(slip.pdf_path and os.path.exists(slip.pdf_path)),
        })
    return {"count": len(items), "items": items}


@app.get("/api/xray/{xray_id}")
def get_xray(xray_id: int, request: Request,
             db: Session = Depends(get_db_session),
             user: User = Depends(require_user)):
    x = db.query(XRay).filter(XRay.id == xray_id).first()
    if not x:
        raise HTTPException(status_code=404, detail="X-ray not found")
    _require_case_access(x, user)

    referral = (
        db.query(ReferralSlip)
        .filter(ReferralSlip.xray_id == x.id)
        .order_by(ReferralSlip.generated_at.desc())
        .first()
    )

    third_molars = _third_molar_ids(x.detections)

    # Full history, oldest first, so an amended case still shows the original
    # decision and who made it.
    history = (db.query(Prescription)
               .filter(Prescription.xray_id == x.id)
               .order_by(Prescription.signed_at.asc()).all())
    active = next((p for p in reversed(history) if not p.is_superseded), None)

    audit(db, "CASE_VIEWED", actor=user, target_type="xray", target_id=x.id,
          request=request)

    return {
        "id": x.id,
        "patient_name": x.patient.name if x.patient else "Unknown",
        "mrn": x.patient.mrn if x.patient else "—",
        "filename": x.original_filename,
        "status": x.status,
        "appointment_date": x.appointment_date,
        "width": x.image_width,
        "height": x.image_height,
        "error_message": x.error_message,
        "image_url": f"/api/xray/{x.id}/image",
        "detections": [_detection_dict(d, third_molars) for d in x.detections],
        "referral": {
            "pdf_name": os.path.basename(referral.pdf_path),
            "doctor_name": referral.doctor_name,
            "prescription_text": referral.prescription_text,
            "generated_at": referral.generated_at.isoformat() if referral.generated_at else None,
        } if referral else None,
        "assigned_to_id": x.assigned_to_id,
        "assigned_to": x.assigned_to.full_name if x.assigned_to else None,
        "assigned_at": x.assigned_at.isoformat() if x.assigned_at else None,
        "prescription": _prescription_dto(active) if active else None,
        "prescription_history": [_prescription_dto(p) for p in history],
        "model": _model_info(),
    }


@app.get("/api/xray/{xray_id}/image")
def get_xray_image(xray_id: int, db: Session = Depends(get_db_session),
                   user: User = Depends(require_user)):
    x = db.query(XRay).filter(XRay.id == xray_id).first()
    if not x:
        raise HTTPException(status_code=404, detail="X-ray not found")
    _require_case_access(x, user)
    if not os.path.exists(x.file_path):
        raise HTTPException(status_code=404, detail="Image file missing from store")
    return FileResponse(x.file_path)


def run_inference_for_xray(xray_id: int) -> None:
    """
    Run detection for one stored x-ray and persist the result.

    Executed as a BackgroundTask so the upload request can return immediately:
    a full panoramic takes several seconds through three models, which is far
    too long to hold the intake form open. Opens its own Session, because the
    request-scoped one is closed by the time this runs.

    Never raises. A failure is recorded on the row as STATUS_ERROR so the queue
    can show it and offer a retry; there is no caller left to receive an
    exception.
    """
    from inference import predict_all

    db = SessionLocal()
    try:
        xray = db.query(XRay).filter(XRay.id == xray_id).first()
        if xray is None:
            return

        try:
            result = predict_all(xray.file_path)
        except Exception as exc:
            xray.status = STATUS_ERROR
            xray.error_message = str(exc)
            db.commit()
            print(f"[backend] inference failed for xray {xray_id}: {exc}")
            return

        # A retry re-runs a case that may already hold rows from a previous
        # attempt; replace them rather than appending a second set.
        db.query(Detection).filter(Detection.xray_id == xray.id).delete()

        xray.image_width = result["width"]
        xray.image_height = result["height"]
        for det in result["detections"]:
            db.add(Detection(
                xray_id=xray.id,
                class_name=det["class_name"],
                source=det.get("source", "detect"),
                fdi_number=det.get("fdi_number"),
                universal_number=det.get("universal_number"),
                quadrant=det.get("quadrant"),
                bbox_json=json.dumps(det["bbox"]),
                polygon_json=json.dumps(det["polygon"]) if det.get("polygon") else None,
                confidence=det["confidence"],
                disease=det.get("disease"),
            ))
        xray.status = STATUS_PROCESSED
        xray.error_message = None
        xray.processed_at = datetime.now()
        db.commit()
    finally:
        db.close()


@app.post("/api/upload", status_code=202)
async def upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    patient_name: str = Form("Unknown Patient"),
    mrn: str = Form(""),
    appointment_date: str = Form(""),
    db: Session = Depends(get_db_session),
    admin: User = Depends(require_admin),
):
    """
    Manual upload for cases that didn't arrive through the RPA folder.

    Admin only: intake is a practice-management action, and a new case has to be
    assigned before any doctor can work it.

    Returns 202 as soon as the image and patient details are stored. Detection
    runs in the background; poll GET /api/xray/{id} until status leaves PENDING.
    """
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty upload")

    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    stored_name = f"{_safe_name(mrn or patient_name, 'case')}_{uuid.uuid4().hex[:8]}{ext}"
    stored_path = os.path.join(XRAY_STORE, stored_name)
    with open(stored_path, "wb") as fh:
        fh.write(contents)

    effective_mrn = mrn.strip() or f"AUTO-{uuid.uuid4().hex[:8].upper()}"
    patient = db.query(Patient).filter(Patient.mrn == effective_mrn).first()
    if not patient:
        patient = Patient(mrn=effective_mrn, name=patient_name.strip() or "Unknown Patient")
        db.add(patient)
        db.flush()

    xray = XRay(
        patient_id=patient.id,
        original_filename=file.filename or stored_name,
        file_path=stored_path,
        appointment_date=appointment_date.strip() or None,
        status=STATUS_PENDING,
    )
    db.add(xray)
    db.commit()

    background_tasks.add_task(run_inference_for_xray, xray.id)

    return {
        "xray_id": xray.id,
        "status": STATUS_PENDING,
        "patient_name": patient.name,
        "mrn": patient.mrn,
    }


@app.post("/api/xray/{xray_id}/retry", status_code=202)
def retry_xray(
    xray_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db_session),
    user: User = Depends(require_user),
):
    """Re-run detection on a case that failed, without re-uploading the image."""
    xray = db.query(XRay).filter(XRay.id == xray_id).first()
    if not xray:
        raise HTTPException(status_code=404, detail="X-ray not found")
    if not os.path.exists(xray.file_path):
        raise HTTPException(status_code=409, detail="Image file missing from store")

    xray.status = STATUS_PENDING
    xray.error_message = None
    db.commit()

    background_tasks.add_task(run_inference_for_xray, xray.id)
    return {"xray_id": xray.id, "status": STATUS_PENDING}


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...),
                     user: User = Depends(require_user)):
    """Transcribe a dictated note locally. Audio never leaves this machine."""
    model = _get_whisper()
    if model is None:
        return JSONResponse(
            status_code=503,
            content={"error": "whisper_unavailable",
                     "detail": "Server transcription is not installed; use browser dictation."},
        )

    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    tmp_path = os.path.join(tempfile.gettempdir(), f"smileai_{uuid.uuid4().hex}{suffix}")
    try:
        with open(tmp_path, "wb") as fh:
            fh.write(await audio.read())
        result = model.transcribe(tmp_path, fp16=False)
        return {"text": (result.get("text") or "").strip()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.post("/api/approve")
async def approve(
    request: Request,
    xray_id: int = Form(...),
    decision: str = Form(...),
    prescription_text: str = Form(...),
    signature: str = Form(...),
    extraction_ids: str = Form("[]"),
    dictation_text: Optional[str] = Form(None),
    reviewed_at: Optional[str] = Form(None),
    amends_id: Optional[int] = Form(None),
    clinician: User = Depends(require_orthodontist),
    db: Session = Depends(get_db_session),
):
    """
    Record the clinician's signed decision and emit the referral PDF.

    extraction_ids is a JSON array of Detection.id the doctor ticked. Those are
    the only teeth that appear as extractions anywhere downstream.

    Attribution -- who signed and when -- comes from the authenticated session and
    the server clock, never from the request body, so a client cannot sign as
    somebody else or backdate a record. `decision` includes NO_ACTION_NEEDED, an
    explicit clinical decision that is signed and stored like any other but
    produces no referral.
    """
    import base64

    x = db.query(XRay).filter(XRay.id == xray_id).first()
    if not x:
        raise HTTPException(status_code=404, detail="X-ray not found")
    _require_case_access(x, clinician)
    if decision not in DECISIONS:
        raise HTTPException(status_code=400,
                            detail=f"decision must be one of {list(DECISIONS)}")
    if not prescription_text.strip():
        raise HTTPException(status_code=400, detail="Prescription note is empty")

    # Signed records are immutable: a correction must explicitly reference the
    # record it supersedes, so the original decision and timestamp survive.
    existing = (db.query(Prescription)
                .filter(Prescription.xray_id == x.id,
                        Prescription.is_superseded.is_(False))
                .order_by(Prescription.signed_at.desc()).first())
    if existing and amends_id is None:
        raise HTTPException(
            status_code=409,
            detail=(f"This case was already signed by {existing.clinician_name_snapshot} "
                    f"on {existing.signed_at:%Y-%m-%d %H:%M}. To correct it, submit "
                    f"an amendment referencing id {existing.id}."))
    if amends_id is not None:
        prior = (db.query(Prescription)
                 .filter(Prescription.id == amends_id,
                         Prescription.xray_id == x.id).first())
        if not prior:
            raise HTTPException(status_code=400, detail="Unknown prescription to amend.")

    try:
        marked_ids = {int(i) for i in json.loads(extraction_ids or "[]")}
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="extraction_ids must be a JSON array of ids")

    valid_ids = {d.id for d in x.detections}
    unknown = marked_ids - valid_ids
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"detection ids not on this x-ray: {sorted(unknown)}")

    # "No action needed" means no tooth is being acted on; accepting ticked
    # extractions alongside it would store a self-contradictory record.
    if decision == DECISION_NO_ACTION and marked_ids:
        raise HTTPException(
            status_code=400,
            detail="'No action needed' cannot be combined with teeth marked for extraction.")

    # Apply the clinician's decisions. marked_by is the session identity.
    for det in x.detections:
        det.needs_extraction = det.id in marked_ids
        det.marked_by = clinician.full_name if det.id in marked_ids else None

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{_safe_name(x.patient.mrn if x.patient else 'case')}_{stamp}"

    # Signature: decode the data URL the SignaturePad produced.
    signature_path = None
    if signature.startswith("data:image"):
        try:
            encoded = signature.split(",", 1)[1]
            signature_path = os.path.join(OUTPUT_DIR, f"{base}_signature.png")
            with open(signature_path, "wb") as fh:
                fh.write(base64.b64decode(encoded))
        except (IndexError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid signature data: {exc}")
    else:
        raise HTTPException(status_code=400, detail="Signature must be a data:image URL")

    det_dicts = [_detection_dict(d, _third_molar_ids(x.detections)) for d in x.detections]

    # Annotated radiograph for the PDF; a failure here must not block sign-off.
    annotated_path = None
    if os.path.exists(x.file_path):
        try:
            annotated_path = annotate(
                x.file_path, det_dicts,
                os.path.join(ANNOTATED_DIR, f"{base}_annotated.jpg"),
            )
        except Exception as exc:
            print(f"[backend] annotation failed for xray {x.id}: {exc}")

    reviewed_dt = None
    if reviewed_at:
        try:
            reviewed_dt = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
        except ValueError:
            reviewed_dt = None

    # The signed decision is the clinical record, written before the PDF so a
    # rendering failure cannot lose the sign-off.
    presc = Prescription(
        xray_id=x.id,
        clinician_id=clinician.id,
        clinician_name_snapshot=clinician.full_name,
        location_name_snapshot=(clinician.primary_location.name
                                if clinician.primary_location else None),
        decision=decision,
        prescription_text=prescription_text,
        dictation_text=(dictation_text or "").strip() or None,
        signature_path=signature_path,
        reviewed_at=reviewed_dt,
        signed_at=datetime.now(),
        amends_id=amends_id,
    )
    db.add(presc)
    db.flush()  # need presc.id for the referral row

    if amends_id is not None:
        prior.is_superseded = True

    # A referral PDF only means something when treatment is being asked for.
    # "No action needed" is recorded but generates no referral.
    pdf_path = None
    if decision != DECISION_NO_ACTION:
        pdf_path = os.path.join(OUTPUT_DIR, f"referral_{base}.pdf")
        try:
            generate_referral(
                output_path=pdf_path,
                patient_name=x.patient.name if x.patient else "Unknown",
                mrn=x.patient.mrn if x.patient else "—",
                doctor_name=clinician.full_name,
                prescription_text=prescription_text,
                detections=det_dicts,
                annotated_image_path=annotated_path,
                signature_path=signature_path,
                appointment_date=x.appointment_date,
                model_info=_model_info(),
            )
        except Exception as exc:
            db.rollback()
            raise HTTPException(status_code=500, detail=f"PDF generation failed: {exc}")

        presc.pdf_path = pdf_path
        db.add(ReferralSlip(
            xray_id=x.id,
            prescription_id=presc.id,
            pdf_path=pdf_path,
            doctor_name=clinician.full_name,
            prescription_text=prescription_text,
            signature_path=signature_path,
        ))

    x.status = STATUS_APPROVED
    db.commit()
    db.refresh(presc)

    audit(db, "PRESCRIPTION_SIGNED", actor=clinician, target_type="xray",
          target_id=x.id,
          detail=f"prescription={presc.id} decision={decision}"
                 + (f" amends={amends_id}" if amends_id else ""),
          request=request)

    return {
        "status": "success",
        "xray_id": x.id,
        "prescription_id": presc.id,
        "decision": presc.decision,
        "clinician": presc.clinician_name_snapshot,
        "signed_at": presc.signed_at.isoformat(),
        "pdf_name": os.path.basename(pdf_path) if pdf_path else None,
        "pdf_url": f"/api/referral/{x.id}" if pdf_path else None,
        "marked_for_extraction": len(marked_ids),
    }


@app.get("/api/referral/{xray_id}")
def get_referral(xray_id: int, db: Session = Depends(get_db_session),
                 user: User = Depends(require_user)):
    x = db.query(XRay).filter(XRay.id == xray_id).first()
    if not x:
        raise HTTPException(status_code=404, detail="Referral PDF not found")
    _require_case_access(x, user)

    referral = (
        db.query(ReferralSlip)
        .filter(ReferralSlip.xray_id == xray_id)
        .order_by(ReferralSlip.generated_at.desc())
        .first()
    )
    if not referral or not os.path.exists(referral.pdf_path):
        raise HTTPException(status_code=404, detail="Referral PDF not found")
    return FileResponse(
        referral.pdf_path,
        media_type="application/pdf",
        filename=os.path.basename(referral.pdf_path),
    )


# ---------------------------------------------------------------------------
# Built frontend
#
# Mounted last, on purpose: this catch-all would otherwise shadow every /api
# route declared above it. In the container the Vite build lands in
# frontend/dist and is served same-origin, so VITE_API_URL stays empty and no
# CORS or second hostname is involved. Skipped when dist/ is absent, which is
# the normal local setup where `npm run dev` serves the UI on :5173.
# ---------------------------------------------------------------------------
_FRONTEND_DIST = os.environ.get(
    "SMILEAI_FRONTEND_DIST", os.path.join(BASE_DIR, "frontend", "dist")
)

if os.path.isdir(_FRONTEND_DIST):
    from fastapi.staticfiles import StaticFiles
    from starlette.exceptions import HTTPException as StarletteHTTPException

    _INDEX_HTML = os.path.join(_FRONTEND_DIST, "index.html")

    # index.html names the current bundle hashes, so a cached copy outlives the
    # deploy it came from: the browser then asks for a hash that no longer exists,
    # gets a 404 and renders nothing. Always revalidate it.
    _NO_STORE = "no-store, no-cache, must-revalidate"

    def _index_response():
        return FileResponse(_INDEX_HTML, headers={"Cache-Control": _NO_STORE})

    class _ImmutableStatic(StaticFiles):
        """
        StaticFiles for Vite's hashed output.

        The filename changes whenever the content does, so these can be cached
        for a year. Without it the browser re-fetches ~700 KB of JS on every
        page view.
        """

        def file_response(self, *args, **kwargs):
            resp = super().file_response(*args, **kwargs)
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp

    # Mounted under /assets rather than / so a missing chunk 404s properly
    # instead of being handed index.html, which would arrive at a <script> tag as
    # HTML and fail with a confusing syntax error.
    _ASSETS_DIR = os.path.join(_FRONTEND_DIST, "assets")
    if os.path.isdir(_ASSETS_DIR):
        app.mount("/assets", _ImmutableStatic(directory=_ASSETS_DIR), name="assets")

    @app.exception_handler(StarletteHTTPException)
    async def _spa_fallback(request, exc):
        """
        Serve index.html for unmatched GETs so the client router can resolve them.

        /upload, /queue and /case/3 exist only in the browser; a refresh or a
        pasted link hits the server, which has no such route. StaticFiles(html=True)
        does not cover this -- it only serves index.html for *directory* paths, so
        every page but / returned 404.

        /api/ and /assets/ are deliberately excluded. Masking a mistyped endpoint
        or a missing bundle with a 200 of HTML turns an obvious 404 into a
        mystery -- a <script> tag receiving HTML fails with an unrelated-looking
        syntax error.
        """
        path = request.url.path
        is_page_request = (
            exc.status_code == 404
            and request.method in ("GET", "HEAD")
            and not path.startswith("/api/")
            and not path.startswith("/assets/")
            and os.path.exists(_INDEX_HTML)
        )
        if is_page_request:
            return _index_response()
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    # Real top-level files only (favicon.svg, icons.svg). Deliberately NOT
    # html=True: that would serve index.html for "/" straight from StaticFiles,
    # bypassing the no-store header above. Without it "/" 404s inside the mount
    # and lands on _spa_fallback, which serves index.html correctly.
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST), name="frontend")
    print(f"[backend] serving frontend from {_FRONTEND_DIST}")
else:
    print(f"[backend] no frontend build at {_FRONTEND_DIST}; API only")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
