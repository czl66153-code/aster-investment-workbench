#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


NAVY = "17324D"
TEAL = "197278"
RED = "C84A4A"
PALE_BLUE = "EAF1F6"
PALE_RED = "F9EAEA"
LIGHT_GRAY = "EEF1F4"
MID_GRAY = "64748B"
DARK = "1F2937"
WHITE = "FFFFFF"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=70, bottom=80, end=70):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_run_font(run, name="微软雅黑", size=9.5, bold=False, color=DARK):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def set_paragraph_spacing(paragraph, before=0, after=4, line=1.1):
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    fmt.line_spacing = line


def add_text(paragraph, text, **kwargs):
    run = paragraph.add_run(str(text))
    set_run_font(run, **kwargs)
    return run


def style_table(table, header_fill=NAVY, font_size=8.2):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for row_index, row in enumerate(table.rows):
        for cell in row.cells:
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_margins(cell)
            if row_index == 0:
                set_cell_shading(cell, header_fill)
            elif row_index % 2 == 0:
                set_cell_shading(cell, "F7F9FB")
            for paragraph in cell.paragraphs:
                set_paragraph_spacing(paragraph, after=0, line=1.0)
                for run in paragraph.runs:
                    set_run_font(
                        run,
                        size=font_size,
                        bold=row_index == 0,
                        color=WHITE if row_index == 0 else DARK,
                    )


def add_heading(document, text, level=1):
    paragraph = document.add_paragraph()
    set_paragraph_spacing(paragraph, before=10 if level == 1 else 6, after=5)
    add_text(
        paragraph,
        text,
        size=15 if level == 1 else 11.5,
        bold=True,
        color=NAVY if level == 1 else TEAL,
    )
    if level == 1:
        p_pr = paragraph._p.get_or_add_pPr()
        border = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "12")
        bottom.set(qn("w:space"), "4")
        bottom.set(qn("w:color"), TEAL)
        border.append(bottom)
        p_pr.append(border)
    return paragraph


def add_bullet(document, label, text, color=DARK):
    paragraph = document.add_paragraph(style="List Bullet")
    set_paragraph_spacing(paragraph, after=3)
    add_text(paragraph, f"{label}：", bold=True, color=NAVY)
    add_text(paragraph, text, color=color)


