"""Registry of the business tables the app may read and import into.

Column names, types and Chinese labels come from information_schema; the
column comments match the Excel headers, which is what the importer maps on.
"""
from dataclasses import dataclass
from functools import lru_cache

from . import config
from .db import query

# Table definitions and import rules come from the business package (re-exported for importers).
from .package import PACKAGE, TableDef, ValueRule  # noqa: F401

TABLES: dict[str, TableDef] = PACKAGE.tables

# Filled by the database, never by an import.
SYSTEM_COLS = {"id", "created_at"}


@dataclass(frozen=True)
class Column:
    name: str
    data_type: str  # int, bigint, decimal, varchar, date, text, timestamp
    column_type: str
    label: str


@lru_cache(maxsize=None)
def table_comment(table: str) -> str:
    _, rows = query(
        "select table_comment from information_schema.tables where table_schema=%s and table_name=%s",
        (config.DB_NAME, table),
    )
    return rows[0][0] if rows else ""


@lru_cache(maxsize=None)
def columns(table: str) -> tuple[Column, ...]:
    _, rows = query(
        "select column_name, data_type, column_type, column_comment from information_schema.columns "
        "where table_schema=%s and table_name=%s order by ordinal_position",
        (config.DB_NAME, table),
    )
    return tuple(Column(r[0], r[1].lower(), r[2], r[3] or r[0]) for r in rows)


def get_table(table: str) -> TableDef:
    if table not in TABLES:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail=f"未知的表：{table}")
    return TABLES[table]


def column_names(table: str) -> set[str]:
    return {c.name for c in columns(table)}
