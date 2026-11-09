-- 日汇总表的「客群」（customer_type）：明细里没有，生成汇总时按会员表计算（package.yaml 的 summaries.computed）。
-- src 是明细表 bi_sales_detail 的一行：非会员算散客；首购在 3 个月内的算新客，其余算老客。
-- 会员表变动后按月份重算汇总（depends_on）。
case
  when src.member_no is null or src.member_no = '' then '散客'
  when ifnull((select period_diff(date_format(src.sale_date, '%Y%m'), replace(p.first_month, '-', ''))
               from bi_member_profile p
               where p.member_no = src.member_no), 999) <= 2 then '新客'
  else '老客'
end
