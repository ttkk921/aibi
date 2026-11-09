"""Read-only ad-hoc SQL console."""
import re
import time

import pymysql
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import require_role
from ..db import connect, to_json

router = APIRouter(prefix="/api/sql", tags=["sql"], dependencies=[Depends(require_role("analyst"))])

MAX_ROWS = 2000
_ALLOWED_START = re.compile(r"^\s*(select|with|show|desc|describe|explain)\b", re.I)
_FORBIDDEN = re.compile(r"\binto\s+(outfile|dumpfile)\b|\bload_file\s*\(", re.I)


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"(--[^\n]*|#[^\n]*)", " ", sql)


class SqlIn(BaseModel):
    sql: str


def check_readonly(sql: str) -> str:
    """The statement to run, or HTTP 400 if it is not a single read-only query."""
    text = sql.strip().rstrip(";").strip()
    bare = _strip_comments(text)
    if not _ALLOWED_START.match(bare):
        raise HTTPException(400, "只允许查询语句（SELECT / WITH / SHOW / DESC / EXPLAIN）")
    if ";" in bare:
        raise HTTPException(400, "一次只能执行一条语句")
    if _FORBIDDEN.search(bare):
        raise HTTPException(400, "不允许读写服务器文件")
    return text


def run_readonly(conn, text: str, timeout_ms: int) -> dict:
    """Run a checked query in a read-only transaction; at most MAX_ROWS rows come back."""
    started = time.perf_counter()
    try:
        with conn.cursor() as cur:
            cur.execute(f"set session max_execution_time = {int(timeout_ms)}")
            # Belt and braces: even if a write slips past the checks above, MySQL rejects it here.
            cur.execute("start transaction read only")
            cur.execute(text)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchmany(MAX_ROWS + 1) if cols else []
    except pymysql.MySQLError as e:
        raise HTTPException(400, f"SQL 错误：{e.args[-1] if e.args else e}")
    finally:
        conn.rollback()
    truncated = len(rows) > MAX_ROWS
    return {
        "columns": cols,
        "rows": [[to_json(v) for v in r] for r in rows[:MAX_ROWS]],
        "truncated": truncated,
        "max_rows": MAX_ROWS,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
    }


@router.post("")
def run_sql(body: SqlIn):
    text = check_readonly(body.sql)
    with connect(autocommit=False) as conn:
        return run_readonly(conn, text, 60000)

