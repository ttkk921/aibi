# BI 看板（自建 + AI 问数）

基于 MySQL 自建的可配置 BI 看板系统：**平台代码不含业务，业务全部由「业务包」描述**——
换一个业务包、换一份 YAML，就能给另一种业务做一套带报表、汇总、看板和 AI 问数的系统。

适用于「每天导入一份 Excel/CSV 快照、按日期看累计指标」这类运营看板（门店销售、业绩达成、
人力效能、目标 vs 序时进度、大区/门店/个人多级对比、排名与追赶金额等）。
仓库自带的示例业务包是**虚构门店销售**：销售明细 / 日汇总 / 目标 / 序时 / 人力 / 品类对照 / 毛利率 / 会员，
`tools/gen_demo_data.py` 一键生成示例 Excel。

## 特性

- **报表引擎**：一段 SQL 出一张表，配 KPI 卡、当日图表、分组统计、合并小计、趋势、地区对标、字段分组、默认筛选、隐藏列。
- **汇总报表**：由明细报表按维度汇总，比率一律 `sum(分子)/sum(分母)` 重算，合计行和分组行口径一致。
- **比率永不直接相加**：`ratios` 声明分子分母，前端翻页、分组、合计都用重算值。
- **导入**：xlsx / xls（含网页格式）/ csv，按表头自动匹配字段、预览确认、按日期覆盖；可配表头别名、值清洗、文件名取日期、拆分求和。
- **自动汇总表**：导入明细时在同一事务里重算日汇总，报表不扫百万行明细。
- **派生列**：导入后用 SQL 计算写入的列，可跨表查维表；维表变动后整表重算。
- **可编辑维表**：对照表/人员/费率/目标这类小表可在页面上逐行增删改。
- **AI 问数**：OpenAI 兼容接口 + 只读数据库账号（看不到敏感列），AI 通过「报表 API」和「受控 SQL」查数，
  业务口径写在业务包的 `knowledge.md`，问数记录留档。
- **权限**：只读 / 分析员 / 管理员三种角色，账号存在 SQLite，不动业务库。
- **只读数据 API**：给外部 AI agent 用的 `/api/agent`（bearer token，仅本机或指定来源）。
- **部署**：单镜像（前端 + 后端 + 业务包）+ MySQL + Caddy，一条 `docker compose up -d --build`。

## 目录

```
backend/     FastAPI：导入、报表、AI 问数、账号、只读 API
web/         React + antd + echarts 前端
packages/    业务包（可插拔，默认 packages/retail）
  retail/
    package.yaml   品牌、数据表、导入规则、汇总、列格式、报表、AI 示例
    schema/        建表与迁移（启动时自动执行）
    sql/           每张 SQL 报表一个文件
    knowledge.md   AI 问数的业务口径
deploy/      部署脚本与说明
tools/       示例数据生成脚本
docs/        给外部 AI agent 的说明
agents.md    架构与协作约定（改哪里、哪些不变量不能破）
```

## 快速开始

一台装了 Docker（Compose v2.24+）的机器：

```bash
git clone https://github.com/<your-name>/aibi.git && cd aibi
cp deploy/docker/.env.example .env      # 填域名、两个数据库密码、LLM key（都可留空）
docker compose up -d --build
docker compose logs app | grep 管理员     # 第一个管理员的初始密码
```

打开 `https://<你的域名>`（没有域名见 `deploy/docker/README.md` 末尾的内网用法），登录后先在
「用户管理」建账号，再到「导入」页面导入业务包要求的 Excel。启动时 app 会自动建表、
建只读账号、创建管理员。

详细部署（已有 nginx、用现成 MySQL、换业务包、备份/升级）：`deploy/docker/README.md`、`deploy/README.md`。

## 怎么做一个新的业务包

1. 复制 `packages/retail/` 为 `packages/<你的业务>/`；
2. 改 `schema/`（建表 + 字段注释）、`sql/`（报表），在 `package.yaml` 里声明数据表、导入规则、报表；
3. 写 `knowledge.md`（业务口径，AI 问数照它回答）；
4. `BI_PACKAGE_DIR=/app/packages/<你的业务>` 挂进去，重启。

`package.yaml` 每个字段都有注释，启动时会逐字段校验，写错会直接报错而不是悄悄失效。
格式说明见 `packages/README.md`。

## AI 问数

页面右下角「问数」：AI 用两个工具查数——看板报表（和页面同一套 SQL，数字一致）和以只读账号执行的
SQL（看不到会员号等敏感列）。接口、模型、提示词、示例问题都在「AI 设置」页管理，配置存 `app.db`，
优先于 `.env`。业务口径见 `packages/retail/knowledge.md`。

## 关于数据

本仓库**不含任何真实业务数据**（`datademo/`、`.env`、`app.db`、上传文件都在 `.gitignore` 里）。
示例业务包的品牌、门店、品类、人员、金额全是虚构的；要试跑就自己生成一份：

```bash
python tools/gen_demo_data.py        # 写到 datademo/20260110/，需要 openpyxl（后端依赖里已有）
```

然后在「导入」页按提示顺序上传（先维表，再销售明细，最后目标和序时目标）。

## 许可

[MIT](./LICENSE)。
