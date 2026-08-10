"""
Alembic environment for the SmileAI portal.

The database URL is taken from db.py rather than alembic.ini, so migrations
always target whatever the app itself is pointed at: SQLite locally, RDS
Postgres in AWS via DATABASE_URL. Keeping one source of truth means there is no
way to migrate the wrong database by editing the ini and forgetting the env var.
"""

import os
import sys
from logging.config import fileConfig

from sqlalchemy import pool

from alembic import context

# alembic/ is a subdirectory, so the app modules one level up are not importable
# by default. Prepend rather than append: a stdlib-shadowing name in site-packages
# should not win over this project's own db.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db import Base, DATABASE_URL, engine  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Autogenerate diffs the models against the live database, so every table in
# db.py is covered without listing them here.
target_metadata = Base.metadata

_IS_SQLITE = DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of executing it (`alembic upgrade --sql`).

    Useful when a DBA has to review or apply the change to RDS by hand.
    """
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        render_as_batch=_IS_SQLITE,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against the live database."""
    # Reuse the app's engine so pool_pre_ping and the SQLite connect_args stay
    # consistent with runtime; building a second engine here would drift.
    connectable = engine

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # Catch column type changes, not just added/dropped columns.
            compare_type=True,
            # SQLite cannot ALTER a column in place. Batch mode rebuilds the
            # table via copy-and-swap so ALTER/DROP migrations work locally as
            # well as on Postgres. No-op for Postgres.
            render_as_batch=_IS_SQLITE,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
