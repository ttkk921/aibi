-- 大盘销售：日期 × 品类 × 品类大类 × 大区。
-- 销售额来自日汇总（bi_store_daily），目标来自门店月度目标（bi_store_target，门店 × 品类 × 月），
-- 序时进度来自序时目标（bi_timeline_target，日期 × 品类）。
-- 先用 CTE 把明细聚合到「日期 + 门店 + 品类」，再关联目标，避免目标被明细行放大。
with sales as (
  select d.sale_date as sale_date,
         d.store_name as store_name,
         d.region as region,
         ifnull(cm.category, d.category) as category,
         ifnull(cm.category_group, d.category) as category_group,
         sum(d.amount_total) as amount,
         sum(d.return_amount) as return_amount,
         sum(d.gross_profit) as profit,
         sum(d.orders) as orders
  from bi_store_daily d
  left outer join bi_category_map cm on cm.raw_category = d.category
  group by d.sale_date, d.store_name, d.region, ifnull(cm.category, d.category), ifnull(cm.category_group, d.category)
),
-- 上月同一天（用于同期对比）：把当月这一天映射到上个月的对应日期
last_month as (
  select date_add(d.sale_date, interval 1 month) as sale_date,
         d.store_name as store_name,
         ifnull(cm.category, d.category) as category,
         sum(d.amount_total) as amount
  from bi_store_daily d
  left outer join bi_category_map cm on cm.raw_category = d.category
  group by date_add(d.sale_date, interval 1 month), d.store_name, ifnull(cm.category, d.category)
),
with_target as (
  select s.sale_date, s.category, s.category_group, s.region,
         s.amount, s.return_amount, s.profit, s.orders, s.store_name,
         t.target_amount,
         tt.timeline_ratio
  from sales s
  left outer join bi_store_target t
    on t.month_date = date_format(s.sale_date, '%Y-%m-01') and t.store_name = s.store_name and t.category = s.category
  left outer join bi_timeline_target tt
    on tt.target_date = s.sale_date and tt.category = s.category
)
select
  w.sale_date as '日期',
  w.category as '品类',
  w.category_group as '品类大类',
  w.region as '大区',
  sum(w.target_amount) as '目标销售额',
  sum(w.target_amount * w.timeline_ratio) as '序时目标金额',
  sum(w.amount) as '销售额',
  sum(w.amount) / sum(w.target_amount) as '累计达成率',
  sum(w.amount) / sum(w.target_amount * w.timeline_ratio) as '序时达成率',
  sum(w.target_amount * w.timeline_ratio - w.amount) as '序时缺口',
  sum(w.profit) as '毛利额',
  sum(w.profit) / sum(w.amount) as '毛利率',
  sum(w.return_amount) as '退货额',
  sum(w.return_amount) / sum(w.amount) as '退货率',
  sum(w.orders) as '订单数',
  sum(lm.amount) as '上月同期销售额',
  sum(w.amount) / sum(lm.amount) - 1 as '同期销售额环比'
from with_target w
left outer join last_month lm
  on lm.sale_date = w.sale_date and lm.store_name = w.store_name and lm.category = w.category
group by w.sale_date, w.category, w.category_group, w.region
order by w.sale_date, w.category_group, w.category, w.region
