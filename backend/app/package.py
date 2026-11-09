"""The business package of this deployment: everything the platform shows that is specific to
one customer's business — tables and their import rules, summary tables, reports (SQL and
summary reports), column formats, branding and the AI 问数 knowledge.

A package is a directory (BI_PACKAGE_DIR) holding package.yaml plus the files it references
(sql/, schema/, knowledge.md). The platform code knows nothing about the business; swapping
the package swaps the product. Loading validates every key so a typo fails at startup.
"""
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

from . import config


class PackageError(Exception):
    pass


# ---------------------------------------------------------------- import rules


@dataclass(frozen=True)
class ValueRule:
    """A cleanup applied to a text column's values on import."""

    description: str
    apply: Callable[[str], str]


def strip_suffixes(*suffixes: str) -> Callable[[str], str]:
    """Remove the first matching suffix (list longer suffixes first)."""

    def fn(s: str) -> str:
        for suf in suffixes:
            if s.endswith(suf):
                # A value that is only the suffix is left as-is rather than emptied.
                return s[: -len(suf)] if len(s) > len(suf) else s
        return s

    return fn


def ensure_suffix(suffix: str) -> Callable[[str], str]:
    return lambda s: s if s.endswith(suffix) else s + suffix


def rename(mapping: dict[str, str]) -> Callable[[str], str]:
    return lambda s: mapping.get(s, s)


def chain(*fns: Callable[[str], str]) -> Callable[[str], str]:
    def fn(s: str) -> str:
        for f in fns:
            s = f(s)
        return s

    return fn


@dataclass(frozen=True)
class Group:
    """A section of the menu and of the 数据表 page (e.g. one client's reports and tables)."""

    id: str
    title: str


@dataclass(frozen=True)
class SplitSum:
    """A column computed on import: the `sep`-separated numbers of column `of` added up."""

    of: str
    sep: str


@dataclass(frozen=True)
class Derived:
    """A column worked out by SQL after every write: `sql` is an expression over the table's row (alias src)."""

    sql: str
    # Tables the expression reads: a write to one of them recomputes every row.
    depends_on: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Editable:
    """Single rows may be added, changed and deleted on the page."""

    keys: tuple[str, ...]  # identify a row: no two rows share them (NULL counts as a value)
    required: tuple[str, ...]  # must not be empty (default: the keys)


@dataclass(frozen=True)
class TableDef:
    name: str
    date_col: str | None  # partition column; None = no date (full-replace table)
    # Excel header -> column, for headers that differ from the column comment.
    header_aliases: dict[str, str] = field(default_factory=dict)
    # Date stored as VARCHAR; normalised to YYYY-MM-DD text on import.
    date_is_text: bool = False
    # Files without a date column carry the date in their name (e.g. 「…20261014.xlsx」).
    date_from_filename: bool = False
    # Days added to the file name's date (-1: 「…20261107.csv」 holds 2026-11-06).
    filename_date_offset: int = 0
    # Columns not in the file, computed on import (e.g. splitting 「12.5|88.0」 into two sums).
    split_sums: dict[str, SplitSum] = field(default_factory=dict)
    # Columns recomputed by SQL after imports and edits (e.g. a flag from another table, a batch no.).
    derived: dict[str, Derived] = field(default_factory=dict)
    # column -> cleanup rule applied to every imported value.
    value_rules: dict[str, ValueRule] = field(default_factory=dict)
    # Summary tables are generated from this detail table on import (summaries.py), never imported.
    derived_from: str | None = None
    # Rows editable on the 数据表 page: None = not editable.
    editable: Editable | None = None
    group: str = ""  # Group.id: the section of the 数据表 page it is listed in

    @property
    def importable(self) -> bool:
        return self.derived_from is None


@dataclass(frozen=True)
class Summary:
    """A table rebuilt from `source` per date: group by `keys`, count(*) into `count_as`, sum `sums`."""

    table: str
    source: str
    date_col: str
    keys: list[str]
    count_as: str
    sums: list[str]
    # key -> SQL expression computing it from the detail row (alias src) instead of copying the column
    computed: dict[str, str] = field(default_factory=dict)
    # tables the expressions read by month: importing them rebuilds the summary for those months
    depends_on: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- reports


