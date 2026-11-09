# 架构与协作约定

给在本仓库里干活的人和 AI agent 看的：这个项目怎么分层、改哪里、哪些是不变量。

## 1. 一句话架构

**平台不含业务，业务全在业务包。** 后端 `backend/`（FastAPI + MySQL）、前端 `web/`（React + antd + echarts）
是通用的；一个部署展示什么，由 `BI_PACKAGE_DIR` 指向的业务包决定（默认 `packages/retail`）。

```
package.yaml  →  数据表 / 导入规则 / 汇总表 / 列格式 / 报表 / AI 问数示例
schema/*.sql  →  建表与迁移（启动时 app.cli setup 按文件名顺序执行）
sql/*.sql     →  每张 SQL 报表一个文件
knowledge.md  →  AI 问数的业务口径
```

## 2. 关键分层

| 层 | 位置 | 职责 |
|---|---|---|
| 配置/启动 | `backend/app/config.py`、`main.py`、`dbsetup.py`、`migrate.py` | 读 `.env`、建表迁移、建只读账号、首个管理员 |
| 业务包校验 | `backend/app/package.py` | 逐字段校验 `package.yaml`，写错直接报错，不会悄悄失效 |
| 导入 | `backend/app/importer.py`、`summaries.py`、`derived.py` | 表头匹配、值清洗、拆分求和、按日期覆盖、派生列、同事务重算汇总表 |
| 查询 | `backend/app/routers/reports.py`、`sql.py`、`agent.py` | 报表（含比率重算）、受控 SQL、只读数据 API |
| AI 问数 | `backend/app/routers/chat.py`、`ai_providers.py`、`chatlog.py` | OpenAI 兼容接口、工具调用、问数记录 |
| 前端 | `web/src/pages/*`、`reportTable.tsx`、`tableLayout.ts` | 报表、趋势、分组统计、导入、数据表、用户 |

## 3. 不变量（改代码时别破坏）

- **比率永不直接相加**：`package.yaml` 的 `ratios` 声明分子分母，合计、分组统计、汇总表一律
  `sum(分子)/sum(分母)` 重算。新增比率列必须同时声明 `ratios`。
- **报表 SQL 就是看板 SQL**：同一份 SQL 同时供页面、汇总报表、AI 问数使用；不要在别处复制一份改口径。
- **导入是原子的**：明细导入、汇总表重算、派生列计算在同一事务里，失败要整笔回滚。
- **快照不能相加**：金额是「截至当天的当月累计值」，跨日期只做差值和环比，不做求和。
- **看不到的列要真看不到**：`chat.hidden_columns` 里的列（如账户号）由只读数据库账号层面屏蔽，不是前端隐藏。
- **业务包只描述业务**：平台代码里不写表名、字段名、指标名；新增能力要能在任意业务包里用。

## 4. 开发命令

```bash
# 后端（Python 3.12，MySQL 8.4）
cd backend && uv sync
python -m app.cli setup          # 建表 + 迁移 + 只读账号 + 首个管理员
uv run uvicorn app.main:app --reload --port 8100

# 前端（开发时把 /api 代理到 8100）
cd web && npm install && npm run dev

# 整体
docker compose up -d --build
```

## 5. 改业务包的正确姿势

1. 表结构：`schema/NNN_xxx.sql` 只增不改（迁移按文件名顺序执行，已有部署也要能跑过）；
2. 导入规则：`package.yaml` 的 `date_col` / `header_aliases` / `value_rules` / `split_sums` / `derived`；
3. 报表：`sql/<名字>.sql` + `package.yaml` 的 `reports`（`ratios`、`kpis`、`charts`、`pivots` 等）；
4. 口径：`knowledge.md`——AI 问数的答案质量取决于这里写得多清楚；
5. 启动一次 `python -m app.cli setup`，业务包校验不过会直接告诉你哪个字段错了。

## 6. 数据

仓库不含任何真实业务数据（`datademo/`、`.env`、`app.db`、上传文件都在 `.gitignore` 里）。
示例数据自己从业务系统导出一份，到「导入」页上传。
