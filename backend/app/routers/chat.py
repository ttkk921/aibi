"""AI 问数 (/api/chat): a chat drawer that answers questions with the dashboard's own data.

The model (OpenAI-compatible chat completions, Command Code + DeepSeek by default) gets two
tools that reuse the read-only agent API in-process: `query_report` (the dashboard reports,
aggregated exactly like the 合计 rows) and `run_sql` (one SELECT as the SELECT-only account
without account_no). Each turn streams Server-Sent Events: text deltas, tool calls with their
results (shown to the user as tables), and, in confirm mode, a pause before any SQL runs.

Conversations live in memory (single user, single process); a page reload starts a new one. Every
question and what the user saw of its answer is also written to the history (chatlog) for admins.
"""
import asyncio
import json
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import date as Date

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import config
from ..auth import require_role, require_user
from ..users import User
from . import agent
from .. import ai_providers, chatlog, users
from .. import settings as app_settings
from ..package import PACKAGE
from .reports import REPORTS

router = APIRouter(prefix="/api/chat", tags=["chat"])
log = logging.getLogger("bi.chat")

KNOWLEDGE = PACKAGE.knowledge  # business 口径 of this deployment (package chat.knowledge)

MAX_STEPS = 8  # model calls per user message
MODEL_ATTEMPTS = 3  # tries of one model call when the connection drops
MODEL_ROWS = 60  # rows of a result the model sees
UI_ROWS = 500  # rows of a result sent to the browser
MAX_CONVERSATIONS = 30
CONVERSATION_TTL = 12 * 3600
HEARTBEAT_SECONDS = 15
PROMPT_TTL = 300

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_report",
            "description": (
                "查询看板报表（首选）：和看板同一套 SQL 与汇总口径，比率按 sum(分子)/sum(分母) 重算。"
                "group_by 为空返回报表明细行；结果里 total 是筛选后的合计。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "一句话说明查什么，会显示给用户"},
                    "report": {"type": "string", "enum": list(REPORTS)},
                    "date": {"type": "string", "description": "YYYY-MM-DD；不传取最新日期"},
                    "dates": {"type": "array", "items": {"type": "string"}, "description": "多个日期（看趋势）"},
                    "filters": {
                        "type": "object",
                        "additionalProperties": {"type": "array", "items": {"type": ["string", "null"]}},
                        "description": "维度 -> 取值列表，如 {\"品类大类\": [\"女装\"]}",
                    },
                    "group_by": {"type": "array", "items": {"type": "string"}, "description": "分组维度"},
                    "columns": {"type": "array", "items": {"type": "string"}, "description": "只返回这些指标列"},
                    "sort": {"type": "string", "description": "排序列，前缀 - 表示从大到小"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 500},
                },
                "required": ["title", "report"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_sql",
            "description": (
                "报表回答不了时，在 MySQL 8（库 bi_data）以只读账号执行一条 SELECT/WITH 查询，30 秒超时。"
                "明细表必须带 report_date 条件且不能 select *。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "一句话说明查什么，会显示给用户"},
                    "sql": {"type": "string"},
                },
                "required": ["title", "sql"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_chart",
            "description": (
                "把一次查询结果（result_id）画成图表给用户看。适合：3 个以上对象的比较（bar）、随日期的变化（line）、"
                "构成（stacked_bar；类别不超过 6 个时可用 pie）。只有 1-2 个数字时不要画图。"
                "series 里的列必须是同一种单位（都是金额，或都是比率），不同单位分成两张图。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "图表标题，说明画的是什么"},
                    "result_id": {"type": "string", "description": "查询结果编号，如 R1"},
                    "type": {"type": "string", "enum": ["bar", "line", "stacked_bar", "pie"]},
                    "x": {"type": "string", "description": "类别或日期所在的列名"},
                    "series": {"type": "array", "items": {"type": "string"}, "description": "要画的数值列（1-6 列）"},
                    "split_by": {
                        "type": "string",
                        "description": "按这一列的取值拆成多条系列（如按日期对比各品类）；此时 series 只能有一列，取值不超过 6 个",
                    },
                    "sort": {"type": "string", "enum": ["desc", "asc", "none"], "description": "按第一个数值列排序；默认 none"},
                    "horizontal": {"type": "boolean", "description": "横向柱状图（类别名长或类别多时更易读）"},
                    "emphasize": {
                        "type": "string",
                        "enum": ["positive", "negative"],
                        "description": "数值有正有负、问题只关心其中一侧时（如只关心还有缺口的项=正数），这一侧用主色，另一侧变灰；只用于单列 bar",
                    },
                    "value_format": {
                        "type": "string",
                        "enum": ["amount", "pct", "count"],
                        "description": "SQL 结果的数值格式（报表结果不用填）；pct 表示数值是比例（0.35 = 35%）",
                    },
                },
                "required": ["title", "result_id", "type", "x", "series"],
            },
        },
    },
]

