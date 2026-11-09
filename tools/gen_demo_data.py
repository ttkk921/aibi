#!/usr/bin/env python3
"""生成门店销售看板的虚构示例数据（xlsx），导入到业务包里就能看到所有报表。

用法：
    python tools/gen_demo_data.py                # 写到 datademo/20260110/
    python tools/gen_demo_data.py out --days 10  # 换目录、换天数

生成的文件（表头就是业务包里表的字段注释，导入页按表头自动匹配）：
    销售明细.xlsx  品类对照表.xlsx  门店月度目标.xlsx  序时目标.xlsx
    人员表.xlsx    门店人力.xlsx    毛利率表.xlsx      会员表.xlsx

数据全是随机的虚构数据（固定随机种子，每次生成结果相同）。导入顺序：先维表（品类对照表、毛利率表、
人员表、门店人力、会员表），再「销售明细」（它会自动生成日汇总），最后「门店月度目标」「序时目标」。
"""
import argparse
import datetime as dt
import random
from pathlib import Path

from openpyxl import Workbook

# 大区 → 门店
STORES = {
    "东区": ["东区-繁华店", "东区-中心店"],
    "南区": ["南区-海湾店"],
    "西区": ["西区-湖畔店"],
    "北区": ["北区-北站店"],
}
CITIES = {"东区-繁华店": "示例市", "东区-中心店": "示例市", "南区-海湾店": "样例市",
          "西区-湖畔店": "样例市", "北区-北站店": "演示市"}
# 原始品类, 标准品类, 品类大类, 毛利率
CATEGORIES = [
    ("女装-上装", "女装上装", "女装", 0.420000),
    ("女装-下装", "女装下装", "女装", 0.380000),
    ("男装-上装", "男装上装", "男装", 0.350000),
    ("男装-下装", "男装下装", "男装", 0.320000),
    ("童装（试销）", "童装", "童装", 0.450000),
    ("配饰", "配饰", "配饰", 0.550000),
]
CHANNELS = ["到店", "线上", "直播"]
NAMES = ["陈一", "林二", "周三", "吴四", "郑五", "王六", "冯七", "褚八", "卫九", "蒋十",
         "沈小满", "韩青", "杨帆", "朱可", "秦朗", "许安", "何夕", "吕然", "施雨", "张宁"]
LEVELS = ["普通", "银卡", "金卡"]


def save(path: Path, headers: list[str], rows: list[list]):
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for r in rows:
        ws.append(r)
    wb.save(path)


def money(rng: random.Random, low: int, high: int) -> float:
    return round(rng.uniform(low, high), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="datademo", help="输出目录（默认 datademo）")
    ap.add_argument("--days", type=int, default=10, help="每个月生成几天（默认 10）")
    ap.add_argument("--seed", type=int, default=20260110, help="随机种子")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    out = Path(args.out) / "20260110"
    out.mkdir(parents=True, exist_ok=True)

    # ---------- 人员 ----------
    staff = []  # (工号, 姓名, 大区, 门店, 组别)
    for region, stores in STORES.items():
        for store in stores:
            for k in range(4):
                no = f"S{len(staff) + 1:03d}"
                staff.append((no, NAMES[len(staff) % len(NAMES)], region, store, "一组" if k < 2 else "二组"))
    save(out / "人员表.xlsx", ["工号", "姓名", "大区", "门店", "组别"], [list(r) for r in staff])

    # ---------- 会员 ----------
    members = []
    for i in range(300):
        no = f"M{i + 1:06d}"
        first = dt.date(2025, 6, 1) + dt.timedelta(days=rng.randrange(0, 215))
        members.append((no, f"{first:%Y-%m}", rng.choice(LEVELS)))
    save(out / "会员表.xlsx", ["会员号", "首购月", "会员等级"], [list(r) for r in members])

    # ---------- 品类对照表 / 毛利率表 ----------
    save(out / "品类对照表.xlsx", ["原始品类", "标准品类", "品类大类"],
         [[raw, std, group] for raw, std, group, _ in CATEGORIES])
    save(out / "毛利率表.xlsx", ["品类", "毛利率"], [[std, rate] for _, std, _, rate in CATEGORIES])

    # ---------- 门店人力（2026-01）：门店总人力按品类分摊 ----------
    headcount_rows = []
    for stores in STORES.values():
        for store in stores:
            total = rng.randint(4, 6)
            weights = [rng.uniform(0.6, 1.4) for _ in CATEGORIES]
            scale = total / sum(weights)
            shares = [round(w * scale, 2) for w in weights]
            shares[-1] = round(total - sum(shares[:-1]), 2)  # 最后一档兜住四舍五入，分档之和正好等于门店总人力
            for (_, std, _, _), share in zip(CATEGORIES, shares):
                headcount_rows.append(["2026-01-01", store, std, share])
    save(out / "门店人力.xlsx", ["月份", "门店", "品类", "人力"], headcount_rows)

    # ---------- 门店月度目标（2026-01，门店 × 品类） ----------
    save(out / "门店月度目标.xlsx", ["月份", "门店", "品类", "目标销售额"],
         [["2026-01-01", store, std, money(rng, 30000, 90000)]
          for stores in STORES.values() for store in stores for _, std, _, _ in CATEGORIES])

    # ---------- 序时目标（2026-01 每天，品类） ----------
    days_in_month = 31
    save(out / "序时目标.xlsx", ["日期", "品类", "序时进度"],
         [[f"2026-01-{day:02d}", std, round(day / days_in_month, 6)]
          for day in range(1, days_in_month + 1) for _, std, _, _ in CATEGORIES])

    # ---------- 销售明细：上个月 10 天 + 本月 10 天（当月用于同期对比） ----------
    rows = []
    periods = [(dt.date(2025, 12, 1), "上期"), (dt.date(2026, 1, 1), "本期")]
    for first_day, _ in periods:
        for offset in range(args.days):
            day = first_day + dt.timedelta(days=offset)
            for _, stores in STORES.items():
                for store in stores:
                    for no, name, region, _store, _team in [s for s in staff if s[3] == store]:
                        for raw, _std, _group, _rate in CATEGORIES:
                            if rng.random() < 0.3:  # 有的品类当天没卖
                                continue
                            orders = [money(rng, 199, 2599) for _ in range(rng.choice([1, 1, 1, 2]))]
                            returned = money(rng, 0, 320) if rng.random() < 0.12 else 0
                            rows.append([
                                f"{day:%Y-%m-%d}", region, CITIES[store], store, no, name, raw,
                                rng.choice(CHANNELS),
                                "|".join(f"{o:.2f}" for o in orders),
                                returned,
                                rng.randint(1, 6),
                                rng.choice(members)[0] if rng.random() < 0.65 else "",
                            ])
    rows.sort(key=lambda r: (r[0], r[3], r[4], r[6]))
    save(out / "销售明细.xlsx",
         ["日期", "大区", "城市", "门店", "工号", "导购", "品类", "渠道", "订单金额", "退货额", "件数", "会员号"],
         rows)

    total = sum(float(v) for r in rows for v in str(r[8]).split("|"))
    print(f"已生成 {len(rows)} 行销售明细（销售额合计约 {total:,.0f} 元），{len(staff)} 名导购，"
          f"{sum(len(s) for s in STORES.values())} 家门店，{len(members)} 名会员")
    print(f"输出目录：{out}")
    print("导入顺序：品类对照表 → 毛利率表 → 人员表 → 门店人力 → 会员表 → 销售明细 → 门店月度目标 → 序时目标")


if __name__ == "__main__":
    main()