@dataclass(frozen=True)
class Ratio:
    """How a rate column is recomputed for a total: sum(num) / sum(den) (- 1)."""

    num: str
    den: str
    minus_one: bool = False


@dataclass(frozen=True)
class Benchmark:
    """A reference rate (e.g. 大区平均达成率) and the 是/否 flag comparing `rate` with it.

    In summary rows the reference is shown only when every row shares the same value,
    and the flag is recomputed from the summary row's `rate`.
    """

    avg: str
    flag: str
    rate: str


@dataclass(frozen=True)
class Trend:
    """月度趋势: the report's daily snapshots of one month, totalled per day.

    The amounts are month-to-date, so 当日新增 is the difference between consecutive
    snapshots of `recovered`.
    """

    recovered: str  # 累计额（如销售额）
    timeline_target: str  # where recovery should be by that day
    full_target: str  # 100%目标
    last_period: str  # 上月同期 at the same day of last month
    rates: list[str]  # attainment rates, charted together
    kpis: list[str]  # cards for the latest day of the month
    table: list[str]  # columns of the per-day table; "当日新增" is the derived increment


@dataclass(frozen=True)
class Pivot:
    """A summary table of the report rows by `keys`; the first `merge` keys form merged groups with a 小计 row."""

    title: str
    keys: list[str]
    merge: int = 0
    hide: list[str] = field(default_factory=list)  # report columns this table leaves out


@dataclass(frozen=True)
class ChartMetric:
    col: str
    label: str  # panel title; default: the column name


@dataclass(frozen=True)
class Chart:
    """Charts of the selected day above the tables: a horizontal bar chart per metric, two per row.

    Every panel lists the groups in the same order (by the first metric). `by` (SQL reports): the first
    of these dimensions that still has several values under the page's filters, e.g. 品类大类, or 品类
    once a single 品类大类 is selected. Summary tables chart their own groups.
    """

    title: str
    metrics: list[ChartMetric]
    by: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GapMetric:
    col: str  # distance from the end of the value bar, e.g. 距离前一名差距
    label: str
    name: str | None = None  # column naming whom the distance is to, e.g. the next rank up


@dataclass(frozen=True)
class GapChart:
    """A horizontal bar per row: `value`, then the distances to the ones ahead stacked after it (each gap
    measured from the end of the value, increasing), so one bar shows where we are and how far the next are."""

    value: ChartMetric
    gaps: list[GapMetric]


@dataclass(frozen=True)
class SplitTable:
    """One titled table of an SQL report's rows, showing these columns (label: the header shown)."""

    title: str
    columns: list[ChartMetric]
    chart: GapChart | None = None
    filter: dict[str, list[str | None]] = field(default_factory=dict)  # only rows with these values, e.g. 门店: [东区-繁华店]
    totals: bool = True  # a 合计 row (off where adding rows up means nothing, e.g. one row per vendor)
    highlight: dict[str, list[str | None]] = field(default_factory=dict)  # rows shown emphasized, e.g. 门店: [东区-繁华店]
    # Columns shown as merged cells: neighbouring rows with the same values in all of them form a group
    # (e.g. 1手 · 东北) and each column is one cell per group; a merged table cannot be sorted by its headers.
    merge: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ChoiceOption:
    label: str
    filter: dict[str, list[str | None]] = field(default_factory=dict)  # rows kept; empty keeps all


@dataclass(frozen=True)
class Choice:
    """A single-select filter: each option keeps the rows matching its own filter; the first is the default."""

    title: str
    options: list[ChoiceOption]