CHART_TYPES = {"bar", "line", "stacked_bar", "pie"}
MAX_SERIES = 6  # the categorical palette has six validated slots
MAX_BARS = 30
MAX_POINTS = 200
MAX_PIE = 6
MAX_RESULTS = 30  # query results kept per conversation for charts


# ---------------------------------------------------------------- conversations


@dataclass
class Conversation:
    id: str
    messages: list[dict] = field(default_factory=list)
    # A run_sql call waiting for the user's approval: {"message": index, "call": index}.
    pending: dict | None = None
    # Query results the model can chart by id (R1, R2, ...): {"title", "columns", "rows"}.
    results: "OrderedDict[str, dict]" = field(default_factory=OrderedDict)
    next_result: int = 1
    # History row of the question being answered (an approval adds to it).
    log_id: int | None = None
    updated: float = field(default_factory=time.time)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_conversations: "OrderedDict[str, Conversation]" = OrderedDict()


def _get_conversation(cid: str | None) -> Conversation:
    now = time.time()
    for key in [k for k, c in _conversations.items() if now - c.updated > CONVERSATION_TTL]:
        _conversations.pop(key, None)
    if cid and cid in _conversations:
        conv = _conversations.pop(cid)
    else:
        conv = Conversation(uuid.uuid4().hex)
    _conversations[conv.id] = conv
    while len(_conversations) > MAX_CONVERSATIONS:
        _conversations.popitem(last=False)
    conv.updated = now
    return conv


def _repair(conv: Conversation):
    """Answer tool calls left without a result (an interrupted turn), or the next request would be rejected."""
    answered = {m.get("tool_call_id") for m in conv.messages if m["role"] == "tool"}
    pending_id = None
    if conv.pending:
        msg = conv.messages[conv.pending["message"]]
        pending_id = msg["tool_calls"][conv.pending["call"]]["id"]
    for i, m in enumerate(conv.messages):
        if m["role"] != "assistant" or not m.get("tool_calls"):
            continue
        missing = [c for c in m["tool_calls"] if c["id"] not in answered and c["id"] != pending_id]
        insert_at = i + 1
        while insert_at < len(conv.messages) and conv.messages[insert_at]["role"] == "tool":
            insert_at += 1
        for c in missing:
            conv.messages.insert(insert_at, {"role": "tool", "tool_call_id": c["id"], "content": "（未执行：对话被中断）"})
            insert_at += 1


# ---------------------------------------------------------------- prompt

# Role and answer style: edited by admins on the AI 设置 page, else the business package default.
STYLE_KEY = "chat_style"
FALLBACK_STYLE = "你是「BI 看板」里的 AI 问数助手。用中文回答：先给结论和关键数字，最后一行写数据来源和口径。"

# How the tools work. Fixed by the platform (not part of the editable style) so editing the style
# can never break querying or charting.
PLATFORM_RULES = """## 工具（系统功能，必须遵守）
- `query_report`：查看板报表，**首选**，数字和看板完全一致。
- `run_sql`：报表回答不了时（按导购、组别、城市、渠道等）自己写 SQL，MySQL 8，只读。
- 每次调用都填 `title`，一句话说明查什么，会显示给用户。
- 能并行的查询一起发出。SQL 报错时根据错误信息改正后重试，最多 3 次。
- 查询结果会以表格形式单独展示给用户，你只能看到前 60 行和总行数。每个结果有编号（result_id，如 R1）。
- `show_chart`：把某个结果画成图。对象比较（3 个以上）用 bar，日期走势用 line，构成用 stacked_bar 或类别很少时用 pie。
  用户要求画图时一定画；没要求时，比较或趋势类问题画一张最能说明结论的图即可，1-2 个数字不画。
  一张图只放同一种单位的列；画 SQL 结果时填 value_format（金额 amount、比例 pct、数量 count）；
  对比多个日期等「长表」结果时用 split_by 拆成多条系列。
  结果有正有负、问题只关心一侧时（例如“缺口最大”只关心正数），用 emphasize 突出那一侧，避免另一侧的长柱抢眼。
- 数字只能来自查询结果，不要编造；口径以后面的「BI 业务知识」为准。"""

