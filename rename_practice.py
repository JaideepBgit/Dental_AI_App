"""
rename_practice.py - Rebrand an existing database to the real practice.

The seed script only shapes a *fresh* database. A database already carrying the
placeholder rows ('Doctor One', 'Main Practice') needs those rows updated in
place, because renaming preserves the user IDs that assignments, review locks
and signed prescriptions point at. Deleting and recreating would orphan them.

Idempotent, and safe to run against a database that has already been renamed.

    python rename_practice.py --dry-run    # show what would change
    python rename_practice.py              # apply
"""

import argparse

from db import Base, Location, ROLE_ADMIN, ROLE_ORTHODONTIST, SessionLocal, User, engine

#: old login -> (new login, new full name, new role)
#:
#: The 'admin' account is deliberately absent: practice-wide access lives on its
#: own login, not on a clinician's, so the rebrand leaves it alone.
USER_RENAMES = {
    "doctor": ("patrick", "Dr Patrick", ROLE_ORTHODONTIST),
    "doctor2": ("arcaro", "Dr Arcaro", ROLE_ORTHODONTIST),
}

#: Logins that were placeholders and have no real person behind them. They are
#: deactivated rather than deleted: a user row may be referenced by a past
#: sign-off, and those must always resolve to whoever made them.
USERS_TO_RETIRE = []

#: The dedicated administrator, recreated if a previous run moved the role onto
#: a clinician and left no other admin behind.
ADMIN_LOGIN = "admin"
ADMIN_NAME = "Practice Administrator"

#: Not a hash of anything. bcrypt/argon verification against this fails closed,
#: so a recreated admin cannot be signed into until a password is set for it.
UNUSABLE_PASSWORD_HASH = "!"

#: old location name -> new name
LOCATION_RENAMES = {"Main Practice": "Passion Dental"}

#: Locations that were demo filler. Deactivated, not deleted, so any x-ray still
#: pointing at one keeps a resolvable location.
LOCATIONS_TO_RETIRE = ["Northside Clinic"]


def rename_users(db, dry_run: bool) -> list[str]:
    """Rename each placeholder login to the clinician who uses it.

    A target login already taken means an earlier run under a different mapping
    already created the real account. The placeholder is then a duplicate of a
    person who exists, so it is retired rather than renamed onto them -- writing
    it would collide on the unique email constraint and, if it somehow did not,
    would leave that doctor with two accounts.
    """
    changes = []
    for old_login, (new_login, new_name, new_role) in USER_RENAMES.items():
        user = db.query(User).filter(User.email == old_login).first()
        if user is None:
            # Already renamed on an earlier run, or never seeded.
            continue

        taken = db.query(User).filter(
            User.email == new_login, User.id != user.id).first()
        if taken is not None:
            if not user.is_active:
                continue
            changes.append(
                f"user {user.id}: {old_login!r} deactivated -- {new_login!r} "
                f"already exists as user {taken.id}"
            )
            if not dry_run:
                user.is_active = False
            continue

        changes.append(
            f"user {user.id}: {user.email!r} -> {new_login!r}, "
            f"{user.full_name!r} -> {new_name!r}, role {user.role} -> {new_role}"
        )
        if not dry_run:
            user.email = new_login
            user.full_name = new_name
            user.role = new_role
    return changes


def demote_clinician_admins(db, dry_run: bool) -> list[str]:
    """Move practice-wide access off any clinician login that holds it.

    An earlier version of this script made Patrick the administrator. Reverting
    that is not just a role flip: demoting the last remaining admin would leave
    nobody able to add users or assign cases, so a dedicated admin account is
    ensured first (see `ensure_administrator`).
    """
    changes = []
    clinician_logins = {new_login for new_login, _, _ in USER_RENAMES.values()}
    for login in sorted(clinician_logins):
        user = db.query(User).filter(User.email == login).first()
        if user is None or user.role != ROLE_ADMIN:
            continue
        changes.append(
            f"user {user.id}: {login!r} role {ROLE_ADMIN} -> {ROLE_ORTHODONTIST} "
            f"(practice-wide access belongs to {ADMIN_LOGIN!r})"
        )
        if not dry_run:
            user.role = ROLE_ORTHODONTIST
    return changes


