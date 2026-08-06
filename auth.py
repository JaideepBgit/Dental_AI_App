"""
auth.py - Authentication, session handling and role guards for the SmileAI portal.

Sessions are signed cookies (itsdangerous) rather than JWTs: this is a single
backend serving one SPA, so there is no cross-service token to validate, and a
signed cookie can be invalidated wholesale by rotating the secret. The cookie
carries only the user id and issue time -- never the role -- so a stolen or
hand-crafted cookie cannot escalate privileges. Role and active status are
re-read from the database on every request.
"""

import os
import secrets
from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from db import AuditLog, ROLE_ADMIN, ROLE_ORTHODONTIST, User, get_db_session

COOKIE_NAME = "smileai_session"
SESSION_MAX_AGE_SECONDS = 8 * 60 * 60  # one clinical shift

# A generated fallback keeps dev working, but it rotates on restart (logging
# everyone out) and is not shared between workers -- production must set this.
SECRET_KEY = os.environ.get("SESSION_SECRET_KEY")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(48)
    print("[auth] WARNING: SESSION_SECRET_KEY is not set. Using a random key -- "
          "sessions will not survive a restart and will not work across multiple "
          "workers. Set SESSION_SECRET_KEY for production.")

# Only mark cookies Secure when actually served over HTTPS; forcing it would
# silently break local http:// development.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")

_serializer = URLSafeTimedSerializer(SECRET_KEY, salt="smileai-session-v1")
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Deliberately permissive for demo use: short, memorable credentials make the
# portal easy to hand round. RAISE THIS before real patient data goes in -- 4
# characters with no complexity rule is trivially guessable, and the login
# endpoint has no rate limiting either.
MIN_PASSWORD_LENGTH = int(os.environ.get("MIN_PASSWORD_LENGTH", "4"))


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _pwd_context.verify(plain, hashed)
    except ValueError:
        # Malformed hash in the column -- a failed login, not a 500.
        return False


def validate_password_strength(password: str) -> Optional[str]:
    """
    Returns an error message, or None if acceptable.

    Length is the only rule. A letters-plus-numbers requirement was dropped so
    demo credentials can stay memorable; reinstate it alongside a higher
    MIN_PASSWORD_LENGTH for production.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    return None


# ---------------------------------------------------------------------------
# Session cookie
# ---------------------------------------------------------------------------

def issue_session(user_id: int) -> str:
    return _serializer.dumps({"uid": user_id})


def read_session(token: str) -> Optional[int]:
    try:
        data = _serializer.loads(token, max_age=SESSION_MAX_AGE_SECONDS)
    except (SignatureExpired, BadSignature):
        return None
    uid = data.get("uid")
    return int(uid) if uid is not None else None


def set_session_cookie(response, user_id: int) -> None:
    response.set_cookie(
        COOKIE_NAME,
        issue_session(user_id),
        max_age=SESSION_MAX_AGE_SECONDS,
        httponly=True,      # unreadable from JS -- limits XSS session theft
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def audit(db: Session, action: str, actor: Optional[User] = None,
          target_type: str = None, target_id=None, detail: str = None,
          request: Request = None, commit: bool = True) -> None:
    """Appends an audit row. Never raises into the caller's happy path."""
    try:
        ip = None
        if request is not None:
            fwd = request.headers.get("x-forwarded-for")
            ip = (fwd.split(",")[0].strip() if fwd
                  else (request.client.host if request.client else None))
        db.add(AuditLog(
            actor_user_id=actor.id if actor else None,
            actor_email=actor.email if actor else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            detail=detail,
            ip_address=ip,
        ))
        if commit:
            db.commit()
    except Exception as exc:  # pragma: no cover
        print(f"[auth] audit write failed for {action}: {exc}")
        db.rollback()


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

def get_current_user_optional(request: Request,
                              db: Session = Depends(get_db_session)) -> Optional[User]:
    """Resolves the session cookie to a live, active user, or None."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    uid = read_session(token)
    if uid is None:
        return None
    user = db.query(User).filter(User.id == uid).first()
    # A user deactivated mid-session loses access immediately: role and active
    # flag are always re-read, never trusted from the cookie.
    if user is None or not user.is_active:
        return None
    return user


def require_user(user: Optional[User] = Depends(get_current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Authentication required.")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if user.role != ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Administrator access required.")
    return user


def require_orthodontist(user: User = Depends(require_user)) -> User:
    """
    Guards sign-off. Admins are deliberately NOT allowed through: signing a
    clinical decision requires a clinician, and letting an admin sign would make
    the attribution meaningless.
    """
    if user.role != ROLE_ORTHODONTIST:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an orthodontist can record a clinical decision.")
    return user
