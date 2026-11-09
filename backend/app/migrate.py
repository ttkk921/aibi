"""Business database schema: the package's schema/*.sql files, applied once each in file-name
order and recorded in bi_schema_migrations. Files are append-only history: to change a table,
add a new file (e.g. 003_add_xxx.sql) rather than editing an applied one — an edited file is
reported, never silently re-run.
"""
import hashlib
from pathlib import Path

from .db import connect
from .package import PACKAGE

TABLE = "bi_schema_migrations"


def split_statements(sql: str) -> list[str]:
    """Split on `;` outside quotes and comments (enough for DDL and simple DML)."""
    out, buf, i, quote = [], [], 0, None
    while i < len(sql):
        ch = sql[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < len(sql):
                buf.append(sql[i + 1])
                i += 1
            elif ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
        elif sql.startswith("--", i) or ch == "#":
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end
            continue
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = len(sql) if end < 0 else end + 2
            continue
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    stmt = "".join(buf).strip()
    if stmt:
        out.append(stmt)
    return out


def files() -> list[Path]:
    schema = PACKAGE.dir / "schema"
    return sorted(schema.glob("*.sql")) if schema.is_dir() else []


def _checksum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _applied(cur) -> dict[str, str]:
    cur.execute(
        f"create table if not exists `{TABLE}` ("
        " version varchar(200) not null primary key,"
        " checksum char(64) not null,"
        " applied_at timestamp not null default current_timestamp"
        ") comment='已执行的建表/迁移脚本'"
    )
    cur.execute(f"select version, checksum from `{TABLE}`")
    return dict(cur.fetchall())


def status() -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        applied = _applied(cur)
    return [
        {
            "version": f.name,
            "applied": f.name in applied,
            "changed": f.name in applied and applied[f.name] != _checksum(f),
        }
        for f in files()
    ]


def migrate(log=print) -> list[str]:
    """Apply pending schema files; returns the versions applied now."""
    done = []
    with connect() as conn, conn.cursor() as cur:
        applied = _applied(cur)
        for f in files():
            if f.name in applied:
                if applied[f.name] != _checksum(f):
                    log(f"注意：{f.name} 执行后被修改过，不会重新执行；要改表请新增一个迁移文件")
                continue
            for stmt in split_statements(f.read_text(encoding="utf-8")):
                cur.execute(stmt)
            cur.execute(f"insert into `{TABLE}` (version, checksum) values (%s, %s)", (f.name, _checksum(f)))
            done.append(f.name)
            log(f"已执行 {f.name}")
    return done
