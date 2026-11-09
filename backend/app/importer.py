"""Excel (.xlsx / .xls) and CSV import: map headers to columns, convert types, preview, then commit.

Headers are matched against column comments (which mirror the Excel headers),
then the column name itself, then the table's explicit aliases.
"""
import csv
import datetime as dt
import io
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path

from openpyxl import load_workbook

from .db import connect
from . import derived, summaries
from .meta import SYSTEM_COLS, TABLES, Column, TableDef, ValueRule, columns, table_comment

EXCEL_EPOCH = dt.date(1899, 12, 30)
MAX_ISSUES = 50
SAMPLE_ROWS = 20
INSERT_BATCH = 2000


class ImportFailed(Exception):
    pass


# ---------- reading files ----------

def _decode(raw: bytes, what: str) -> str:
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ImportFailed(f"{what}编码无法识别（支持 UTF-8 / GBK）")


def _xlsx_rows(source):
    wb = load_workbook(source, read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        # Some exporters write a wrong <dimension ref="A1"/>, and read-only mode would stop at A1: read every row.
        ws.reset_dimensions()
        for row in ws.iter_rows(values_only=True):
            yield list(row)
    finally:
        wb.close()


def _biff_rows(path: Path):
    """First sheet of a real (BIFF) .xls, with the value types openpyxl gives for .xlsx."""
    import xlrd

    try:
        book = xlrd.open_workbook(str(path), on_demand=True)
    except xlrd.XLRDError as e:
        raise ImportFailed(f".xls 文件无法读取：{e}")
    try:
        sheet = book.sheet_by_index(0)
        for r in range(sheet.nrows):
            row = []
            for cell in sheet.row(r):
                if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
                    row.append(None)
                elif cell.ctype == xlrd.XL_CELL_NUMBER:
                    # .xls stores every number as a float; whole numbers read as int, like openpyxl
                    row.append(int(cell.value) if float(cell.value).is_integer() else cell.value)
                elif cell.ctype == xlrd.XL_CELL_DATE:
                    row.append(xlrd.xldate_as_datetime(cell.value, book.datemode))
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    row.append(bool(cell.value))
                else:
                    row.append(cell.value)
            yield row
    finally:
        book.release_resources()


class _TableParser(HTMLParser):
    """Rows of the first <table> in an HTML document."""

    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._tables = 0
        self._done = False

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        if tag == "table":
            self._tables += 1
        elif tag == "tr" and self._tables == 1:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if self._done:
            return
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
        elif tag == "table":
            self._tables -= 1
            if self._tables == 0 and self.rows:
                self._done = True

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _xls_rows(path: Path):
    """A ".xls" may be a real Excel 97-2003 file, an .xlsx renamed, or — as many business systems
    export — an HTML table or tab-separated text. Decide by the content, not the extension."""
    raw = path.read_bytes()
    if raw.startswith(b"\xd0\xcf\x11\xe0"):  # OLE2 container: real .xls
        yield from _biff_rows(path)
    elif raw.startswith(b"PK"):  # zip container: an .xlsx with the wrong extension
        yield from _xlsx_rows(io.BytesIO(raw))
    else:
        text = _decode(raw, ".xls 文件")
        if text.lstrip().startswith("<"):
            parser = _TableParser()
            parser.feed(text)
            if not parser.rows:
                raise ImportFailed("这个 .xls 是网页格式，但里面没有表格")
            yield from parser.rows
        else:
            yield from csv.reader(text.splitlines(), delimiter="\t" if "\t" in text.split("\n", 1)[0] else ",")


def read_rows(path: Path):
    """Yield raw rows (lists) from the first sheet of an .xlsx / .xls, or a .csv."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        yield from csv.reader(_decode(path.read_bytes(), "CSV ").splitlines())
    elif suffix == ".xls":
        yield from _xls_rows(path)
    else:
        yield from _xlsx_rows(path)


def _is_blank(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def split_header(rows):
    """Return (header, iterator of (excel_row_number, data_row))."""
    it = iter(rows)
    line = 0
    for row in it:
        line += 1
        if any(not _is_blank(v) for v in row):
            header = ["" if v is None else str(v).strip() for v in row]

            def data():
                n = line
                for r in it:
                    n += 1
                    yield n, r

            return header, data()
    raise ImportFailed("文件是空的")


# ---------- header mapping ----------

def map_headers(t: TableDef, header: list[str]):
    # derived columns are computed after the import, never read from the file
    cols = [c for c in columns(t.name) if c.name not in SYSTEM_COLS and c.name not in t.derived]
    by_label = {c.label: c for c in cols}
    by_name = {c.name: c for c in cols}
    mapping = []  # (index, header, Column | None)
    used = set()
    for i, h in enumerate(header):
        if not h:
            continue
        col = by_label.get(h) or by_name.get(h) or by_name.get(t.header_aliases.get(h, ""))
        if col and col.name in used:
            col = None  # duplicate header: keep the first one
        if col:
            used.add(col.name)
        mapping.append((i, h, col))
    missing = [c for c in cols if c.name not in used]
    return mapping, missing


def guess_table(header: list[str], filename: str) -> str | None:
    best, best_score = None, (0.0, 0.0)
    # Tables named in the file name, e.g. 「后手绩效汇总（公开）20261014.xlsx」: these win over a better
    # header match, since tables can share most headers (后手绩效汇总 and its 公开 version).
    named, named_len = None, 0
    hs = {h for h in header if h}
    for t in TABLES.values():
        if not t.importable:
            continue
        mapping, missing = map_headers(t, header)
        matched = sum(1 for _, _, c in mapping if c)
        score = matched / max(len(hs), 1)
        comment = table_comment(t.name)
        if comment and comment in filename and score >= 0.5 and len(comment) > named_len:
            named, named_len = t.name, len(comment)  # the most specific name
        # Several tables may match the header equally well (a key column + its label): take the
        # one the file covers most completely.
        coverage = matched / max(matched + len(missing), 1)
        if (score, coverage) > best_score:
            best, best_score = t.name, (score, coverage)
    if named:
        return named
    return best if best_score[0] >= 0.5 else None


# ---------- value conversion ----------

_DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M")
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d") + _DATETIME_FORMATS


def to_date(v) -> dt.date | None:
    if _is_blank(v):
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if 20000 <= v <= 80000:  # Excel serial day number
            return EXCEL_EPOCH + dt.timedelta(days=int(v))
        if 19000101 <= v <= 29991231 and float(v).is_integer():
            return dt.datetime.strptime(str(int(v)), "%Y%m%d").date()
        raise ValueError("无法识别的日期数字")
    s = str(v).strip()
    if re.fullmatch(r"\d{5}", s):
        return to_date(int(s))
    for f in _DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            pass
    raise ValueError("无法识别的日期")


def to_datetime(v) -> dt.datetime | None:
    """Keeps the time of text like 「2026/10/24 10:34」; a bare date is midnight."""
    if isinstance(v, dt.datetime):
        return v
    if isinstance(v, str):
        for f in _DATETIME_FORMATS:
            try:
                return dt.datetime.strptime(v.strip(), f)
            except ValueError:
                pass
    d = to_date(v)
    return None if d is None else dt.datetime.combine(d, dt.time())


def filename_date(filename: str) -> dt.date | None:
    """The first valid YYYYMMDD in a file name, e.g. 「后手绩效汇总（公开）20261014.xlsx」."""
    for s in re.findall(r"(?<!\d)(\d{8})(?!\d)", filename):
        try:
            return dt.datetime.strptime(s, "%Y%m%d").date()
        except ValueError:
            continue
    return None


def _to_decimal(v) -> Decimal:
    if isinstance(v, bool):
        raise ValueError("不是数字")
    if isinstance(v, (int, float)):
        return Decimal(str(v))
    s = str(v).strip().replace(",", "")
    try:
        return Decimal(s)
    except InvalidOperation:
        raise ValueError("不是数字")


@dataclass
class Converter:
    col: Column
    date_is_text: bool = False
    rule: ValueRule | None = None
    rounded: int = 0  # non-integers rounded into an INT column
    rewritten: int = 0  # values changed by the rule
    max_len: int | None = None
    precision: tuple[int, int] | None = None

    def __post_init__(self):
        m = re.search(r"\((\d+)(?:,(\d+))?\)", self.col.column_type)
        if self.col.data_type in ("varchar", "char") and m:
            self.max_len = int(m.group(1))
        if self.col.data_type == "decimal" and m:
            self.precision = (int(m.group(1)), int(m.group(2) or 0))

    def __call__(self, v):
        t = self.col.data_type
        if _is_blank(v):
            return None
        if t == "date" or self.date_is_text:
            d = to_date(v)
            return d.isoformat() if self.date_is_text else d
        if t in ("int", "bigint", "smallint", "tinyint", "mediumint"):
            d = _to_decimal(v)
            if d != d.to_integral_value():
                self.rounded += 1
            return int(d.to_integral_value())
        if t == "decimal":
            d = _to_decimal(v)
            if self.precision:
                p, s = self.precision
                if abs(d) >= Decimal(10) ** (p - s):
                    raise ValueError(f"超出 decimal({p},{s}) 范围")
            return d
        if t in ("datetime", "timestamp"):
            return to_datetime(v)
        # text types
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        s = str(v).strip()
        if self.rule:
            cleaned = self.rule.apply(s)
            if cleaned != s:
                self.rewritten += 1
                s = cleaned
        if self.max_len is not None and len(s) > self.max_len:
            raise ValueError(f"长度 {len(s)} 超过 {self.max_len}")
        return s


# ---------- plan / preview ----------

@dataclass
class Plan:
    table: str
    header: list[str]
    mapping: list
    missing: list[Column]
    rows: list[list] = field(default_factory=list)
    dates: dict = field(default_factory=dict)  # date -> row count in file
    skipped_blank: int = 0
    errors: list[dict] = field(default_factory=list)
    error_count: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def target_cols(self) -> list[str]:
        return [c.name for _, _, c in self.mapping if c]


def build_plan(table: str, path: Path, filename: str = "") -> Plan:
    t = TABLES[table]
    header, data = split_header(read_rows(path))
    mapping, missing = map_headers(t, header)
    plan = Plan(table, header, mapping, missing)
    active = [
        (i, h, c, Converter(c, date_is_text=(c.name == t.date_col and t.date_is_text), rule=t.value_rules.get(c.name)))
        for i, h, c in mapping
        if c
    ]
    if not active:
        raise ImportFailed("文件表头和这张表的字段一个都对不上，请确认选择的表")
    date_idx = next((k for k, (_, _, c, _) in enumerate(active) if c.name == t.date_col), None)
    file_date = None
    if t.date_col and date_idx is None:
        if t.date_from_filename:
            d = filename_date(filename)
            if d is None:
                raise ImportFailed(f"文件里没有日期列「{columns_label(t, t.date_col)}」，文件名里也没有日期（如 20261014）")
            named = d
            d += dt.timedelta(days=t.filename_date_offset)
            file_date = d.isoformat() if t.date_is_text else d
            # the date becomes the last target column of every row
            col = next(c for c in plan.missing if c.name == t.date_col)
            plan.missing.remove(col)
            plan.mapping.append((None, "（文件名中的日期）", col))
            shift = f"（文件名 {named:%Y%m%d} {t.filename_date_offset:+d} 天）" if t.filename_date_offset else ""
            plan.warnings.append(f"文件里没有日期列，日期取自文件名：{d.isoformat()}{shift}")
        else:
            plan.warnings.append(f"文件里没有日期列「{columns_label(t, t.date_col)}」，无法按日期覆盖")
    # Computed columns, after the file-name date: (source index in active, target converter, separator).
    split_sums = []
    for name, s in t.split_sums.items():
        col = next((c for c in plan.missing if c.name == name), None)
        if col is None:
            continue  # the file has the column itself
        plan.missing.remove(col)
        src = next((k for k, (_, _, c, _) in enumerate(active) if c.name == s.of), None)
        plan.mapping.append((None, f"（{columns_label(t, s.of)}按「{s.sep}」拆开相加）", col))
        if src is None:
            plan.warnings.append(f"文件里没有「{columns_label(t, s.of)}」列，「{col.label}」将为空")
        split_sums.append((src, Converter(col), s.sep))

    for line, raw in data:
        values = [raw[i] if i < len(raw) else None for i, *_ in active]
        if all(_is_blank(v) for v in values):
            plan.skipped_blank += 1
            continue
        out, bad = [], False
        for (i, h, c, conv), v in zip(active, values):
            try:
                out.append(conv(v))
            except ValueError as e:
                bad = True
                plan.error_count += 1
                if len(plan.errors) < MAX_ISSUES:
                    plan.errors.append({"row": line, "column": h, "value": str(v), "message": str(e)})
                out.append(None)
        if date_idx is not None and not bad:
            d = out[date_idx]
            if d is None:
                plan.error_count += 1
                if len(plan.errors) < MAX_ISSUES:
                    plan.errors.append({"row": line, "column": active[date_idx][1], "value": "", "message": "日期为空"})
            else:
                key = d if isinstance(d, str) else d.isoformat()
                plan.dates[key] = plan.dates.get(key, 0) + 1
        if file_date is not None:
            out.append(file_date)
        for src, conv, sep in split_sums:
            v = None if src is None else out[src]
            parts = [p for p in str(v).split(sep) if p.strip()] if v is not None else []
            try:
                out.append(conv(sum(_to_decimal(p) for p in parts)) if parts else None)
            except ValueError as e:
                plan.error_count += 1
                if len(plan.errors) < MAX_ISSUES:
                    plan.errors.append({"row": line, "column": active[src][1], "value": str(v), "message": f"拆开相加：{e}"})
                out.append(None)
        plan.rows.append(out)

    if file_date is not None and plan.rows:
        key = file_date if isinstance(file_date, str) else file_date.isoformat()
        plan.dates[key] = len(plan.rows)

    for _, h, c, conv in active:
        if conv.rounded:
            plan.warnings.append(f"「{h}」有 {conv.rounded} 个非整数值，写入整数字段 {c.name}（{c.column_type}）时会被四舍五入")
        if conv.rewritten:
            plan.warnings.append(f"「{h}」有 {conv.rewritten} 个值已自动清洗：{conv.rule.description}")
    for c in missing:
        plan.warnings.append(f"文件里没有「{c.label}」列，字段 {c.name} 将为空")
    ignored = [h for _, h, c in mapping if not c]
    if ignored:
        plan.warnings.append("以下列在表里没有对应字段，将被忽略：" + "、".join(ignored))
    return plan


def columns_label(t: TableDef, name: str) -> str:
    return next((c.label for c in columns(t.name) if c.name == name), name)


def modes_for(t: TableDef) -> list[str]:
    return ["replace_dates", "append"] if t.date_col else ["replace_all", "append"]


def existing_counts(t: TableDef, dates: list[str], conn) -> dict:
    with conn.cursor() as cur:
        cur.execute(f"select count(*) from `{t.name}`")
        total = cur.fetchone()[0]
        affected = 0
        if t.date_col and dates:
            ph = ",".join(["%s"] * len(dates))
            cur.execute(f"select count(*) from `{t.name}` where `{t.date_col}` in ({ph})", dates)
            affected = cur.fetchone()[0]
    return {"total": total, "same_dates": affected}


def preview(table: str, path: Path, filename: str = "") -> dict:
    t = TABLES[table]
    plan = build_plan(table, path, filename)
    with connect() as conn:
        existing = existing_counts(t, sorted(plan.dates), conn)
    labels = {c.name: c.label for c in columns(t.name)}
    return {
        "table": table,
        "table_label": table_comment(table),
        "date_col": t.date_col,
        "modes": modes_for(t),
        "mapping": [
            {"header": h, "column": c.name if c else None, "label": c.label if c else None, "type": c.column_type if c else None}
            for _, h, c in plan.mapping
        ],
        "missing": [{"column": c.name, "label": c.label} for c in plan.missing],
        "row_count": len(plan.rows),
        "skipped_blank": plan.skipped_blank,
        "dates": [{"date": d, "rows": n} for d, n in sorted(plan.dates.items())],
        "existing": existing,
        "errors": plan.errors,
        "error_count": plan.error_count,
        "warnings": plan.warnings,
        "sample": {
            "columns": plan.target_cols,
            "labels": [labels[c] for c in plan.target_cols],
            "rows": [[_jsonable(v) for v in r] for r in plan.rows[:SAMPLE_ROWS]],
        },
    }


def _jsonable(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


# ---------- commit ----------

def commit(table: str, path: Path, mode: str, filename: str = "") -> dict:
    t = TABLES[table]
    if mode not in modes_for(t):
        raise ImportFailed(f"这张表不支持导入方式 {mode}")
    plan = build_plan(table, path, filename)
    if plan.error_count:
        raise ImportFailed(f"文件里还有 {plan.error_count} 处数据错误，修正后再导入")
    if not plan.rows:
        raise ImportFailed("没有可导入的数据行")
    if mode == "replace_dates" and not plan.dates:
        raise ImportFailed("文件里没有日期，无法按日期覆盖")

    cols = plan.target_cols
    sql = f"insert into `{t.name}` ({', '.join(f'`{c}`' for c in cols)}) values ({', '.join(['%s'] * len(cols))})"
    deleted = 0
    with connect(autocommit=False) as conn:
        try:
            with conn.cursor() as cur:
                if mode == "replace_dates":
                    dates = sorted(plan.dates)
                    ph = ",".join(["%s"] * len(dates))
                    deleted = cur.execute(f"delete from `{t.name}` where `{t.date_col}` in ({ph})", dates)
                elif mode == "replace_all":
                    deleted = cur.execute(f"delete from `{t.name}`")
                for i in range(0, len(plan.rows), INSERT_BATCH):
                    cur.executemany(sql, plan.rows[i : i + INSERT_BATCH])
                # Same transaction: derived columns and summaries never disagree with the detail rows.
                written = None if mode == "replace_all" else sorted(plan.dates)
                recomputed = derived.refresh(cur, t.name, written)
                summarized = summaries.refresh(cur, t.name, written)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {
        "deleted": deleted,
        "inserted": len(plan.rows),
        "dates": sorted(plan.dates),
        "derived": recomputed,
        "summaries": summarized,
        "warnings": plan.warnings,
    }