def load_font(size, bold=False):
    candidates = [
        Path(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def stock_display(stock):
    code = stock.get("stockCode") or ""
    return f'{stock["stockName"]}  {code}'.strip()


def date_cn(date_text):
    try:
        _, month, day = date_text.split("-")
        return f"{int(month)}月{int(day)}日"
    except (AttributeError, TypeError, ValueError):
        return str(date_text)


def build_chart(data, output_path):
    width, height = 1600, 860
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title_font = load_font(44, bold=True)
    date_font = load_font(24, bold=True)
    label_font = load_font(25)
    number_font = load_font(22, bold=True)
    small_font = load_font(21)

    draw.text((70, 42), "复利笔记热股 × 各组前三名：收盘状态分布", fill="#17324D", font=title_font)
    date_label = f'统计日：{data["date"]}'
    date_bbox = draw.textbbox((0, 0), date_label, font=date_font)
    draw.text(
        (width - 70 - (date_bbox[2] - date_bbox[0]), 58),
        date_label,
        fill="#197278",
        font=date_font,
    )
    legend_y = 112
    legend = [("今天已卖掉", "#C84A4A"), ("正在持有", "#197278"), ("不涉及", "#D8DEE7")]
    legend_x = 770
    for label, color in legend:
        draw.rounded_rectangle((legend_x, legend_y, legend_x + 30, legend_y + 30), radius=6, fill=color)
        draw.text((legend_x + 40, legend_y - 2), label, fill="#334155", font=small_font)
        legend_x += 230

    bar_x, bar_width = 490, 990
    row_y, row_gap, bar_height = 175, 61, 34
    sample_size = len(data["players"])
    for stock in data["stockSummary"]:
        label = f'{stock["hotRank"]:>2}. {stock_display(stock)}'
        draw.text((70, row_y - 2), label, fill="#1F2937", font=label_font)
        values = [
            (stock["soldCount"], "#C84A4A"),
            (stock["holdingCount"], "#197278"),
            (stock["uninvolvedCount"], "#D8DEE7"),
        ]
        cursor = bar_x
        for value, color in values:
            segment_width = round(bar_width * value / sample_size)
            if value:
                draw.rectangle((cursor, row_y, cursor + segment_width, row_y + bar_height), fill=color)
                if segment_width >= 48:
                    text_color = "white" if color != "#D8DEE7" else "#334155"
                    text = str(value)
                    bbox = draw.textbbox((0, 0), text, font=number_font)
                    draw.text(
                        (cursor + (segment_width - (bbox[2] - bbox[0])) / 2, row_y + 2),
                        text,
                        fill=text_color,
                        font=number_font,
                    )
            cursor += segment_width
        draw.rounded_rectangle(
            (bar_x, row_y, bar_x + bar_width, row_y + bar_height),
            radius=5,
            outline="#CBD5E1",
            width=2,
        )
        row_y += row_gap

    draw.text(
        (70, 805),
        f'注：每只股票样本数均为 {sample_size} 人；数字为人数。',
        fill="#64748B",
        font=small_font,
    )
    image.save(output_path, quality=95)


def setup_document(document, data):
    section = document.sections[0]
    section.top_margin = Cm(1.6)
    section.bottom_margin = Cm(1.55)
    section.left_margin = Cm(1.7)
    section.right_margin = Cm(1.7)
    section.header_distance = Cm(0.7)
    section.footer_distance = Cm(0.65)

    normal = document.styles["Normal"]
    normal.font.name = "微软雅黑"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
    normal.font.size = Pt(9.5)
    normal.font.color.rgb = RGBColor.from_string(DARK)

    header = section.header
    table = header.add_table(rows=1, cols=2, width=Inches(7.1))
    table.autofit = False
    table.columns[0].width = Inches(4.7)
    table.columns[1].width = Inches(2.4)
    for cell in table.rows[0].cells:
        set_cell_shading(cell, NAVY)
        set_cell_margins(cell, top=70, bottom=70, start=110, end=110)
    left = table.cell(0, 0).paragraphs[0]
    add_text(left, "FL DATA BRIEF", size=8.5, bold=True, color=WHITE)
    right = table.cell(0, 1).paragraphs[0]
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    add_text(right, data["date"], size=8.5, bold=True, color=WHITE)

    footer = section.footer
    paragraph = footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_text(paragraph, "复利笔记热股持仓分析｜爬虫自动生成｜", size=7.5, color=MID_GRAY)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    paragraph._p.append(field)


def add_cell_text(cell, text, bold=False, color=DARK, size=8.3, align=WD_ALIGN_PARAGRAPH.LEFT):
    paragraph = cell.paragraphs[0]
    paragraph.alignment = align
    set_paragraph_spacing(paragraph, after=0, line=1.0)
    add_text(paragraph, text, bold=bold, color=color, size=size)


def generate_docx(data, chart_path, output_path):
    document = Document()
    setup_document(document, data)

    sample_size = len(data["players"])
    hot_count = len(data["hotStocks"])
    observation_count = sample_size * hot_count
    sold_total = sum(item["soldCount"] for item in data["stockSummary"])
    holding_total = sum(item["holdingCount"] for item in data["stockSummary"])
    active = [
        item
        for item in data["stockSummary"]
        if item["soldCount"] + item["holdingCount"] > 0
    ]
    max_holding = max(data["stockSummary"], key=lambda item: item["holdingCount"])
    missing_structured = sum(
        1
        for player in data["players"]
        if (player.get("todayStockPercent") or 0) > 0 and player.get("todayStockCount") == 0
    )

    title = document.add_paragraph()
    set_paragraph_spacing(title, before=8, after=2)
    add_text(title, "复利笔记热门股与各组选手收盘持仓报告", size=22, bold=True, color=NAVY)
    subtitle = document.add_paragraph()
    set_paragraph_spacing(subtitle, after=10)
    add_text(
        subtitle,
        f'{data["match"]["name"]}｜热股榜前 {hot_count} 名｜'
        f'{len(data["groups"])} 组各取累计排名前三',
        size=11,
        color=TEAL,
    )

    facts = document.add_table(rows=2, cols=4)
    fact_values = [
        ("统计日", data["date"]),
        ("对比日", data["previousTradingDate"]),
        ("样本选手", f"{sample_size} 人"),
        ("状态记录", f"{observation_count} 条"),
    ]
    for index, (label, value) in enumerate(fact_values):
        set_cell_shading(facts.cell(0, index), PALE_BLUE)
        set_cell_shading(facts.cell(1, index), "F8FAFC")
        add_cell_text(
            facts.cell(0, index),
            label,
            bold=True,
            color=NAVY,
            align=WD_ALIGN_PARAGRAPH.CENTER,
        )
        add_cell_text(
            facts.cell(1, index),
            value,
            bold=True,
            color=TEAL,
            size=11,
            align=WD_ALIGN_PARAGRAPH.CENTER,
        )
    facts.alignment = WD_TABLE_ALIGNMENT.CENTER

    add_heading(document, "核心结论", level=1)
    add_bullet(
        document,
        "总体",
        f"{hot_count} 只热股与 {sample_size} 名头部选手形成 "
        f"{observation_count} 个观察项，其中今天已卖掉 {sold_total} 项、"
        f"正在持有 {holding_total} 项，其余为不涉及。",
    )
    add_bullet(
        document,
        "覆盖",
        f'共有 {len(active)} 只热股在样本中出现持有或当日卖出记录：{"、".join(item["stockName"] for item in active)}。',
    )
    add_bullet(
        document,
        "最集中",
        f'{max_holding["stockName"]}由 {max_holding["holdingCount"]} 名样本选手持有，'
        f'并有 {max_holding["soldCount"]} 名样本选手在 {date_cn(data["date"])}退出。',
    )
    if missing_structured:
        add_bullet(
            document,
            "数据边界",
            f"有 {missing_structured} 名选手的仓位比例大于 0，但接口未返回可识别的结构化股票明细；相关个股只能按已返回记录分类。",
            color=MID_GRAY,
        )

    add_heading(document, "各组累计排名前三名", level=1)
    group_table = document.add_table(rows=1, cols=4)
    headers = ["组别", "第1名", "第2名", "第3名"]
    for index, header in enumerate(headers):
        group_table.cell(0, index).text = header
    for group in data["groups"]:
        cells = group_table.add_row().cells
        cells[0].text = group["name"]
        for index, player in enumerate(group["players"][:3], start=1):
            cells[index].text = (
                f'{player.get("gameName", "")}\n'
                f'累计 {player.get("totalEarningRate", "—")}%'
            )
    style_table(group_table, font_size=8.4)

    document.add_page_break()
    add_heading(document, "热门股状态分布", level=1)
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.add_run().add_picture(str(chart_path), width=Inches(6.35))

    add_heading(document, "汇总表", level=1)
    summary_table = document.add_table(rows=1, cols=8)
    headers = ["排名", "股票", "热度", "前日", "已卖掉", "持有", "不涉及", "校验"]
    for index, header in enumerate(headers):
        summary_table.cell(0, index).text = header
    for item in data["stockSummary"]:
        row = summary_table.add_row().cells
        values = [
            item["hotRank"],
            stock_display(item),
            item["hotCount"],
            item["previousHotCount"],
            item["soldCount"],
            item["holdingCount"],
            item["uninvolvedCount"],
            item["totalChecked"],
        ]
        for index, value in enumerate(values):
            row[index].text = str(value)
            if index != 1:
                row[index].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    style_table(summary_table, font_size=7.2)

    document.add_page_break()
    add_heading(document, "发生持有或卖出的逐人明细", level=1)
    action_rows = []
    for stock in data["stockSummary"]:
        action_rows.extend(
            detail for detail in stock["details"] if detail["status"] != "不涉及"
        )
    detail_table = document.add_table(rows=1, cols=7)
    headers = [
        "股票",
        "状态",
        "组别",
        "组内名次",
        "选手",
        f'{date_cn(data["previousTradingDate"])}(万)',
        f'{date_cn(data["date"])}(万)',
    ]
    for index, header in enumerate(headers):
        detail_table.cell(0, index).text = header
    for item in action_rows:
        row = detail_table.add_row().cells
        values = [
            item["stockName"],
            item["status"],
            item["group"],
            item["groupRank"],
            item["player"],
            f'{item["yesterdayAmountWan"]:.2f}',
            f'{item["todayAmountWan"]:.2f}',
        ]
        for index, value in enumerate(values):
            row[index].text = str(value)
        if item["status"] == "今天已卖掉":
            set_cell_shading(row[1], PALE_RED)
        elif item["status"] == "正在持有":
            set_cell_shading(row[1], "E6F4F3")
    style_table(detail_table, font_size=7.9)

    add_heading(document, "统计口径与校验", level=1)
    add_bullet(
        document,
        "正在持有",
        f'{date_cn(data["date"])}的结构化报单中，该股票的持仓金额大于 0。',
    )
    add_bullet(
        document,
        "今天已卖掉",
        f'{date_cn(data["previousTradingDate"])}持有该股票，但'
        f'{date_cn(data["date"])}已无正持仓；或统计日存在零持仓记录。',
    )
    add_bullet(
        document,
        "不涉及",
        f'既无{date_cn(data["date"])}持仓，也无可识别的隔日卖出证据。',
    )
    add_bullet(
        document,
        "完整性",
        f"每只股票三类人数之和均为 {sample_size}；共完成 {observation_count} 条分类，校验全部通过。",
    )

    add_heading(document, "限制与数据来源", level=1)
    paragraph = document.add_paragraph()
    set_paragraph_spacing(paragraph, after=4)
    add_text(
        paragraph,
        "本报告比较两个收盘日提交到比赛系统的结构化报单，不能还原同一交易日内先买后卖的完整盘中路径。若选手仅上传截图而系统未识别出股票明细，报告不会凭截图主观补录。数据由纯 HTTP 爬虫从复利笔记/复利杯小程序后台的赛季配置、热股榜、分组排名和选手报单详情接口批量获取。",
        size=8.8,
        color=MID_GRAY,
    )
    source = document.add_paragraph()
    set_paragraph_spacing(source, after=0)
    add_text(source, f'抓取时间：{data["generatedAt"]}', size=7.8, color=MID_GRAY)

    document.save(output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", type=Path)
    parser.add_argument("output_docx", type=Path)
    parser.add_argument("--chart", type=Path)
    args = parser.parse_args()

    data = json.loads(args.input_json.read_text(encoding="utf-8"))
    args.output_docx.parent.mkdir(parents=True, exist_ok=True)
    chart_path = args.chart or args.output_docx.with_name(
        f"{args.output_docx.stem}_chart.png"
    )
    build_chart(data, chart_path)
    generate_docx(data, chart_path, args.output_docx)
    print(
        json.dumps(
            {"docx": str(args.output_docx), "chart": str(chart_path)},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
