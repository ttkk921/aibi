"""Browse and filter the business tables; add, change and delete single rows of the editable ones."""
import csv
import io
from datetime import date
from typing import Any, Literal

import pymysql
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import applog, derived, summaries
from ..auth import require_role
from ..db import connect, query, to_json
from ..importer import Converter
from ..meta import SYSTEM_COLS, TABLES, column_names, columns, get_table, table_comment
from ..users import User

analyst = require_role("analyst")
router = APIRouter(prefix="/api/tables", tags=["tables"], dependencies=[Depends(analyst)])

EXPORT_LIMIT = 300_000


@router.get("")
def list_tables():
    out = []
    with connect() as conn:
        for t in TABLES.values():
            if t.date_col:
                _, rows = query(
                    f"select `{t.date_col}`, count(*) from `{t.name}` group by `{t.date_col}` order by 1 desc",
                    conn=conn,
                )
                by_date = [{"date": r[0], "rows": r[1]} for r in rows]
                total = sum(r[1] for r in rows)
            else:
                _, rows = query(f"select count(*) from `{t.name}`", conn=conn)
                by_date, total = [], rows[0][0]
            out.append(
                {
                    "name": t.name,
                    "label": table_comment(t.name),
                    "date_col": t.date_col,
                    "total": total,
                    "by_date": by_date,
                    "derived_from": t.derived_from,
                    "editable": _editable_info(t),
                    "group": t.group,
                }
            )
    return out


@router.get("/{table}/columns")
def table_columns(table: str):
    t = get_table(table)
    return {
        "name": t.name,
        "label": table_comment(t.name),
        "date_col": t.date_col,
        "editable": _editable_info(t),
        "columns": [{"name": c.name, "type": c.data_type, "column_type": c.column_type, "label": c.label} for c in columns(t.name)],
    }


@router.get("/{table}/distinct")
def distinct_values(table: str, column: str, date: str | None = None, limit: int = 200):
    t = get_table(table)
    if column not in column_names(t.name):
        raise HTTPException(400, f"未知字段：{column}")
    where, params = _date_where(t, date)
    _, rows = query(
        f"select `{column}`, count(*) from `{t.name}` {where} group by `{column}` order by 2 desc limit %s",
        params + [min(limit, 1000)],
    )
    return [{"value": r[0], "count": r[1]} for r in rows]


Op = Literal["eq", "ne", "contains", "gt", "gte", "lt", "lte", "null", "notnull"]


class Condition(BaseModel):
    column: str
    op: Op
    value: str | None = None


class QueryIn(BaseModel):
    date: str | None = None
    conditions: list[Condition] = []
    sort_by: str | None = None
    sort_desc: bool = False
    page: int = 1
    page_size: int = 50


