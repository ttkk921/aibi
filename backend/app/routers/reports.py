"""Reports of the business package: SQL reports (data per date) and summary reports
(tables summarized in the browser from a SQL report's rows)."""
import time
from dataclasses import asdict
from datetime import date as Date

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import require_user
from ..db import connect, query
from ..package import PACKAGE, Report, SummaryReport

router = APIRouter(prefix="/api/reports", tags=["reports"], dependencies=[Depends(require_user)])

# SQL reports by id (the AI tools and the agent API query these); summary reports build on them.
REPORTS: dict[str, Report] = PACKAGE.sql_reports
column_format = PACKAGE.column_format


def _get(report_id: str) -> Report:
    if report_id not in REPORTS:
        raise HTTPException(404, "未知的报表")
    return REPORTS[report_id]


@router.get("")
def list_reports():
    """Every report in menu order."""
    return [{"id": r.id, "title": r.title, "description": r.description, "type": r.type} for r in PACKAGE.reports.values()]


def _summary_meta(r: SummaryReport):
    source = REPORTS[r.source]
    _, rows = query(source.dates_sql)
    return {
        "id": r.id,
        "type": r.type,
        "title": r.title,
        "description": r.description,
        "note": r.note,
        "source": r.source,
        "dates": [str(x[0]) for x in rows],
        "ratios": {k: {"num": v.num, "den": v.den, "minus_one": v.minus_one} for k, v in source.ratios.items()},
        "tables": [
            {
                "title": t.title,
                "group_by": t.group_by,
                "filter": t.filter,
                "sort": t.sort,
                "hide_empty": t.hide_empty,
                "chart": asdict(t.chart) if t.chart else None,
                "columns": [
                    {
                        "name": c.name,
                        "sum": c.sum,
                        "ratio": c.ratio,
                        "diff": c.diff,
                        # sums and differences keep the source column's format; ratios are percentages
                        "format": c.format or ("pct" if c.ratio else column_format(c.sum or c.diff[0])),
                    }
                    for c in t.columns
                ],
            }
            for t in r.tables
        ],
    }


@router.get("/{report_id}")
def report_meta(report_id: str):
    summary = PACKAGE.reports.get(report_id)
    if isinstance(summary, SummaryReport):
        return _summary_meta(summary)
    r = _get(report_id)
    _, rows = query(r.dates_sql)
    return {
        "type": r.type,
        "id": r.id,
        "title": r.title,
        "description": r.description,
        "sql": r.sql,
        "dates": [str(x[0]) for x in rows],
        "dims": r.dims,
        "ratios": {k: {"num": v.num, "den": v.den, "minus_one": v.minus_one} for k, v in r.ratios.items()},
        "kpis": r.kpis,
        "group_by": r.group_by,
        "stage_dim": r.stage_dim,
        "default_filters": r.default_filters,
        "choices": [asdict(c) for c in r.choices],
        "hidden": r.hidden,
        "column_groups": r.column_groups,
        "base_group": r.base_group,
        "benchmarks": [{"avg": b.avg, "flag": b.flag, "rate": b.rate} for b in r.benchmarks],
        "trend": asdict(r.trend) if r.trend else None,
        "pivots": [{"title": p.title, "keys": p.keys, "merge": p.merge, "hide": p.hide} for p in r.pivots],
        "charts": [asdict(c) for c in r.charts],
        "tables": [asdict(t) for t in r.tables],
    }


def fetch(r: Report, dates: list[str]) -> tuple[list[str], list[list], int]:
    """The report's rows for the given dates (all dates when empty): columns, rows, elapsed ms."""
    where = ""
    if dates:
        try:
            dates = sorted({Date.fromisoformat(d).isoformat() for d in dates})
        except ValueError:
            raise HTTPException(400, "日期格式不对")
        # validated ISO dates, safe to inline
        where = " where r.`日期` in (" + ", ".join(f"'{d}'" for d in dates) + ")"
    # No params are passed, so the literal % in the SQL text is not treated as a placeholder.
    sql = f"select * from (\n{r.sql}\n) r{where}"
    started = time.perf_counter()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("set session max_execution_time = 120000")
        cols, rows = query(sql, conn=conn)
    return cols, rows, round((time.perf_counter() - started) * 1000)


@router.get("/{report_id}/data")
def report_data(report_id: str, date: list[str] = Query(default=[])):
    """date may repeat (?date=a&date=b); none means all dates."""
    r = _get(report_id)
    cols, rows, elapsed_ms = fetch(r, date)
    return {
        "columns": [{"name": c, "format": column_format(c)} for c in cols],
        "rows": rows,
        "elapsed_ms": elapsed_ms,
    }