@dataclass(frozen=True)
class Report:
    """A report backed by one SQL statement (type: sql)."""

    id: str
    title: str
    description: str
    sql_file: str
    dates_sql: str
    dims: list[str]
    # Rate columns whose totals are recomputed from summed amounts (never by adding rates).
    ratios: dict[str, Ratio] = field(default_factory=dict)
    # Columns shown as headline cards above the table.
    kpis: list[str] = field(default_factory=list)
    # Dimension for the grouped statistics table under the main table.
    group_by: str | None = None
    # Dimension counted as a column in that grouped table (e.g. 品类 → 「品类数」); None = no such column.
    stage_dim: str | None = None
    # Dimension values selected when the page opens (the user can clear them); None selects（空）.
    default_filters: dict[str, list[str | None]] = field(default_factory=dict)
    # Single-select filters shown after the dimension filters (e.g. 只看未达成 / 全部).
    choices: list[Choice] = field(default_factory=list)
    # Columns the SQL returns (KPI cards may use them) but the tables and CSV do not show.
    hidden: list[str] = field(default_factory=list)
    # Summary tables shown above the detail rows (the detail table is then collapsed).
    pivots: list[Pivot] = field(default_factory=list)
    # Column switches: each prefix is a group the user can show or hide; columns
    # without any of these prefixes form the first group (named by `base_group`).
    column_groups: list[str] = field(default_factory=list)
    base_group: str = ""
    benchmarks: list[Benchmark] = field(default_factory=list)
    trend: Trend | None = None
    charts: list[Chart] = field(default_factory=list)
    # Instead of one detail table: these tables, each with its own columns (e.g. 全量排名 and A类排名).
    tables: list[SplitTable] = field(default_factory=list)
    group: str = ""  # Group.id: the menu section it is listed in
    type: str = "sql"

    @property
    def sql(self) -> str:
        return (config.PACKAGE_DIR / self.sql_file).read_text(encoding="utf-8").strip().rstrip(";")


@dataclass(frozen=True)
class SummaryColumn:
    """One column of a summary table: sum of a source column, a ratio, or a difference.

    `ratio` and `diff` only count rows where both source columns have values (e.g. a 达成率
    leaves out the rows without a target). `{day}` in the name is the selected date's day.
    """

    name: str
    sum: str | None = None
    ratio: list[str] | None = None
    diff: list[str] | None = None
    format: str | None = None  # default: the source column's format (pct for ratios)


@dataclass(frozen=True)
class SummaryTable:
    title: str
    group_by: str
    columns: list[SummaryColumn]
    filter: dict[str, list[str | None]] = field(default_factory=dict)
    sort: str | None = None
    hide_empty: str | None = None  # drop groups where this column is 0 or empty
    chart: Chart | None = None


@dataclass(frozen=True)
class SummaryReport:
    """Tables summarized in the browser from another report's rows (type: summary)."""

    id: str
    title: str
    description: str
    source: str
    tables: list[SummaryTable]
    note: str = ""
    group: str = ""
    type: str = "summary"


@dataclass(frozen=True)
class FormatRule:
    format: str
    equals: list[str] = field(default_factory=list)
    contains: list[str] = field(default_factory=list)
    ends_with: list[str] = field(default_factory=list)

    def matches(self, name: str) -> bool:
        return name in self.equals or any(w in name for w in self.contains) or any(name.endswith(w) for w in self.ends_with)


@dataclass(frozen=True)
class Package:
    name: str
    title: str
    subtitle: str
    groups: list[Group]  # menu and 数据表 page sections, in order
    tables: dict[str, TableDef]
    summaries: dict[str, Summary]  # by source table
    reports: dict[str, Report | SummaryReport]  # menu order
    format_rules: list[FormatRule]
    knowledge: str
    chat_style: str  # default role and answer style of AI 问数 (admins can override it on the page)
    # Columns the read-only account (AI SQL, agent API) must never read, by table — e.g. account numbers.
    hidden_columns: dict[str, list[str]]
    chat_examples: dict[str, list[str]]
    dir: Path

    @property
    def sql_reports(self) -> dict[str, Report]:
        return {k: r for k, r in self.reports.items() if isinstance(r, Report)}

    def column_format(self, name: str) -> str:
        """pct | amount | count | text — by the package's naming rules for report columns."""
        for rule in self.format_rules:
            if rule.matches(name):
                return rule.format
        return "text"


# ---------------------------------------------------------------- loading

FORMATS = {"amount", "pct", "count", "text"}


