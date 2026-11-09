"""Import history, kept in a local SQLite file so the business DB stays untouched."""
import json
import sqlite3
from datetime import datetime

from . import config

_DB = config.DATA_DIR / "app.db"


def _conn():
    conn = sqlite3.connect(_DB)
    conn.execute(
        """create table if not exists import_log (
            id integer primary key autoincrement,
            created_at text not null,
            table_name text not null,
            filename text not null,
            mode text not null,
            status text not null,
            deleted integer,
            inserted integer,
            dates text,
            message text,
            username text
        )"""
    )
    # Logs written before accounts existed have no username column.
    if "username" not in {r[1] for r in conn.execute("pragma table_info(import_log)")}:
        conn.execute("alter table import_log add column username text")
    return conn


def record(
    table: str, filename: str, mode: str, status: str, deleted=None, inserted=None, dates=None, message=None, username=None
):
    with _conn() as conn:
        conn.execute(
            "insert into import_log (created_at, table_name, filename, mode, status, deleted, inserted, dates, message, username) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                datetime.now().isoformat(timespec="seconds"),
                table,
                filename,
                mode,
                status,
                deleted,
                inserted,
                json.dumps(dates or [], ensure_ascii=False),
                message,
                username,
            ),
        )


def history(limit: int = 100) -> list[dict]:
    with _conn() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("select * from import_log order by id desc limit ?", (limit,)).fetchall()
    return [{**dict(r), "dates": json.loads(r["dates"] or "[]")} for r in rows]
