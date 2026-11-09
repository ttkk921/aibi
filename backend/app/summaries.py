"""Summary tables rebuilt from a detail table, so reports never scan the detail rows.

An import into the detail table rebuilds the summary for the imported dates in the same
transaction: either both change or neither does. Defined in the business package
(package.yaml `summaries`); the table itself is created by the package schema.
"""
from .db import connect
from .package import PACKAGE, Summary


SUMMARIES: dict[str, Summary] = PACKAGE.summaries  # by source table


def refresh(cur, table: str, dates: list[str] | None) -> dict[str, int]:
    """After an import into `table` for these dates (all dates when None): rebuild the summaries of that
    detail table for the same dates, and those whose computed keys read `table` for the same months.
    Rows written per summary table."""
    out: dict[str, int] = {}
    s = SUMMARIES.get(table)
    if s is not None:
        out[s.table] = _rebuild(cur, s, dates)
    for s in SUMMARIES.values():
        if table in s.depends_on:
            out[s.table] = _rebuild(cur, s, None if dates is None else _same_months(cur, s, dates))
    return out


def _same_months(cur, s: Summary, dates: list[str]) -> list[str]:
    """The detail dates in the months of `dates` (e.g. 案件AB表 of 2026-10 → every October report date)."""
    months = sorted({str(d)[:7] for d in dates})
    if not months:
        return []
    cur.execute(
        f"select distinct `{s.date_col}` from `{s.source}` "
        f"where date_format(`{s.date_col}`, '%%Y-%%m') in ({', '.join(['%s'] * len(months))})",
        months,
    )
    return [str(r[0]) for r in cur.fetchall()]


def _rebuild(cur, s: Summary, dates: list[str] | None) -> int:
    where, params = "", []
    if dates is not None:
        if not dates:
            return 0
        where = f" where `{s.date_col}` in ({', '.join(['%s'] * len(dates))})"
        params = list(dates)
    keys = ", ".join(f"`{k}`" for k in s.keys)
    sums = ", ".join(f"sum(`{c}`)" for c in s.sums)
    cur.execute(f"delete from `{s.table}`{where}", params)
    source = f"`{s.source}`{where}"
    if s.computed:
        # computed keys (e.g. AB类 from 队列 + 批次号) are worked out per detail row, then grouped like the rest
        # % is the driver's placeholder: date_format('%Y%m') in an expression must be doubled
        cols = [f"({s.computed[k].replace('%', '%%')}\n) as `{k}`" if k in s.computed else f"src.`{k}`" for k in s.keys]
        cols += [f"src.`{c}`" for c in s.sums]
        source = f"(select {', '.join(cols)} from `{s.source}` src{where.replace(' where `', ' where src.`')}) s"
    return cur.execute(
        f"insert into `{s.table}` ({keys}, `{s.count_as}`, {', '.join(f'`{c}`' for c in s.sums)}) "
        f"select {keys}, count(*), {sums} from {source} group by {keys}",
        params,
    )


def rebuild_all() -> dict[str, int]:
    out: dict[str, int] = {}
    with connect(autocommit=False) as conn:
        try:
            with conn.cursor() as cur:
                for s in SUMMARIES.values():
                    out[s.table] = _rebuild(cur, s, None)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return out