def _keys(where: str, d: dict, required: set[str], optional: set[str] = frozenset()) -> dict:
    if not isinstance(d, dict):
        raise PackageError(f"{where}：应为对象")
    missing = required - d.keys()
    unknown = d.keys() - required - optional
    if missing:
        raise PackageError(f"{where}：缺少 {', '.join(sorted(missing))}")
    if unknown:
        raise PackageError(f"{where}：不认识的字段 {', '.join(sorted(unknown))}")
    return d


def _rule(where: str, d: dict) -> ValueRule:
    _keys(where, d, {"description", "steps"})
    fns = []
    for i, step in enumerate(d["steps"]):
        _keys(f"{where}.steps[{i}]", step, set(), {"rename", "strip_suffixes", "ensure_suffix"})
        if len(step) != 1:
            raise PackageError(f"{where}.steps[{i}]：每一步只能有一种操作")
        (op, arg), = step.items()
        fns.append({"rename": lambda a: rename({str(k): str(v) for k, v in a.items()}),
                    "strip_suffixes": lambda a: strip_suffixes(*a),
                    "ensure_suffix": ensure_suffix}[op](arg))
    return ValueRule(d["description"], fns[0] if len(fns) == 1 else chain(*fns))


def _ratio(where: str, v) -> Ratio:
    if isinstance(v, list) and len(v) == 2:
        return Ratio(str(v[0]), str(v[1]))
    _keys(where, v, {"num", "den"}, {"minus_one"})
    return Ratio(str(v["num"]), str(v["den"]), bool(v.get("minus_one", False)))


def _pair(where: str, v) -> list[str]:
    if not (isinstance(v, list) and len(v) == 2):
        raise PackageError(f"{where}：应为 [列, 列]")
    return [str(x) for x in v]


def _labelled(where: str, items: list) -> list[ChartMetric]:
    """Columns written as a name or {col: name, label: shown name}."""
    out = []
    for i, m in enumerate(items or []):
        if isinstance(m, str):
            out.append(ChartMetric(m, m))
        else:
            _keys(f"{where}[{i}]", m, {"col"}, {"label"})
            out.append(ChartMetric(str(m["col"]), str(m.get("label") or m["col"])))
    return out


def _chart(where: str, d: dict, need_by: bool) -> Chart:
    _keys(where, d, {"title", "metrics"} | ({"by"} if need_by else set()))
    metrics = _labelled(f"{where}.metrics", d["metrics"])
    if not metrics:
        raise PackageError(f"{where}.metrics：至少一个指标")
    by = d.get("by") or []
    return Chart(title=str(d["title"]), metrics=metrics, by=[str(x) for x in ([by] if isinstance(by, str) else by)])


def _values(d: dict | None) -> dict[str, list[str | None]]:
    """{column: [values]} as strings (None stays None, for empty cells)."""
    return {str(k): [None if x is None else str(x) for x in v] for k, v in (d or {}).items()}


def _split_table(where: str, d: dict) -> SplitTable:
    _keys(where, d, {"title", "columns"}, {"chart", "filter", "totals", "highlight", "merge", "hidden"})
    columns = _labelled(f"{where}.columns", d["columns"])
    if not columns:
        raise PackageError(f"{where}.columns：至少一列")
    merge = [str(x) for x in d.get("merge") or []]
    if unknown := [m for m in merge if m not in {c.col for c in columns}]:
        raise PackageError(f"{where}.merge：{'、'.join(unknown)} 不在 columns 里")
    chart = None
    if d.get("chart"):
        c = _keys(f"{where}.chart", d["chart"], {"value", "gaps"})
        gaps = []
        for i, g in enumerate(c["gaps"] or []):
            _keys(f"{where}.chart.gaps[{i}]", g, {"col"}, {"label", "name"})
            gaps.append(GapMetric(str(g["col"]), str(g.get("label") or g["col"]), str(g["name"]) if g.get("name") else None))
        chart = GapChart(value=_labelled(f"{where}.chart.value", [c["value"]])[0], gaps=gaps)
    return SplitTable(
        title=str(d["title"]),
        columns=columns,
        chart=chart,
        filter=_values(d.get("filter")),
        totals=bool(d.get("totals", True)),
        highlight=_values(d.get("highlight")),
        merge=merge,
    )


