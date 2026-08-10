"""
The seed script bootstraps the real practice, not a generic demo.

A fresh database must come up with Passion Dental's own people in it, and
re-running the seed must never disturb an account somebody is already using.

The administrator is a separate account from the clinicians: Patrick and Arcaro
both treat patients, and neither carries practice-wide access.
"""
import seed_users
from db import ROLE_ADMIN, ROLE_ORTHODONTIST


def test_practice_doctors_are_the_named_clinicians():
    names = {name for _, name, _ in seed_users.PRACTICE_DOCTORS}
    assert names == {"Dr Patrick", "Dr Arcaro"}


def test_every_clinician_is_a_doctor_not_an_administrator():
    """Practice-wide access belongs to the admin account, not a treating doctor."""
    roles = {role for _, _, role in seed_users.PRACTICE_DOCTORS}
    assert roles == {ROLE_ORTHODONTIST}


def test_the_administrator_is_its_own_account():
    assert seed_users.DEFAULT_ADMIN_LOGIN == "admin"
    assert seed_users.DEFAULT_ADMIN_ROLE == ROLE_ADMIN


def test_the_administrator_is_not_one_of_the_clinicians():
    logins = {login for login, _, _ in seed_users.PRACTICE_DOCTORS}
    assert seed_users.DEFAULT_ADMIN_LOGIN not in logins


def test_logins_are_the_doctors_own_names():
    logins = {login for login, _, _ in seed_users.PRACTICE_DOCTORS}
    assert logins == {"patrick", "arcaro"}


def test_the_practice_location_is_named_for_the_practice():
    assert seed_users.DEFAULT_LOCATIONS[0] == "Passion Dental"