_prompt_cache: dict = {"at": 0.0, "catalog": ""}


def current_style() -> str:
    saved = app_settings.get(STYLE_KEY)
    return saved["value"] if saved else (PACKAGE.chat_style or FALLBACK_STYLE)


def _catalog_text() -> str:
    cat = agent.catalog()
    lines = ["## 当前可查的数据", f"今天是 {Date.today().isoformat()}。", "", "### 报表（query_report 的 report）"]
    for r in cat["reports"]:
        cols = "、".join(c["name"] for c in r["columns"])
        rates = "、".join(c["name"] for c in r["columns"] if c["format"] == "pct")
        lines.append(f"- `{r['id']}` {r['title']}：维度 {'、'.join(r['dims'])}；可用日期 {'、'.join(r['dates'][:15]) or '无'}")
        lines.append(f"  指标列（columns 参数用这些名字，原样照写）：{cols}")
        lines.append(f"  其中比率列（结果是比例，0.35 = 35%）：{rates}")
    lines += ["", "### 数据表字段（run_sql 用；只读账号能看到的列）"]
    for t in cat["tables"]:
        cols = ", ".join(f"{c['name']}" + (f"({c['comment']})" if c["comment"] and c["comment"] != c["name"] else "") for c in t["columns"] if c["name"] not in ("id", "created_at"))
        lines.append(f"- `{t['name']}`（{t['comment']}）：{cols}")
    return "\n".join(lines)


def _system_prompt() -> str:
    """Style + platform rules + data catalog + business knowledge. The catalog (database reads) is
    cached for a few minutes; the style is read every time so a saved change applies to the next question."""
    now = time.time()
    if now - _prompt_cache["at"] > PROMPT_TTL:
        _prompt_cache["catalog"] = _catalog_text()
        _prompt_cache["at"] = now
    return "\n\n".join([current_style().strip(), PLATFORM_RULES, _prompt_cache["catalog"], KNOWLEDGE])


class PageContext(BaseModel):
    page: str | None = None
    report: str | None = None
    view: str | None = None
    date: str | None = None
    month: str | None = None
    filters: dict[str, list[str | None]] = Field(default_factory=dict)
    fields: list[str] = Field(default_factory=list)
    table: str | None = None


def _context_parts(ctx: PageContext | None) -> list[str]:
    if ctx is None or not ctx.page:
        return []
    parts = [f"用户当前在「{ctx.page}」页面"]
    if ctx.report:
        parts.append(f"报表 {ctx.report}")
    if ctx.view == "trend" and ctx.month:
        parts.append(f"月度趋势视图，月份 {ctx.month}")
    elif ctx.date:
        parts.append(f"日期 {ctx.date}")
    if ctx.table:
        parts.append(f"数据表 {ctx.table}")
    filters = [f"{k} = {'、'.join('（空）' if v is None else v for v in vs)}" for k, vs in ctx.filters.items() if vs]
    if filters:
        parts.append("筛选：" + "；".join(filters))
    if ctx.fields:
        parts.append("显示字段组：" + "、".join(ctx.fields))
    return parts


def _context_text(ctx: PageContext | None) -> str:
    parts = _context_parts(ctx)
    if not parts:
        return ""
    return "【页面上下文：" + "，".join(parts) + "。问题里说“这里”“当前”指的就是它；没提到的条件不要擅自加上。】\n\n"


# ---------------------------------------------------------------- tools


def _compact_rows(rows: list[list], limit: int) -> list[list]:
    def v(x):
        return round(x, 6) if isinstance(x, float) else x

    return [[v(x) for x in r] for r in rows[:limit]]


