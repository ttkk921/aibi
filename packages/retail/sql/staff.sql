-- 导购表：日期 × 品类 × 大区 × 门店 × 导购。口径同门店明细，只是拆到人。
-- 目标只到门店（门店月度目标），所以这里不列个人目标；给出门店平均销售额做对标。
with staff_sales as (
  select d.sale_date as sale_date,
         d.region as region,
         d.store_name as store_name,
         d.staff_no as staff_no,
         d.staff_name as staff_name,
         ifnull(cm.category, d.category) as category,
         ifnull(cm.category_group, d.category) as category_group,
         sum(d.amount_total) as amount,
         sum(d.return_amount) as return_amount,
         sum(d.gross_profit) as profit,
         sum(d.orders) as orders,
         sum(d.quantity) as quantity,
         sum(if(d.customer_type = '新客', d.amount_total, 0)) as new_amount
  from bi_store_daily d
  left outer join bi_category_map cm on cm.raw_category = d.category
  group by d.sale_date, d.region, d.store_name, d.staff_no, d.staff_name,
           ifnull(cm.category, d.category), ifnull(cm.category_group, d.category)
),
-- 门店内人均销售额：同一 日期 + 品类 + 门店 的 销售额合计 / 导购数
store_avg as (
  select sale_date, category, store_name,
         sum(amount) / count(distinct staff_no) as avg_amount
  from staff_sales
  group by sale_date, category, store_name
)
select
  s.sale_date as '日期',
  s.category as '品类',
  s.category_group as '品类大类',
  s.region as '大区',
  s.store_name as '门店',
  s.staff_name as '导购',
  s.amount as '销售额',
  s.profit as '毛利额',
  s.profit / s.amount as '毛利率',
  s.orders as '订单数',
  s.quantity as '件数',
  s.amount / s.orders as '客单价',
  s.return_amount / s.amount as '退货率',
  s.new_amount as '新客销售额',
  s.new_amount / s.amount as '新客占比',
  a.avg_amount as '门店平均销售额',
  case
    when s.amount > a.avg_amount then '是'
    when s.amount <= a.avg_amount then '否'
  end as '是否超过门店平均'
from staff_sales s
left outer join store_avg a
  on a.sale_date = s.sale_date and a.category = s.category and a.store_name = s.store_name
order by s.sale_date, s.category_group, s.category, s.region, s.store_name, s.amount desc
