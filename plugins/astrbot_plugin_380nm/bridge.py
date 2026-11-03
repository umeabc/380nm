"""Small HTTP client and draft workflow, independent of AstrBot."""

import asyncio
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit

import aiohttp


class BridgeError(Exception):
    """A message that is safe to display in chat."""


# Match an actual host, not evilx.com or https://evil.test/x.com/...
X_LINK = re.compile(
    r"(?<![\w./:@-])(?:https?://)?(?:www\.|mobile\.|m\.)?"
    r"(?:x\.com|twitter\.com)/(?:([A-Za-z0-9_]{1,15})/status|i/web/status)/"
    r"([0-9]{1,25})(?:/(?:photo|video)/[0-9]+)?/?(?![\w/])(?!\.\w)", re.IGNORECASE,
)
TEMPLATE_NAME = "AstrBot X 草稿"
CHINA_TZ = timezone(timedelta(hours=8))


def extract_links(text):
    """Return canonical URLs, retaining order and deduplicating tweet IDs."""
    if not isinstance(text, str):
        return []
    found = {}
    for match in X_LINK.finditer(text or ""):
        handle, work_id = match.groups()
        # 380nm's parser expects /<handle>/status/<id>; IDs identify the work.
        found.setdefault(work_id, f"https://x.com/{handle or 'i'}/status/{work_id}")
    return list(found.values())


def tweet_id(url):
    links = extract_links(url)
    return links[0].rsplit("/", 1)[-1] if links else None


def normalize_base_url(value):
    base = str(value or "").strip().rstrip("/")
    parts = urlsplit(base)
    if (parts.scheme not in ("http", "https") or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment):
        raise BridgeError("请在插件配置中填写正确的 380nm 地址，例如 http://服务器地址:8787。")
    if base.endswith("/api"):
        base = base[:-4]
    return base


def short(value, limit=45):
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


