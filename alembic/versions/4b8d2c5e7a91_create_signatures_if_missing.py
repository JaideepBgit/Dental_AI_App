"""create the signatures table if a legacy database never had it

Reusable e-signatures arrived after some databases were already deployed. Those
databases get stamped at the baseline, which SKIPS the baseline's CREATE TABLE
statements -- so a table they never had would never be created by any revision.

db.py's _stamp_legacy_database() fills that gap with create_all() at stamp time,
but only for a database being adopted for the FIRST time. Production had already
been stamped by an earlier deploy attempt, so that path was skipped on the next
boot and `signatures` stayed missing while the app reported healthy. Every
signature endpoint would then fail at runtime rather than at startup.

Creating it here makes the repair part of the migration chain, so it applies
regardless of how or when a database was adopted.

Revision ID: 4b8d2c5e7a91
Revises: 3c7e1a2b9f04
"""

from alembic import context, op
import sqlalchemy as sa

revision = "4b8d2c5e7a91"
down_revision = "3c7e1a2b9f04"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    if context.is_offline_mode():
        # Nothing to inspect when rendering SQL; emit the CREATE so a reviewer
        # sees it. Postgres would reject a duplicate, which is why the online
        # path guards instead of relying on this.
        return False
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade():
    if _has_table("signatures"):
        return

    op.create_table(
        "signatures",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=60), nullable=False),
        sa.Column("file_path", sa.String(length=500), nullable=False),
        sa.Column("source", sa.String(length=10), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_signatures_id", "signatures", ["id"], unique=False)
    op.create_index("ix_signatures_user_id", "signatures", ["user_id"],
                    unique=False)


def downgrade():
    # Dropping this would destroy clinicians' saved signatures. The table is
    # additive and harmless to leave in place, so downgrade is deliberately a
    # no-op rather than a data-losing DROP.
    pass
