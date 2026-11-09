-- 门店排名：同一 日期 + 品类 + 大区 下，各门店的销售额、达成率、名次，以及与前一名、前前一名还差多少钱。
-- 只排有目标的门店（没有目标的门店没有达成率，不参与排名）。
-- 达成率相同时按门店名排；差距 = (前一名达成率 − 本店达成率) × 本店目标销售额，即追上他还需多做多少销售额。
with sales as (
  select d.sale_date as sale_date,
         d.region as region,
         d.store_name as store_name,
         ifnull(cm.category, d.category) as category,
         ifnull(cm.category_group, d.category) as category_group,
         sum(d.amount_total) as amount
  from bi_store_daily d
  left outer join bi_category_map cm on cm.raw_category = d.category
  group by d.sale_date, d.region, d.store_name, ifnull(cm.category, d.category), ifnull(cm.category_group, d.category)
),
-- 目标只到月，先聚到月 × 门店 × 品类，再按天匹配，避免被明细行放大
target as (
  select date_format(t.month_date, '%Y-%m-01') as month_date, t.store_name, t.category, sum(t.target_amount) as target_amount
  from bi_store_target t
  group by date_format(t.month_date, '%Y-%m-01'), t.store_name, t.category
),
base as (
  select s.sale_date, s.region, s.store_name, s.category, s.category_group, s.amount,
         t.target_amount,
         s.amount / t.target_amount as rate
  from sales s
  left outer join target t
    on t.month_date = date_format(s.sale_date, '%Y-%m-01') and t.store_name = s.store_name and t.category = s.category
),
ranked as (
  select b.sale_date, b.region, b.store_name, b.category, b.category_group,
         b.amount, b.target_amount, b.rate,
         row_number() over (partition by b.sale_date, b.category, b.region
                            order by b.rate desc, b.store_name) as rn,
         count(*) over (partition by b.sale_date, b.category, b.region) as stores
  from base b
  where b.rate is not null
)
select
  r.sale_date as '日期',
  r.category as '品类',
  r.category_group as '品类大类',
  r.region as '大区',
  r.store_name as '门店',
  r.amount as '销售额',
  r.target_amount as '目标销售额',
  r.rate as '累计达成率',
  r.target_amount - r.amount as '距离目标差额',
  concat(r.rn, '/', r.stores) as '达成率排名',
  p1.store_name as '前一名门店',
  p1.rate as '前一名达成率',
  (p1.rate - r.rate) * r.target_amount as '距离前一名差距',
  p2.store_name as '前前一名门店',
  (p2.rate - r.rate) * r.target_amount as '距离前前一名差距',
  case when r.rate >= 1 then '是' else '否' end as '是否达成目标'
from ranked r
left outer join ranked p1
  on p1.sale_date = r.sale_date and p1.category = r.category and p1.region = r.region and p1.rn = r.rn - 1
left outer join ranked p2
  on p2.sale_date = r.sale_date and p2.category = r.category and p2.region = r.region and p2.rn = r.rn - 2
order by r.sale_date, r.category_group, r.category, r.region, r.rn
