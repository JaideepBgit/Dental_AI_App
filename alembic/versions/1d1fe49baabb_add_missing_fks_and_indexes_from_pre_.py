"""add missing FKs and indexes from pre-alembic ALTER TABLE path

The old _add_missing_columns() helper in db.py could only issue
ALTER TABLE ADD COLUMN, so columns introduced after a database was first created
arrived without their foreign keys or indexes. The models always declared them;
only the live schema was missing them. This migration closes that gap.

Affected: referral_slips.prescription_id and the three xrays ownership/lock
columns (assigned_to_id, assigned_by_id, claimed_by_id). The two indexes matter
for the queue, which filters on assignment and claim state on every poll.

Databases created fresh from the baseline already have all of this, so each
operation is guarded and the migration is a no-op there.

Revision ID: 1d1fe49baabb
Revises: 2a9de32687b8
Create Date: 2026-08-09 17:07:47.514572

"""
from typing import Sequence, Union

from alembic import context, op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1d1fe49baabb'
down_revision: Union[str, Sequence[str], None] = '2a9de32687b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Named explicitly rather than left to autogenerate's None. Postgres rejects an
# unnamed ADD CONSTRAINT, and an unnamed drop_constraint cannot be resolved on
# downgrade -- both only appear to work because SQLite batch mode rebuilds the
# whole table and never needs the name.
FK_REFERRAL_PRESCRIPTION = "fk_referral_slips_prescription_id_prescriptions"
FK_XRAY_ASSIGNED_TO = "fk_xrays_assigned_to_id_users"
FK_XRAY_ASSIGNED_BY = "fk_xrays_assigned_by_id_users"
FK_XRAY_CLAIMED_BY = "fk_xrays_claimed_by_id_users"

IX_XRAY_ASSIGNED_TO = "ix_xrays_assigned_to_id"
IX_XRAY_CLAIMED_BY = "ix_xrays_claimed_by_id"


def _existing_indexes(table: str) -> set:
    if context.is_offline_mode():
        # No database to inspect when emitting SQL; assume nothing exists so
        # every statement is rendered for the reviewer.
        return set()
    inspector = sa.inspect(op.get_bind())
    return {ix["name"] for ix in inspector.get_indexes(table)}


def _existing_fks(table: str) -> set:
    if context.is_offline_mode():
        return set()
    inspector = sa.inspect(op.get_bind())
    return {fk["name"] for fk in inspector.get_foreign_keys(table)}


def _existing_columns(table: str) -> set:
    if context.is_offline_mode():
        return set()
    inspector = sa.inspect(op.get_bind())
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    """Add the constraints and indexes the ALTER TABLE path could not create."""
    # op.get_bind() returns a MockConnection under `alembic upgrade --sql`, so
    # read the dialect from the migration context, which works in both modes.
    is_sqlite = context.get_context().dialect.name == "sqlite"
    timestamp_type = sa.DateTime()

    # How far the legacy ALTER TABLE path actually got varies by deployment: it
    # only ever added a column when that version of db.py knew about it. The
    # production database was last touched before the review lock existed, so it
    # has assigned_* but not claimed_*, while a developer's database has both.
    # Add whatever is absent before indexing it -- an index on a missing column
    # is what took the app down on the first deploy of this revision.
    xray_columns = _existing_columns("xrays")
    for column, coltype in (("assigned_to_id", sa.Integer()),
                            ("assigned_at", timestamp_type),
                            ("assigned_by_id", sa.Integer()),
                            ("claimed_by_id", sa.Integer()),
                            ("claimed_at", timestamp_type)):
        if column not in xray_columns:
            op.add_column("xrays", sa.Column(column, coltype, nullable=True))

    if "prescription_id" not in _existing_columns("referral_slips"):
        op.add_column("referral_slips",
                      sa.Column("prescription_id", sa.Integer(), nullable=True))

    xray_indexes = _existing_indexes("xrays")

    # SQLite can add an index in place; only the foreign keys need a table
    # rebuild. Creating the indexes outside the batch block keeps the rebuild
    # as small as possible.
    if IX_XRAY_ASSIGNED_TO not in xray_indexes:
        op.create_index(IX_XRAY_ASSIGNED_TO, "xrays", ["assigned_to_id"],
                        unique=False)
    if IX_XRAY_CLAIMED_BY not in xray_indexes:
        op.create_index(IX_XRAY_CLAIMED_BY, "xrays", ["claimed_by_id"],
                        unique=False)

    # SQLite never reports names for the foreign keys the legacy path created,
    # so the guard below cannot distinguish "already present" from "absent" the
    # way it can on Postgres. A batch rebuild reconciles the table against the
    # model either way, which is idempotent in practice.
    referral_fks = _existing_fks("referral_slips")
    if is_sqlite or FK_REFERRAL_PRESCRIPTION not in referral_fks:
        with op.batch_alter_table("referral_slips", schema=None) as batch_op:
            batch_op.create_foreign_key(
                FK_REFERRAL_PRESCRIPTION, "prescriptions",
                ["prescription_id"], ["id"])

    xray_fks = _existing_fks("xrays")
    missing = {FK_XRAY_ASSIGNED_TO, FK_XRAY_ASSIGNED_BY,
               FK_XRAY_CLAIMED_BY} - xray_fks
    if is_sqlite or missing:
        with op.batch_alter_table("xrays", schema=None) as batch_op:
            if is_sqlite or FK_XRAY_ASSIGNED_TO in missing:
                batch_op.create_foreign_key(
                    FK_XRAY_ASSIGNED_TO, "users", ["assigned_to_id"], ["id"])
            if is_sqlite or FK_XRAY_ASSIGNED_BY in missing:
                batch_op.create_foreign_key(
                    FK_XRAY_ASSIGNED_BY, "users", ["assigned_by_id"], ["id"])
            if is_sqlite or FK_XRAY_CLAIMED_BY in missing:
                batch_op.create_foreign_key(
                    FK_XRAY_CLAIMED_BY, "users", ["claimed_by_id"], ["id"])


def downgrade() -> None:
    """Drop them again, returning to the pre-Alembic shape."""
    with op.batch_alter_table("xrays", schema=None) as batch_op:
        batch_op.drop_constraint(FK_XRAY_CLAIMED_BY, type_="foreignkey")
        batch_op.drop_constraint(FK_XRAY_ASSIGNED_BY, type_="foreignkey")
        batch_op.drop_constraint(FK_XRAY_ASSIGNED_TO, type_="foreignkey")

    with op.batch_alter_table("referral_slips", schema=None) as batch_op:
        batch_op.drop_constraint(FK_REFERRAL_PRESCRIPTION, type_="foreignkey")

    op.drop_index(IX_XRAY_CLAIMED_BY, table_name="xrays")
    op.drop_index(IX_XRAY_ASSIGNED_TO, table_name="xrays")