def _run_report(args: dict) -> tuple[dict, dict]:
    q = agent.ReportQuery(**{k: v for k, v in args.items() if k != "title" and v is not None})
    r = agent.report(q)
    ui = {
        "kind": "report",
        "title": args.get("title") or r["title"],
        "report": r["report"],
        "report_title": r["title"],
        "dates": r["dates"],
        "filters": r["filters"],
        "group_by": r["group_by"],
        "columns": r["columns"],
        "rows": r["rows"][:UI_ROWS],
        "row_count": r["row_count"],
        "total": r["total"],
    }
    model = {
        "report": r["title"],
        "dates": r["dates"],
        "filters": r["filters"],
        "group_by": r["group_by"],
        "columns": [c["name"] for c in r["columns"]],
        "rate_columns": [c["name"] for c in r["columns"] if c["format"] == "pct"],
        "rows": _compact_rows(r["rows"], MODEL_ROWS),
        "row_count": r["row_count"],
        "total": r["total"],
        "notes": r["notes"],
    }
    if r["row_count"] > MODEL_ROWS:
        model["note"] = f"共 {r['row_count']} 行，这里只给出前 {MODEL_ROWS} 行"
    return ui, model


def _run_sql(args: dict) -> tuple[dict, dict]:
    sql = args.get("sql") or ""
    r = agent.sql(agent.SqlQuery(sql=sql))
    count = len(r["rows"])
    ui = {
        "kind": "sql",
        "title": args.get("title") or "SQL 查询",
        "sql": sql,
        "columns": [{"name": c, "format": "raw"} for c in r["columns"]],
        "rows": r["rows"][:UI_ROWS],
        "row_count": count,
        "truncated": r["truncated"],
        "elapsed_ms": r["elapsed_ms"],
    }
    model = {"columns": r["columns"], "rows": _compact_rows(r["rows"], MODEL_ROWS), "row_count": count}
    if r["truncated"]:
        model["note"] = f"结果超过 {r['max_rows']} 行被截断，请加条件或聚合"
    elif count > MODEL_ROWS:
        model["note"] = f"共 {count} 行，这里只给出前 {MODEL_ROWS} 行"
    return ui, model


class ChartError(ValueError):
    pass


def _is_date(v) -> bool:
    return isinstance(v, str) and len(v) == 10 and v[4] == "-" and v[7] == "-"


