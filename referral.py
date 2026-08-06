"""
referral.py - Referral slip / prescription PDF generator.

Differs from the root referral_generator.py in three ways that matter:

  * the doctor's drawn e-signature is embedded, not a typed name;
  * the findings table lists only teeth the DOCTOR marked, and says plainly
    when the doctor marked none;
  * the AI's role is disclosed as detection-only, so nothing in the document
    implies the software made a diagnosis.
"""

import os
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    Image as RLImage, KeepTogether,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT_DIR = os.path.join(BASE_DIR, "output_prescriptions")

_INK = colors.HexColor("#111827")
_ACCENT = colors.HexColor("#633394")
_MUTED = colors.HexColor("#6b7280")
_RULE = colors.HexColor("#e5e7eb")
_WASH = colors.HexColor("#f9fafb")
_DANGER = colors.HexColor("#b91c1c")


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title", parent=base["Heading1"], fontName="Helvetica-Bold",
            fontSize=17, leading=21, textColor=_INK, spaceAfter=2,
        ),
        "subtitle": ParagraphStyle(
            "Subtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=13, textColor=_MUTED, spaceAfter=14,
        ),
        "section": ParagraphStyle(
            "Section", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=10.5, leading=14, textColor=_ACCENT, spaceBefore=6, spaceAfter=7,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=14, textColor=_INK,
        ),
        "cell": ParagraphStyle(
            "Cell", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, leading=12, textColor=_INK,
        ),
        "small": ParagraphStyle(
            "Small", parent=base["Normal"], fontName="Helvetica",
            fontSize=8, leading=11, textColor=_MUTED,
        ),
    }


def _fit(image_path: str, max_width: float, max_height: float):
    """
    Scale an image to fit a box while preserving aspect ratio.

    Returns None if the file cannot be read. An unreadable radiograph or
    signature must not abort the referral — the PDF is the legal record of the
    doctor's decision and matters more than its illustrations.
    """
    try:
        reader = ImageReader(image_path)
        iw, ih = reader.getSize()
        if not iw or not ih:
            return None
        scale = min(max_width / iw, max_height / ih)
        return RLImage(image_path, width=iw * scale, height=ih * scale)
    except Exception as exc:
        print(f"[referral] could not embed image {image_path}: {exc}")
        return None


