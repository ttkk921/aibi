-- 门店明细：日期 × 品类 × 品类大类 × 大区 × 门店。
-- 销售额来自日汇总，目标来自门店月度目标，序时进度来自序时目标，人力来自门店人力（月 × 门店 × 品类，分摊值），
-- 新客/老客来自日汇总的客群（生成汇总时按会员表算好），大区平均达成率在同一 日期 + 品类 + 大区 内用
-- sum(销售额) / sum(目标销售额) 重算（不是把各门店的达成率平均）。
with sales as (
  select d.sale_date as sale_date,
         d.region as region,
         d.store_name as store_name,
         ifnull(cm.category, d.category) as category,
         ifnull(cm.category_group, d.category) as category_group,
         sum(d.amount_total) as amount,
         sum(d.return_amount) as return_amount,
         sum(d.gross_profit) as profit,
         sum(d.orders) as orders,
         sum(d.quantity) as quantity,
         sum(if(d.customer_type = '新客', d.amount_total, 0)) as new_amount,
         sum(if(d.customer_type = '老客', d.amount_total, 0)) as returning_amount
  from bi_store_daily d
  left outer join bi_category_map cm on cm.raw_category = d.category
  group by d.sale_date, d.region, d.store_name, ifnull(cm.category, d.category), ifnull(cm.category_group, d.category)
),
with_target as (
  select s.sale_date, s.region, s.store_name, s.category, s.category_group,
         s.amount, s.return_amount, s.profit, s.orders, s.quantity,
         s.new_amount, s.returning_amount,
         t.target_amount, tt.timeline_ratio
  from sales s
  left outer join bi_store_target t
    on t.month_date = date_format(s.sale_date, '%Y-%m-01') and t.store_name = s.store_name and t.category = s.category
  left outer join bi_timeline_target tt
    on tt.target_date = s.sale_date and tt.category = s.category
),
-- 大区平均：同一 日期 + 品类 + 大区 的 销售额合计 / 目标合计
region_avg as (
  select sale_date, category, region,
         sum(amount) / sum(target_amount) as region_rate
  from with_target
  group by sale_date, category, region
)
select
  w.sale_date as '日期',
  w.category as '品类',
  w.category_group as '品类大类',
  w.region as '大区',
  w.store_name as '门店',
  hc.headcount as '人力',
  w.target_amount as '目标销售额',
  w.target_amount * w.timeline_ratio as '序时目标金额',
  w.amount as '销售额',
  w.amount / w.target_amount as '累计达成率',
  w.amount / (w.target_amount * w.timeline_ratio) as '序时达成率',
  w.target_amount * w.timeline_ratio - w.amount as '序时缺口',
  w.profit as '毛利额',
  w.profit / w.amount as '毛利率',
  w.amount / hc.headcount as '人均销售额',
  w.orders as '订单数',
  w.quantity as '件数',
  w.quantity / hc.headcount as '人均件数',
  w.return_amount as '退货额',
  w.return_amount / w.amount as '退货率',
  w.new_amount as '新客销售额',
  w.returning_amount as '老客销售额',
  w.new_amount / w.amount as '新客占比',
  reg.region_rate as '大区平均达成率',
  case
    when w.amount / w.target_amount > reg.region_rate then '是'
    when w.amount / w.target_amount <= reg.region_rate then '否'
  end as '是否超过大区平均'
from with_target w
left outer join bi_store_headcount hc
  on hc.month_date = date_format(w.sale_date, '%Y-%m-01') and hc.store_name = w.store_name
     and hc.category = w.category
left outer join region_avg reg
  on reg.sale_date = w.sale_date and reg.category = w.category and reg.region = w.region
order by w.sale_date, w.category_group, w.category, w.region, w.store_name
