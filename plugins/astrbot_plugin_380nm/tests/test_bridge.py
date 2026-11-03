"""Contract tests against local HTTP only; no X or real 380nm account is used."""

import asyncio
import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import web


sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from astrbot_plugin_380nm.bridge import (  # noqa: E402
    BridgeError, Client, DraftBridge, TEMPLATE_NAME, extract_links,
    normalize_base_url, queue_summary,
)


URL = "https://x.com/artist/status/1850000000000000000"
DESCRIPTION = "  作者完整说明\n\n第二段 🎨\t原始空白保留。\n" + "长文也必须完整。" * 300


class Local380nm:
    """Subset of src/routes.js, with explicit network-failure controls."""

    def __init__(self):
        self.login_count = 0
        self.cookie_values = []
        self.calls = []
        self.sessions = set()
        self.templates = []
        self.drafts = []
        self.jobs = []
        self.accounts = []
        self.parsed_urls = []
        self.saved_payloads = []
        self.patched_payloads = []
        self.force_401 = 0
        self.parse_entered = asyncio.Event()
        self.parse_release = None
        self.save_failure = None
        self.patch_failure = None
        self.login_status = 200
        self.events = [
            {"type": "progress", "step": 0, "done": 1, "sub": "正在读取作者"},
            {"type": "progress", "step": 2, "done": 3, "sub": "原图"},
            {"type": "done", "step": 4, "work": {
                "platform": "x", "workId": "1850000000000000000",
                "title": "作者完整说明", "description": DESCRIPTION,
                "author": "作者 A", "handle": "artist", "url": URL,
            }, "images": [
                {"key": "img-1", "name": "first.jpg", "url": "/images/first.jpg"},
                {"key": "img-2", "name": "second.png", "url": "/images/second.png"},
            ], "total": 2},
        ]
        self.raw_stream = None
        self.chunk_sizes = (1, 7, 2, 29, 3, 101, 4096)

    @property
    def done(self):
        return self.events[-1]

    async def start(self):
        @web.middleware
        async def authentication(request, handler):
            self.calls.append((request.method, request.path))
            if request.path != "/api/auth/login":
                cookie = request.cookies.get("sid")
                self.cookie_values.append(cookie)
                if self.force_401:
                    self.force_401 -= 1
                    self.sessions.discard(cookie)
                    return web.json_response({"error": "expired"}, status=401)
                if cookie not in self.sessions:
                    return web.json_response({"error": "not signed in"}, status=401)
            return await handler(request)

        app = web.Application(middlewares=[authentication])
        app.router.add_post("/api/auth/login", self.login)
        app.router.add_get("/api/drafts", self.list_drafts)
        app.router.add_post("/api/drafts", self.save_draft)
        app.router.add_patch("/api/drafts/{draft_id}", self.patch_draft)
        app.router.add_get("/api/templates", self.list_templates)
        app.router.add_post("/api/templates", self.save_template)
        app.router.add_post("/api/library/parse-work", self.parse_work)
        app.router.add_get("/api/jobs", self.list_jobs)
        app.router.add_get("/api/accounts", self.list_accounts)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base_url = "http://127.0.0.1:" + str(site._server.sockets[0].getsockname()[1])

    async def close(self):
        if self.parse_release:
            self.parse_release.set()
        await self.runner.cleanup()

    async def login(self, request):
        self.login_count += 1
        if await request.json() != {"username": "test-user", "password": "test-password"}:
            return web.json_response({"error": "wrong credentials"}, status=401)
        if self.login_status != 200:
            return web.json_response({"error": "upstream-private-detail"}, status=self.login_status)
        sid = "test-session-" + str(self.login_count)
        self.sessions.add(sid)
        response = web.json_response({"ok": True})
        response.set_cookie("sid", sid, httponly=True, path="/")
        return response

    async def list_drafts(self, request):
        return web.json_response({"drafts": self.drafts})

    async def list_templates(self, request):
        if request.query.get("category") != "dynamic":
            return web.json_response({"error": "category required"}, status=400)
        return web.json_response({"templates": self.templates})

    async def save_template(self, request):
        body = await request.json()
        template = dict(body, id="template-" + str(len(self.templates) + 1))
        self.templates.append(template)
        return web.json_response({"template": template})

    async def parse_work(self, request):
        body = await request.json()
        self.parsed_urls.append(body["url"])
        self.parse_entered.set()
        if self.parse_release:
            await self.parse_release.wait()
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson; charset=utf-8"})
        await response.prepare(request)
        data = self.raw_stream
        if data is None:
            data = ("\n" + "\n".join(json.dumps(item, ensure_ascii=False) for item in self.events) + "\n").encode("utf-8")
        offset = 0
        index = 0
        while offset < len(data):
            size = self.chunk_sizes[index % len(self.chunk_sizes)]
            await response.write(data[offset:offset + size])
            offset += size
            index += 1
            # Exercise HTTP chunk boundaries and UTF-8 splits without long waits.
            await asyncio.sleep(0)
        await response.write_eof()
        return response

    async def save_draft(self, request):
        body = await request.json()
        self.saved_payloads.append(body)
        # Mirror observable backend input constraints, rather than client internals.
        template = next((t for t in self.templates if t["id"] == body.get("templateId")), None)
        title = str(body.get("title") or "").strip()
        valid_keys = {image["key"] for image in self.done.get("images", [])}
        if (not template or not body.get("variables", {}).get("content", "").strip()
                or len(title.encode("utf-16-le")) // 2 > 20
                or len(body.get("images", [])) > min(9, template.get("maxImages", 9))
                or any(i.get("key") not in valid_keys for i in body.get("images", []))):
            return web.json_response({"error": "invalid draft input"}, status=400)
        draft = dict(body, id="draft-" + str(len(self.drafts) + 1), title=title,
                     text=body["variables"]["content"].strip())
        if self.save_failure != "before_commit":
            self.drafts.append(draft)
        if self.save_failure:
            # TCP disconnect: POST may have committed, so a second POST is unsafe.
            request.transport.abort()
            return web.Response()
        return web.json_response({"draft": draft})

    async def list_jobs(self, request):
        return web.json_response({"jobs": self.jobs})

    async def list_accounts(self, request):
        return web.json_response({"accounts": self.accounts})

    async def patch_draft(self, request):
        body = await request.json()
        self.patched_payloads.append(body)
        draft = next((item for item in self.drafts if item["id"] == request.match_info["draft_id"]), None)
        if draft is None:
            return web.json_response({"error": "missing draft"}, status=404)
        if self.patch_failure != "before_commit":
            draft.update(body)
        if self.patch_failure:
            request.transport.abort()
            return web.Response()
        return web.json_response({"draft": draft})


class HttpContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = Local380nm()
        await self.server.start()
        self.client = Client(self.server.base_url, "test-user", "test-password")
        self.bridge = DraftBridge(self.client)

    async def asyncTearDown(self):
        await self.client.close()
        await self.server.close()

    async def test_full_import_keeps_raw_description_credit_and_ordered_images_without_publishing(self):
        result = await self.bridge.import_link(URL)
        draft = result["draft"]
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(draft["variables"]["description"], DESCRIPTION)
        self.assertEqual(draft["variables"]["content"],
                         DESCRIPTION + "\n\n作者：作者 A\nX：@artist\n来源：" + URL)
        self.assertEqual(draft["variables"]["sourceUrl"], URL)
        self.assertEqual(draft["images"], [{"key": "img-1"}, {"key": "img-2"}])
        self.assertEqual(draft["scheduledAt"], "")
        self.assertEqual(self.server.jobs, [])
        self.assertEqual({path for method, path in self.server.calls if method == "POST"},
                         {"/api/auth/login", "/api/templates", "/api/library/parse-work", "/api/drafts"})
        self.assertEqual((self.bridge.active, self.bridge.waiting), (0, 0))

    async def test_ip_host_keeps_session_cookie_and_reuses_login(self):
        await self.client.request("GET", "/jobs")
        await self.client.request("GET", "/drafts")
        self.assertEqual(self.server.login_count, 1)
        self.assertEqual(self.server.cookie_values, ["test-session-1", "test-session-1"])

    async def test_401_refreshes_session_once(self):
        await self.client.request("GET", "/jobs")
        self.server.force_401 = 1
        self.assertEqual(await self.client.request("GET", "/jobs"), {"jobs": []})
        self.assertEqual(self.server.login_count, 2)
        self.assertEqual(self.server.cookie_values[-2:], ["test-session-1", "test-session-2"])

    async def test_repeated_401_stops_instead_of_login_loop(self):
        self.server.force_401 = 2
        with self.assertRaisesRegex(BridgeError, "会话无效"):
            await self.client.request("GET", "/jobs")
        self.assertEqual(self.server.login_count, 2)

    async def test_login_error_is_safe_and_does_not_call_parse(self):
        self.server.login_status = 401
        with self.assertRaisesRegex(BridgeError, "登录失败") as caught:
            await self.bridge.import_link(URL)
        self.assertNotIn("upstream-private-detail", str(caught.exception))
        self.assertEqual(self.server.parsed_urls, [])
        self.assertEqual(self.server.saved_payloads, [])

    async def test_ndjson_progress_arbitrary_chunks_and_utf8_splits(self):
        self.server.done["work"]["description"] = "原始说明\n\n必须保留 🎨"
        self.server.chunk_sizes = (1,)
        result = await self.client.request("POST", "/library/parse-work", {"url": URL}, stream=True)
        self.assertEqual(result["type"], "done")
        self.assertEqual(result["work"]["description"], "原始说明\n\n必须保留 🎨")
        self.assertEqual(result["total"], 2)

    async def test_ndjson_final_record_without_newline(self):
        self.server.raw_stream = json.dumps(self.server.done, ensure_ascii=False).encode("utf-8")
        result = await self.client.request("POST", "/library/parse-work", {"url": URL}, stream=True)
        self.assertEqual(result["images"][0]["key"], "img-1")

    async def test_error_record_never_saves_draft_or_exposes_upstream_text(self):
        self.server.events = [{"type": "progress", "step": 0},
                              {"type": "error", "error": "restricted", "message": "auth_token=DO-NOT-LEAK"}]
        with self.assertRaisesRegex(BridgeError, "受限") as caught:
            await self.bridge.import_link(URL)
        self.assertNotIn("DO-NOT-LEAK", str(caught.exception))
        self.assertEqual(self.server.saved_payloads, [])
        self.assertEqual((self.bridge.active, self.bridge.waiting), (0, 0))

    async def test_premature_eof_never_saves_draft(self):
        self.server.events = [{"type": "progress", "step": 0}]
        with self.assertRaisesRegex(BridgeError, "提前结束"):
            await self.bridge.import_link(URL)
        self.assertEqual(self.server.saved_payloads, [])

    async def test_malformed_ndjson_never_saves_draft(self):
        self.server.raw_stream = b'{"type":"progress"}\nnot-json\n'
        with self.assertRaisesRegex(BridgeError, "无法解析"):
            await self.bridge.import_link(URL)
        self.assertEqual(self.server.saved_payloads, [])

    async def test_empty_or_excess_images_are_not_silently_saved(self):
        for count, total in [(0, 0), (10, 10), (9, 10)]:
            with self.subTest(count=count, total=total):
                self.server.done["images"] = [{"key": "img-" + str(i)} for i in range(count)]
                self.server.done["total"] = total
                with self.assertRaises(BridgeError):
                    await self.bridge.import_link(URL)
                self.assertEqual(self.server.saved_payloads, [])

    async def test_duplicate_id_with_other_host_handle_query_does_not_fetch_again(self):
        first = await self.bridge.import_link(URL)
        for url in [URL + "?s=20&t=anything", "https://twitter.com/another/status/1850000000000000000",
                    "https://mobile.twitter.com/artist/status/1850000000000000000"]:
            with self.subTest(url=url):
                result = await self.bridge.import_link(url)
                self.assertTrue(result["duplicate"])
                self.assertEqual(result["draft"]["id"], first["draft"]["id"])
        self.assertEqual(self.server.parsed_urls, [URL])
        self.assertEqual(len(self.server.saved_payloads), 1)

    async def test_existing_draft_alternate_source_host_is_recognized(self):
        self.server.drafts.append({"id": "old", "variables": {
            "sourceUrl": "https://twitter.com/someone/status/1850000000000000000?ref=share"}})
        result = await self.bridge.import_link(URL)
        self.assertTrue(result["duplicate"])
        self.assertEqual(result["draft"]["id"], "old")
        self.assertEqual(self.server.parsed_urls, [])
        self.assertEqual(self.server.templates, [])

    async def test_historical_non_string_sources_do_not_prevent_import(self):
        for value in [None, [], {}, 123]:
            self.server.drafts.append({"id": "old-" + str(len(self.server.drafts)),
                                       "variables": {"sourceUrl": value}})
        result = await self.bridge.import_link(URL)
        self.assertFalse(result["duplicate"])
        self.assertEqual(len(self.server.saved_payloads), 1)

    async def test_concurrent_duplicate_serializes_and_reports_queue_state(self):
        self.server.parse_release = asyncio.Event()
        first = asyncio.create_task(self.bridge.import_link(URL))
        await asyncio.wait_for(self.server.parse_entered.wait(), 2)
        second = asyncio.create_task(self.bridge.import_link(URL + "?s=20"))
        try:
            await asyncio.sleep(0)
            self.assertEqual((self.bridge.active, self.bridge.waiting), (1, 1))
        finally:
            self.server.parse_release.set()
        results = await asyncio.gather(first, second)
        self.assertEqual([result["duplicate"] for result in results], [False, True])
        self.assertEqual(len(self.server.parsed_urls), 1)
        self.assertEqual(len(self.server.saved_payloads), 1)
        self.assertEqual((self.bridge.active, self.bridge.waiting), (0, 0))

    async def test_cancel_waiting_request_restores_queue_counters(self):
        self.server.parse_release = asyncio.Event()
        first = asyncio.create_task(self.bridge.import_link(URL))
        await asyncio.wait_for(self.server.parse_entered.wait(), 2)
        waiting = asyncio.create_task(self.bridge.import_link(URL))
        await asyncio.sleep(0)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual((self.bridge.active, self.bridge.waiting), (1, 0))
        self.server.parse_release.set()
        await first
        self.assertEqual((self.bridge.active, self.bridge.waiting), (0, 0))

    async def test_lost_save_response_recovers_committed_draft_without_second_post(self):
        self.server.save_failure = "after_commit"
        result = await self.bridge.import_link(URL)
        self.assertEqual(result["draft"]["id"], "draft-1")
        self.assertFalse(result["duplicate"])
        self.assertEqual(len(self.server.saved_payloads), 1)
        self.assertEqual(len(self.server.drafts), 1)
        self.assertEqual(self.server.calls.count(("GET", "/api/drafts")), 2)

    async def test_lost_save_before_commit_reports_uncertainty_without_blind_retry(self):
        self.server.save_failure = "before_commit"
        with self.assertRaisesRegex(BridgeError, "保存未确认"):
            await self.bridge.import_link(URL)
        self.assertEqual(len(self.server.saved_payloads), 1)
        self.assertEqual(self.server.drafts, [])

    async def test_unicode_title_obeys_javascript_twenty_unit_limit(self):
        self.server.done["work"]["title"] = "中" * 19 + "🎨" * 20
        result = await self.bridge.import_link(URL)
        title = result["draft"]["title"]
        self.assertTrue(self.server.done["work"]["title"].startswith(title))
        self.assertLessEqual(len(title.encode("utf-16-le")) // 2, 20)
        self.assertGreaterEqual(len(title.encode("utf-16-le")) // 2, 19)
        self.assertNotIn("\ufffd", title)

    async def test_backend_js_slice_truncated_surrogate_in_title_does_not_lose_import(self):
        # parseXWork's JS .slice(0, 30) can cut an emoji after its high surrogate.
        self.server.done["work"]["title"] = "中" * 29 + "\ud83c"
        self.server.raw_stream = (json.dumps(self.server.done) + "\n").encode("utf-8")
        result = await self.bridge.import_link(URL)
        self.assertEqual(result["draft"]["title"], "中" * 20)

    async def test_whitespace_description_is_preserved_and_credit_supplies_content(self):
        self.server.done["work"]["description"] = " \n\t "
        self.server.done["work"]["title"] = "  "
        result = await self.bridge.import_link(URL)
        self.assertEqual(result["draft"]["variables"]["description"], " \n\t ")
        self.assertIn("作者：作者 A", result["draft"]["text"])

    async def test_backend_without_description_warns_instead_of_using_truncated_title(self):
        del self.server.done["work"]["description"]
        result = await self.bridge.import_link(URL)
        self.assertTrue(result["warnings"])
        self.assertEqual(result["draft"]["variables"]["description"], "")
        self.assertNotIn(self.server.done["work"]["title"], result["draft"]["text"])

    async def test_matching_template_is_reused_but_altered_template_is_not(self):
        self.server.templates = [{"id": "unrelated", "name": TEMPLATE_NAME, "content": "changed", "maxImages": 9},
                                 {"id": "suitable", "name": TEMPLATE_NAME, "content": "{{content}}", "maxImages": 9}]
        result = await self.bridge.import_link(URL)
        self.assertEqual(result["draft"]["templateId"], "suitable")
        self.assertNotIn(("POST", "/api/templates"), self.server.calls)

    async def test_custom_title_and_schedule_persist_without_creating_a_job(self):
        result = await self.bridge.import_link(URL, title="  指定标题  ", scheduled_at="2099-12-25T20:30:00+08:00")
        self.assertEqual(result["draft"]["title"], "指定标题")
        self.assertEqual(result["draft"]["scheduledAt"], "2099-12-25T12:30:00Z")
        self.assertEqual(result["draft"]["variables"]["description"], DESCRIPTION)
        self.assertEqual(self.server.jobs, [])
        self.assertFalse(any(path.startswith("/api/jobs") for _, path in self.server.calls))

    async def test_invalid_explicit_fields_are_rejected_before_http(self):
        for fields in [{"title": " "}, {"title": "中" * 21}, {"title": "🎨" * 11},
                       {"title": 123}, {"scheduled_at": "tomorrow"},
                       {"scheduled_at": "2099-12-25T20:00:00"}, {"scheduled_at": 123}]:
            with self.subTest(fields=fields), self.assertRaises(BridgeError):
                await self.bridge.import_link(URL, **fields)
        self.assertEqual(self.server.calls, [])
        self.assertEqual((self.bridge.active, self.bridge.waiting), (0, 0))

    async def test_duplicate_updates_only_explicit_fields_without_downloading(self):
        initial = await self.bridge.import_link(URL, title="原标题", scheduled_at="2099-01-01T12:00:00Z")
        original = initial["draft"]
        retitled = await self.bridge.import_link(URL + "?s=20", title="新标题")
        self.assertTrue(retitled["duplicate"])
        self.assertTrue(retitled["updated"])
        self.assertEqual(retitled["draft"]["scheduledAt"], "2099-01-01T12:00:00Z")
        rescheduled = await self.bridge.import_link(URL, scheduled_at="2099-01-02T20:30:00+08:00")
        self.assertEqual(rescheduled["draft"]["title"], "新标题")
        self.assertEqual(rescheduled["draft"]["scheduledAt"], "2099-01-02T12:30:00Z")
        unchanged = await self.bridge.import_link(URL)
        self.assertFalse(unchanged["updated"])
        self.assertEqual(unchanged["draft"], rescheduled["draft"])
        self.assertEqual(unchanged["draft"]["variables"], original["variables"])
        self.assertEqual(unchanged["draft"]["images"], original["images"])
        self.assertEqual(self.server.patched_payloads, [{"title": "新标题"}, {"scheduledAt": "2099-01-02T12:30:00Z"}])
        self.assertEqual(self.server.parsed_urls, [URL])
        self.assertEqual(len(self.server.saved_payloads), 1)
        self.assertEqual(self.server.jobs, [])

    async def test_lost_patch_response_checks_committed_fields_without_second_patch(self):
        await self.bridge.import_link(URL)
        self.server.patch_failure = "after_commit"
        result = await self.bridge.import_link(URL, title="修订标题", scheduled_at="2099-01-02T20:30:00+08:00")
        self.assertTrue(result["updated"])
        self.assertEqual(result["draft"]["title"], "修订标题")
        self.assertEqual(result["draft"]["scheduledAt"], "2099-01-02T12:30:00Z")
        self.assertEqual(len(self.server.patched_payloads), 1)
        self.assertEqual(self.server.parsed_urls, [URL])
        self.assertEqual(len(self.server.saved_payloads), 1)

    async def test_lost_patch_before_commit_reports_uncertainty_without_retry(self):
        await self.bridge.import_link(URL, title="原标题", scheduled_at="2099-01-01T12:00:00Z")
        self.server.patch_failure = "before_commit"
        with self.assertRaisesRegex(BridgeError, "更新未确认"):
            await self.bridge.import_link(URL, title="修订标题", scheduled_at="2099-01-02T12:30:00Z")
        self.assertEqual(self.server.drafts[0]["title"], "原标题")
        self.assertEqual(self.server.drafts[0]["scheduledAt"], "2099-01-01T12:00:00Z")
        self.assertEqual(len(self.server.patched_payloads), 1)
        self.assertEqual(self.server.parsed_urls, [URL])


class TextContractTests(unittest.TestCase):
    def test_multiple_links_dedup_id_and_keep_order(self):
        message = ("看看（https://x.com/A/status/123?s=20）。\n"
                   "https://twitter.com/B/status/123\n"
                   "https://mobile.twitter.com/C/status/456#share\n"
                   "https://x.com/i/web/status/789")
        self.assertEqual(extract_links(message), ["https://x.com/A/status/123",
                                                  "https://x.com/C/status/456", "https://x.com/i/status/789"])

    def test_hostile_or_incomplete_urls_are_not_treated_as_x_works(self):
        for value in ["https://evilx.com/a/status/123", "https://x.com.evil.test/a/status/123",
                      "https://evil.test/x.com/a/status/123", "https://x.com@evil.test/a/status/123",
                      "https://evil.test@x.com/a/status/123", "https://not-twitter.com/a/status/123",
                      "https://x.com/a/status/123abc", "https://x.com/a/status/123.evil",
                      "https://x.com/a/status/", "https://x.com/a/status/123/unexpected/path",
                      "https://x.com/a/status/" + "1" * 26, "user@x.com/a/status/123"]:
            with self.subTest(value=value):
                self.assertEqual(extract_links(value), [])

    def test_photo_video_and_trailing_slash_resolve_to_the_same_work(self):
        for suffix in ["/photo/1", "/video/1", "/", "/photo/2?s=20"]:
            with self.subTest(suffix=suffix):
                self.assertEqual(extract_links(URL + suffix), [URL])

    def test_base_url_normalization_and_invalid_values(self):
        self.assertEqual(normalize_base_url(" http://127.0.0.1:3000/api/ "), "http://127.0.0.1:3000")
        self.assertEqual(normalize_base_url("https://host.test/prefix/"), "https://host.test/prefix")
        for value in ["", "host.test", "ftp://host.test", "https://u:p@host.test", "https://host.test?x=1", "https://host.test/#fragment"]:
            with self.subTest(value=value), self.assertRaises(BridgeError):
                normalize_base_url(value)

    def test_queue_counts_order_beijing_timezone_and_safe_error_summary(self):
        jobs = [
            {"id": "pending-late", "status": "pending", "title": "稍后", "scheduledAt": "2026-11-02T08:00:00Z"},
            {"id": "failed-1", "status": "failed", "title": "失败作品", "error": "sid=SECRET", "updatedAt": "2026-11-02T00:00:00Z"},
            {"id": "published-1", "status": "published"}, {"id": "canceled-1", "status": "canceled"},
            {"id": "pending-early", "status": "pending", "title": "先发", "scheduledAt": "2026-11-02T07:00:00Z"},
            {"id": "in-flight", "status": "publishing", "title": "正在发布"},
        ]
        summary = queue_summary(jobs)
        for value in ["待发布 2", "发布中 1", "已发布 1", "失败 1", "已取消 1", "11-02 15:00", "北京时间", "失败作品"]:
            self.assertIn(value, summary)
        self.assertLess(summary.index("in-flight"), summary.index("pending-early"))
        self.assertLess(summary.index("pending-early"), summary.index("pending-late"))
        self.assertNotIn("SECRET", summary)
        self.assertIn("不会自动入队", queue_summary([]))


def load_plugin_with_astrbot_stubs():
    """Decorators are inert; handler code and permission checks remain real."""
    api = types.ModuleType("astrbot.api")
    api.AstrBotConfig = dict
    api.logger = types.SimpleNamespace(error=lambda message: None)
    event = types.ModuleType("astrbot.api.event")
    event.AstrMessageEvent = object
    event.filter = types.SimpleNamespace(
        EventMessageType=types.SimpleNamespace(ALL="all"),
        event_message_type=lambda *args, **kwargs: lambda fn: fn,
        command=lambda *args, **kwargs: lambda fn: fn,
    )
    star = types.ModuleType("astrbot.api.star")
    star.Context = object
    star.Star = type("Star", (), {"__init__": lambda self, context: None})
    star.register = lambda *args, **kwargs: lambda cls: cls
    modules = {"astrbot": types.ModuleType("astrbot"), "astrbot.api": api,
               "astrbot.api.event": event, "astrbot.api.star": star}
    with patch.dict(sys.modules, modules):
        return importlib.import_module("astrbot_plugin_380nm.main").Plugin380nm


Plugin380nm = load_plugin_with_astrbot_stubs()


class FakeEvent:
    def __init__(self, message="", sender="alice", bot="bot", group="", private=True, admin=False):
        self.message, self.sender, self.bot = message, sender, bot
        self.group, self.private, self.admin = group, private, admin
        self.stopped = False

    def get_message_str(self):
        return self.message

    def get_sender_id(self):
        return self.sender

    def get_self_id(self):
        return self.bot

    def get_group_id(self):
        return self.group

    def is_private_chat(self):
        return self.private

    def is_admin(self):
        return self.admin

    def stop_event(self):
        self.stopped = True

    def is_stopped(self):
        return self.stopped

    def plain_result(self, message):
        return message


async def consume_like_astrbot(generator, event):
    """AstrBot stops advancing a handler generator after a stopped event yields."""
    messages = []
    try:
        async for message in generator:
            messages.append(message)
            if event.is_stopped():
                break
    finally:
        await generator.aclose()
    return messages


class HandlerContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_user_whitelist_allows_admin_only_and_rejects_bot_echo(self):
        plugin = Plugin380nm(None, {})
        self.assertTrue(plugin._allowed(FakeEvent(admin=True)))
        self.assertFalse(plugin._allowed(FakeEvent(admin=False)))
        self.assertFalse(plugin._allowed(FakeEvent(sender="bot", admin=True)))
        self.assertFalse(plugin._allowed(FakeEvent(sender="", admin=True)))

    async def test_group_requires_both_group_and_user_authorization(self):
        plugin = Plugin380nm(None, {"allowed_users": ["alice"], "allowed_groups": ["group-a"]})
        self.assertTrue(plugin._allowed(FakeEvent()))
        self.assertTrue(plugin._allowed(FakeEvent(group="group-a", private=False)))
        self.assertFalse(plugin._allowed(FakeEvent(group="group-b", private=False)))
        self.assertFalse(plugin._allowed(FakeEvent(sender="mallory", group="group-a", private=False, admin=True)))

    async def test_naked_urls_and_legacy_commands_do_not_trigger_or_stop_other_handlers(self):
        plugin = Plugin380nm(None, {"allowed_users": ["alice"]})
        for message in [URL, "看看 " + URL, "/380队列", "/队列状态", "/bddd " + URL]:
            with self.subTest(message=message):
                event = FakeEvent(message)
                self.assertEqual([reply async for reply in plugin.bd(event)], [])
                self.assertFalse(event.stopped)
        self.assertIsNone(plugin.bridge)
        self.assertFalse(hasattr(plugin, "on_link"))

    async def test_unauthorized_commands_do_not_initialize_http_client(self):
        plugin = Plugin380nm(None, {})
        for message in ["/bd " + URL, "/bd status", "/bd queue", "/bd blogin"]:
            with self.subTest(message=message):
                event = FakeEvent(message)
                messages = [reply async for reply in plugin.bd(event)]
                self.assertEqual(len(messages), 1)
                self.assertIn("未获", messages[0])
                self.assertTrue(event.stopped)
        self.assertIsNone(plugin.bridge)

    async def test_bad_title_time_and_multiple_links_rejected_before_network(self):
        plugin = Plugin380nm(None, {"allowed_users": ["alice"]})
        for suffix in [' "' + "中" * 21 + '"', " 明天25点", " 2099-02-30 20:00",
                       " https://x.com/a/status/456", ' ""', " 2000-01-01 20:00"]:
            with self.subTest(suffix=suffix):
                event = FakeEvent("/bd " + URL + suffix)
                messages = [reply async for reply in plugin.bd(event)]
                self.assertEqual(len(messages), 1)
                self.assertIsNone(plugin.bridge)
                self.assertTrue(event.stopped)
                self.assertEqual(plugin._tasks, set())

    async def test_help_does_not_need_service_config_or_make_requests(self):
        plugin = Plugin380nm(None, {})
        for text in ["/bd", "/bd help", "bd help"]:
            with self.subTest(text=text):
                event = FakeEvent(text)
                messages = [message async for message in plugin.bd(event)]
                self.assertIn("/bd status", messages[0])
                self.assertIn("/bd queue", messages[0])
                self.assertIn("/bd blogin", messages[0])
                self.assertTrue(event.stopped)
        self.assertIsNone(plugin.bridge)

    async def test_authorized_handler_completes_import_and_returns_exact_draft_link(self):
        server = Local380nm()
        await server.start()
        plugin = Plugin380nm(None, {"allowed_users": ["alice"], "base_url": server.base_url,
                                   "username": "test-user", "password": "test-password"})
        try:
            event = FakeEvent("/bd " + URL + " 指定标题 2099-12-25 20:30")
            messages = await consume_like_astrbot(plugin.bd(event), event)
            self.assertEqual(len(messages), 2)
            self.assertIn("已保存草稿", messages[-1])
            self.assertIn("图片：2 张", messages[-1])
            self.assertIn("标题：指定标题", messages[-1])
            self.assertIn("计划时间：2099-12-25 20:30（北京时间）", messages[-1])
            self.assertIn("未加入发布队列", messages[-1])
            self.assertIn("草稿地址：" + server.base_url + "/release?draft=draft-1", messages[-1])
            self.assertEqual(server.drafts[0]["scheduledAt"], "2099-12-25T12:30:00Z")
            self.assertTrue(event.stopped)
            # AstrBot can strip its wake prefix before dispatching the same command.
            duplicate_event = FakeEvent("bd " + URL + " 新标题")
            duplicate = await consume_like_astrbot(plugin.bd(duplicate_event), duplicate_event)
            self.assertIn("已更新已有草稿", duplicate[-1])
            self.assertEqual(server.drafts[0]["title"], "新标题")
            self.assertEqual(server.drafts[0]["scheduledAt"], "2099-12-25T12:30:00Z")
            self.assertEqual(len(server.drafts), 1)
            self.assertEqual(server.parsed_urls, [URL])
            self.assertEqual(server.jobs, [])
            self.assertEqual(plugin._tasks, set())
        finally:
            await plugin.terminate()
            await server.close()

    async def test_omitted_title_and_time_use_author_title_and_no_schedule(self):
        server = Local380nm()
        await server.start()
        plugin = Plugin380nm(None, {"allowed_users": ["alice"], "base_url": server.base_url,
                                   "username": "test-user", "password": "test-password"})
        try:
            event = FakeEvent("bd " + URL)
            messages = await consume_like_astrbot(plugin.bd(event), event)
            self.assertIn("计划时间：未设置", messages[-1])
            self.assertEqual(server.drafts[0]["title"], "作者完整说明")
            self.assertEqual(server.drafts[0]["scheduledAt"], "")
            self.assertEqual(server.jobs, [])
        finally:
            await plugin.terminate()
            await server.close()

    async def test_all_query_commands_are_read_only_and_show_live_snapshot(self):
        server = Local380nm()
        server.jobs = [{"id": "job-123", "status": "failed", "title": "失败作品", "text": "动态正文",
                        "scheduledAt": "2099-12-25T12:30:00Z", "attempts": 2,
                        "lastError": "请求被限流; sid=PRIVATE-SECRET", "updatedAt": "2026-11-02T08:00:00Z"}]
        server.accounts = [{"id": "account-1", "name": "测试账号", "canAutoRefresh": True,
                            "cookie": "NEVER-ECHO-COOKIE", "refreshToken": "NEVER-ECHO-TOKEN",
                            "cookieStatus": {"ok": True, "code": 0, "checkedAt": "2026-11-02T08:00:00Z"}}]
        await server.start()
        plugin = Plugin380nm(None, {"allowed_users": ["alice"], "base_url": server.base_url,
                                   "username": "test-user", "password": "test-password"})
        try:
            for command, expected in [("status", ["失败 1", "处理中 0，等待 0"]),
                                      ("queue", ["job-123", "失败作品", "请求被限流"]),
                                      ("queue job-123", ["动态正文", "2099-12-25 20:30", "失败原因", "/queue/job-123"]),
                                      ("queue missing", ["未找到"]),
                                      ("blogin", ["测试账号", "有效", "2026-11-02 16:00", "最近检查"])]:
                with self.subTest(command=command):
                    event = FakeEvent("/bd " + command)
                    messages = await consume_like_astrbot(plugin.bd(event), event)
                    self.assertEqual(len(messages), 1)
                    for value in expected:
                        self.assertIn(value, messages[0])
                    for secret in ["PRIVATE-SECRET", "NEVER-ECHO-COOKIE", "NEVER-ECHO-TOKEN"]:
                        self.assertNotIn(secret, messages[0])
                    self.assertTrue(event.stopped)
            self.assertEqual(server.login_count, 1)
            self.assertEqual({(method, path) for method, path in server.calls if method != "GET"},
                             {("POST", "/api/auth/login")})
            self.assertEqual({path for method, path in server.calls if method == "GET"},
                             {"/api/jobs", "/api/accounts"})
            self.assertEqual(server.drafts, [])
            self.assertEqual(server.parsed_urls, [])
            self.assertEqual(plugin._tasks, set())
        finally:
            await plugin.terminate()
            await server.close()


if __name__ == "__main__":
    unittest.main()
