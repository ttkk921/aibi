"""Settings changed on the page (admins), kept in data/app.db so a redeploy never overwrites them.
A missing key means "use the business package's default"."""
import sqlite3
from datetime import datetime

from . import config

_DB = config.DATA_DIR / "app.db"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """create table if not exists settings (
            key text primary key,
            value text not null,
            updated_at text not null,
            updated_by text
        )"""
    )
    return conn


def get(key: str) -> dict | None:
    """{"value", "updated_at", "updated_by"} or None when not set."""
    with _conn() as conn:
        row = conn.execute("select value, updated_at, updated_by from settings where key = ?", (key,)).fetchone()
    return dict(row) if row else None


def put(key: str, value: str, user: str):
    with _conn() as conn:
        conn.execute(
            "insert into settings (key, value, updated_at, updated_by) values (?, ?, ?, ?) "
            "on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (key, value, datetime.now().isoformat(timespec="seconds"), user),
        )


def delete(key: str):
    with _conn() as conn:
        conn.execute("delete from settings where key = ?", (key,))
