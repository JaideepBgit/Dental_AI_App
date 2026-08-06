"""
watcher.py - Ingests X-rays that the client's RPA bot drops into a shared folder.

The RPA downloads panoramics ~3 days ahead of the appointment. This picks them
up, runs detection once, and parks the result in the review queue so the portal
loads instantly instead of running inference while a doctor waits.

Filename conventions understood (first match wins):
    <mrn>_<patient name>_<YYYY-MM-DD>.jpg
    <mrn>_<patient name>.jpg
    <patient name>.jpg              -> MRN derived from the filename

Usage:
    python watcher.py --scan-once     process what's already there and exit
    python watcher.py                 stay resident and watch for new files
"""

import argparse
import json
import os
import re
import shutil
import time
from datetime import datetime

from db import (
    SessionLocal, init_db, Patient, XRay, Detection,
    STATUS_PROCESSED, STATUS_ERROR,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INBOX_DIR = os.environ.get("SMILEAI_INBOX", os.path.join(BASE_DIR, "inbox"))
ARCHIVE_DIR = os.environ.get("SMILEAI_ARCHIVE", os.path.join(BASE_DIR, "inbox_archive"))

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def parse_filename(filename: str) -> dict:
    """Best-effort patient metadata from the RPA's filename."""
    stem = os.path.splitext(os.path.basename(filename))[0]

    appointment_date = None
    date_match = _DATE_RE.search(stem)
    if date_match:
        appointment_date = date_match.group(1)
        stem = stem.replace(date_match.group(1), "").strip(" _-")

    parts = [p for p in stem.split("_") if p]
    if len(parts) >= 2:
        mrn, name = parts[0], " ".join(parts[1:])
    elif parts:
        # No MRN in the name; synthesise a stable one so re-ingesting the same
        # patient doesn't create duplicate records.
        name = parts[0]
        mrn = f"AUTO-{re.sub(r'[^A-Za-z0-9]', '', parts[0]).upper()[:16] or 'UNKNOWN'}"
    else:
        name, mrn = "Unknown Patient", "AUTO-UNKNOWN"

    return {
        "mrn": mrn,
        "patient_name": name.replace("-", " ").title(),
        "appointment_date": appointment_date,
    }


def ingest_file(file_path: str, move_to_archive: bool = True) -> dict:
    """Run detection on one file and record it as PROCESSED (or ERROR)."""
    from inference import predict_all

    meta = parse_filename(file_path)
    db = SessionLocal()
    try:
        patient = db.query(Patient).filter(Patient.mrn == meta["mrn"]).first()
        if not patient:
            patient = Patient(mrn=meta["mrn"], name=meta["patient_name"])
            db.add(patient)
            db.flush()

        # Where the image lives for the app's lifetime. Copy out of the inbox so
        # the portal keeps working after the archive is rotated.
        store_dir = os.path.join(BASE_DIR, "xray_store")
        os.makedirs(store_dir, exist_ok=True)
        stored_path = os.path.join(store_dir, os.path.basename(file_path))
        if os.path.abspath(stored_path) != os.path.abspath(file_path):
            shutil.copy2(file_path, stored_path)

        xray = XRay(
            patient_id=patient.id,
            original_filename=os.path.basename(file_path),
            file_path=stored_path,
            appointment_date=meta["appointment_date"],
        )
        db.add(xray)
        db.flush()

        try:
            result = predict_all(stored_path)
            xray.image_width = result["width"]
            xray.image_height = result["height"]
            for det in result["detections"]:
                db.add(Detection(
                    xray_id=xray.id,
                    class_name=det["class_name"],
                    source=det.get("source", "detect"),
                    fdi_number=det.get("fdi_number"),
                    universal_number=det.get("universal_number"),
                    quadrant=det.get("quadrant"),
                    bbox_json=json.dumps(det["bbox"]),
                    polygon_json=json.dumps(det["polygon"]) if det.get("polygon") else None,
                    confidence=det["confidence"],
                    # impaction/extraction intentionally left unset — the doctor decides.
                ))
            xray.status = STATUS_PROCESSED
            xray.processed_at = datetime.now()
            outcome = {"xray_id": xray.id, "detections": result["num_detections"]}
        except Exception as exc:  # inference failed; keep the row for triage
            xray.status = STATUS_ERROR
            xray.error_message = str(exc)
            outcome = {"xray_id": xray.id, "error": str(exc)}

        db.commit()

        if move_to_archive:
            os.makedirs(ARCHIVE_DIR, exist_ok=True)
            try:
                shutil.move(file_path, os.path.join(ARCHIVE_DIR, os.path.basename(file_path)))
            except (OSError, shutil.Error) as exc:
                print(f"[watcher] could not archive {file_path}: {exc}")

        return outcome
    finally:
        db.close()


def _is_stable(path: str, checks: int = 3, delay: float = 0.4) -> bool:
    """Wait for the RPA to finish writing before reading the file."""
    last = -1
    for _ in range(checks):
        try:
            size = os.path.getsize(path)
        except OSError:
            return False
        if size == last and size > 0:
            return True
        last = size
        time.sleep(delay)
    return last > 0


def scan_once() -> list:
    os.makedirs(INBOX_DIR, exist_ok=True)
    results = []
    for name in sorted(os.listdir(INBOX_DIR)):
        path = os.path.join(INBOX_DIR, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
            continue
        if not _is_stable(path):
            print(f"[watcher] skipping {name}: still being written")
            continue
        print(f"[watcher] ingesting {name}")
        results.append(ingest_file(path))
    return results


def watch():
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    os.makedirs(INBOX_DIR, exist_ok=True)

    class Handler(FileSystemEventHandler):
        def _handle(self, path):
            if os.path.splitext(path)[1].lower() not in IMAGE_EXTS:
                return
            if not _is_stable(path):
                return
            print(f"[watcher] ingesting {os.path.basename(path)}")
            try:
                print(f"[watcher] -> {ingest_file(path)}")
            except Exception as exc:
                print(f"[watcher] failed on {path}: {exc}")

        def on_created(self, event):
            if not event.is_directory:
                self._handle(event.src_path)

        def on_moved(self, event):
            if not event.is_directory:
                self._handle(event.dest_path)

    observer = Observer()
    observer.schedule(Handler(), INBOX_DIR, recursive=False)
    observer.start()
    print(f"[watcher] watching {INBOX_DIR} (Ctrl+C to stop)")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SmileAI RPA folder watcher")
    parser.add_argument("--scan-once", action="store_true",
                        help="process existing files then exit")
    args = parser.parse_args()

    init_db()
    if args.scan_once:
        print(f"[watcher] scanned: {scan_once()}")
    else:
        scan_once()
        watch()