def generate_referral(
    output_path: str,
    patient_name: str,
    mrn: str,
    doctor_name: str,
    prescription_text: str,
    detections: list,
    annotated_image_path: str = None,
    signature_path: str = None,
    appointment_date: str = None,
    model_info: dict = None,
) -> str:
    """Build the referral PDF. Returns the written path."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    st = _styles()
    now = datetime.now()

    doc = SimpleDocTemplate(
        output_path, pagesize=letter,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
        title=f"Referral - {patient_name}", author=doctor_name or "SmileAI",
    )
    avail = doc.width
    story = []

    story.append(Paragraph("DENTAL REFERRAL &amp; PRESCRIPTION NOTE", st["title"]))
    story.append(Paragraph("SmileAI Portal — panoramic radiograph review", st["subtitle"]))

    meta = [
        [Paragraph("<b>Patient</b>", st["cell"]), Paragraph(patient_name or "—", st["cell"]),
         Paragraph("<b>MRN</b>", st["cell"]), Paragraph(mrn or "—", st["cell"])],
        [Paragraph("<b>Appointment</b>", st["cell"]), Paragraph(appointment_date or "—", st["cell"]),
         Paragraph("<b>Reviewed</b>", st["cell"]), Paragraph(now.strftime("%Y-%m-%d %H:%M"), st["cell"])],
    ]
    t = Table(meta, colWidths=[avail * 0.16, avail * 0.34, avail * 0.16, avail * 0.34])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _WASH),
        ("BOX", (0, 0), (-1, -1), 0.75, _RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(t)
    story.append(Spacer(1, 16))

    if annotated_image_path and os.path.exists(annotated_image_path):
        story.append(Paragraph("Annotated radiograph", st["section"]))
        img = _fit(annotated_image_path, avail, 3.1 * inch)
        if img:
            story.append(img)
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                "Arrows mark teeth reviewed by the attending dentist. "
                "Red indicates a tooth marked for extraction.", st["small"]))
        story.append(Spacer(1, 14))

    # Findings — only what the doctor actually marked.
    marked = [d for d in detections if d.get("needs_extraction")]
    story.append(Paragraph("Extraction findings", st["section"]))

    if marked:
        rows = [[
            Paragraph("<b>Tooth (FDI)</b>", st["cell"]),
            Paragraph("<b>Universal</b>", st["cell"]),
            Paragraph("<b>Quadrant</b>", st["cell"]),
            Paragraph("<b>Assessment</b>", st["cell"]),
            Paragraph("<b>Recommendation</b>", st["cell"]),
        ]]
        for d in marked:
            rows.append([
                Paragraph(str(d.get("fdi_number") or "—"), st["cell"]),
                Paragraph(str(d.get("universal_number") or "—"), st["cell"]),
                Paragraph(str(d.get("quadrant") or "—"), st["cell"]),
                Paragraph(str(d.get("impaction_type") or "Clinical judgement"), st["cell"]),
                Paragraph("<b>Extraction indicated</b>", st["cell"]),
            ])
        ft = Table(rows, colWidths=[avail * 0.15, avail * 0.15, avail * 0.2, avail * 0.25, avail * 0.25],
                   repeatRows=1)
        ft.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), _ACCENT),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.5, _RULE),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _WASH]),
            ("TEXTCOLOR", (4, 1), (4, -1), _DANGER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ]))
        story.append(ft)
    else:
        story.append(Paragraph(
            "No teeth were marked for extraction during this review.", st["body"]))

    story.append(Spacer(1, 16))

    story.append(Paragraph("Prescription / clinical notes", st["section"]))
    text = (prescription_text or "").strip() or "—"
    for para in text.split("\n"):
        if para.strip():
            story.append(Paragraph(para.strip().replace("&", "&amp;"), st["body"]))
            story.append(Spacer(1, 3))

    story.append(Spacer(1, 20))

    # Signature block — kept on one page so a signature never orphans.
    sig_bits = [Paragraph("Authorised by", st["section"])]
    if signature_path and os.path.exists(signature_path):
        sig_img = _fit(signature_path, 2.4 * inch, 0.85 * inch)
        if sig_img:
            sig_bits.append(sig_img)
    sig_bits.append(Spacer(1, 2))
    sig_table = Table(
        [[Paragraph(
            f"<b>Dr. {doctor_name}</b><br/>"
            f"Electronically signed {now.strftime('%Y-%m-%d %H:%M:%S')}"
            if doctor_name else "Signature on file", st["cell"])]],
        colWidths=[3.2 * inch],
    )
    sig_table.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.75, _INK),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    sig_bits.append(sig_table)
    story.append(KeepTogether(sig_bits))

    story.append(Spacer(1, 14))

    # Disclosure: state exactly what the software did and did not do.
    if model_info and not model_info.get("supports_pathology", False):
        ai_note = (
            "AI assistance: automated tooth detection and numbering only "
            f"(model: {model_info.get('path', 'n/a')}, "
            f"{model_info.get('num_classes', 0)} anatomical classes). "
            "This model does not assess caries, impaction, or any pathology. "
            "All clinical findings and extraction decisions in this document "
            "were made by the attending dentist."
        )
    else:
        ai_note = (
            "AI assistance: automated detection is decision-support only. "
            "All clinical findings and extraction decisions were reviewed and "
            "confirmed by the attending dentist."
        )
    story.append(Paragraph(ai_note, st["small"]))

    doc.build(story)
    return output_path
