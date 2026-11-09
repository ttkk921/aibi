import datetime as dt
import threading
from contextlib import contextmanager
from decimal import Decimal

import pymysql

from . import config


# The report SQL groups by some columns and selects others that depend on them, which MySQL's
# default ONLY_FULL_GROUP_BY rejects. Relax it per session so any MySQL server works as-is.
SESSION_INIT = "SET SESSION sql_mode = REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', '')"

_POOL_SIZE = 5
_idle: list[pymysql.Connection] = []
_lock = threading.Lock()


def _open(autocommit: bool) -> pymysql.Connection:
    return pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=config.DB_NAME,
        charset="utf8mb4",
        autocommit=autocommit,
        connect_timeout=10,
        init_command=SESSION_INIT,
    )


@contextmanager
def connect(autocommit: bool = True):
    """Read connections come from a small pool (connecting is slow over a tunnel);
    transactional ones are always fresh so no session state leaks between imports."""
    if not autocommit:
        conn = _open(False)
        try:
            yield conn
        finally:
            conn.close()
        return

    conn = None
    with _lock:
        if _idle:
            conn = _idle.pop()
    if conn is not None:
        try:
            conn.ping(reconnect=True)
        except pymysql.MySQLError:
            conn = None
    if conn is None:
        conn = _open(True)
    ok = False
    try:
        yield conn
        ok = True
    finally:
        with _lock:
            if ok and len(_idle) < _POOL_SIZE:
                _idle.append(conn)
                conn = None
        if conn is not None:
            conn.close()


@contextmanager
def connect_agent():
    """A fresh connection as the SELECT-only agent account (no write rights, no account_no)."""
    if not (config.AGENT_DB_USER and config.AGENT_DB_PASSWORD):
        raise RuntimeError("AGENT_DB_USER / AGENT_DB_PASSWORD 未配置")
    conn = pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.AGENT_DB_USER,
        password=config.AGENT_DB_PASSWORD,
        database=config.DB_NAME,
        charset="utf8mb4",
        autocommit=False,
        connect_timeout=10,
        init_command=SESSION_INIT,
    )
    try:
        yield conn
    finally:
        conn.close()


def to_json(value):
    """Convert a DB value into something JSON can carry."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def query(sql: str, params=None, conn=None):
    """Run a SELECT and return (column names, rows as lists)."""
    def run(c):
        with c.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [[to_json(v) for v in r] for r in cur.fetchall()]
            return cols, rows

    if conn is not None:
        return run(conn)
    with connect() as c:
        return run(c)
