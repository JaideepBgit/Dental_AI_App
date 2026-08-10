"""
The practice name is one string, in one place.

It reaches a patient-facing document -- the referral PDF -- so it must not be
retyped per call site where one copy can drift from another.
"""
from branding import PRACTICE_NAME, practice_name


def test_practice_name_defaults_to_the_practice():
    assert PRACTICE_NAME == "Passion Dental"


def test_practice_name_is_overridable_by_environment(monkeypatch):
    # A second practice deploying this should not need a code change.
    monkeypatch.setenv("PRACTICE_NAME", "Northside Orthodontics")
    assert practice_name() == "Northside Orthodontics"


def test_blank_environment_override_falls_back_to_the_default(monkeypatch):
    # An empty env var is a misconfiguration, not a request for a blank header.
    monkeypatch.setenv("PRACTICE_NAME", "   ")
    assert practice_name() == "Passion Dental"


def _referral_bytes(tmp_path, **kwargs):
    """Build a referral PDF and hand back its raw bytes.

    No PDF text-extraction library is a dependency of this project, and adding
    one for a single assertion is not worth it: reportlab writes the document
    title and metadata as literal strings, so a byte search is enough to catch
    the name drifting or reverting.
    """
    from referral import generate_referral

    out = tmp_path / "referral.pdf"
    kwargs.setdefault("doctor_name", "")
    generate_referral(
        output_path=str(out),
        patient_name="Test Patient",
        mrn="MRN-1",
        prescription_text="Extract 18, 28.",
        detections=[],
        **kwargs,
    )
    return out.read_bytes()


def test_referral_pdf_is_authored_by_the_practice_not_the_old_brand(tmp_path):
    """The PDF is what a patient receives; its author must not say SmileAI."""
    raw = _referral_bytes(tmp_path)

    # With no signing doctor the author falls back to the practice.
    assert b"Passion Dental" in raw
    assert b"SmileAI" not in raw


def test_referral_pdf_names_the_signing_doctor_as_author(tmp_path):
    raw = _referral_bytes(tmp_path, doctor_name="Dr Patrick")

    assert b"Dr Patrick" in raw
    assert b"SmileAI" not in raw


def test_referral_pdf_follows_the_environment_override(tmp_path, monkeypatch):
    monkeypatch.setenv("PRACTICE_NAME", "Northside Orthodontics")
    raw = _referral_bytes(tmp_path)

    assert b"Northside Orthodontics" in raw
