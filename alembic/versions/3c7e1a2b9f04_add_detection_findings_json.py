"""add detections.findings_json

Stores the seg-model findings that spatially overlap a tooth's box, joined at
inference time so the Detection tab can name a tooth's pathology instead of
making the doctor cross-reference the Segmentation tab by eye.

Nullable with no backfill: cases analysed before this column existed keep NULL,
which the API serialises as an empty list. Re-upload to populate them.

Revision ID: 3c7e1a2b9f04
Revises: 1d1fe49baabb
"""

from alembic import context, op
import sqlalchemy as sa

revision = "3c7e1a2b9f04"
down_revision = "1d1fe49baabb"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    if context.is_offline_mode():
        # `alembic upgrade --sql` has no database to inspect -- op.get_bind()
        # returns a MockConnection. Report the column as absent so the statement
        # is rendered for whoever is reviewing the SQL.
        return False
    inspector = sa.inspect(op.get_bind())
    return column in {c["name"] for c in inspector.get_columns(table)}


def upgrade():
    # Guarded like revision 1d1fe49baabb: a pre-Alembic database built by the old
    # create_all() path already carries every column in db.py, so an unguarded
    # ADD COLUMN fails with "duplicate column name" when migrations are replayed
    # over it.
    if not _has_column("detections", "findings_json"):
        op.add_column("detections", sa.Column("findings_json", sa.Text(), nullable=True))


def downgrade():
    # Offline mode cannot inspect, and _has_column() reports False there -- which
    # would silently emit nothing. The column always exists at this revision, so
    # render the drop unconditionally when generating SQL.
    if context.is_offline_mode() or _has_column("detections", "findings_json"):
        op.drop_column("detections", "findings_json")
