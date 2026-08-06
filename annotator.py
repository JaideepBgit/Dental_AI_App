"""
annotator.py - Burns arrows and tooth labels onto a panoramic radiograph.

Mahesh's ask was arrows pointing at the 3rd molars, not just boxes, so the
annotated image is what goes into the referral PDF. Colour coding:

  red    tooth the doctor marked for extraction
  amber  3rd molar, reviewed, not marked for extraction
  slate  every other detected tooth

Nothing here decides anything clinical; it renders decisions made elsewhere.
"""

import os

import cv2

COLOR_EXTRACTION = (60, 60, 220)    # BGR red
COLOR_THIRD_MOLAR = (20, 160, 235)  # BGR amber
COLOR_OTHER = (150, 130, 110)       # BGR slate

_FONT = cv2.FONT_HERSHEY_SIMPLEX


def _scaled(value: float, width: int, minimum: int = 1) -> int:
    """Scale a constant tuned at 2000px wide to the actual image width."""
    return max(minimum, int(round(value * width / 2000.0)))


def annotate(
    image_path: str,
    detections: list,
    output_path: str,
    only_annotated: bool = True,
) -> str:
    """
    Draw arrows/labels for `detections` and write to `output_path`.

    only_annotated=True draws just the teeth that carry a decision (extraction
    or 3rd molar). A referral slip about two wisdom teeth shouldn't be cluttered
    with 30 boxes.
    """
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not decode image: {image_path}")

    height, width = img.shape[:2]
    overlay = img.copy()

    thickness = _scaled(4, width, 2)
    font_scale = max(0.4, width / 2600.0)
    arrow_len = _scaled(110, width, 20)

    for det in detections:
        needs_extraction = bool(det.get("needs_extraction"))
        is_third_molar = bool(det.get("is_third_molar"))

        if only_annotated and not (needs_extraction or is_third_molar):
            continue

        if needs_extraction:
            color = COLOR_EXTRACTION
        elif is_third_molar:
            color = COLOR_THIRD_MOLAR
        else:
            color = COLOR_OTHER

        x1, y1, x2, y2 = (int(round(v)) for v in det["bbox"])
        cx = (x1 + x2) // 2

        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, thickness)

        # Arrow points down at the tooth from above, or up from below for the
        # lower arch, so it never crosses the opposing teeth.
        is_upper = (det.get("quadrant") or "").startswith("Upper")
        if is_upper:
            tip = (cx, max(0, y1 - _scaled(6, width)))
            tail = (cx, max(0, y1 - arrow_len))
        else:
            tip = (cx, min(height, y2 + _scaled(6, width)))
            tail = (cx, min(height, y2 + arrow_len))
        cv2.arrowedLine(overlay, tail, tip, color, thickness, tipLength=0.35)

        fdi = det.get("fdi_number")
        label = f"FDI {fdi}" if fdi else str(det.get("class_name", "tooth"))
        if needs_extraction:
            label += " - EXTRACT"

        (tw, th), _ = cv2.getTextSize(label, _FONT, font_scale, 1)
        pad = _scaled(8, width, 2)
        # Park the label at the arrow tail, clamped inside the frame.
        ly = tail[1] - pad if is_upper else tail[1] + th + pad
        ly = min(max(th + pad, ly), height - pad)
        lx = min(max(pad, cx - tw // 2), width - tw - pad)

        cv2.rectangle(
            overlay,
            (lx - pad, ly - th - pad),
            (lx + tw + pad, ly + pad),
            color,
            -1,
        )
        cv2.putText(overlay, label, (lx, ly), _FONT, font_scale, (255, 255, 255), 1, cv2.LINE_AA)

    # Blend so the radiograph stays readable underneath the markup.
    cv2.addWeighted(overlay, 0.75, img, 0.25, 0, img)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    if not cv2.imwrite(output_path, img):
        raise IOError(f"Failed to write annotated image: {output_path}")
    return output_path
