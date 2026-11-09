"""Read-only query API for external AI agents: the dashboard's reports and ad-hoc SQL.

Auth is a bearer token (hash in .env, see `app.cli agent-token`), separate from the login
session. By default only callers on the server itself are served: nginx always adds
X-Forwarded-For / X-Real-IP, so a request carrying them came from outside and is refused.

Report figures are aggregated exactly like the dashboard's 合计 / pivot rows: amounts and
counts are summed, rates are recomputed as sum(num) / sum(den) over rows where both are
present, and a reference rate (大区平均达成率) is kept only when all rows share it.
The SQL endpoint runs as a SELECT-only account that cannot read account_no.
"""
import hashlib
import hmac
import logging
from datetime import date as Date

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .. import config
from ..db import connect, connect_agent, query
from ..package import PACKAGE
from .reports import REPORTS, Report, column_format, fetch
from .sql import check_readonly, run_readonly

log = logging.getLogger("bi.agent")


def require_agent(request: Request, authorization: str = Header(default="")):
    if not config.AGENT_TOKEN_HASH:
        raise HTTPException(503, "agent 接口未启用：先运行 python -m app.cli agent-token")
    if not config.AGENT_ALLOW_REMOTE and (request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip")):
        raise HTTPException(403, "agent 接口只接受服务器本机的请求")
    token = authorization.removeprefix("Bearer ").strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not token or not hmac.compare_digest(digest, config.AGENT_TOKEN_HASH):
        raise HTTPException(401, "token 无效")


router = APIRouter(prefix="/api/agent", tags=["agent"], dependencies=[Depends(require_agent)])

MAX_REPORT_ROWS = 500


# ---------------------------------------------------------------- aggregation


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def metric_columns(r: Report, cols: list[str]) -> list[str]:
    """Columns that can be summed or recomputed for a group of rows (as in the dashboard)."""
    bench = {b.avg for b in r.benchmarks} | {b.flag for b in r.benchmarks}
    return [
        c
        for c in cols
        if c not in r.dims and (c in r.ratios or column_format(c) in ("amount", "count") or c in bench)
    ]


def summarize(r: Report, rows: list[dict], metrics: list[str]) -> dict:
    out: dict = {}

    def total(col, where=None):
        vals = [x[col] for x in rows if _num(x.get(col)) and (where is None or where(x))]
        return sum(vals) if vals else None

    for c in metrics:
        ratio = r.ratios.get(c)
        if ratio:
            both = lambda x, ratio=ratio: _num(x.get(ratio.num)) and _num(x.get(ratio.den))  # noqa: E731
            n, d = total(ratio.num, both), total(ratio.den, both)
            out[c] = None if n is None or not d else n / d - (1 if ratio.minus_one else 0)
        elif column_format(c) in ("amount", "count"):
            out[c] = total(c)
        else:
            out[c] = None
    for b in r.benchmarks:
        values = {x[b.avg] for x in rows if _num(x.get(b.avg))}
        avg = values.pop() if len(values) == 1 else None
        rate = out.get(b.rate)
        out[b.avg] = avg
        out[b.flag] = None if avg is None or rate is None else ("是" if rate > avg else "否")
    return out


def _round(v, fmt: str):
    if not _num(v):
        return v
    return round(v, 6) if fmt == "pct" else round(v, 2)


# ---------------------------------------------------------------- endpoints

_columns_cache: dict[str, list[str]] = {}


def report_columns(r: Report, latest: str | None) -> list[str]:
    """Column names of a report (they only change with a deploy, so cached per process)."""
    if r.id not in _columns_cache and latest:
        _columns_cache[r.id] = fetch(r, [latest])[0]
    return _columns_cache.get(r.id, [])



@router.get("/catalog")
def catalog():
    """What can be asked: reports (dimensions, dates, rate formulas) and the tables the SQL endpoint sees."""
    reports = []
    for r in REPORTS.values():
        _, drows = query(r.dates_sql)
        dates = [str(x[0]) for x in drows]
        cols = report_columns(r, dates[0] if dates else None)
        reports.append(
            {
                "id": r.id,
                "title": r.title,
                "description": r.description,
                "dims": r.dims,
                "columns": [{"name": c, "format": column_format(c)} for c in cols if c not in r.dims],
                "dates": dates[:62],
                "rates": {k: f"sum({v.num}) / sum({v.den})" + (" - 1" if v.minus_one else "") for k, v in r.ratios.items()},
                "benchmarks": [
                    {"reference": b.avg, "flag": b.flag, "compares": b.rate} for b in r.benchmarks
                ],
            }
        )
    # Without the read-only account (not set up yet) list the same tables minus the hidden columns.
    with (connect_agent() if config.AGENT_DB_USER else connect()) as conn:
        _, cols = query(
            "select c.table_name, t.table_comment, c.column_name, c.column_type, c.column_comment "
            "from information_schema.columns c join information_schema.tables t "
            "on t.table_schema=c.table_schema and t.table_name=c.table_name "
            "where c.table_schema=%s order by c.table_name, c.ordinal_position",
            (config.DB_NAME,),
            conn=conn,
        )
    tables: dict[str, dict] = {}
    for table, comment, col, ctype, ccomment in cols:
        if table not in PACKAGE.tables or col in PACKAGE.hidden_columns.get(table, []):
            continue
        t = tables.setdefault(table, {"name": table, "comment": comment, "columns": []})
        t["columns"].append({"name": col, "type": ctype, "comment": ccomment})
    return {"reports": reports, "tables": list(tables.values())}


class ReportQuery(BaseModel):
    report: str = Field(description="报表 id，见 /catalog")
    date: str | None = Field(default=None, description="YYYY-MM-DD；不传则取最新日期")
    dates: list[str] | None = Field(default=None, description="多个日期（看趋势）；结果按日期分组")
    filters: dict[str, list[str | None]] = Field(default_factory=dict, description="维度 -> 取值列表；null 表示空值")
    group_by: list[str] = Field(default_factory=list, description="分组维度；为空返回明细行")
    columns: list[str] | None = Field(default=None, description="只返回这些指标列")
    sort: str | None = Field(default=None, description="排序列，前缀 - 表示降序")
    limit: int = Field(default=200, ge=1, le=MAX_REPORT_ROWS)


@router.post("/report")
def report(q: ReportQuery):
    r = REPORTS.get(q.report)
    if not r:
        raise HTTPException(404, f"未知报表 {q.report}，可选：{', '.join(REPORTS)}")
    _, drows = query(r.dates_sql)
    available = [str(x[0]) for x in drows]
    dates = q.dates or ([q.date] if q.date else available[:1])
    for d in dates:
        try:
            Date.fromisoformat(d)
        except ValueError:
            raise HTTPException(400, f"日期格式不对：{d}")
        if d not in available:
            raise HTTPException(400, f"{d} 没有数据；最近的日期：{', '.join(available[:10])}")
    for dim in [*q.filters, *q.group_by]:
        if dim not in r.dims:
            raise HTTPException(400, f"{dim} 不是这个报表的维度；可选：{', '.join(r.dims)}")

    cols, raw, elapsed_ms = fetch(r, dates)
    rows = [dict(zip(cols, x)) for x in raw]
    for dim, values in q.filters.items():
        allowed = {None if v is None else str(v) for v in values}
        rows = [x for x in rows if (None if x.get(dim) is None else str(x[dim])) in allowed]

    group_by = list(q.group_by)
    notes = []
    if len(dates) > 1 and "日期" not in group_by:
        # The amounts are month-to-date snapshots; adding up days would be meaningless.
        group_by.insert(0, "日期")
        notes.append("多个日期时按日期分组；金额是截至当天的累计值，不能跨日期相加")
    metrics = metric_columns(r, cols)
    if q.columns:
        unknown = [c for c in q.columns if c not in cols]
        if unknown:
            raise HTTPException(400, f"没有这些列：{', '.join(unknown)}")
    # Grouped rows can only carry summable/recomputable columns; detail rows keep every column.
    default_cols = metrics if group_by else [c for c in cols if c not in r.dims]
    shown_metrics = [c for c in (q.columns or default_cols) if c not in r.dims]

    if group_by:
        buckets: dict[tuple, list[dict]] = {}
        for x in rows:
            buckets.setdefault(tuple(x.get(g) for g in group_by), []).append(x)
        out_rows = [{**dict(zip(group_by, k)), **summarize(r, rs, metrics)} for k, rs in buckets.items()]
        out_cols = group_by + [c for c in shown_metrics if c in metrics]
    else:
        out_rows = rows
        out_cols = [c for c in cols if c in r.dims] + shown_metrics

    if q.sort:
        key = q.sort.lstrip("-")
        if key not in out_cols:
            raise HTTPException(400, f"不能按 {key} 排序，它不在结果列里")
        present = [x for x in out_rows if x.get(key) is not None]
        missing = [x for x in out_rows if x.get(key) is None]
        out_rows = sorted(present, key=lambda x: x[key], reverse=q.sort.startswith("-")) + missing

    total = None if len(dates) > 1 else summarize(r, rows, metrics)
    fmts = {c: column_format(c) for c in out_cols}
    log.info("report %s dates=%s filters=%s group_by=%s rows=%d", r.id, dates, q.filters, group_by, len(out_rows))
    return {
        "report": r.id,
        "title": r.title,
        "dates": dates,
        "filters": q.filters,
        "group_by": group_by,
        "columns": [{"name": c, "format": fmts[c]} for c in out_cols],
        "rows": [[_round(x.get(c), fmts[c]) for c in out_cols] for x in out_rows[: q.limit]],
        "row_count": len(out_rows),
        "truncated": len(out_rows) > q.limit,
        "total": None if total is None else {c: _round(total.get(c), fmts[c]) for c in out_cols if c in total},
        "notes": notes
        + ["format=pct 的值是比例（0.35 表示 35%）", "达成率等比率按 sum(分子)/sum(分母) 重算，只统计分子分母都有值的行"],
        "elapsed_ms": elapsed_ms,
    }


class SqlQuery(BaseModel):
    sql: str


@router.post("/sql")
def sql(q: SqlQuery):
    text = check_readonly(q.sql)
    with connect_agent() as conn:
        result = run_readonly(conn, text, 30000)
    log.info("sql rows=%d elapsed=%dms: %s", len(result["rows"]), result["elapsed_ms"], " ".join(text.split())[:500])
    return result
