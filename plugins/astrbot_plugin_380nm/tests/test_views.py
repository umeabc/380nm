"""Read-only queue/account views and secrets-leak regression coverage."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from astrbot_plugin_380nm.views import (  # noqa: E402
    format_accounts, format_jobs, format_time, safe_reason,
)


BASE = "https://380.example.test/prefix/api/"


class JobsViewTests(unittest.TestCase):
    def test_recent_jobs_are_capped_sorted_and_show_complete_ids(self):
        jobs = [{"id": "job_" + str(i) + "x" * 45, "status": "pending", "title": "标题" + str(i),
                 "updatedAt": f"2026-11-0{i + 1}T12:00:00Z", "scheduledAt": "2026-11-10T12:00:00Z"}
                for i in range(7)]
        result = format_jobs(jobs, BASE)
        self.assertIn("最近任务（5/7", result)
        self.assertIn(jobs[6]["id"], result)
        self.assertNotIn(jobs[1]["id"], result)
        self.assertLess(result.index(jobs[6]["id"]), result.index(jobs[5]["id"]))
        self.assertIn("https://380.example.test/prefix/queue/" + jobs[6]["id"], result)
        self.assertIn("2026-11-10 20:00", result)
        self.assertIn("/bd queue <任务ID>", result)

    def test_exact_id_detailed_body_failure_and_publish_link(self):
        job = {"id": "job_123", "status": "failed", "title": "自定义标题", "text": "正文" * 350,
               "attempts": 2, "scheduledAt": "2026-11-03T12:00:00Z", "publishedAt": None,
               "lastError": "B站返回 412 风控；SESSDATA=really-secret; token=top-secret",
               "dynamicUrl": "https://t.bilibili.com/123456?token=publish-secret#tracking"}
        self.assertIn("未找到", format_jobs([job], BASE, "job_12"))
        result = format_jobs([job], BASE, "job_123")
        self.assertIn("状态：失败", result)
        self.assertIn("实际发布：尚未发布", result)
        self.assertIn("次数）：2", result)
        self.assertIn("B站返回 412 风控", result)
        self.assertIn("已发布动态：https://t.bilibili.com/123456", result)
        self.assertNotIn("really-secret", result)
        self.assertNotIn("top-secret", result)
        self.assertNotIn("publish-secret", result)
        body = next(line for line in result.splitlines() if line.startswith("正文："))
        self.assertLessEqual(len(body.removeprefix("正文：")), 500)
        self.assertIn("…", body)

    def test_list_shows_failure_reason_and_published_url(self):
        result = format_jobs([{"id": "failed", "status": "failed", "lastError": "图片过大"},
                              {"id": "published", "status": "published", "dynamicId": "999"}], BASE)
        self.assertIn("失败原因：图片过大", result)
        self.assertIn("https://t.bilibili.com/999", result)

    def test_published_urls_have_strict_host_and_path_allowlist(self):
        rejected = [
            "https://t.bilibili.com.evil.test/123", "http://t.bilibili.com/123",
            "https://user:password@t.bilibili.com/123", "https://t.bilibili.com:443/123",
            "https://www.bilibili.com/video/123", "https://t.bilibili.com/secret",
            "https://www.bilibili.com/opus/123/../../evil", "https://t.bilibili.com:bad/123",
        ]
        for url in rejected:
            with self.subTest(url=url):
                result = format_jobs([{"id": "j", "dynamicUrl": url}], BASE, "j")
                self.assertNotIn("已发布动态", result)
                self.assertNotIn(url, result)
        self.assertIn("https://www.bilibili.com/opus/42", format_jobs(
            [{"id": "j", "dynamicUrl": "https://www.bilibili.com/opus/42/"}], BASE, "j"))

    def test_empty_malformed_fields_and_encoded_job_path(self):
        self.assertIn("发布队列为空", format_jobs([], BASE))
        self.assertIn("未找到", format_jobs([], BASE, "not-visible"))
        result = format_jobs([None, {"id": "a/b?c", "title": {"token": "secret"}, "lastError": {"token": "secret"}}], BASE, "a/b?c")
        self.assertIn("/queue/a%2Fb%3Fc", result)
        self.assertIn("正文：无正文", result)
        self.assertNotIn("secret", result)


class ErrorRedactionTests(unittest.TestCase):
    def test_error_preserves_useful_reason_redacts_secret_pairs_and_headers(self):
        cases = [
            ('上传超时 SESSDATA=secret-value; bili_jct=csrf-value', ["secret-value", "csrf-value"]),
            ('请求失败 {"refreshToken": "refresh secret", "password": "p a s s"}', ["refresh secret", "p a s s"]),
            ("请求失败 token='quoted secret' API_KEY: private-key", ["quoted secret", "private-key"]),
            ("连接失败 Authorization: Bearer header-secret; next=secret\n请稍后重试", ["header-secret", "next=secret"]),
            ("上传失败 Cookie: foo=unknown-secret; SESSDATA=secret-value", ["unknown-secret", "secret-value"]),
            ("连接失败 https://user:pass@private.test/private-path?token=secret", ["private.test", "user:pass", "secret"]),
            ("请求失败 Bearer bearer-secret Basic dXNlcjpwYXNz", ["bearer-secret", "dXNlcjpwYXNz"]),
            ('失败 password="unterminated-secret', ["unterminated-secret"]),
            ("失效 Cookie: a=first-cookie\n  b=folded-cookie\n请重试", ["first-cookie", "folded-cookie"]),
            (r"连接失败 https:\/\/user:pass@private.test/path", ["user:pass", "private.test"]),
        ]
        for message, secrets in cases:
            with self.subTest(message=message):
                result = safe_reason(message)
                self.assertIn("[", result)
                for secret in secrets:
                    self.assertNotIn(secret, result)
        self.assertEqual(safe_reason("Cookie已失效，请扫码更新"), "Cookie已失效，请扫码更新")

    def test_stack_not_echoed_and_unknown_objects_not_dumped(self):
        self.assertEqual(safe_reason("上传 412 错误\n    at secretFunction (C:/secret/path.js:1)"), "上传 412 错误")
        self.assertEqual(safe_reason({"message": "图片过大", "token": "hidden"}), "图片过大")
        self.assertEqual(safe_reason({"password": "hidden"}), "未记录")
        self.assertEqual(safe_reason(["hidden"]), "未记录")

    def test_x_pixiv_and_bilibili_refresh_cookies_are_redacted(self):
        keys = ("auth_token", "ct0", "twitterAuth", "twitterCt0", "pixivSession", "PHPSESSID", "ac_time_value")
        message = "抓取失败 " + "; ".join(f"{key}=private-value-{i}" for i, key in enumerate(keys))
        result = safe_reason(message, limit=1000)
        self.assertIn("抓取失败", result)
        self.assertEqual(result.count("[已隐藏]"), len(keys))
        for i in range(len(keys)):
            self.assertNotIn(f"private-value-{i}", result)


class AccountViewTests(unittest.TestCase):
    def test_status_priority_and_account_management_link(self):
        accounts = [
            {"name": "未检查", "canAutoRefresh": False},
            {"name": "正常账号", "cookieStatus": {"ok": True, "checkedAt": "2026-11-02T07:00:00Z"}, "canAutoRefresh": True},
            {"name": "已过期", "cookieStatus": {"ok": False, "code": -101, "message": "Cookie已失效，请扫码更新", "refreshError": {"message": "续期检查网络失败"}}},
            {"name": "网络问题", "cookieStatus": {"ok": False, "code": None, "message": "网络异常，无法连接B站"}},
            {"name": "续期问题", "cookieStatus": {"ok": False, "code": 0, "message": "Cookie有效，但自动续期失败", "refreshError": {"message": "续期错误"}}, "canAutoRefresh": True},
            {"name": "手动账号", "cookieStatus": {"ok": True}, "canAutoRefresh": False, "lastCookieRefreshAt": "2026-11-01T12:30:00+08:00"},
        ]
        result = format_accounts(accounts, BASE)
        self.assertIn("未检查：未检测", result)
        self.assertIn("正常账号：有效", result)
        self.assertIn("最后登录检查：2026-11-02 15:00", result)
        self.assertIn("已过期：失效", result)
        self.assertIn("续期异常：续期检查网络失败", result)
        self.assertIn("网络问题：检查异常", result)
        self.assertIn("续期问题：续期异常（登录有效）", result)
        self.assertIn("手动账号：有效\n自动续期：不支持", result)
        self.assertIn("最后续期检查：2026-11-01 12:30", result)
        self.assertIn("https://380.example.test/prefix/accounts", result)
        self.assertIn("只读取已保存的状态", result)

    def test_accounts_never_display_credentials_even_masked_values(self):
        result = format_accounts([{
            "name": "主账号", "sessdata": "masked****data", "bili_jct": "masked****csrf",
            "refreshToken": "top-secret-refresh", "sid": "private-sid", "password": "passwd-secret",
            "credentials": {"token": "nested-secret"},
            "cookieStatus": {"ok": False, "code": -101, "message": "失效 Cookie: custom=hidden-cookie",
                             "refreshError": {"message": '续期失败 refreshToken="refresh-hidden"'}},
        }], BASE)
        for secret in ("masked****data", "masked****csrf", "top-secret-refresh", "private-sid", "passwd-secret", "nested-secret", "hidden-cookie", "refresh-hidden"):
            self.assertNotIn(secret, result)
        self.assertIn("失效", result)

    def test_empty_and_partial_account_snapshots(self):
        self.assertIn("暂无可见", format_accounts([], BASE))
        result = format_accounts([None, {"name": {"token": "secret"}, "cookieStatus": []}], BASE)
        self.assertIn("未命名账号：未检测", result)
        self.assertNotIn("secret", result)

    def test_time_conversion_is_year_inclusive_and_host_independent(self):
        self.assertEqual(format_time("2026-12-31T20:00:00Z"), "2027-01-01 04:00")
        self.assertEqual(format_time("2026-11-03T20:00:00"), "2026-11-03 20:00")
        self.assertEqual(format_time(None), "未设置")
        self.assertEqual(format_time("invalid"), "未设置")


if __name__ == "__main__":
    unittest.main()