def _choice(where: str, d: dict) -> Choice:
    _keys(where, d, {"title", "options"})
    options = []
    for i, o in enumerate(d["options"] or []):
        _keys(f"{where}.options[{i}]", o, {"label"}, {"filter"})
        options.append(ChoiceOption(label=str(o["label"]), filter=_values(o.get("filter"))))
    if len(options) < 2:
        raise PackageError(f"{where}.options：至少两个选项")
    return Choice(title=str(d["title"]), options=options)


def _sql_report(where: str, d: dict, pkg_dir: Path) -> Report:
    _keys(
        where, d, {"id", "title", "sql", "dates_sql", "dims"},
        {"type", "description", "ratios", "kpis", "group_by", "stage_dim", "default_filters", "hidden", "pivots",
         "column_groups", "base_group", "benchmarks", "trend", "charts", "tables", "choices", "group"},
    )
    if not (pkg_dir / d["sql"]).is_file():
        raise PackageError(f"{where}：找不到 SQL 文件 {d['sql']}")
    trend = None
    if d.get("trend"):
        t = _keys(f"{where}.trend", d["trend"], {"recovered", "timeline_target", "full_target", "last_period", "rates", "kpis", "table"})
        trend = Trend(**{k: t[k] for k in t})
    return Report(
        id=str(d["id"]),
        title=str(d["title"]),
        description=str(d.get("description", "")),
        sql_file=str(d["sql"]),
        dates_sql=str(d["dates_sql"]),
        dims=[str(x) for x in d["dims"]],
        ratios={str(k): _ratio(f"{where}.ratios.{k}", v) for k, v in (d.get("ratios") or {}).items()},
        kpis=[str(x) for x in d.get("kpis") or []],
        group_by=d.get("group_by"),
        stage_dim=d.get("stage_dim"),
        default_filters={
            str(k): [None if x is None else str(x) for x in v] for k, v in (d.get("default_filters") or {}).items()
        },
        choices=[_choice(f"{where}.choices[{i}]", c) for i, c in enumerate(d.get("choices") or [])],
        hidden=[str(x) for x in d.get("hidden") or []],
        pivots=[
            Pivot(**_keys(f"{where}.pivots[{i}]", p, {"title", "keys"}, {"merge", "hide"}))
            for i, p in enumerate(d.get("pivots") or [])
        ],
        column_groups=[str(x) for x in d.get("column_groups") or []],
        base_group=str(d.get("base_group", "")),
        benchmarks=[
            Benchmark(**_keys(f"{where}.benchmarks[{i}]", b, {"avg", "flag", "rate"}))
            for i, b in enumerate(d.get("benchmarks") or [])
        ],
        trend=trend,
        charts=[_chart(f"{where}.charts[{i}]", c, True) for i, c in enumerate(d.get("charts") or [])],
        # hidden: true keeps a table's definition but leaves it off the page for now
        tables=[_split_table(f"{where}.tables[{i}]", t) for i, t in enumerate(d.get("tables") or []) if not t.get("hidden")],
    )