def _build_chart(conv: Conversation, args: dict) -> tuple[dict, dict]:
    """Validate a show_chart request against a stored result and shape the points to draw."""
    rid = str(args.get("result_id") or "")
    r = conv.results.get(rid)
    if r is None:
        raise ChartError(f"没有结果 {rid}；可用的结果：{', '.join(conv.results) or '无'}")
    ctype = args.get("type")
    if ctype not in CHART_TYPES:
        raise ChartError(f"type 只能是 {', '.join(sorted(CHART_TYPES))}")
    index = {c["name"]: i for i, c in enumerate(r["columns"])}
    formats = {c["name"]: c["format"] for c in r["columns"]}
    x = args.get("x")
    series = [s for s in args.get("series") or [] if s != x]
    missing = [c for c in [x, *series] if c not in index]
    if missing:
        raise ChartError(f"结果 {rid} 里没有这些列：{', '.join(map(str, missing))}；有：{', '.join(index)}")
    if not series or len(series) > MAX_SERIES:
        raise ChartError(f"series 要 1-{MAX_SERIES} 列")
    rows = [row for row in r["rows"] if row[index[x]] is not None]
    split = args.get("split_by")
    if split:
        # Long rows (x, split value, number) -> one series per split value.
        if split not in index:
            raise ChartError(f"结果 {rid} 里没有列 {split}")
        if len(series) != 1:
            raise ChartError("用 split_by 时 series 只能有一列")
        keys = list(dict.fromkeys(str(row[index[split]]) for row in rows))
        if len(keys) > MAX_SERIES:
            raise ChartError(f"{split} 有 {len(keys)} 个取值，最多 {MAX_SERIES} 个，请先筛选")
        value_col = series[0]
        wide: dict = {}
        for row in rows:
            wide.setdefault(row[index[x]], {})[str(row[index[split]])] = row[index[value_col]]
        index = {x: 0, **{k: i + 1 for i, k in enumerate(keys)}}
        formats = {**{k: formats[value_col] for k in keys}, x: formats[x]}
        rows = [[xv, *[vals.get(k) for k in keys]] for xv, vals in wide.items()]
        series = keys
    for s in series:
        if not any(isinstance(row[index[s]], (int, float)) for row in rows):
            raise ChartError(f"列 {s} 不是数值，不能画图")
    fmts = {formats[s] for s in series}
    if len(fmts) > 1:
        raise ChartError("这几列单位不同（例如金额和比率），一张图只能放同一种单位，请分成两张图")
    fmt = fmts.pop()
    if fmt in ("raw", "text"):
        # SQL results carry no formats: take the model's, else judge by the column name like reports do.
        guessed = {PACKAGE.column_format(s) for s in series} - {"text"}
        fmt = args.get("value_format") or (guessed.pop() if len(guessed) == 1 else "number")

    points = [[row[index[x]], *[row[index[s]] for s in series]] for row in rows]
    sort = args.get("sort") or "none"
    if ctype == "line" and all(_is_date(p[0]) for p in points):
        points.sort(key=lambda p: p[0])
    elif sort in ("desc", "asc"):
        points.sort(key=lambda p: (p[1] is None, -(p[1] or 0) if sort == "desc" else (p[1] or 0)))
    note = None
    if ctype == "pie":
        if len(series) != 1 or fmt == "pct":
            raise ChartError("饼图只能画一列金额或数量（构成），比率请用柱状图")
        points = [p for p in points if isinstance(p[1], (int, float)) and p[1] > 0]
        if len(points) > MAX_PIE:
            raise ChartError(f"饼图最多 {MAX_PIE} 个类别，这里有 {len(points)} 个，请改用 bar 或 stacked_bar")
    limit = MAX_POINTS if ctype == "line" else MAX_BARS
    if len(points) > limit:
        note = f"共 {len(points)} 项，图里只画了前 {limit} 项"
        points = points[:limit]
    emphasize = args.get("emphasize")
    if emphasize is not None and (emphasize not in ("positive", "negative") or ctype != "bar" or len(series) != 1):
        raise ChartError("emphasize 只能是 positive 或 negative，且只用于单列的 bar")
    horizontal = args.get("horizontal")
    if horizontal is None:
        # long or many category names read better down the side
        horizontal = ctype in ("bar", "stacked_bar") and (len(points) > 8 or max((len(str(p[0])) for p in points), default=0) > 6)
    ui = {
        "kind": "chart",
        "title": args.get("title") or r["title"],
        "type": ctype,
        "horizontal": bool(horizontal) and ctype in ("bar", "stacked_bar"),
        "x": x,
        "series": [{"name": s, "format": fmt} for s in series],
        "emphasize": emphasize,
        "points": points,
        "source": f"{rid} {r['title']}",
        "note": note,
    }
    model = {"ok": True, "chart": ui["title"], "points": len(points), "note": note or "图表已展示给用户"}
    return ui, model


def _remember(conv: Conversation, ui: dict, model: dict):
    """Number a query result so the model can chart it later."""
    rid = f"R{conv.next_result}"
    conv.next_result += 1
    conv.results[rid] = {"title": ui.get("title"), "columns": ui["columns"], "rows": ui["rows"]}
    while len(conv.results) > MAX_RESULTS:
        conv.results.popitem(last=False)
    ui["result_id"] = rid
    model["result_id"] = rid


async def _execute(conv: Conversation, name: str, args: dict) -> tuple[dict | None, str]:
    """(result for the browser, content for the model). Errors go back to the model so it can fix them."""
    try:
        if name == "query_report":
            ui, model = await run_in_threadpool(_run_report, args)
            _remember(conv, ui, model)
        elif name == "run_sql":
            ui, model = await run_in_threadpool(_run_sql, args)
            _remember(conv, ui, model)
        elif name == "show_chart":
            ui, model = _build_chart(conv, args)
        else:
            return None, f"未知工具 {name}"
    except HTTPException as e:
        return {"kind": "error", "error": str(e.detail)}, f"错误：{e.detail}"
    except ChartError as e:
        return {"kind": "error", "error": f"画图失败：{e}"}, f"画图失败：{e}"
    except (TypeError, ValueError) as e:
        return {"kind": "error", "error": f"参数不对：{e}"}, f"参数不对：{e}"
    return ui, json.dumps(model, ensure_ascii=False, default=str)


