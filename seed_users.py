"""
seed_users.py - Bootstrap the practice: locations, an admin, and orthodontists.

Idempotent: re-running skips anything already present rather than duplicating it.
Existing passwords are never overwritten -- an operator re-running the seed must
not clobber a credential somebody is already using.

Login names are bare usernames ('admin', 'patrick', 'arcaro'), not email
addresses, so they are quick to type. The column is still called `email` since
it accepts either.

    python seed_users.py --demo                   # the practice, simple passwords
    python seed_users.py --admin-password '...'   # choose the admin password
    python seed_users.py --reset                  # rewrite the demo passwords

WARNING: --demo issues passwords that match the username. Replace them before
this touches real patient data.
"""

import argparse
import os
import secrets
import string

from auth import hash_password
from db import (Location, ROLE_ADMIN, ROLE_ORTHODONTIST, SessionLocal, User,
                init_db)

DEFAULT_LOCATIONS = ["Passion Dental"]

# Practice-wide access lives in its own account rather than on a clinician's
# login. The doctors treat patients; whoever runs the practice signs in as the
# administrator to upload cases, assign them and manage logins. Keeping the two
# separate means a doctor's day-to-day session cannot reach the whole practice.
DEFAULT_ADMIN_LOGIN = "admin"
DEFAULT_ADMIN_NAME = "Practice Administrator"
DEFAULT_ADMIN_ROLE = ROLE_ADMIN

#: (login, full name, role) -- the practice's clinicians. Full names are what
#: print on referral PDFs, so they are written the way a patient should read
#: them.
PRACTICE_DOCTORS = [
    ("patrick", "Dr Patrick", ROLE_ORTHODONTIST),
    ("arcaro", "Dr Arcaro", ROLE_ORTHODONTIST),
]


def _random_password(n: int = 14) -> str:
    # No shell metacharacters: these get pasted into terminals and curl commands.
    alphabet = string.ascii_letters + string.digits + "-_=+."
    return "".join(secrets.choice(alphabet) for _ in range(n))


def ensure_location(db, name: str) -> Location:
    loc = db.query(Location).filter(Location.name == name).first()
    if loc:
        print(f"  location exists: {name}")
        return loc
    loc = Location(name=name)
    db.add(loc)
    db.commit()
    db.refresh(loc)
    print(f"  location created: {name}")
    return loc


def ensure_user(db, email, full_name, role, password, location=None, reset=False):
    email = email.strip().lower()
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        if not reset:
            print(f"  user exists (unchanged): {email}")
            return None
        # --reset is the one path allowed to overwrite a password, so a forgotten
        # demo credential can be recovered without deleting the account and its
        # signed prescriptions.
        existing.password_hash = hash_password(password)
        existing.is_active = True
        existing.deactivated_at = None
        db.commit()
        print(f"  user password reset: {email}")
        return password

    u = User(
        email=email,
        full_name=full_name,
        role=role,
        password_hash=hash_password(password),
        primary_location_id=location.id if location else None,
    )
    db.add(u)
    db.commit()
    print(f"  user created: {email}  role={role}")
    return password


def main():
    ap = argparse.ArgumentParser(description="Seed practice users and locations")
    ap.add_argument("--admin-email", default=DEFAULT_ADMIN_LOGIN,
                    help=f"Admin login name (default: {DEFAULT_ADMIN_LOGIN})")
    ap.add_argument("--admin-name", default=DEFAULT_ADMIN_NAME)
    ap.add_argument("--admin-password", default=None,
                    help="Omit for a password matching the login with --demo, "
                         "else a random one.")
    ap.add_argument("--demo", action="store_true",
                    help="Issue simple passwords matching each login name")
    ap.add_argument("--reset", action="store_true",
                    help="Overwrite passwords of existing users (and reactivate them)")
    args = ap.parse_args()

    init_db()
    db = SessionLocal()
    created = []

    try:
        print("\n[seed] Locations")
        locations = [ensure_location(db, n) for n in DEFAULT_LOCATIONS]

        # With --demo each password matches its login so it is trivial to
        # recall; without it, a random password is generated instead.
        print("\n[seed] Administrator")
        admin_pw = args.admin_password or (
            args.admin_email if args.demo else _random_password()
        )
        issued = ensure_user(db, args.admin_email, args.admin_name,
                             DEFAULT_ADMIN_ROLE, admin_pw, locations[0],
                             reset=args.reset)
        if issued:
            created.append((DEFAULT_ADMIN_ROLE, args.admin_email, issued))

        print("\n[seed] Clinicians")
        for login, name, role in PRACTICE_DOCTORS:
            pw = login if args.demo else _random_password()
            issued = ensure_user(db, login, name, role, pw,
                                 locations[0], reset=args.reset)
            if issued:
                created.append((role, login, issued))

        if created:
            print("\n" + "=" * 58)
            print("  LOGIN CREDENTIALS")
            print("=" * 58)
            for role, username, pw in created:
                print(f"  {role:13s} {username:12s} / {pw}")
            print("=" * 58)
            if args.demo:
                print("  DEMO credentials -- change them before real patient data.")
        else:
            print("\n[seed] Nothing new created; all records already present.")
            print("[seed] Use --reset to overwrite existing passwords.")

        if not os.environ.get("SESSION_SECRET_KEY"):
            print("\n[seed] REMINDER: SESSION_SECRET_KEY is not set -- sessions will")
            print("       reset on every backend restart until you set it.")

    finally:
        db.close()


if __name__ == "__main__":
    main()
