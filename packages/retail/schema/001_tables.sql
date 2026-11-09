-- 门店销售看板的数据表（虚构示例，供演示导入、汇总、派生列、报表与 AI 问数）。
-- 由 app.cli setup / migrate 按文件名顺序执行。
-- 列注释就是导入时的 Excel 表头；文件里没有、导入时计算的列（销售额加总、毛利额）见 package.yaml 的 split_sums / derived。

-- ---------------------------------------------------------------- 销售明细
create table if not exists bi_sales_detail (
  id bigint not null auto_increment,
  sale_date date default null comment '日期',
  region varchar(50) default null comment '大区',
  city varchar(50) default null comment '城市',
  store_name varchar(100) default null comment '门店',
  staff_no varchar(50) default null comment '工号',
  staff_name varchar(50) default null comment '导购',
  category varchar(50) default null comment '品类',
  channel varchar(50) default null comment '渠道',
  order_amount varchar(255) default null comment '订单金额',
  amount_total decimal(15,2) default null comment '销售额加总',
  return_amount decimal(15,2) default null comment '退货额',
  quantity int default null comment '件数',
  member_no varchar(64) default null comment '会员号',
  gross_profit decimal(15,2) default null comment '毛利额',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  key idx_sale_date (sale_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='销售明细';

-- ---------------------------------------------------------------- 销售日汇总（导入明细时自动生成）
create table if not exists bi_store_daily (
  id bigint not null auto_increment,
  sale_date date default null comment '日期',
  region varchar(50) default null comment '大区',
  city varchar(50) default null comment '城市',
  store_name varchar(100) default null comment '门店',
  staff_no varchar(50) default null comment '工号',
  staff_name varchar(50) default null comment '导购',
  category varchar(50) default null comment '品类',
  channel varchar(50) default null comment '渠道',
  customer_type varchar(10) default null comment '客群',
  orders int default null comment '订单数',
  amount_total decimal(15,2) default null comment '销售额',
  return_amount decimal(15,2) default null comment '退货额',
  quantity int default null comment '件数',
  gross_profit decimal(15,2) default null comment '毛利额',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  key idx_sale_date (sale_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='销售日汇总';

-- ---------------------------------------------------------------- 维表 / 月度表
create table if not exists bi_category_map (
  id bigint not null auto_increment,
  raw_category varchar(50) default null comment '原始品类',
  category varchar(50) default null comment '标准品类',
  category_group varchar(50) default null comment '品类大类',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  unique key uk_raw_category (raw_category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='品类对照表';

create table if not exists bi_store_target (
  id bigint not null auto_increment,
  month_date date default null comment '月份',
  store_name varchar(100) default null comment '门店',
  category varchar(50) default null comment '品类',
  target_amount decimal(15,2) default null comment '目标销售额',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  key idx_month (month_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='门店月度目标';

create table if not exists bi_timeline_target (
  id bigint not null auto_increment,
  target_date date default null comment '日期',
  category varchar(50) default null comment '品类',
  timeline_ratio decimal(12,6) default null comment '序时进度',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  key idx_date (target_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='序时目标';

create table if not exists bi_store_staff (
  id bigint not null auto_increment,
  staff_no varchar(50) default null comment '工号',
  staff_name varchar(50) default null comment '姓名',
  region varchar(50) default null comment '大区',
  store_name varchar(100) default null comment '门店',
  team varchar(50) default null comment '组别',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  unique key uk_staff_no (staff_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='人员表';

-- 人力按 月 × 门店 × 品类 分摊（一个导购卖几个品类就按比例摊到几个品类），
-- 这样一个门店各品类的人力加起来仍是这个店的总人力，报表汇总时不会重复计算。
create table if not exists bi_store_headcount (
  id bigint not null auto_increment,
  month_date date default null comment '月份',
  store_name varchar(100) default null comment '门店',
  category varchar(50) default null comment '品类',
  headcount decimal(10,2) default null comment '人力',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  key idx_month (month_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='门店人力';

create table if not exists bi_margin_rate (
  id bigint not null auto_increment,
  category varchar(50) default null comment '品类',
  margin_rate decimal(10,6) default null comment '毛利率',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  unique key uk_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='毛利率表';

create table if not exists bi_member_profile (
  id bigint not null auto_increment,
  member_no varchar(64) default null comment '会员号',
  first_month varchar(7) default null comment '首购月',
  level varchar(20) default null comment '会员等级',
  created_at timestamp not null default current_timestamp comment '创建时间',
  primary key (id),
  unique key uk_member_no (member_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会员表';
