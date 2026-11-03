"""Cross-language contract check against the real, isolated Express backend.

Only X downloading is stubbed. No scheduler starts and no publish endpoint is
called. Node plus the project's npm dependencies are needed to run this test.
"""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import unittest


HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[2]
NODE = shutil.which("node")
BRIDGE_SPEC = importlib.util.spec_from_file_location("real_backend_bridge", HERE.parent / "bridge.py")
bridge = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(bridge)


@unittest.skipUnless(NODE, "Node.js is not installed")
@unittest.skipUnless((PROJECT_ROOT / "node_modules" / "express").is_dir(), "Run npm ci before backend integration tests")
class RealBackendIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_parent = Path(tempfile.gettempdir()).resolve()
        self.data_dir = Path(tempfile.mkdtemp(prefix="astrbot-380nm-integration-", dir=self.temp_parent)).resolve()
        (self.data_dir / ".fixture-owned").write_bytes(b"380nm integration fixture\n")
        self.process = None
        self.stderr_file = None
        self.client = None
        self.addCleanup(self._cleanup)
        self.stderr_file = (self.data_dir / "node-stderr.log").open("w+", encoding="utf-8")
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        self.process = subprocess.Popen(
            [NODE, str(HERE / "backend_fixture.cjs"), str(self.data_dir)],
            cwd=PROJECT_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr_file, text=True, encoding="utf-8", **options,
        )
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(self.process.stdout.readline()), daemon=True).start()
        try:
            line = ready.get(timeout=15)
            if not line:
                self.stderr_file.flush()
                self.stderr_file.seek(0)
                self.fail("Backend fixture failed to start:\n" + self.stderr_file.read())
            self.base_url = json.loads(line)["base_url"]
        except queue.Empty:
            self.fail("Backend fixture did not become ready within 15 seconds")

    def _stop_backend(self):
        if not self.process or self.process.poll() is not None:
            return None
        try:
            output, _ = self.process.communicate("shutdown\n", timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate(timeout=5)
            self.fail("Backend fixture did not shut down cleanly")
        self.assertEqual(self.process.returncode, 0, "Backend fixture returned a failure status")
        records = [json.loads(line) for line in output.splitlines() if line.strip()]
        return next((record for record in records if record.get("stopped")), None)

    def _cleanup(self):
        try:
            self._stop_backend()
        finally:
            if self.process:
                for pipe in (self.process.stdin, self.process.stdout):
                    if pipe and not pipe.closed:
                        pipe.close()
            if self.stderr_file and not self.stderr_file.closed:
                self.stderr_file.close()
            # Delete only the exact mkdtemp child created above, never a supplied
            # path or a production directory. Verify again immediately before rm.
            resolved = self.data_dir.resolve()
            if (resolved != self.data_dir or resolved.parent != self.temp_parent
                    or not resolved.name.startswith("astrbot-380nm-integration-")
                    or (resolved / ".fixture-owned").read_text(encoding="utf-8") != "380nm integration fixture\n"):
                raise AssertionError("Refusing to remove an unverified fixture directory")
            shutil.rmtree(resolved)

    async def asyncTearDown(self):
        if self.client:
            await self.client.close()

    async def test_x_link_persists_complete_draft_without_enqueuing_and_deduplicates(self):
        self.client = bridge.Client(self.base_url, "fixture-user", "fixture-password")
        workflow = bridge.DraftBridge(self.client)
        url = "https://x.com/fixture_artist/status/1234567890123456789"
        expected_description = "这是超过三十个字的作者原文，用来确认完整说明不会被作品标题截断。\n第二段保留换行、emoji 🌟 和 & 符号。"

        result = await workflow.import_link(url)
        draft = result["draft"]
        self.assertFalse(result["duplicate"])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(draft["userId"], "fixture-user")
        self.assertEqual(draft["variables"]["description"], expected_description)
        self.assertEqual(draft["variables"]["sourceUrl"], url)
        self.assertEqual(
            draft["text"],
            expected_description + "\n\n作者：测试作者\nX：@fixture_artist\n来源：" + url,
        )
        self.assertEqual(len(draft["images"]), 2)
        self.assertFalse(draft.get("scheduledAt"))
        self.assertTrue(draft["incomplete"])
        self.assertEqual(draft["type"], "原创")
        self.assertEqual((await self.client.request("GET", "/lib-accounts"))["accounts"], [])

        templates = (await self.client.request("GET", "/templates?category=dynamic"))["templates"]
        imported_templates = [item for item in templates if item["name"] == bridge.TEMPLATE_NAME]
        self.assertEqual(len(imported_templates), 1)
        self.assertEqual(imported_templates[0]["content"], "{{content}}")
        self.assertEqual(imported_templates[0]["id"], draft["templateId"])
        self.assertEqual((await self.client.request("GET", "/jobs"))["jobs"], [])

        # Different URL form, same tweet ID: no second download, image or draft.
        duplicate = await workflow.import_link("https://twitter.com/changed_handle/status/1234567890123456789")
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["draft"]["id"], draft["id"])
        self.assertEqual(len((await self.client.request("GET", "/drafts"))["drafts"]), 1)
        self.assertEqual(len((await self.client.request("GET", "/images"))["images"]), 2)
        self.assertEqual((await self.client.request("GET", "/jobs"))["jobs"], [])

        # Repeat /bd with explicit edits through the bridge and real PATCH route.
        # This completes draft fields but never enqueues or publishes anything.
        edited = await workflow.import_link(url, title="自定义标题", scheduled_at="2099-01-01T20:00:00+08:00")
        self.assertTrue(edited["duplicate"])
        self.assertTrue(edited["updated"])
        completed = edited["draft"]
        self.assertFalse(completed["incomplete"])
        self.assertEqual(completed["title"], "自定义标题")
        self.assertEqual(completed["scheduledAt"], "2099-01-01T12:00:00.000Z")
        self.assertEqual(completed["text"], draft["text"])
        self.assertEqual(completed["images"], draft["images"])
        self.assertEqual(completed["variables"], draft["variables"])
        retitled = await workflow.import_link(url, title="最终标题")
        self.assertEqual(retitled["draft"]["title"], "最终标题")
        self.assertEqual(retitled["draft"]["scheduledAt"], completed["scheduledAt"])
        rescheduled = await workflow.import_link(url, scheduled_at="2099-01-02T20:30:00+08:00")
        self.assertEqual(rescheduled["draft"]["title"], "最终标题")
        self.assertEqual(rescheduled["draft"]["scheduledAt"], "2099-01-02T12:30:00.000Z")
        untouched = await workflow.import_link(url)
        self.assertFalse(untouched["updated"])
        self.assertEqual(untouched["draft"], rescheduled["draft"])
        self.assertEqual(len((await self.client.request("GET", "/drafts"))["drafts"]), 1)
        self.assertEqual((await self.client.request("GET", "/jobs"))["jobs"], [])
        self.assertEqual((await self.client.request("GET", "/lib-accounts"))["accounts"], [])

        await self.client.close()
        stopped = await asyncio.to_thread(self._stop_backend)
        self.assertEqual(stopped, {"stopped": True, "parseCalls": 1})
        stored = json.loads((self.data_dir / "db.json").read_text(encoding="utf-8"))
        self.assertEqual(len(stored["drafts"]), 1)
        self.assertEqual(stored["drafts"][0]["text"], draft["text"])
        self.assertEqual(stored["drafts"][0]["title"], "最终标题")
        self.assertEqual(stored["drafts"][0]["scheduledAt"], "2099-01-02T12:30:00.000Z")
        self.assertEqual(stored["jobs"], [])
        self.assertEqual(stored["libAccounts"], [])
        self.assertEqual(len(stored["images"]), 2)
        for image in stored["images"]:
            saved_file = (self.data_dir / "uploads" / image["key"]).resolve()
            self.assertTrue(saved_file.is_relative_to(self.data_dir / "uploads"))
            self.assertTrue(saved_file.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(saved_file.stat().st_size, image["size"])

    async def test_first_import_with_title_and_time_is_saved_only_as_a_draft(self):
        self.client = bridge.Client(self.base_url, "fixture-user", "fixture-password")
        workflow = bridge.DraftBridge(self.client)
        result = await workflow.import_link("https://x.com/fixture_artist/status/1234567890123456789",
                                            title="春节插画", scheduled_at="2099-02-01T20:30:00+08:00")
        self.assertFalse(result["duplicate"])
        draft = result["draft"]
        self.assertEqual(draft["title"], "春节插画")
        self.assertEqual(draft["scheduledAt"], "2099-02-01T12:30:00.000Z")
        self.assertFalse(draft["incomplete"])
        self.assertEqual(len(draft["images"]), 2)
        self.assertIn("作者：测试作者", draft["text"])
        self.assertEqual((await self.client.request("GET", "/drafts"))["drafts"], [draft])
        self.assertEqual((await self.client.request("GET", "/jobs"))["jobs"], [])
        self.assertEqual((await self.client.request("GET", "/accounts"))["accounts"], [])
        await self.client.close()
        stopped = await asyncio.to_thread(self._stop_backend)
        self.assertEqual(stopped, {"stopped": True, "parseCalls": 1})
        stored = json.loads((self.data_dir / "db.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["drafts"][0]["title"], "春节插画")
        self.assertEqual(stored["drafts"][0]["scheduledAt"], "2099-02-01T12:30:00.000Z")
        self.assertEqual(stored["jobs"], [])


if __name__ == "__main__":
    unittest.main()