def _summary_report(where: str, d: dict) -> SummaryReport:
    _keys(where, d, {"id", "type", "title", "source", "tables"}, {"description", "note", "group"})
    tables = []
    for i, t in enumerate(d["tables"]):
        tw = f"{where}.tables[{i}]"
        _keys(tw, t, {"title", "group_by", "columns"}, {"filter", "sort", "hide_empty", "chart"})
        cols = []
        for j, c in enumerate(t["columns"]):
            cw = f"{tw}.columns[{j}]"
            _keys(cw, c, {"name"}, {"sum", "ratio", "diff", "format"})
            kinds = [k for k in ("sum", "ratio", "diff") if k in c]
            if len(kinds) != 1:
                raise PackageError(f"{cw}：sum / ratio / diff 必须且只能有一个")
            if c.get("format") and c["format"] not in FORMATS:
                raise PackageError(f"{cw}：format 只能是 {', '.join(sorted(FORMATS))}")
            cols.append(
                SummaryColumn(
                    name=str(c["name"]),
                    sum=str(c["sum"]) if "sum" in c else None,
                    ratio=_pair(f"{cw}.ratio", c["ratio"]) if "ratio" in c else None,
                    diff=_pair(f"{cw}.diff", c["diff"]) if "diff" in c else None,
                    format=c.get("format"),
                )
            )
        tables.append(
            SummaryTable(
                title=str(t["title"]),
                group_by=str(t["group_by"]),
                columns=cols,
                filter={str(k): [None if x is None else str(x) for x in v] for k, v in (t.get("filter") or {}).items()},
                sort=t.get("sort"),
                hide_empty=t.get("hide_empty"),
                chart=_chart(f"{tw}.chart", t["chart"], False) if t.get("chart") else None,
            )
        )
    return SummaryReport(
        id=str(d["id"]),
        title=str(d["title"]),
        description=str(d.get("description", "")),
        source=str(d["source"]),
        tables=tables,
        note=str(d.get("note", "")),
    )


def _editable(where: str, t: dict) -> Editable | None:
    e = t.get("editable")
    if e is None:
        return None
    _keys(where, e, {"keys"}, {"required"})
    if t.get("summary_of"):
        raise PackageError(f"{where}：汇总表不能在页面上编辑")
    keys = tuple(str(k) for k in e["keys"] or [])
    if not keys:
        raise PackageError(f"{where}.keys 至少一列")
    return Editable(keys=keys, required=tuple(str(k) for k in e.get("required", keys)))


def _derived(where: str, d: dict, pkg_dir: Path) -> Derived:
    _keys(where, d, {"sql"}, {"depends_on", "src"})
    if not (pkg_dir / d["sql"]).is_file():
        raise PackageError(f"{where}：找不到 SQL 文件 {d['sql']}")
    sql = (pkg_dir / d["sql"]).read_text(encoding="utf-8").strip().rstrip(";")
    if d.get("src"):
        # Another table's expression: its src columns made from this row (e.g. data_date ← the 还款日期).
        cols = ", ".join(f"{expr} as `{name}`" for name, expr in d["src"].items())
        sql = f"(select ({sql}\n) from (select {cols}) src)"
    return Derived(
        sql=sql,
        depends_on=[str(x) for x in d.get("depends_on") or []],
    )


