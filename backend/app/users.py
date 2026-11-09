"""User accounts and roles, kept in the app's own SQLite file (data/app.db), never in the business DB.

Roles, each including the ones below it:
- viewer:  reports, the AI 问数 drawer (report queries only), own password
- analyst: + raw tables, imports, the SQL console, SQL in the AI 问数 drawer
- admin:   + user management

Each user has an `epoch` that is bumped when their password is changed or reset, or when an
admin disables them; a session carries the epoch it was issued with and stops working when
they differ. The first start migrates the single admin of the old setup (.env or
data/auth.json) into the table, so existing logins keep working.
"""
import json
import os
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime

from . import config
from .passwords import hash_password

ROLES = ("viewer", "analyst", "admin")
ROLE_LABELS = {"viewer": "只读", "analyst": "分析员", "admin": "管理员"}

_DB = config.DATA_DIR / "app.db"
_lock = threading.Lock()


@dataclass(frozen=True)
class User:
    id: int
    username: str
    display_name: str
    role: str
    active: bool
    epoch: int
    password_hash: str
    created_at: str
    last_login: str | None

    def at_least(self, role: str) -> bool:
        return ROLES.index(self.role) >= ROLES.index(role)

    def public(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name,
            "role": self.role,
            "role_label": ROLE_LABELS[self.role],
            "active": self.active,
            "created_at": self.created_at,
            "last_login": self.last_login,
        }


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """create table if not exists users (
            id integer primary key autoincrement,
            username text not null unique collate nocase,
            display_name text not null default '',
            role text not null,
            active integer not null default 1,
            epoch integer not null default 0,
            password_hash text not null,
            created_at text not null,
            last_login text
        )"""
    )
    return conn


def _user(row) -> User | None:
    if row is None:
        return None
    return User(
        id=row["id"],
        username=row["username"],
        display_name=row["display_name"] or row["username"],
        role=row["role"],
        active=bool(row["active"]),
        epoch=row["epoch"],
        password_hash=row["password_hash"],
        created_at=row["created_at"],
        last_login=row["last_login"],
    )


INITIAL_PASSWORD_FILE = config.DATA_DIR / "initial_admin_password"


def bootstrap() -> str | None:
    """Create the table and, while it is empty, the first admin.

    The single-user setup's password (data/auth.json or ADMIN_PASSWORD_HASH) carries over; a new
    deployment gets a random password, returned once and written to data/initial_admin_password.
    """
    with _lock, _conn() as conn:
        if conn.execute("select count(*) from users").fetchone()[0]:
            return None
        password_hash = config.ADMIN_PASSWORD_HASH
        legacy = config.DATA_DIR / "auth.json"  # password changed on the page before accounts existed
        if legacy.exists():
            password_hash = json.loads(legacy.read_text()).get("password_hash") or password_hash
        generated = None
        if not password_hash:
            generated = secrets.token_urlsafe(12)
            password_hash = hash_password(generated)
            fd = os.open(INITIAL_PASSWORD_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(f"{config.ADMIN_USER} {generated}\n")
        conn.execute(
            "insert into users (username, display_name, role, password_hash, created_at) values (?, ?, 'admin', ?, ?)",
            (config.ADMIN_USER, config.ADMIN_USER, password_hash, _now()),
        )
    return generated


def get(user_id: int) -> User | None:
    with _conn() as conn:
        return _user(conn.execute("select * from users where id = ?", (user_id,)).fetchone())


def by_username(username: str) -> User | None:
    with _conn() as conn:
        return _user(conn.execute("select * from users where username = ?", (username,)).fetchone())


def all_users() -> list[User]:
    with _conn() as conn:
        return [_user(r) for r in conn.execute("select * from users order by id").fetchall()]


def active_admins() -> int:
    with _conn() as conn:
        return conn.execute("select count(*) from users where role = 'admin' and active = 1").fetchone()[0]


def create(username: str, display_name: str, role: str, password_hash: str) -> User:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "insert into users (username, display_name, role, password_hash, created_at) values (?, ?, ?, ?, ?)",
            (username, display_name, role, password_hash, _now()),
        )
        user_id = cur.lastrowid
    return get(user_id)


def update(user_id: int, *, display_name: str | None = None, role: str | None = None, active: bool | None = None) -> User:
    sets, params = [], []
    if display_name is not None:
        sets.append("display_name = ?")
        params.append(display_name)
    if role is not None:
        sets.append("role = ?")
        params.append(role)
    if active is not None:
        sets.append("active = ?")
        params.append(int(active))
        if not active:
            sets.append("epoch = epoch + 1")  # signs the user out everywhere
    if sets:
        with _lock, _conn() as conn:
            conn.execute(f"update users set {', '.join(sets)} where id = ?", (*params, user_id))
    return get(user_id)


def set_password(user_id: int, password_hash: str) -> User:
    """New password; every existing session of this user stops working."""
    with _lock, _conn() as conn:
        conn.execute("update users set password_hash = ?, epoch = epoch + 1 where id = ?", (password_hash, user_id))
    return get(user_id)


def touch_login(user_id: int):
    with _conn() as conn:
        conn.execute("update users set last_login = ? where id = ?", (_now(), user_id))


def delete(user_id: int):
    with _lock, _conn() as conn:
        conn.execute("delete from users where id = ?", (user_id,))
