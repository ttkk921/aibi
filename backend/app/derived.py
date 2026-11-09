"""Columns worked out by SQL from the row and other tables (package.yaml `derived`), e.g. 在案表的核算还款率标识.

A write to a table recomputes its derived columns for the written dates, in the same transaction; a write to
a table they read (depends_on) recomputes every row. The expression is the table's SQL file, over alias src.
"""
from .db import connect
from .meta import columns, table_comment
from .package import PACKAGE, Derived, TableDef


def refresh(cur, table: str, dates: list[str] | None) -> dict[str, int]:
    """After a write to `table` for these dates (all dates when None). Rows updated per 「表「列」」 label."""
    out: dict[str, int] = {}
    for t in PACKAGE.tables.values():
        for col, d in t.derived.items():
            if t.name == table:
                out[_label(t, col)] = _update(cur, t, col, d, dates if t.date_col else None)
            elif table in d.depends_on:
                out[_label(t, col)] = _update(cur, t, col, d, None)
    return out


def fill_empty() -> dict[str, int]:
    """Compute the derived columns that are still empty (e.g. rows imported before the column existed)."""
    return _all(only_empty=True)


def rebuild_all() -> dict[str, int]:
    return _all(only_empty=False)


def _all(only_empty: bool) -> dict[str, int]:
    out: dict[str, int] = {}
    with connect(autocommit=False) as conn:
        try:
            with conn.cursor() as cur:
                for t in PACKAGE.tables.values():
                    for col, d in t.derived.items():
                        out[_label(t, col)] = _update(cur, t, col, d, None, only_empty)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return out


def _label(t: TableDef, col: str) -> str:
    label = next((c.label for c in columns(t.name) if c.name == col), col)
    return f"{table_comment(t.name) or t.name}「{label}」"


def _update(cur, t: TableDef, col: str, d: Derived, dates: list[str] | None, only_empty: bool = False) -> int:
    conds, params = [], []
    if dates is not None:
        if not dates:
            return 0
        conds.append(f"src.`{t.date_col}` in ({', '.join(['%s'] * len(dates))})")
        params = list(dates)
    if only_empty:
        conds.append(f"src.`{col}` is null")
    where = f" where {' and '.join(conds)}" if conds else ""
    # % is the driver's placeholder: date_format('%Y%m%d') in the expression must be doubled
    return cur.execute(f"update `{t.name}` src set src.`{col}` = ({d.sql.replace('%', '%%')}\n){where}", params)