# ---------------------------------------------------------------- model


class LlmError(Exception):
    pass


def _api_messages(conv: Conversation, system: str) -> list[dict]:
    """System prompt + history. Reasoning is replayed only within the current turn's tool loop."""
    last_user = max((i for i, m in enumerate(conv.messages) if m["role"] == "user"), default=0)
    out = [{"role": "system", "content": system}]
    for i, m in enumerate(conv.messages):
        if m["role"] == "assistant" and i < last_user and "reasoning_content" in m:
            m = {k: v for k, v in m.items() if k != "reasoning_content"}
        out.append(m)
    return out


def _tools(allow_sql: bool) -> list[dict]:
    return TOOLS if allow_sql else [t for t in TOOLS if t["function"]["name"] != "run_sql"]


NO_SQL_NOTE = (
    "\n\n## 当前用户的权限\n当前用户是只读角色，**不能执行 SQL**，只能用 query_report。"
    "报表回答不了的问题（需要按导购、组别、城市等明细统计），告诉用户这需要分析员权限，请联系管理员。"
)


async def _call_model(conv: Conversation, emit, usage: dict, allow_sql: bool) -> dict:
    provider, model = ai_providers.selected()
    if not provider or not provider["api_key"]:
        raise LlmError("还没有配置模型：请管理员在「AI 设置」页添加 provider 并填写 key")
    payload = {
        "model": model,
        # building the prompt queries the database (catalog), so keep it off the event loop
        "messages": _api_messages(conv, await run_in_threadpool(_system_prompt) + ("" if allow_sql else NO_SQL_NOTE)),
        "tools": _tools(allow_sql),
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": config.LLM_MAX_TOKENS,
    }
    for attempt in range(1, MODEL_ATTEMPTS + 1):
        content, reasoning, calls = [], [], {}
        try:
            return await _stream_model(provider, payload, emit, usage, content, reasoning, calls)
        except httpx.TransportError as e:
            # A dropped connection (common on cross-border links) is retried, but only while nothing of the
            # answer has reached the user yet (a retry after that would print the text twice), and not after
            # a 3-minute read timeout.
            if content or attempt == MODEL_ATTEMPTS or isinstance(e, httpx.ReadTimeout):
                log.warning("model call failed (attempt %d): %r", attempt, e)
                raise
            log.warning("model call failed (attempt %d), retrying: %r", attempt, e)
            await asyncio.sleep(attempt)
    raise AssertionError("unreachable")


