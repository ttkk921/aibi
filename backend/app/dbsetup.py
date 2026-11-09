"""Database-level setup run by `python -m app.cli setup`: the database itself and the SELECT-only
account used by AI SQL and the agent API. Uses DB_ADMIN_USER (default DB_USER), which needs the
CREATE / CREATE USER / GRANT privileges; without them setup reports what to do by hand.
"""
import secrets

import pymysql

from . import config
from .package import PACKAGE

READONLY_USER = "bi_ai_ro"


def _admin(database: str | None = None) -> pymysql.Connection:
    return pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.DB_ADMIN_USER,
        password=config.DB_ADMIN_PASSWORD,
        database=database,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=10,
    )


def create_database() -> bool:
    """Create the business database if missing; False when it already existed."""
    with _admin() as conn, conn.cursor() as cur:
        cur.execute("select 1 from information_schema.schemata where schema_name = %s", (config.DB_NAME,))
        if cur.fetchone():
            return False
        cur.execute(f"create database `{config.DB_NAME}` character set utf8mb4 collate utf8mb4_unicode_ci")
        return True


def _grants(cur, user: str, host: str):
    """SELECT on every package table; column by column where the package hides columns."""
    for table in PACKAGE.tables:
        hidden = set(PACKAGE.hidden_columns.get(table, []))
        if not hidden:
            cur.execute(f"grant select on `{config.DB_NAME}`.`{table}` to %s@%s", (user, host))
            continue
        cur.execute(
            "select column_name from information_schema.columns where table_schema = %s and table_name = %s "
            "order by ordinal_position",
            (config.DB_NAME, table),
        )
        cols = [r[0] for r in cur.fetchall() if r[0] not in hidden]
        if cols:
            cur.execute(
                f"grant select ({', '.join(f'`{c}`' for c in cols)}) on `{config.DB_NAME}`.`{table}` to %s@%s",
                (user, host),
            )


def ensure_readonly_user() -> dict[str, str]:
    """Create the read-only account if it is not configured yet, and (re)grant it the package's tables.

    Returns the settings to persist (empty when the account was already configured).
    """
    with _admin(config.DB_NAME) as conn, conn.cursor() as cur:
        if config.AGENT_DB_USER:
            cur.execute("select host from mysql.user where user = %s", (config.AGENT_DB_USER,))
            hosts = [r[0] for r in cur.fetchall()]
            for host in hosts:  # new tables (later migrations) need their grants too
                _grants(cur, config.AGENT_DB_USER, host)
            return {}
        password = secrets.token_urlsafe(24)
        host = config.AGENT_DB_HOST
        cur.execute("select count(*) from mysql.user where user = %s and host = %s", (READONLY_USER, host))
        if cur.fetchone()[0]:
            cur.execute("alter user %s@%s identified by %s", (READONLY_USER, host, password))
        else:
            cur.execute("create user %s@%s identified by %s with max_user_connections 5", (READONLY_USER, host, password))
        _grants(cur, READONLY_USER, host)
    return {"AGENT_DB_USER": READONLY_USER, "AGENT_DB_PASSWORD": password}