def display_time(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(CHINA_TZ).strftime("%m-%d %H:%M")
    except (ValueError, TypeError):
        return "时间未设置"


def queue_summary(jobs):
    counts = Counter(job.get("status", "unknown") for job in jobs)
    lines = ["380nm 发布队列（当前账号）", " · ".join(
        f"{label} {counts[key]}" for key, label in (
            ("pending", "待发布"), ("publishing", "发布中"), ("published", "已发布"),
            ("failed", "失败"), ("canceled", "已取消"))) ]
    active = sorted((j for j in jobs if j.get("status") in ("pending", "publishing")),
                    key=lambda j: (j.get("status") != "publishing", str(j.get("scheduledAt") or "")))[:5]
    if active:
        lines.append("近期任务（北京时间）：")
        for job in active:
            label = "发布中" if job.get("status") == "publishing" else display_time(job.get("scheduledAt"))
            lines.append(f"• {label} | {short(job.get('title') or job.get('text'))} | {short(job.get('id'), 32)}")
    elif not jobs:
        lines.append("发布队列为空；保存到草稿不会自动入队。")
    failed = sorted((j for j in jobs if j.get("status") == "failed"),
                    key=lambda j: str(j.get("updatedAt") or j.get("createdAt") or ""), reverse=True)[:3]
    if failed:
        lines.append("最近失败：")
        for job in failed:
            # Raw upstream errors can contain cookies/URLs; details stay in the authenticated UI.
            lines.append(f"• {short(job.get('title') or job.get('text'))} | {short(job.get('id'), 32)}（原因见网页任务详情）")
    return "\n".join(lines)


class Client:
    def __init__(self, base_url, username, password, timeout=300):
        self.base_url = normalize_base_url(base_url)
        self.username = str(username or "").strip()
        self.password = str(password or "")
        if not self.username or not self.password:
            raise BridgeError("请先在插件配置中填写 380nm 登录用户名和密码。")
        self.timeout = max(30, min(900, int(timeout)))
        self._session = None
        self._logged_in = False
        self._login_lock = asyncio.Lock()

    async def close(self):
        if self._session:
            await self._session.close()
        self._session = None
        self._logged_in = False

    def _get_session(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                # Self-hosted installations commonly use a LAN IP, including loopback.
                cookie_jar=aiohttp.CookieJar(unsafe=True),
                timeout=aiohttp.ClientTimeout(total=self.timeout, connect=15),
                read_bufsize=1024 * 1024,
            )
        return self._session

    async def _login(self):
        async with self._login_lock:
            if self._logged_in:
                return
            session = self._get_session()
            async with session.post(self.base_url + "/api/auth/login", json={
                "username": self.username, "password": self.password,
            }, allow_redirects=False) as response:
                if response.status == 429:
                    raise BridgeError("380nm 登录被限流，请稍后再试，并核对插件中的用户名和密码。")
                if response.status in (401, 403):
                    raise BridgeError("380nm 登录失败，请核对用户名、密码及账号是否启用。")
                if response.status != 200 or "sid" not in response.cookies:
                    raise BridgeError("380nm 登录接口异常，请检查服务地址和反向代理配置。")
                await response.read()
                self._logged_in = True

    async def request(self, method, path, payload=None, *, stream=False):
        try:
            for attempt in range(2):
                await self._login()
                async with self._get_session().request(
                    method, self.base_url + "/api" + path, json=payload,
                    allow_redirects=False,
                ) as response:
                    # Authentication middleware rejects the request before any mutation.
                    if response.status == 401 and attempt == 0:
                        self._logged_in = False
                        continue
                    if response.status != 200:
                        if response.status == 401:
                            raise BridgeError("380nm 会话无效，请检查插件登录配置。")
                        raise BridgeError(f"380nm 接口返回 HTTP {response.status}，请在网页检查权限、模板和服务状态。")
                    if stream:
                        return await self._read_work(response)
                    data = await response.json(content_type=None)
                    if not isinstance(data, dict):
                        raise BridgeError("380nm 接口返回格式不正确，请检查服务地址。")
                    return data
        except (asyncio.TimeoutError, aiohttp.ClientError) as error:
            raise BridgeError("连接 380nm 超时或中断；请先检查网页草稿，再重发链接。") from error
        except (ValueError, UnicodeError) as error:
            raise BridgeError("380nm 响应无法解析，请检查服务版本和反向代理配置。") from error

    async def _read_work(self, response):
        async for raw in response.content:
            if not raw.strip():
                continue
            event = json.loads(raw)
            if not isinstance(event, dict):
                raise BridgeError("抓取响应格式不正确。")
            if event.get("type") == "error":
                reason = {
                    "invalid": "不是支持的 X 作品链接。",
                    "notfound": "作品不存在或已删除。",
                    "restricted": "作品受限或未找到图片，请检查全站 X 凭据；暂不支持纯文字和视频。",
                    "deleted": "推文已删除，或对当前 X 账号不可见。",
                    "timeout": "抓取 X 超时，请检查 380nm 的下载代理后重试。",
                    "network": "抓取失败，请检查 380nm 的网络、下载代理和 X 凭据。",
                }.get(event.get("error"), "抓取失败，请在 380nm 网页中重试链接。")
                raise BridgeError(reason)
            if event.get("type") == "done":
                if not isinstance(event.get("work"), dict) or not isinstance(event.get("images"), list):
                    raise BridgeError("抓取结果缺少作品信息或图片。")
                return event
        raise BridgeError("抓取连接提前结束，未收到完成结果；请重试链接。")


class DraftBridge:
    def __init__(self, client):
        self.client = client
        self._lock = asyncio.Lock()
        self.waiting = 0
        self.active = 0

    async def _find_draft(self, url):
        data = await self.client.request("GET", "/drafts")
        for draft in data.get("drafts", []):
            source = (draft.get("variables") or {}).get("sourceUrl", "")
            if tweet_id(source) == tweet_id(url):
                return draft
        return None

    async def _template(self):
        data = await self.client.request("GET", "/templates?category=dynamic")
        for item in data.get("templates", []):
            if (item.get("name") == TEMPLATE_NAME and item.get("content") == "{{content}}"
                    and item.get("maxImages", 9) == 9):
                return item["id"]
        data = await self.client.request("POST", "/templates", {
            "name": TEMPLATE_NAME, "content": "{{content}}", "category": "dynamic", "maxImages": 9,
            "variables": [{"key": "content", "label": "原文与作者说明", "type": "textarea"}],
        })
        return data["template"]["id"]

    async def import_link(self, url, *, title=None, scheduled_at=None):
        if not tweet_id(url):
            raise BridgeError("不是支持的 X 作品链接。")
        if title is not None:
            if not isinstance(title, str) or not title.strip():
                raise BridgeError("标题不能为空；不需要自定义标题时请省略。")
            title = title.strip()
            if len(title.encode("utf-16-le", errors="surrogatepass")) > 40:
                raise BridgeError("标题最多 20 个字（emoji 通常占 2 个字），请缩短后重试。")
        if scheduled_at is not None:
            try:
                when = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
                if when.tzinfo is None:
                    raise ValueError("timezone required")
                scheduled_at = when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            except (AttributeError, ValueError, TypeError) as error:
                raise BridgeError("计划时间格式无效，请使用带时区的具体时间。") from error
        if self.waiting >= 10:
            raise BridgeError("当前抓取等待任务较多，请稍后再发。")
        self.waiting += 1
        entered = False
        try:
            async with self._lock:
                entered = True
                self.waiting -= 1
                self.active += 1
                try:
                    return await self._import_link(url, title=title, scheduled_at=scheduled_at)
                finally:
                    self.active -= 1
        finally:
            if not entered:
                self.waiting -= 1

    async def _import_link(self, url, *, title=None, scheduled_at=None):
        existing = await self._find_draft(url)
        if existing:
            patch = {}
            if title is not None:
                patch["title"] = title
            if scheduled_at is not None:
                patch["scheduledAt"] = scheduled_at
            if patch:
                try:
                    saved = await self.client.request("PATCH", "/drafts/" + quote(str(existing["id"]), safe=""), patch)
                    existing = saved["draft"]
                except BridgeError as error:
                    try:
                        confirmed = await self._find_draft(url)
                    except BridgeError:
                        confirmed = None
                    same_time = not scheduled_at or (confirmed and self._same_time(confirmed.get("scheduledAt"), scheduled_at))
                    if not confirmed or (title is not None and confirmed.get("title") != title) or not same_time:
                        raise BridgeError("已有草稿的标题或时间更新未确认，请打开网页核对。") from error
                    existing = confirmed
            return {"draft": existing, "duplicate": True, "updated": bool(patch), "warnings": []}
        template_id = await self._template()
        parsed = await self.client.request("POST", "/library/parse-work", {"url": url}, stream=True)
        work, images = parsed["work"], parsed["images"]
        if not images:
            raise BridgeError("未抓到可用图片，未创建草稿；暂不支持纯文字和视频。")
        if len(images) > 9 or parsed.get("total", len(images)) > 9:
            raise BridgeError("作品超过 9 张图片，已存入图库；请在网页拆分草稿，避免遗漏图片。")
        description = work.get("description", work.get("text"))
        warnings = []
        if not isinstance(description, str):
            description = ""
            warnings.append("后端未提供原文；请更新本项目 src/importers.js 并重启 380nm，原文需在网页补填。")
        author = str(work.get("author") or work.get("handle") or "未知作者")
        handle = str(work.get("handle") or "").lstrip("@")
        credit = f"作者：{author}" + (f"\nX：@{handle}" if handle else "") + f"\n来源：{url}"
        content = (description + "\n\n" if description else "") + credit
        payload = {
            "templateId": template_id,
            "variables": {"content": content, "sourceUrl": url, "author": author,
                          "handle": handle, "description": description},
            "images": [{"key": image["key"]} for image in images],
            # Server validates JS string.length, which counts UTF-16 code units.
            "title": title if title is not None else str(work.get("title") or "X 草稿").encode("utf-16-le", errors="surrogatepass")[:40].decode("utf-16-le", errors="ignore"),
            # Use the same default draft type as the current release/batch UI.
            # The legacy '转载' type requires a Bilibili library orig slot; an X
            # handle is not a verified Bilibili identity. Keep attribution in text.
            "scheduledAt": scheduled_at or "",
        }
        try:
            saved = await self.client.request("POST", "/drafts", payload)
        except BridgeError as error:
            # A lost POST response may still have committed. Never blindly repeat the POST.
            try:
                existing = await self._find_draft(url)
            except BridgeError:
                existing = None
            if existing:
                return {"draft": existing, "duplicate": False, "warnings": warnings}
            raise BridgeError(f"图片已入图库，但草稿保存未确认。{error}") from error
        return {"draft": saved["draft"], "duplicate": False, "warnings": warnings}

    @staticmethod
    def _same_time(first, second):
        try:
            return datetime.fromisoformat(first.replace("Z", "+00:00")) == datetime.fromisoformat(second.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return False