async def _stream_model(provider: dict, payload: dict, emit, usage: dict, content: list, reasoning: list, calls: dict) -> dict:
    headers = {"Authorization": f"Bearer {provider['api_key']}"}
    thinking_shown = False
    timeout = httpx.Timeout(connect=15, read=180, write=30, pool=15)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", f"{provider['base_url']}/chat/completions", json=payload, headers=headers) as r:
            if r.status_code != 200:
                body = (await r.aread()).decode("utf-8", "replace")[:300]
                hint = {401: "key 无效", 403: "套餐没有这个模型的权限", 429: "请求太频繁或额度用完"}.get(r.status_code, "")
                raise LlmError(f"模型接口返回 {r.status_code}{('（' + hint + '）') if hint else ''}：{body}")
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                if chunk.get("usage"):
                    u = chunk["usage"]
                    usage["prompt"] += u.get("prompt_tokens") or 0
                    usage["completion"] += u.get("completion_tokens") or 0
                    usage["cached"] += (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("reasoning_content"):
                        reasoning.append(delta["reasoning_content"])
                        if not thinking_shown:
                            thinking_shown = True
                            await emit({"type": "status", "text": "思考中…"})
                    if delta.get("content"):
                        content.append(delta["content"])
                        await emit({"type": "text", "delta": delta["content"]})
                    for tc in delta.get("tool_calls") or []:
                        slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function") or {}
                        slot["name"] += fn.get("name") or ""
                        slot["arguments"] += fn.get("arguments") or ""
    message: dict = {"role": "assistant", "content": "".join(content) or None}
    if reasoning:
        message["reasoning_content"] = "".join(reasoning)
    if calls:
        message["tool_calls"] = [
            {
                "id": c["id"] or f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
            }
            for _, c in sorted(calls.items())
        ]
    return message


def _args(call: dict) -> dict:
    try:
        args = json.loads(call["function"]["arguments"] or "{}")
    except json.JSONDecodeError:
        return {}
    return args if isinstance(args, dict) else {}


async def _run_calls(
    conv: Conversation, msg_index: int, start: int, emit, auto_execute: bool, decision: bool | None, allow_sql: bool
) -> bool:
    """Run the tool calls of one assistant message from `start`. Returns True when paused for approval."""
    calls = conv.messages[msg_index]["tool_calls"]
    cancel_rest = False  # cancelling one SQL cancels the other SQL calls of the same batch
    for i in range(start, len(calls)):
        call = calls[i]
        name, args = call["function"]["name"], _args(call)
        title = args.get("title") or {"run_sql": "SQL 查询", "show_chart": "图表"}.get(name, "报表查询")
        if name == "run_sql" and decision is False:
            cancel_rest = True
        if name == "run_sql" and not allow_sql:
            # Checked first, and again on approval: the role may have changed mid-conversation.
            content = "当前用户没有执行 SQL 的权限（只读角色），只能用 query_report。"
            await emit({"type": "tool_result", "id": call["id"], "result": {"kind": "error", "title": title, "error": "没有执行 SQL 的权限"}})
        elif name == "run_sql" and not auto_execute and decision is None and not cancel_rest:
            conv.pending = {"message": msg_index, "call": i}
            await emit({"type": "confirm", "id": call["id"], "title": title, "sql": args.get("sql", "")})
            return True
        elif name == "run_sql" and cancel_rest:
            content = "用户取消了这条 SQL，没有执行。请换个思路或询问用户。"
            await emit({"type": "tool_result", "id": call["id"], "result": {"kind": "cancelled", "title": title, "sql": args.get("sql", "")}})
        else:
            await emit({"type": "tool_start", "id": call["id"], "name": name, "title": title, "sql": args.get("sql") if name == "run_sql" else None})
            ui, content = await _execute(conv, name, args)
            await emit({"type": "tool_result", "id": call["id"], "result": ui})
            log.info("tool %s %s -> %s", name, json.dumps(args, ensure_ascii=False)[:400], (ui or {}).get("kind"))
        decision = None  # an approval covers only the call it was given for
        conv.messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
    return False


async def _turn(conv: Conversation, emit, auto_execute: bool, decision: bool | None, allow_sql: bool):
    usage = {"prompt": 0, "completion": 0, "cached": 0}
    started = time.perf_counter()
    if conv.pending is not None:
        pending, conv.pending = conv.pending, None
        if await _run_calls(conv, pending["message"], pending["call"], emit, auto_execute, decision, allow_sql):
            return
    for _ in range(MAX_STEPS):
        message = await _call_model(conv, emit, usage, allow_sql)
        conv.messages.append(message)
        if not message.get("tool_calls"):
            break
        if await _run_calls(conv, len(conv.messages) - 1, 0, emit, auto_execute, None, allow_sql):
            break
    else:
        await emit({"type": "text", "delta": "\n\n（这个问题查询步骤太多，先停在这里。可以把问题拆小一点再问。）"})
    await emit({"type": "usage", "usage": usage})
    log.info(
        "turn %s: %.1fs, tokens prompt=%d (cached %d) completion=%d",
        conv.id[:8], time.perf_counter() - started, usage["prompt"], usage["cached"], usage["completion"],
    )


# ---------------------------------------------------------------- history


def _log_start(user: User, conv: Conversation, body: "ChatIn") -> int | None:
    provider, model = ai_providers.selected()
    try:
        return chatlog.start(
            user.username, conv.id, body.message.strip(), "，".join(_context_parts(body.context)) or None,
            f"{provider['name']} / {model}" if provider else model,
        )
    except Exception:  # noqa: BLE001 - the history never stops an answer
        log.exception("chat history: could not record the question")
        return None


def _log_finish(conv: Conversation, events: list[dict], stopped: bool, seconds: float):
    if conv.log_id is None:
        return
    usage = next((e["usage"] for e in reversed(events) if e.get("type") == "usage"), {})
    status = (
        "stopped" if stopped
        else "error" if any(e.get("type") == "error" for e in events)
        else "waiting" if conv.pending is not None
        else "ok"
    )
    try:
        chatlog.finish(conv.log_id, events, status, seconds, usage)
    except Exception:  # noqa: BLE001
        log.exception("chat history: could not record the answer")


def _names() -> dict[str, str]:
    return {u.username: u.display_name for u in users.all_users()}


def _with_names(rows: list[dict], names: dict[str, str]) -> list[dict]:
    return [{**r, "display_name": names.get(r["username"]) or r["username"]} for r in rows]


@router.get("/history")
def history(
    user: str | None = None,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 50,
    offset: int = 0,
    _: User = Depends(require_role("admin")),
):
    out = chatlog.search(user, (q or "").strip() or None, date_from, date_to, max(1, min(limit, 200)), max(0, offset))
    names = _names()
    return {
        **out,
        "items": _with_names(out["items"], names),
        "users": [{"username": u, "display_name": names.get(u) or u} for u in out["users"]],
    }


@router.get("/history/{log_id}")
def history_conversation(log_id: int, _: User = Depends(require_role("admin"))):
    turns = chatlog.conversation(log_id)
    if turns is None:
        raise HTTPException(404, "没有这条记录")
    return {"turns": _with_names(turns, _names())}


# ---------------------------------------------------------------- endpoint


class ChatIn(BaseModel):
    conversation_id: str | None = None
    message: str | None = Field(default=None, max_length=4000)
    context: PageContext | None = None
    auto_execute: bool = True
    approve: bool | None = None  # answer to a pending SQL confirmation


@router.post("")
async def chat(body: ChatIn, user: User = Depends(require_user)):
    # SQL needs both the role and the read-only database account (created by setup).
    allow_sql = user.at_least("analyst") and bool(config.AGENT_DB_USER)
    if body.approve is None and not (body.message or "").strip():
        raise HTTPException(400, "问题不能为空")
    if body.approve is not None and body.conversation_id not in _conversations:
        raise HTTPException(409, "这段对话已过期，请重新提问")
    conv = _get_conversation(body.conversation_id)
    if conv.lock.locked():
        raise HTTPException(409, "上一个问题还在回答中")

    async def worker(emit):
        events: list[dict] = []  # what this request showed the user, for the history
        started = time.perf_counter()
        stopped = False

        async def record(event):
            events.append(event)
            await emit(event)

        async with conv.lock:
            try:
                await record({"type": "conversation", "id": conv.id})
                if body.approve is None:
                    if conv.pending is not None:
                        conv.pending = None  # a new question abandons the unanswered confirmation
                    _repair(conv)
                    conv.messages.append({"role": "user", "content": _context_text(body.context) + body.message.strip()})
                    conv.log_id = _log_start(user, conv, body)
                elif conv.pending is None:
                    raise LlmError("没有等待确认的 SQL")
                await _turn(conv, record, body.auto_execute, body.approve, allow_sql)
            except LlmError as e:
                await record({"type": "error", "message": str(e)})
            except httpx.HTTPError as e:
                log.warning("chat turn failed: %r", e)
                await record({"type": "error", "message": f"连接模型接口失败：{e.__class__.__name__}"})
            except asyncio.CancelledError:
                stopped = True
                raise
            except Exception as e:  # noqa: BLE001 - report anything else to the user, keep the server up
                log.exception("chat turn failed")
                await record({"type": "error", "message": f"出错了：{e}"})
            finally:
                _repair(conv)
                _log_finish(conv, events, stopped, time.perf_counter() - started)

    async def stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(event):
            await queue.put(event)

        async def run():
            try:
                await worker(emit)
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
            yield 'data: {"type": "done"}\n\n'
        finally:
            # The browser went away (stop button, closed drawer): stop the model call too.
            task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