def ensure_administrator(db, dry_run: bool) -> list[str]:
    """Guarantee an active administrator exists.

    Runs before any demotion. If the only admin is a clinician about to be
    demoted, this recreates the dedicated account so the practice is never left
    without one. A deactivated 'admin' is reactivated rather than duplicated.
    """
    existing = db.query(User).filter(User.email == ADMIN_LOGIN).first()
    if existing is not None:
        if existing.role == ROLE_ADMIN and existing.is_active:
            return []
        changes = [
            f"user {existing.id}: {ADMIN_LOGIN!r} restored to an active "
            f"{ROLE_ADMIN}"
        ]
        if not dry_run:
            existing.role = ROLE_ADMIN
            existing.is_active = True
            existing.deactivated_at = None
        return changes

    changes = [
        f"user: {ADMIN_LOGIN!r} created as {ROLE_ADMIN} "
        "(no administrator account present)"
    ]
    if not dry_run:
        # No usable password: this account must be given one deliberately, via
        # `seed_users.py --reset` or the Administration screen. A guessable
        # default on an admin login is worse than an unusable one.
        db.add(User(
            email=ADMIN_LOGIN,
            full_name=ADMIN_NAME,
            role=ROLE_ADMIN,
            password_hash=UNUSABLE_PASSWORD_HASH,
            primary_location_id=_practice_location_id(db),
        ))
    return changes


def _practice_location_id(db):
    loc = db.query(Location).filter(Location.is_active).first()
    return loc.id if loc else None


def retire_users(db, dry_run: bool) -> list[str]:
    changes = []
    for login in USERS_TO_RETIRE:
        user = db.query(User).filter(User.email == login).first()
        if user is None or not user.is_active:
            continue
        changes.append(f"user {user.id}: {login!r} deactivated (placeholder)")
        if not dry_run:
            user.is_active = False
    return changes


def rename_locations(db, dry_run: bool) -> list[str]:
    changes = []
    for old_name, new_name in LOCATION_RENAMES.items():
        loc = db.query(Location).filter(Location.name == old_name).first()
        if loc is None:
            continue
        changes.append(f"location {loc.id}: {old_name!r} -> {new_name!r}")
        if not dry_run:
            loc.name = new_name
    return changes


def retire_locations(db, dry_run: bool) -> list[str]:
    changes = []
    for name in LOCATIONS_TO_RETIRE:
        loc = db.query(Location).filter(Location.name == name).first()
        if loc is None or not loc.is_active:
            continue
        changes.append(f"location {loc.id}: {name!r} deactivated (placeholder)")
        if not dry_run:
            loc.is_active = False
    return changes


def apply(db, dry_run: bool = False) -> list[str]:
    """Run every rename. Returns a human-readable list of what changed."""
    # Order matters: an administrator is ensured *before* any clinician is
    # demoted, so the practice is never momentarily left without one.
    changes = (
        rename_locations(db, dry_run)
        + retire_locations(db, dry_run)
        + rename_users(db, dry_run)
        + ensure_administrator(db, dry_run)
        + demote_clinician_admins(db, dry_run)
        + retire_users(db, dry_run)
    )
    if changes and not dry_run:
        db.commit()
    return changes


def main():
    ap = argparse.ArgumentParser(description="Rebrand the database to Passion Dental")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the changes without writing them")
    args = ap.parse_args()

    # Only the users and locations tables are touched, and both predate every
    # migration, so the schema is not advanced here: this script renames rows in
    # a database the app already manages. create_all is a no-op on an existing
    # schema and simply lets this run against an empty file too.
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        changes = apply(db, dry_run=args.dry_run)
        header = "would change" if args.dry_run else "changed"
        if not changes:
            print("[rename] nothing to do; already renamed.")
            return
        print(f"\n[rename] {header}:")
        for line in changes:
            print(f"  {line}")
        if args.dry_run:
            print("\n[rename] dry run -- nothing written. Re-run without --dry-run.")
        else:
            print(f"\n[rename] {len(changes)} change(s) committed.")
            print("[rename] Passwords are unchanged. Reset them from "
                  "Administration, or with: python seed_users.py --reset")
    finally:
        db.close()


if __name__ == "__main__":
    main()
