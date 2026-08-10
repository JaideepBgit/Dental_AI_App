"""
inference.py - Detection + FDI tooth numbering for panoramic radiographs.

Two deliberate constraints:

1. Nothing is ever fabricated. If the model returns no boxes, this returns an
   empty list. There is no synthetic-detection fallback.
2. Extraction and impaction are never inferred. Detection confidence says how
   sure the model is that a tooth is *there* — it carries no information about
   whether the tooth is diseased. Those fields stay None/False until either a
   doctor sets them or a model trained to classify impaction provides them.

Tooth numbering is geometric (quadrant + horizontal rank from the midline), so
it works with an anatomy-only model. When a model emits explicit per-tooth
classes, set FDI_FROM_CLASS_NAMES and it will trust the class instead.
"""

import os
import re
from typing import Optional

import cv2
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Two models, because no single set of weights covers both tabs:
#
#   best_dental_seg.pt    12 pathology/anatomy classes (Caries, Filling,
#                         'impacted tooth', ...) with polygon masks. Knows
#                         nothing about individual teeth, so it can never say
#                         which tooth is a 3rd molar.
#   best_dental_model.pt  2 classes, {Tooth, 3rd_Molar}. Names third molars
#                         explicitly, which is what the Detection tab filters on.
#
# The Detection tab therefore runs the detector and the Segmentation tab runs
# the seg model. Either can be overridden independently.
#   best_dental_hier.pt   128 classes, Q{1-4}_tooth_{1-8}_{disease}. Names both
#                         the quadrant and the position, so a third molar is
#                         'Q3_tooth_8_*' — no geometry needed to identify it,
#                         and a first molar can be told apart from a wisdom
#                         tooth instead of forced into one of four labels.
#   best_dental_m3.pt     5 classes, {Tooth, M3_UR, M3_UL, M3_LL, M3_LR}. The
#                         retrained detector: same question as best_dental_model
#                         but it names WHICH wisdom tooth, so no geometric
#                         fallback is needed. Runs behind the Wisdom (M3) tab
#                         for side-by-side comparison against the 2-class
#                         detector; once trusted it replaces it in Detection.
DEFAULT_WEIGHTS = os.path.join(BASE_DIR, "models", "best_dental_model.pt")
DEFAULT_SEG_WEIGHTS = os.path.join(BASE_DIR, "models", "best_dental_seg.pt")
DEFAULT_HIER_WEIGHTS = os.path.join(BASE_DIR, "models", "best_dental_hier.pt")
DEFAULT_M3_WEIGHTS = os.path.join(BASE_DIR, "models", "best_dental_m3.pt")

# Panoramic radiographs are shot facing the patient: image-left is the
# patient's RIGHT side. Quadrant naming below follows patient anatomy.
QUADRANT_UPPER_RIGHT = "Upper-Right"
QUADRANT_UPPER_LEFT = "Upper-Left"
QUADRANT_LOWER_RIGHT = "Lower-Right"
QUADRANT_LOWER_LEFT = "Lower-Left"

# FDI first digit per quadrant; second digit is 1..8 outward from the midline.
FDI_QUADRANT_DIGIT = {
    QUADRANT_UPPER_RIGHT: 1,
    QUADRANT_UPPER_LEFT: 2,
    QUADRANT_LOWER_LEFT: 3,
    QUADRANT_LOWER_RIGHT: 4,
}

# Universal numbering (1-32), indexed by FDI code.
FDI_TO_UNIVERSAL = {
    18: 1, 17: 2, 16: 3, 15: 4, 14: 5, 13: 6, 12: 7, 11: 8,
    21: 9, 22: 10, 23: 11, 24: 12, 25: 13, 26: 14, 27: 15, 28: 16,
    38: 17, 37: 18, 36: 19, 35: 20, 34: 21, 33: 22, 32: 23, 31: 24,
    41: 25, 42: 26, 43: 27, 44: 28, 45: 29, 46: 30, 47: 31, 48: 32,
}

# Model class names that already encode a tooth position, e.g. 'tooth_38'.
FDI_FROM_CLASS_NAMES = True

_THIRD_MOLAR_FDI = {18, 28, 38, 48}

# Class names that assert "this is a wisdom tooth" without naming which one.
# Matches '3rd_Molar' (the detector's class), 'third_molar', 'Third Molar'.
# Deliberately NOT 'impacted tooth': impaction is a separate finding that also
# occurs on canines and premolars, so it is neither necessary nor sufficient.
_THIRD_MOLAR_CLASS_RE = re.compile(r"\b(3rd|third)[\s_-]*molar\b", re.IGNORECASE)