_OPS = {"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


def _date_where(t, value: str | None):
    if not value or not t.date_col:
        return "", []
    try:
        date.fromisoformat(value)
    except ValueError:
        raise HTTPException(400, f"日期格式不对：{value}")
    return f"where `{t.date_col}` = %s", [value]


def _build_where(t, body: QueryIn):
    valid = column_names(t.name)
    clauses, params = [], []
    where, p = _date_where(t, body.date)
    if where:
        clauses.append(where.removeprefix("where "))
        params += p
    for c in body.conditions:
        if c.column not in valid:
            raise HTTPException(400, f"未知字段：{c.column}")
        col = f"`{c.column}`"
        if c.op == "null":
            clauses.append(f"{col} is null")
        elif c.op == "notnull":
            clauses.append(f"{col} is not null")
        elif c.value is None or c.value == "":
            raise HTTPException(400, f"字段 {c.column} 的条件缺少值")
        elif c.op == "contains":
            clauses.append(f"{col} like %s")
            params.append("%" + c.value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        else:
            clauses.append(f"{col} {_OPS[c.op]} %s")
            params.append(c.value)
    return (" where " + " and ".join(clauses)) if clauses else "", params


@router.post("/{table}/query")
def query_table(table: str, body: QueryIn):
    t = get_table(table)
    where, params = _build_where(t, body)
    order = ""
    if body.sort_by:
        if body.sort_by not in column_names(t.name):
            raise HTTPException(400, f"未知字段：{body.sort_by}")
        order = f" order by `{body.sort_by}` {'desc' if body.sort_desc else 'asc'}"
    else:
        order = " order by id"
    size = max(1, min(body.page_size, 500))
    offset = (max(body.page, 1) - 1) * size
    with connect() as conn:
        _, cnt = query(f"select count(*) from `{t.name}`{where}", params, conn=conn)
        cols, rows = query(f"select * from `{t.name}`{where}{order} limit %s offset %s", params + [size, offset], conn=conn)
    return {"columns": cols, "rows": rows, "total": cnt[0][0]}


@router.post("/{table}/export")
def export_table(table: str, body: QueryIn):
    t = get_table(table)
    where, params = _build_where(t, body)
    labels = {c.name: c.label for c in columns(t.name)}

    def gen():
        with connect() as conn:
            with conn.cursor(pymysql.cursors.SSCursor) as cur:
                cur.execute(f"select * from `{t.name}`{where} order by id limit {EXPORT_LIMIT}", params)
                cols = [d[0] for d in cur.description]
                buf = io.StringIO()
                w = csv.writer(buf)
                buf.write("﻿")  # BOM so Excel opens UTF-8 Chinese correctly
                w.writerow([labels.get(c, c) for c in cols])
                while batch := cur.fetchmany(5000):
                    for r in batch:
                        w.writerow(["" if v is None else to_json(v) for v in r])
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate()
                yield buf.getvalue()

    filename = f"{t.name}{'_' + body.date if body.date else ''}.csv"
    return StreamingResponse(
        gen(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


# ---------------------------------------------------------------- editing single rows
# Only tables marked `editable` in package.yaml (small dimension and monthly target tables). Values go
# through the same conversion and value_rules as an import, and every change is written to the import log.

EDIT_LOG_FILE = "页面编辑"


def _editable_info(t) -> dict | None:
    return {"keys": list(t.editable.keys), "required": list(t.editable.required)} if t.editable else None


def _editable(table: str):
    t = get_table(table)
    if not t.editable:
        raise HTTPException(400, f"{table_comment(t.name) or t.name} 不能在页面上修改，请用「数据导入」")
    return t


def _labels(t) -> dict[str, str]:
    return {c.name: c.label for c in columns(t.name)}


def _clean(t, values: dict[str, Any]) -> dict:
    """The row as it would be imported: every editable column, converted and cleaned."""
    cols = [c for c in columns(t.name) if c.name not in SYSTEM_COLS]
    unknown = set(values) - {c.name for c in cols}
    if unknown:
        raise HTTPException(400, f"未知字段：{', '.join(sorted(unknown))}")
    row = {}
    for c in cols:
        conv = Converter(c, date_is_text=(c.name == t.date_col and t.date_is_text), rule=t.value_rules.get(c.name))
        try:
            row[c.name] = conv(values.get(c.name))
        except ValueError as e:
            raise HTTPException(400, f"{c.label}：{e}")
    empty = [c.label for c in cols if c.name in t.editable.required and row[c.name] is None]
    if empty:
        raise HTTPException(400, f"{'、'.join(empty)} 不能为空")
    return row


def _describe(t, row: dict, names) -> str:
    labels = _labels(t)
    return "，".join(f"{labels.get(k, k)}={'空' if row.get(k) is None else to_json(row[k])}" for k in names)


def _check_unique(cur, t, row: dict, row_id: int | None = None):
    keys = t.editable.keys
    where = " and ".join(f"`{k}` <=> %s" for k in keys)
    params = [row[k] for k in keys]
    if row_id is not None:
        where += " and id <> %s"
        params.append(row_id)
    cur.execute(f"select id from `{t.name}` where {where} limit 1", params)
    if cur.fetchone():
        raise HTTPException(400, f"已经有一行 {_describe(t, row, keys)}，不能重复")


def _fetch(cur, t, row_id: int) -> dict:
    cur.execute(f"select * from `{t.name}` where id = %s", (row_id,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "这一行已经不存在，刷新后再试")
    return dict(zip([d[0] for d in cur.description], r))


def _dates(t, *rows: dict) -> list[str]:
    return sorted({str(r[t.date_col]) for r in rows if t.date_col and r.get(t.date_col) is not None})


def _write(t, user: User, mode: str, fn) -> dict:
    """Run fn(cur) -> (deleted, inserted, dates, message) in one transaction, with the summaries that read
    this table, and log it."""
    with connect(autocommit=False) as conn:
        try:
            with conn.cursor() as cur:
                deleted, inserted, dates, message = fn(cur)
                derived.refresh(cur, t.name, dates if t.date_col else None)
                summaries.refresh(cur, t.name, dates if t.date_col else None)
            conn.commit()
        except pymysql.err.IntegrityError as e:
            conn.rollback()
            raise HTTPException(400, f"和已有的行重复：{e.args[-1]}")
        except Exception:
            conn.rollback()
            raise
    applog.record(t.name, EDIT_LOG_FILE, mode, "ok", deleted=deleted, inserted=inserted, dates=dates,
                  message=message, username=user.username)
    return {"ok": True, "message": message}


class RowIn(BaseModel):
    values: dict[str, Any]


@router.post("/{table}/rows")
def add_row(table: str, body: RowIn, user: User = Depends(analyst)):
    t = _editable(table)
    row = _clean(t, body.values)

    def fn(cur):
        _check_unique(cur, t, row)
        names = list(row)
        cur.execute(
            f"insert into `{t.name}` ({', '.join(f'`{c}`' for c in names)}) values ({', '.join(['%s'] * len(names))})",
            [row[c] for c in names],
        )
        return 0, 1, _dates(t, row), f"新增：{_describe(t, row, names)}"

    return _write(t, user, "row_insert", fn)


@router.put("/{table}/rows/{row_id}")
def update_row(table: str, row_id: int, body: RowIn, user: User = Depends(analyst)):
    t = _editable(table)
    row = _clean(t, body.values)

    def fn(cur):
        old = _fetch(cur, t, row_id)
        _check_unique(cur, t, row, row_id)
        changed = [c for c in row if to_json(old.get(c)) != to_json(row[c])]
        if not changed:
            raise HTTPException(400, "没有修改")
        cur.execute(f"update `{t.name}` set {', '.join(f'`{c}` = %s' for c in changed)} where id = %s",
                    [row[c] for c in changed] + [row_id])
        labels = _labels(t)
        diff = "，".join(f"{labels.get(c, c)}：{'空' if old[c] is None else to_json(old[c])} → "
                        f"{'空' if row[c] is None else to_json(row[c])}" for c in changed)
        return 1, 1, _dates(t, old, row), f"修改 {_describe(t, old, t.editable.keys)}（id={row_id}）：{diff}"

    return _write(t, user, "row_update", fn)


@router.delete("/{table}/rows/{row_id}")
def delete_row(table: str, row_id: int, user: User = Depends(analyst)):
    t = _editable(table)

    def fn(cur):
        old = _fetch(cur, t, row_id)
        cur.execute(f"delete from `{t.name}` where id = %s", (row_id,))
        names = [c.name for c in columns(t.name) if c.name not in SYSTEM_COLS]
        return 1, 0, _dates(t, old), f"删除（id={row_id}）：{_describe(t, old, names)}"

    return _write(t, user, "row_delete", fn)
