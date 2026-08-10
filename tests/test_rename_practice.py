"""
Rebranding an existing database must preserve identity.

User IDs are referenced by case assignments, review locks and signed
prescriptions, so a rename must update rows in place. The dangerous failure is
deleting and recreating: that silently orphans a signature from the clinician
who made it.

The practice keeps a dedicated administrator account. Patrick and Arcaro both
treat patients and neither carries practice-wide access.
"""
import pytest

import rename_practice
from db import Location, ROLE_ADMIN, ROLE_ORTHODONTIST, User


def _make_db(tmp_path, monkeypatch, users):
    """A database seeded with (login, full_name, role) rows."""
    import sys

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'rename.db'}")
    for module in ("db", "auth", "main"):
        sys.modules.pop(module, None)

    import db as db_module

    # create_all rather than init_db(): the rename only touches two tables, and
    # this avoids running the whole alembic chain for a throwaway database.
    db_module.Base.metadata.create_all(db_module.engine)
    session = db_module.SessionLocal()

    main = db_module.Location(name="Main Practice")
    north = db_module.Location(name="Northside Clinic")
    session.add_all([main, north])
    session.commit()

    session.add_all([
        db_module.User(email=login, full_name=name, role=role,
                       password_hash="x", primary_location_id=main.id)
        for login, name, role in users
    ])
    session.commit()
    return session


@pytest.fixture
def seeded_db(tmp_path, monkeypatch):
    """A database carrying the original placeholder rows."""
    session = _make_db(tmp_path, monkeypatch, [
        ("admin", "Practice Administrator", ROLE_ADMIN),
        ("doctor", "Doctor One", ROLE_ORTHODONTIST),
        ("doctor2", "Doctor Two", ROLE_ORTHODONTIST),
    ])
    yield session
    session.close()


@pytest.fixture
def patrick_as_admin_db(tmp_path, monkeypatch):
    """A database from the earlier run that made Patrick the administrator."""
    session = _make_db(tmp_path, monkeypatch, [
        ("patrick", "Dr Patrick", ROLE_ADMIN),
        ("arcaro", "Dr Arcaro", ROLE_ORTHODONTIST),
    ])
    yield session
    session.close()


@pytest.fixture
def half_renamed_db(tmp_path, monkeypatch):
    """A database left mid-way by an earlier run of a different mapping.

    'arcaro' already exists, and a stale 'doctor2' placeholder is still present
    pointing at the same person. Renaming that placeholder onto the taken login
    would collide on the unique email constraint.
    """
    session = _make_db(tmp_path, monkeypatch, [
        ("patrick", "Dr Patrick", ROLE_ADMIN),
        ("arcaro", "Dr Arcaro", ROLE_ORTHODONTIST),
        ("doctor2", "Doctor Two", ROLE_ORTHODONTIST),
    ])
    yield session
    session.close()


def _by_login(db, login):
    return db.query(User).filter(User.email == login).first()


def test_dry_run_writes_nothing(seeded_db):
    changes = rename_practice.apply(seeded_db, dry_run=True)

    assert changes, "a dry run should still report what it would do"
    assert _by_login(seeded_db, "doctor") is not None
    assert _by_login(seeded_db, "patrick") is None


def test_doctor_one_becomes_patrick_keeping_the_same_row(seeded_db):
    original_id = _by_login(seeded_db, "doctor").id

    rename_practice.apply(seeded_db)

    patrick = _by_login(seeded_db, "patrick")
    assert patrick is not None
    # The same row: anything already assigned to this id still resolves.
    assert patrick.id == original_id
    assert patrick.full_name == "Dr Patrick"
    assert patrick.role == ROLE_ORTHODONTIST


def test_doctor_two_becomes_arcaro_keeping_the_same_row(seeded_db):
    original_id = _by_login(seeded_db, "doctor2").id

    rename_practice.apply(seeded_db)

    arcaro = _by_login(seeded_db, "arcaro")
    assert arcaro is not None
    assert arcaro.id == original_id
    assert arcaro.full_name == "Dr Arcaro"
    assert arcaro.role == ROLE_ORTHODONTIST


def test_the_administrator_account_is_left_alone(seeded_db):
    """Practice-wide access stays on its own login, untouched by the rebrand."""
    rename_practice.apply(seeded_db)

    admin = _by_login(seeded_db, "admin")
    assert admin is not None
    assert admin.role == ROLE_ADMIN
    assert admin.is_active is True


def test_a_clinician_promoted_to_admin_is_demoted_back(patrick_as_admin_db):
    """Undoes the earlier run that put practice-wide access on Patrick."""
    rename_practice.apply(patrick_as_admin_db)

    patrick = _by_login(patrick_as_admin_db, "patrick")
    assert patrick.role == ROLE_ORTHODONTIST


def test_demoting_the_last_admin_restores_a_dedicated_one(patrick_as_admin_db):
    """Demoting the only admin without a replacement would lock everyone out."""
    rename_practice.apply(patrick_as_admin_db)

    admin = _by_login(patrick_as_admin_db, "admin")
    assert admin is not None, "an administrator account must always exist"
    assert admin.role == ROLE_ADMIN
    assert admin.is_active is True


def test_a_rename_onto_a_taken_login_is_refused(half_renamed_db):
    """Two rows with the same login would break sign-in for that doctor."""
    original = _by_login(half_renamed_db, "arcaro")
    original_id = original.id

    rename_practice.apply(half_renamed_db)

    matches = half_renamed_db.query(User).filter(User.email == "arcaro").all()
    assert len(matches) == 1, "the login must not be duplicated"
    assert matches[0].id == original_id, "the real account must be the survivor"


def test_a_stale_placeholder_blocked_by_a_rename_is_retired(half_renamed_db):
    """It cannot be renamed, so it must not be left active and signable-into."""
    rename_practice.apply(half_renamed_db)

    stale = _by_login(half_renamed_db, "doctor2")
    assert stale is not None, "placeholder users must not be deleted"
    assert stale.is_active is False


def test_the_practice_location_is_renamed(seeded_db):
    rename_practice.apply(seeded_db)

    names = {loc.name for loc in seeded_db.query(Location).all()}
    assert "Passion Dental" in names
    assert "Main Practice" not in names


def test_demo_location_is_deactivated_not_deleted(seeded_db):
    rename_practice.apply(seeded_db)

    north = seeded_db.query(Location).filter(
        Location.name == "Northside Clinic").first()
    assert north is not None
    assert north.is_active is False


def test_running_twice_changes_nothing_the_second_time(seeded_db):
    rename_practice.apply(seeded_db)

    assert rename_practice.apply(seeded_db) == []


def test_no_placeholder_names_survive(seeded_db):
    rename_practice.apply(seeded_db)

    active_names = {
        u.full_name for u in seeded_db.query(User).filter(User.is_active).all()
    }
    assert active_names == {"Practice Administrator", "Dr Patrick", "Dr Arcaro"}