# 5-class M3 detector: 'M3_LL' names the wisdom tooth's quadrant outright, so it
# resolves to an FDI code with no geometry and no positional ranking. UR/UL/LL/LR
# is patient anatomy, matching QUADRANT_* above; every one is position 8.
_M3_CLASS_TO_FDI = {
    "M3_UR": 18,
    "M3_UL": 28,
    "M3_LL": 38,
    "M3_LR": 48,
}


def _class_says_third_molar(class_name: str) -> bool:
    # The 5-class detector's M3_* names assert a wisdom tooth without using the
    # words, so they are checked separately from the '3rd molar' text pattern.
    if str(class_name or "").strip().upper() in _M3_CLASS_TO_FDI:
        return True
    return bool(_THIRD_MOLAR_CLASS_RE.search(class_name or ""))


# Hierarchical class names: 'Q3_tooth_8_impacted' -> quadrant 3, position 8.
# Matched before the bare-FDI pattern below, which would otherwise never fire on
# these names anyway ('3_tooth_8' has no two-digit FDI code in it).
# (?![0-9]) rather than \b after the position digit: the digit is followed by
# '_' in 'Q1_tooth_8_caries', and '8_' is word-char to word-char, so \b never
# matches there. This still refuses a multi-digit run like 'tooth_12'.
_HIER_CLASS_RE = re.compile(r"\bQ([1-4])_tooth_([1-8])(?![0-9])", re.IGNORECASE)


def _extract_fdi_from_class(class_name: str) -> Optional[int]:
    """Pull an FDI code out of 'tooth_38', 'Q3_tooth_8', or 'M3_LL'."""
    if not FDI_FROM_CLASS_NAMES or not class_name:
        return None
    m3 = _M3_CLASS_TO_FDI.get(str(class_name).strip().upper())
    if m3 is not None:
        return m3
    hier = _HIER_CLASS_RE.search(class_name)
    if hier:
        return int(hier.group(1)) * 10 + int(hier.group(2))
    # (?<![0-9])/(?![0-9]) instead of \b: in 'tooth_38' the code is preceded by
    # '_', which is a word character, so \b does not match before the digits.
    match = re.search(r"(?<![0-9])([1-4][1-8])(?![0-9])", class_name)
    if match:
        return int(match.group(1))
    return None


def _disease_from_class(class_name: str) -> Optional[str]:
    """
    Trailing pathology token on a hierarchical class, e.g. 'deep_caries'.

    The DENTEX label set has no healthy class — every annotated tooth carries a
    disease token, so this is the model's finding for that tooth, not a
    severity ranking. Returned for display only; it never sets needs_extraction.
    """
    hier = _HIER_CLASS_RE.search(class_name or "")
    if not hier:
        return None
    tail = class_name[hier.end():].lstrip("_")
    return tail.replace("_", " ") or None