def load(pkg_dir: Path) -> Package:
    path = pkg_dir / "package.yaml"
    if not path.is_file():
        raise PackageError(f"找不到业务包 {path}（BI_PACKAGE_DIR）")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    _keys("package.yaml", raw, {"name", "tables", "reports"},
          {"title", "subtitle", "groups", "summaries", "column_formats", "chat"})

    groups = []
    for i, g in enumerate(raw.get("groups") or [{"id": "default", "title": "报表"}]):
        _keys(f"groups[{i}]", g, {"id", "title"})
        groups.append(Group(id=str(g["id"]), title=str(g["title"])))
    if len({g.id for g in groups}) != len(groups):
        raise PackageError("groups：id 重复")

    def group_of(where: str, d: dict) -> str:
        """The entry's `group`; without one, the first group."""
        g = str(d.get("group") or groups[0].id)
        if g not in {x.id for x in groups}:
            raise PackageError(f"{where}：group {g} 不在 groups 里")
        return g

    tables: dict[str, TableDef] = {}
    for i, t in enumerate(raw["tables"]):
        where = f"tables[{i}]"
        _keys(where, t, {"name"},
              {"date_col", "date_is_text", "date_from_filename", "filename_date_offset", "split_sums", "derived",
               "header_aliases", "value_rules", "summary_of", "editable", "group"})
        tables[t["name"]] = TableDef(
            name=t["name"],
            date_col=t.get("date_col"),
            header_aliases={str(k): str(v) for k, v in (t.get("header_aliases") or {}).items()},
            date_is_text=bool(t.get("date_is_text", False)),
            date_from_filename=bool(t.get("date_from_filename", False)),
            filename_date_offset=int(t.get("filename_date_offset", 0)),
            split_sums={
                str(col): SplitSum(**_keys(f"{where}.split_sums.{col}", s, {"of", "sep"}))
                for col, s in (t.get("split_sums") or {}).items()
            },
            value_rules={str(col): _rule(f"{where}.value_rules.{col}", r) for col, r in (t.get("value_rules") or {}).items()},
            derived_from=t.get("summary_of"),
            editable=_editable(f"{where}.editable", t),
            group=group_of(where, t),
            derived={str(col): _derived(f"{where}.derived.{col}", d, pkg_dir) for col, d in (t.get("derived") or {}).items()},
        )
    for t in tables.values():
        for col, d in t.derived.items():
            for dep in d.depends_on:
                if dep not in tables:
                    raise PackageError(f"{t.name}.derived.{col}.depends_on：{dep} 不在 tables 里")

    summaries: dict[str, Summary] = {}
    for i, s in enumerate(raw.get("summaries") or []):
        where = f"summaries[{i}]"
        _keys(where, s, {"table", "source", "date_col", "keys", "count_as", "sums"}, {"computed", "depends_on"})
        computed = {}
        for k, f in (s.get("computed") or {}).items():
            if k not in s["keys"]:
                raise PackageError(f"{where}.computed：{k} 不在 keys 里")
            if not (pkg_dir / f).is_file():
                raise PackageError(f"{where}.computed.{k}：找不到 SQL 文件 {f}")
            computed[str(k)] = (pkg_dir / f).read_text(encoding="utf-8").strip().rstrip(";")
        summaries[s["source"]] = Summary(
            **{k: s[k] for k in ("table", "source", "date_col", "keys", "count_as", "sums")},
            computed=computed,
            depends_on=[str(t) for t in s.get("depends_on") or []],
        )

    reports: dict[str, Report | SummaryReport] = {}
    for i, r in enumerate(raw["reports"]):
        where = f"reports[{i}]（{r.get('id', '?')}）"
        kind = r.get("type", "sql")
        if kind == "sql":
            report = _sql_report(where, r, pkg_dir)
        elif kind == "summary":
            report = _summary_report(where, r)
        else:
            raise PackageError(f"{where}：type 只能是 sql 或 summary")
        report = replace(report, group=group_of(where, r))
        if report.id in reports:
            raise PackageError(f"{where}：报表 id 重复")
        reports[report.id] = report
    for r in reports.values():
        if isinstance(r, SummaryReport) and not isinstance(reports.get(r.source), Report):
            raise PackageError(f"汇总报表 {r.id} 的 source {r.source} 不是一张 SQL 报表")

    rules = []
    for i, f in enumerate(raw.get("column_formats") or []):
        _keys(f"column_formats[{i}]", f, {"format"}, {"equals", "contains", "ends_with"})
        if f["format"] not in FORMATS:
            raise PackageError(f"column_formats[{i}]：format 只能是 {', '.join(sorted(FORMATS))}")
        rules.append(FormatRule(**f))

    chat = _keys("chat", raw.get("chat") or {}, set(), {"knowledge", "style", "examples", "hidden_columns"})
    hidden = {str(t): [str(c) for c in cols] for t, cols in (chat.get("hidden_columns") or {}).items()}
    for t in hidden:
        if t not in tables:
            raise PackageError(f"chat.hidden_columns：{t} 不在 tables 里")

    def chat_file(key: str) -> str:
        if not chat.get(key):
            return ""
        path = pkg_dir / chat[key]
        if not path.is_file():
            raise PackageError(f"chat.{key}：找不到 {chat[key]}")
        return path.read_text(encoding="utf-8")

    return Package(
        name=str(raw["name"]),
        title=str(raw.get("title") or "BI 看板"),
        subtitle=str(raw.get("subtitle") or ""),
        groups=groups,
        tables=tables,
        summaries=summaries,
        reports=reports,
        format_rules=rules,
        knowledge=chat_file("knowledge"),
        chat_style=chat_file("style"),
        hidden_columns=hidden,
        chat_examples={str(k): [str(x) for x in v] for k, v in (chat.get("examples") or {}).items()},
        dir=pkg_dir,
    )


PACKAGE = load(config.PACKAGE_DIR)
