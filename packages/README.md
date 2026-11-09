# 业务包

平台（`backend/`、`web/`）不含任何业务内容。一个部署展示什么，全部由一个**业务包**决定，
用环境变量 `BI_PACKAGE_DIR` 指定（默认 `packages/retail`）。给新客户做 BI，写一个新的业务包即可。

```
packages/<name>/
├── package.yaml     # 品牌、数据表、汇总表、列格式、报表、AI 问数示例
├── sql/             # 报表 SQL（每张 SQL 报表一个文件）
├── schema/          # 建表语句
└── knowledge.md     # 给 AI 问数的业务口径说明
```

`package.yaml` 的字段在 `packages/retail/package.yaml` 里逐项有注释，可以照着改。要点：

- **tables**：能导入、能浏览的表。`date_col` 是按日期覆盖导入的分区列；`value_rules` 是导入时的值清洗
  （`rename` / `strip_suffixes` / `ensure_suffix`，按顺序执行）；`summary_of` 标记由明细自动生成的汇总表。
  `editable`（`keys` 唯一键、`required` 必填列）让这张表能在「数据表」页面逐行新增、修改、删除，值同样经过 `value_rules`，
  每次修改记在导入记录里。
- **summaries**：导入明细时在同一事务里重算的汇总表。
- **column_formats**：报表列按名字判断显示格式（金额、百分比、数量），从上到下第一个匹配的规则生效。
- **reports**：菜单按顺序显示。
  - `type: sql`：一段 SQL 出表。`ratios` 声明比率列的分子分母——合计、分组统计时按 sum(分子)/sum(分母) 重算，
    绝不把比率直接相加。另可配 KPI 卡片、分组统计、合并小计、地区对标、月度趋势、字段分组开关、默认筛选、隐藏列。
  - `type: summary`：由一张 SQL 报表按维度汇总出的若干张表，列用 `sum` / `ratio` / `diff` 定义。
- **chat**：AI 问数的业务口径文件和示例问题（按报表 id 给）。

启动时会逐字段校验业务包，写错字段名、引用不存在的报表或文件都会直接报错，不会悄悄失效。

## 自带的示例包

`packages/retail` 是虚构的「门店销售」示例：销售明细（每天一份）→ 日汇总（导入时自动生成）→
目标 / 序时 / 人力 / 品类对照 / 毛利率 / 会员，五张报表把 `package.yaml` 的配置项基本都用到了
（`value_rules`、`split_sums`、`derived`、`summaries.computed`、`ratios`、`kpis`、`charts`、`trend`、
`pivots`、`column_groups`、`benchmarks`、`choices`、汇总报表）。

示例 Excel 由 `tools/gen_demo_data.py` 生成（纯虚构数据，固定随机种子），导入页按提示顺序上传即可。