class DentalInference:
    """Wraps a YOLO detection or segmentation model."""

    def __init__(self, model_path: Optional[str] = None, use_gpu: bool = True):
        from ultralytics import YOLO
        import torch

        self.device = "cuda:0" if (use_gpu and torch.cuda.is_available()) else "cpu"
        self.model_path = model_path or DEFAULT_WEIGHTS

        if not os.path.exists(self.model_path):
            raise FileNotFoundError(
                f"Model weights not found at {self.model_path}. "
                "Set SMILEAI_MODEL_PATH or drop weights into dental_ai_app/models/."
            )

        self.model = YOLO(self.model_path)
        self.class_names = self.model.names
        self.task = getattr(self.model, "task", "detect")

    def describe(self) -> dict:
        """Model metadata, surfaced to the UI so the doctor knows what ran."""
        classes = list(self.class_names.values())
        return {
            "path": os.path.basename(self.model_path),
            "device": self.device,
            "task": self.task,
            "num_classes": len(classes),
            "classes": classes,
            # An anatomy-only model cannot assess disease. The UI uses this to
            # suppress any pathology affordance rather than implying a verdict.
            "supports_pathology": self._supports_pathology(),
        }

    def _supports_pathology(self) -> bool:
        keywords = ("caries", "impact", "lesion", "periapical", "disease", "cyst")
        return any(
            any(k in str(name).lower() for k in keywords)
            for name in self.class_names.values()
        )

    def predict(self, image_path: str, conf: float = 0.25, iou: float = 0.45) -> dict:
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Could not decode image: {image_path}")
        height, width = img.shape[:2]

        results = self.model.predict(
            source=img, conf=conf, iou=iou, device=self.device, verbose=False
        )
        result = results[0]

        raw = []
        boxes = getattr(result, "boxes", None)
        if boxes is not None:
            masks = getattr(result, "masks", None)
            for idx, box in enumerate(boxes):
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                class_id = int(box.cls[0])
                class_name = str(self.class_names.get(class_id, class_id))

                polygon = None
                if masks is not None:
                    try:
                        polygon = np.asarray(masks.xy[idx]).tolist()
                    except (IndexError, AttributeError, TypeError):
                        polygon = None

                raw.append({
                    "class_id": class_id,
                    "class_name": class_name,
                    "confidence": float(box.conf[0]),
                    "bbox": [x1, y1, x2, y2],
                    "polygon": polygon,
                })

        detections = self._assign_tooth_numbers(raw, width, height)

        return {
            "width": width,
            "height": height,
            "num_detections": len(detections),
            "detections": detections,
            "model": self.describe(),
        }

    @staticmethod
    def _occlusal_plane(raw: list, height: int) -> float:
        """
        Find the y that separates the upper arch from the lower one.

        The two arches are separated by a band of empty space (the bite line),
        so the split is the *widest vertical gap* between consecutive tooth
        centres — not the median. The median assumes both arches contributed
        equally many detections; when one arch is better detected than the
        other, it lands inside the denser arch and mislabels the teeth around
        it, which then produces impossible results like two FDI 48s.

        Only gaps in the middle of the image are considered, so a single
        outlying detection near the top or bottom cannot become the split.
        """
        centres = sorted(d["_cy"] for d in raw)
        if len(centres) < 4:
            return height / 2.0

        lo, hi = 0.2 * height, 0.8 * height
        best_gap, best_split = 0.0, None
        for a, b in zip(centres, centres[1:]):
            midpoint = (a + b) / 2.0
            if not (lo <= midpoint <= hi):
                continue
            gap = b - a
            if gap > best_gap:
                best_gap, best_split = gap, midpoint

        # A real bite line is a meaningful fraction of image height. If nothing
        # that size exists, the detections are probably one arch only, and any
        # split would be invented — fall back to the image centre.
        if best_split is None or best_gap < 0.04 * height:
            return height / 2.0
        return best_split

    @staticmethod
    def _enforce_one_fdi_number(members: list) -> None:
        """
        A tooth position exists at most once. Keep the most confident claim on
        each FDI number and unnumber the rest.

        The 128-class model predicts position per box independently, so two
        neighbouring boxes can both come back 'Q3_tooth_8'. Their overlap is
        small enough to survive NMS, which is how one arch ends up displaying
        the same tooth number twice. Losers keep their box and are shown as
        unnumbered teeth: something was detected there, only its identity is
        unresolved.
        """
        by_fdi = {}
        for det in members:
            fdi = det.get("fdi_number")
            if not fdi:
                continue
            by_fdi.setdefault(fdi, []).append(det)

        for duplicates in by_fdi.values():
            if len(duplicates) < 2:
                continue
            keep = max(duplicates, key=lambda d: d["confidence"])
            for det in duplicates:
                if det is keep:
                    continue
                det["fdi_number"] = None
                det["universal_number"] = None
                det["fdi_is_estimated"] = False
                det["is_third_molar"] = False

    @staticmethod
    def _enforce_one_third_molar(members: list, midline_x: float) -> None:
        """
        A quadrant has at most one third molar. Keep the best candidate and
        demote the others in place.

        The detector regularly labels two adjacent teeth '3rd_Molar' in one
        quadrant — typically the wisdom tooth plus the 2nd molar beside it.
        These boxes barely overlap, so NMS does not remove them, and without
        this the UI would show two teeth both numbered e.g. 48 and a doctor
        could sign a referral naming the wrong tooth.

        The wisdom tooth is the most distal tooth in the arch, so the candidate
        furthest from the midline wins; confidence breaks ties. Losers keep
        their box and are shown as ordinary teeth, unnumbered — the model saw
        something there, and only its identity is in doubt.
        """
        candidates = [d for d in members if d.get("is_third_molar")]
        if len(candidates) < 2:
            return

        keep = max(candidates, key=lambda d: (abs(d["_cx"] - midline_x), d["confidence"]))
        for det in candidates:
            if det is keep:
                continue
            det["is_third_molar"] = False
            det["fdi_number"] = None
            det["universal_number"] = None
            det["fdi_is_estimated"] = False

    def _assign_tooth_numbers(self, raw: list, width: int, height: int) -> list:
        """
        Assign quadrant + FDI number to each box.

        Geometric approach: split into arches at the occlusal plane, split into
        left and right by the image midline, then rank outward from the midline.
        """
        if not raw:
            return []

        for det in raw:
            x1, y1, x2, y2 = det["bbox"]
            det["_cx"] = (x1 + x2) / 2.0
            det["_cy"] = (y1 + y2) / 2.0

        arch_split = self._occlusal_plane(raw, height)
        midline_x = width / 2.0

        # FDI first digit -> quadrant, for models whose classes name the quadrant.
        digit_to_quadrant = {v: k for k, v in FDI_QUADRANT_DIGIT.items()}

        for det in raw:
            # A class that names the quadrant outranks geometry: it is what the
            # model actually predicted, and geometry mislabels teeth near the
            # midline and on partially-detected arches.
            explicit = _extract_fdi_from_class(det["class_name"])
            if explicit is not None and explicit // 10 in digit_to_quadrant:
                det["quadrant"] = digit_to_quadrant[explicit // 10]
                continue

            is_upper = det["_cy"] < arch_split
            is_patient_right = det["_cx"] < midline_x  # image-left = patient right
            if is_upper:
                det["quadrant"] = QUADRANT_UPPER_RIGHT if is_patient_right else QUADRANT_UPPER_LEFT
            else:
                det["quadrant"] = QUADRANT_LOWER_RIGHT if is_patient_right else QUADRANT_LOWER_LEFT

        # Rank outward from the midline within each quadrant -> FDI second digit.
        for quadrant, digit in FDI_QUADRANT_DIGIT.items():
            members = [d for d in raw if d["quadrant"] == quadrant]
            if not members:
                continue
            # Distance from midline: teeth nearest the midline are #1 (central incisor).
            members.sort(key=lambda d: abs(d["_cx"] - midline_x))

            # Positional ranking is only trustworthy on a fully-detected arch.
            # A partial arch (missing/unlabelled teeth, the common case) shifts
            # every subsequent rank, so the number would be confidently wrong.
            # 8 teeth per quadrant is a complete adult quadrant.
            arch_complete = len(members) == 8

            for rank, det in enumerate(members, start=1):
                # A class that names the tooth is direct evidence; trust it over
                # geometry. Positional rank is only ever a fallback guess.
                explicit = _extract_fdi_from_class(det["class_name"])
                class_says_third_molar = _class_says_third_molar(det["class_name"])

                if explicit is not None:
                    fdi = explicit
                elif class_says_third_molar:
                    # Model asserts a 3rd molar: its FDI is determined by
                    # quadrant alone (x8), no ranking needed.
                    fdi = digit * 10 + 8
                elif arch_complete and rank <= 8:
                    fdi = digit * 10 + rank
                else:
                    # Unknown position — leave unnumbered rather than assert a
                    # number the doctor might act on.
                    fdi = None

                det["fdi_number"] = str(fdi) if fdi else None
                det["universal_number"] = (
                    str(FDI_TO_UNIVERSAL[fdi]) if fdi in FDI_TO_UNIVERSAL else None
                )
                det["fdi_is_estimated"] = fdi is not None and explicit is None
                det["is_third_molar"] = class_says_third_molar or fdi in _THIRD_MOLAR_FDI
                det["disease"] = _disease_from_class(det["class_name"])

            self._enforce_one_fdi_number(members)
            self._enforce_one_third_molar(members, midline_x)

        out = []
        for det in raw:
            out.append({
                "class_id": det["class_id"],
                "class_name": det["class_name"],
                "confidence": det["confidence"],
                "bbox": det["bbox"],
                "polygon": det["polygon"],
                "quadrant": det.get("quadrant"),
                "fdi_number": det.get("fdi_number"),
                "universal_number": det.get("universal_number"),
                # True when the number came from geometry rather than the model,
                # so the UI can show it as provisional.
                "fdi_is_estimated": det.get("fdi_is_estimated", False),
                "is_third_molar": det.get("is_third_molar", False),
                # Pathology token from a hierarchical class name. Display only.
                "disease": det.get("disease"),
                # Never model-derived. See module docstring.
                "impaction_type": None,
                "needs_extraction": False,
            })

        # Stable, clinically readable order: upper arch first, then left to right.
        out.sort(key=lambda d: (
            0 if (d["quadrant"] or "").startswith("Upper") else 1,
            d["bbox"][0],
        ))
        return out


_engine: Optional[DentalInference] = None
_seg_engine: Optional[DentalInference] = None
_hier_engine: Optional[DentalInference] = None
_m3_engine: Optional[DentalInference] = None


def _use_gpu() -> bool:
    return os.environ.get("SMILEAI_USE_GPU", "1") != "0"


def get_engine() -> DentalInference:
    """
    Detection engine: the tooth/3rd-molar detector behind the Detection tab.

    Lazily constructed so the weights load once per process.
    """
    global _engine
    if _engine is None:
        _engine = DentalInference(
            model_path=os.environ.get("SMILEAI_MODEL_PATH"),
            use_gpu=_use_gpu(),
        )
    return _engine


def get_seg_engine() -> Optional[DentalInference]:
    """
    Segmentation engine: the 12-class pathology model behind the Segmentation
    tab. Returns None when its weights are absent — segmentation is additive, so
    a missing seg model must degrade to detection-only rather than fail the case.
    """
    global _seg_engine
    if _seg_engine is None:
        path = os.environ.get("SMILEAI_SEG_MODEL_PATH", DEFAULT_SEG_WEIGHTS)
        if not os.path.exists(path):
            return None
        _seg_engine = DentalInference(model_path=path, use_gpu=_use_gpu())
    return _seg_engine


def get_hier_engine() -> Optional[DentalInference]:
    """
    Hierarchical engine: the 128-class full-dentition model behind the Dentition
    tab. Returns None when its weights are absent, for the same reason as the
    seg engine — an extra tab must never be able to fail a case.
    """
    global _hier_engine
    if _hier_engine is None:
        path = os.environ.get("SMILEAI_HIER_MODEL_PATH", DEFAULT_HIER_WEIGHTS)
        if not os.path.exists(path):
            return None
        _hier_engine = DentalInference(model_path=path, use_gpu=_use_gpu())
    return _hier_engine


def get_m3_engine() -> Optional[DentalInference]:
    """
    M3 engine: the 5-class retrained detector behind the Wisdom (M3) tab.

    Returns None when its weights are absent, like the seg and hier engines —
    this tab is a comparison surface against the Detection tab, so it must never
    be able to fail a case.
    """
    global _m3_engine
    if _m3_engine is None:
        path = os.environ.get("SMILEAI_M3_MODEL_PATH", DEFAULT_M3_WEIGHTS)
        if not os.path.exists(path):
            return None
        _m3_engine = DentalInference(model_path=path, use_gpu=_use_gpu())
    return _m3_engine


# Seg classes that describe a condition OF a tooth. Only these are attached to a
# tooth box. 'Mandibular Canal' and 'maxillary sinus' are landmarks that legally
# overlap many teeth, and 'Missing teeth' marks a gap where no tooth was
# detected, so none of them say anything about the tooth they overlap.
_TOOTH_LEVEL_SEG_CLASSES = {
    "caries",
    "crown",
    "filling",
    "implant",
    "periapical lesion",
    "retained root",
    "root canal treatment",
    "root piece",
    "impacted tooth",
}

# A finding must cover this much of its own area inside the tooth box to be
# attributed to it. Containment, not IoU: a caries lesion is far smaller than the
# tooth, so IoU stays low even at full containment and would reject every match.
_FUSION_CONTAINMENT = 0.5


def _containment(inner: list, outer: list) -> float:
    """Fraction of `inner`'s box area that lies inside `outer`."""
    ix1 = max(inner[0], outer[0])
    iy1 = max(inner[1], outer[1])
    ix2 = min(inner[2], outer[2])
    iy2 = min(inner[3], outer[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    intersection = (ix2 - ix1) * (iy2 - iy1)
    inner_area = (inner[2] - inner[0]) * (inner[3] - inner[1])
    if inner_area <= 0:
        return 0.0
    return intersection / inner_area


def _attach_findings_to_teeth(tooth_dets: list, seg_dets: list) -> None:
    """
    Attach overlapping pathology findings to each tooth box, in place.

    This is a spatial JOIN, not a second inference pass: both models still run
    independently on the full image, and this correlates their outputs
    afterwards. It exists because the seg model has no concept of tooth identity
    (a caries mask is just a blob) while the detector has no concept of disease.
    Joined, the Detection tab can say "tooth 38, with caries" instead of making
    the doctor eyeball two tabs and match them up by position.

    Deliberately display-only. Overlap is correlation, not diagnosis: a lesion
    inside a tooth's box is not proof it belongs to that tooth, so this never
    sets needs_extraction or impaction_type. Those stay the doctor's call, per
    the module docstring.
    """
    if not tooth_dets or not seg_dets:
        return

    candidates = [
        d for d in seg_dets
        if str(d.get("class_name", "")).strip().lower() in _TOOTH_LEVEL_SEG_CLASSES
    ]

    for tooth in tooth_dets:
        findings = []
        for finding in candidates:
            share = _containment(finding["bbox"], tooth["bbox"])
            if share >= _FUSION_CONTAINMENT:
                findings.append({
                    "class_name": finding["class_name"],
                    "confidence": finding["confidence"],
                    "containment": round(share, 3),
                })
        # Strongest evidence first, so a truncated UI list drops the weakest.
        findings.sort(key=lambda f: f["confidence"], reverse=True)
        tooth["findings"] = findings


def predict_all(image_path: str, conf: float = 0.25, iou: float = 0.45) -> dict:
    """
    Run every installed model over one radiograph and return a single list.

    Each detection carries a "source" of 'detect', 'segment', 'hier' or 'm3' so
    each tab shows its own model's output without any of them polluting another.

    Only the detector is required. The seg, hier and m3 models are best-effort:
    if one is missing or fails, the case still completes rather than erroring
    out, minus that tab.

    After all passes, seg findings are spatially joined onto tooth boxes so the
    Detection tab can name a tooth's pathology. That join is display-only and
    never sets needs_extraction.
    """
    result = get_engine().predict(image_path, conf=conf, iou=iou)
    for det in result["detections"]:
        det["source"] = "detect"

    seg_model = None
    seg = get_seg_engine()
    if seg is not None:
        try:
            seg_result = seg.predict(image_path, conf=conf, iou=iou)
            seg_model = seg_result["model"]
            for det in seg_result["detections"]:
                det["source"] = "segment"
                # Pathology classes carry no tooth identity. Numbering them by
                # position would attach an FDI code to a caries blob, so the
                # geometric guess is dropped rather than shown to a doctor.
                det["fdi_number"] = None
                det["universal_number"] = None
                det["fdi_is_estimated"] = False
                det["is_third_molar"] = False
                result["detections"].append(det)
        except Exception as exc:
            print(f"[inference] segmentation pass failed, continuing detect-only: {exc}")

    # Third pass: full-dentition model. Its classes name quadrant and position,
    # so it numbers teeth without the geometric ranking the detector needs, and
    # it can call a first molar a first molar instead of a wisdom tooth.
    hier_model = None
    hier = get_hier_engine()
    if hier is not None:
        try:
            hier_result = hier.predict(image_path, conf=conf, iou=iou)
            hier_model = hier_result["model"]
            for det in hier_result["detections"]:
                det["source"] = "hier"
                result["detections"].append(det)
        except Exception as exc:
            print(f"[inference] hierarchical pass failed, continuing without it: {exc}")

    # Fourth pass: the 5-class retrained detector. Same question as the first
    # pass, but its classes name which wisdom tooth, so the geometric fallback
    # never fires. Kept as its own source so the two can be compared in the UI.
    m3_model = None
    m3 = get_m3_engine()
    if m3 is not None:
        try:
            m3_result = m3.predict(image_path, conf=conf, iou=iou)
            m3_model = m3_result["model"]
            for det in m3_result["detections"]:
                det["source"] = "m3"
                result["detections"].append(det)
        except Exception as exc:
            print(f"[inference] m3 pass failed, continuing without it: {exc}")

    # Join pathology onto teeth once every model has run. Display-only: see
    # _attach_findings_to_teeth. Applied to the detector and M3 rows (both are
    # teeth) but not to hier rows, whose classes already carry their own disease
    # token from the model itself.
    seg_rows = [d for d in result["detections"] if d.get("source") == "segment"]
    for src in ("detect", "m3"):
        _attach_findings_to_teeth(
            [d for d in result["detections"] if d.get("source") == src], seg_rows
        )

    result["num_detections"] = len(result["detections"])
    result["seg_model"] = seg_model
    result["hier_model"] = hier_model
    result["m3_model"] = m3_model
    return result
