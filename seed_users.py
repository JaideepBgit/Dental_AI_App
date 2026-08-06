"""
seed_users.py - Bootstrap the practice: locations, an admin, and orthodontists.

Idempotent: re-running skips anything already present rather than duplicating it.
Existing passwords are never overwritten -- an operator re-running the seed must
not clobber a credential somebody is already using.

Login names are bare usernames ('admin', 'doctor'), not email addresses, so they
are quick to type during a demo. The column is still called `email` since it
accepts either.

    python seed_users.py --demo                   # admin + two doctors (simple)
    python seed_users.py --admin-password '...'   # choose the admin password
    python seed_users.py --reset                  # rewrite the demo passwords

WARNING: the defaults here are demo credentials -- 'admin'/'admin'. Replace them
before this touches real patient data.
"""

import argparse
import os
import secrets
import string

from auth import hash_password
from db import (Location, ROLE_ADMIN, ROLE_ORTHODONTIST, SessionLocal, User,
                init_db)

DEFAULT_LOCATIONS = ["Main Practice", "Northside Clinic"]


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
    ap.add_argument("--admin-email", default="admin",
                    help="Admin login name (default: admin)")
    ap.add_argument("--admin-name", default="Practice Administrator")
    ap.add_argument("--admin-password", default=None,
                    help="Omit to use 'admin' with --demo, else a random one.")
    ap.add_argument("--demo", action="store_true",
                    help="Create simple demo logins: admin/admin, doctor/doctor")
    ap.add_argument("--reset", action="store_true",
                    help="Overwrite passwords of existing users (and reactivate them)")
    args = ap.parse_args()

    init_db()
    db = SessionLocal()
    created = []

    try:
        print("\n[seed] Locations")
        locations = [ensure_location(db, n) for n in DEFAULT_LOCATIONS]

        print("\n[seed] Administrator")
        # With --demo the password matches the username so it is trivial to
        # recall; without it, a random password is generated instead.
        pw = args.admin_password or ("admin" if args.demo else _random_password())
        issued = ensure_user(db, args.admin_email, args.admin_name,
                             ROLE_ADMIN, pw, locations[0], reset=args.reset)
        if issued:
            created.append(("ADMIN", args.admin_email, issued))

        if args.demo:
            print("\n[seed] Orthodontists")
            for username, name, loc in [
                ("doctor", "Doctor One", locations[0]),
                ("doctor2", "Doctor Two", locations[1]),
            ]:
                issued = ensure_user(db, username, name, ROLE_ORTHODONTIST,
                                     username, loc, reset=args.reset)
                if issued:
                    created.append(("ORTHODONTIST", username, issued))

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
