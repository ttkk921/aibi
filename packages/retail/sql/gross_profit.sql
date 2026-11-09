-- 销售明细的「毛利额」（gross_profit）：不在文件里，写入后计算（package.yaml 的 derived）。
-- src 是 bi_sales_detail 的一行；品类先经对照表换成标准品类，再查毛利率。
-- 毛利率表或品类对照表变动后整表重算（depends_on）。
ifnull(src.amount_total, 0)
* ifnull((select m.margin_rate
          from bi_category_map cm
          join bi_margin_rate m on m.category = cm.category
          where cm.raw_category = src.category), 0)
