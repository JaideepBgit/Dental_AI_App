"""
Tests for the M3 class mapping and the seg->tooth spatial join.

Both are pure functions over plain dicts, so they are tested directly without
loading any model weights.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from inference import (  # noqa: E402
    _attach_findings_to_teeth,
    _class_says_third_molar,
    _containment,
    _extract_fdi_from_class,
)


def tooth(bbox, class_name="Tooth"):
    return {"class_name": class_name, "bbox": bbox, "confidence": 0.9}


def finding(bbox, class_name, confidence=0.8):
    return {"class_name": class_name, "bbox": bbox, "confidence": confidence}


class TestM3ClassMapping:
    """The 5-class detector names the wisdom tooth; no geometry should be used."""

    def test_each_m3_class_maps_to_its_fdi_code(self):
        assert _extract_fdi_from_class("M3_UR") == 18
        assert _extract_fdi_from_class("M3_UL") == 28
        assert _extract_fdi_from_class("M3_LL") == 38
        assert _extract_fdi_from_class("M3_LR") == 48

    def test_m3_classes_register_as_third_molars(self):
        # The '3rd molar' text regex cannot match these names, so they are
        # recognised via the class map instead.
        for name in ("M3_UR", "M3_UL", "M3_LL", "M3_LR"):
            assert _class_says_third_molar(name) is True

    def test_plain_tooth_class_is_not_a_third_molar(self):
        assert _class_says_third_molar("Tooth") is False
        assert _extract_fdi_from_class("Tooth") is None

    def test_hierarchical_classes_still_resolve(self):
        # Adding the M3 branch must not shadow the existing 128-class parsing.
        assert _extract_fdi_from_class("Q3_tooth_8_impacted") == 38
        assert _extract_fdi_from_class("Q1_tooth_1_caries") == 11


class TestContainment:
    def test_fully_contained_finding_scores_one(self):
        assert _containment([10, 10, 20, 20], [0, 0, 100, 100]) == 1.0

    def test_disjoint_boxes_score_zero(self):
        assert _containment([0, 0, 10, 10], [50, 50, 60, 60]) == 0.0

    def test_half_overlap_scores_half(self):
        # Finding spans x 0..10; tooth starts at x=5 -> half the area inside.
        assert _containment([0, 0, 10, 10], [5, 0, 100, 10]) == 0.5

    def test_zero_area_finding_does_not_divide_by_zero(self):
        assert _containment([5, 5, 5, 5], [0, 0, 10, 10]) == 0.0


class TestAttachFindings:
    def test_contained_finding_is_attached_to_the_tooth(self):
        teeth = [tooth([0, 0, 100, 100])]
        segs = [finding([40, 40, 60, 60], "Caries")]

        _attach_findings_to_teeth(teeth, segs)

        assert [f["class_name"] for f in teeth[0]["findings"]] == ["Caries"]
        assert teeth[0]["findings"][0]["containment"] == 1.0

    def test_finding_outside_the_tooth_is_not_attached(self):
        teeth = [tooth([0, 0, 100, 100])]
        segs = [finding([500, 500, 520, 520], "Caries")]

        _attach_findings_to_teeth(teeth, segs)

        assert teeth[0]["findings"] == []

    def test_barely_overlapping_finding_is_rejected(self):
        # 20% of the finding lies inside the tooth: below the 0.5 threshold, so
        # a lesion on the neighbouring tooth is not blamed on this one.
        teeth = [tooth([0, 0, 100, 100])]
        segs = [finding([90, 0, 140, 100], "Caries")]

        _attach_findings_to_teeth(teeth, segs)

        assert teeth[0]["findings"] == []

    def test_landmark_classes_are_never_attached(self):
        # The mandibular canal legitimately runs under many teeth; attaching it
        # would tag half the arch with a finding that says nothing about them.
        teeth = [tooth([0, 0, 100, 100])]
        segs = [
            finding([10, 10, 90, 90], "Mandibular Canal"),
            finding([10, 10, 90, 90], "maxillary sinus"),
            finding([10, 10, 90, 90], "Missing teeth"),
        ]

        _attach_findings_to_teeth(teeth, segs)

        # The seg model DID run and produced rows, so the tooth is marked as
        # checked-with-nothing-found rather than left unset.
        assert teeth[0]["findings"] == []

    def test_findings_are_ordered_by_confidence(self):
        teeth = [tooth([0, 0, 100, 100])]
        segs = [
            finding([40, 40, 60, 60], "Filling", confidence=0.4),
            finding([40, 40, 60, 60], "Caries", confidence=0.95),
        ]

        _attach_findings_to_teeth(teeth, segs)

        assert [f["class_name"] for f in teeth[0]["findings"]] == ["Caries", "Filling"]

    def test_one_finding_can_attach_to_two_overlapping_teeth(self):
        # Interproximal caries genuinely sits between two teeth. Reporting it on
        # both is correct; the doctor decides which one it belongs to.
        teeth = [tooth([0, 0, 100, 100]), tooth([50, 0, 150, 100])]
        segs = [finding([60, 40, 80, 60], "Caries")]

        _attach_findings_to_teeth(teeth, segs)

        assert len(teeth[0]["findings"]) == 1
        assert len(teeth[1]["findings"]) == 1

    def test_join_never_sets_extraction_or_impaction(self):
        # The core safety property: pathology is display-only.
        teeth = [tooth([0, 0, 100, 100])]
        teeth[0]["needs_extraction"] = False
        teeth[0]["impaction_type"] = None
        segs = [finding([40, 40, 60, 60], "Caries", confidence=0.99)]

        _attach_findings_to_teeth(teeth, segs)

        assert teeth[0]["needs_extraction"] is False
        assert teeth[0]["impaction_type"] is None

    def test_empty_inputs_are_safe(self):
        teeth = [tooth([0, 0, 100, 100])]

        _attach_findings_to_teeth(teeth, [])
        _attach_findings_to_teeth([], [finding([0, 0, 10, 10], "Caries")])

        # No seg rows at all means the key is never added, rather than being set
        # to an empty list that would read as "checked, found nothing".
        assert "findings" not in teeth[0]
