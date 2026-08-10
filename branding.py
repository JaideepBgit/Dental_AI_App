"""
branding.py - The practice's identity, in one place.

The practice name is printed on referral PDFs that go to patients, so it must
have exactly one definition; a literal retyped at each call site is a name that
eventually disagrees with itself.

`PRACTICE_NAME` is the constant for import-time use. `practice_name()` reads the
environment on every call so a deployment can override it without a code change,
which is what a second practice running this needs.
"""
import os

DEFAULT_PRACTICE_NAME = "Passion Dental"

#: Tagline under the heading on the referral PDF.
PRACTICE_TAGLINE = "panoramic radiograph review"


def practice_name() -> str:
    """The practice name, honouring a PRACTICE_NAME override.

    A blank or whitespace-only override is a misconfiguration rather than a
    request for an empty letterhead, so it falls back to the default.
    """
    return os.environ.get("PRACTICE_NAME", "").strip() or DEFAULT_PRACTICE_NAME


PRACTICE_NAME = practice_name()
