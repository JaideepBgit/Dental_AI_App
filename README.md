# SmileAI Dental Review Portal

Doctor-facing portal for reviewing panoramic radiographs, marking teeth for
extraction, dictating a prescription note, and producing a signed referral PDF.

Implements the workflow requested by the client: the RPA drops X-rays for
appointments ~3 days out into a shared folder, the portal presents them one at a
time with the third molars marked, and the dentist dictates and signs off.

## What the AI does — and does not — do

The model **detects teeth and assigns tooth numbers**. That is all.

Extraction decisions and impaction assessments are made by the **dentist**, in
the UI. Nothing in this app infers pathology from detection confidence, and no
finding is ever synthesised when the model returns nothing. If the loaded model
has no pathology classes, the header shows *"Detection only"* and the referral
PDF states in writing that all clinical findings came from the attending
dentist.

Tooth numbers derived from position rather than from an explicit model class are
flagged `est.` in the UI, because positional numbering is only reliable on a
fully-detected arch. Teeth whose position cannot be determined are left
unnumbered rather than given a guessed number.

## Setup

```bash
pip install -r requirements.txt          # from this directory
cd frontend && npm install && cd ..
python seed_users.py --demo              # once: creates admin/admin, doctor/doctor
```

`seed_users.py` builds the schema and the first logins. The app has
authentication, so without this step there is no way to log in. It is idempotent
— re-running skips existing users and never overwrites a password unless you
pass `--reset`.

Place YOLO weights at `models/best_dental_model.pt`, or point
`SMILEAI_MODEL_PATH` at them.

Local voice transcription needs `openai-whisper` **and `ffmpeg` on PATH**. Without
it the API still starts and the browser falls back to the Web Speech API — which
sends audio to the browser vendor's cloud, so install Whisper for patient data.

## Running

```bash
python main.py                  # API on :8000
cd frontend && npm run dev      # UI on :5173
python watcher.py               # optional: watch the RPA inbox folder
python watcher.py --scan-once   # process what's already in the inbox, then exit
```

## Database migrations

Schema is managed by **Alembic** (`alembic/versions/`). `init_db()` runs
`alembic upgrade head` on every backend start, so a normal deploy needs no
manual step — restarting the app applies pending migrations.

An existing database created before Alembic was introduced is detected and
stamped at the baseline revision automatically, then only newer revisions run.
Nothing is rebuilt and no data is touched.

```bash
alembic current                 # revision this database is at
alembic history --verbose       # all revisions
alembic upgrade head            # apply pending (also done at startup)
alembic downgrade -1            # step back one
alembic check                   # models vs database: any undeclared drift?
alembic upgrade head --sql      # print SQL instead of running it (RDS review)
```

After changing a model in `db.py`:

```bash
alembic revision --autogenerate -m "what changed"
```

**Always read the generated file before committing.** Autogenerate does not
detect renames — it emits a drop plus an add, which loses data. It also cannot
see `CHECK` constraints or server defaults reliably. Migrations run against
SQLite use batch mode (copy-and-swap), since SQLite cannot `ALTER` a column in
place.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SMILEAI_MODEL_PATH` | `models/best_dental_model.pt` | YOLO weights |
| `SMILEAI_USE_GPU` | `1` | set `0` to force CPU |
| `SMILEAI_INBOX` | `./inbox` | folder the RPA writes into |
| `SMILEAI_ARCHIVE` | `./inbox_archive` | where ingested files are moved |
| `SMILEAI_WHISPER_MODEL` | `base` | Whisper size (`tiny`…`large`) |
| `VITE_API_URL` | `http://localhost:8000` | API base URL for the frontend |
| `DATABASE_URL` | local `smileai.db` | SQLite locally; RDS Postgres in AWS |
| `SESSION_SECRET_KEY` | random per start | **set in production** — signs session cookies |
| `COOKIE_SECURE` | `0` | set `1` when served over HTTPS |

## Inbox filename conventions

The watcher reads patient metadata from the filename:

```
MRN-10023_jane doe_2026-08-06.jpg     -> MRN, name, appointment date
MRN-10023_jane doe.jpg                -> MRN and name
jane doe.jpg                          -> name only; MRN auto-derived
```

Files are copied into `xray_store/` and the original is moved to the archive, so
the portal keeps working after the archive is rotated.

## Layout

| File | Role |
|---|---|
| `main.py` | FastAPI app: queue, case, upload, transcribe, approve |
| `db.py` | SQLAlchemy schema (patients, xrays, detections, referrals) |
| `alembic/` | Migration scripts; `init_db()` applies them at startup |
| `auth.py` | Password hashing, signed session cookies, role guards |
| `seed_users.py` | One-time bootstrap: locations, admin, orthodontists |
| `inference.py` | YOLO wrapper + FDI/Universal tooth numbering |
| `annotator.py` | Burns arrows and tooth labels onto the radiograph |
| `referral.py` | Referral/prescription PDF with embedded e-signature |
| `watcher.py` | Ingests X-rays from the RPA folder |

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | model + Whisper status |
| GET | `/api/queue` | review queue, soonest appointment first |
| GET | `/api/xray/{id}` | one case with detections |
| GET | `/api/xray/{id}/image` | radiograph bytes |
| POST | `/api/upload` | manual upload |
| POST | `/api/transcribe` | audio → text (local Whisper) |
| POST | `/api/approve` | sign off, write referral PDF |
| GET | `/api/referral/{id}` | download the referral PDF |

## Known limitations

- **`db.py` and `referral.py` are deliberate copies** of the root
  `database.py` / `referral_generator.py` so this folder deploys standalone.
  They will drift; change both or consolidate later.
- Re-approving a case writes a **new** referral PDF and leaves the old file on
  disk. Prior slips are retained by design (audit trail), but nothing prunes
  them.
- Sessions are signed cookies. Set `SESSION_SECRET_KEY` in any real deployment —
  without it a random key is generated at import, so sessions do not survive a
  restart and do not work across multiple workers.
- `seed_users.py --demo` creates **demo credentials** (`admin`/`admin`). Change
  them before this touches real patient data.
- SQLite suits the stated load (2–4 doctors, ~150 images/day). Concurrent
  writes from several watcher processes are not supported.
