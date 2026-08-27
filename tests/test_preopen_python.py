from python_engine.preopen_daily_task import (
    _author_metadata,
    _normalized_publish_time,
    _window,
    build_industry_buckets,
    influencer_candidates,
    split_news,
)
from datetime import date
import json


def test_strict_window_boundaries():
    start, end = _window(date(2026, 8, 21))
    assert _normalized_publish_time("2026-08-20", start, end) == "2026-08-20 00:00:00"
    assert _normalized_publish_time("2026-08-21 09:14:59", start, end) == "2026-08-21 09:14:59"
    assert _normalized_publish_time("2026-08-21", start, end) is None
    assert _normalized_publish_time("2026-08-19 23:59:59", start, end) is None
    assert _normalized_publish_time("2026-08-21 09:15:00", start, end) is None


def test_domestic_wrap_does_not_become_us_market_news():
    rows = [
        {"title": "【午报】创业板指上涨，美股创新药映射", "content": "纳斯达克生物科技上涨", "publish_time": "2026-08-20", "_score": 1},
        {"title": "纳斯达克大幅收涨", "content": "美股科技股上涨", "publish_time": "2026-08-20", "_score": 1},
        {"title": "AI服务器需求增长", "content": "A股PCB产业链受益", "publish_time": "2026-08-20", "_score": 1},
    ]
    domestic, us_market = split_news(rows)
    assert {item["title"] for item in domestic} == {rows[0]["title"], rows[2]["title"]}
    assert [item["title"] for item in us_market] == [rows[1]["title"]]


def test_verified_author_metadata_and_industry_grouping():
    metadata = _author_metadata(json.dumps({"userName": "认证作者", "userID": 7, "auth": 1, "viewNum": 300, "usefulnum": 12, "replyNum": 8}, ensure_ascii=False))
    assert metadata["author"] == "认证作者"
    assert metadata["author_verified"] is True
    assert metadata["view_count"] == 300
    rows = [
        {"post_author": "认证作者", "author_verified": True, "author_badge": "平台认证", "post_publish_time": "2026-08-20 08:00:00", "post_origin_url": "https://example.test/1", "post_hot_score": 10, "view_count": 300, "like_count": 12, "reply_count": 8, "post_title": "医药观点", "post_content": "看好临床催化", "stock_mentions": [{"code": "600000.SH", "name": "测试制药", "industry": "化学制药"}], "industry_mentions": ["化学制药"]},
        {"post_author": "普通作者", "author_verified": False, "author_badge": "", "post_publish_time": "2026-08-20 08:10:00", "post_origin_url": "https://example.test/2", "post_hot_score": 8, "view_count": 20, "like_count": 1, "reply_count": 1, "post_title": "行业观点", "post_content": "关注医药", "stock_mentions": [{"code": "600000.SH", "name": "测试制药", "industry": "化学制药"}], "industry_mentions": ["化学制药"]},
    ]
    buckets = build_industry_buckets(rows)
    assert buckets[0]["industry"] == "化学制药"
    assert buckets[0]["stock_rank"][0]["mention_count"] == 2
    assert influencer_candidates(rows)[0]["post_author"] == "认证作者"
