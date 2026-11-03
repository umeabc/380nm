"""Read-only chat views of the jobs and account API snapshots."""

import re
from datetime import datetime
from urllib.parse import quote, urlsplit

from .bridge import CHINA_TZ, normalize_base_url, short


STATUSES = {
    "pending": "待发布", "publishing": "发布中", "published": "已发布",
    "failed": "失败", "canceled": "已取消",
}
_SECRET_KEY = (
    r"sessdata|bili_jct|refresh[_-]?token|access[_-]?token|id[_-]?token|auth[_-]?token|"
    r"ct0|twitter[_-]?auth|twitter[_-]?ct0|pixiv[_-]?session|phpsessid|ac_time_value|"
    r"token|password|passwd|pwd|secret|api[_-]?key|csrf(?:[_-]?token)?|"
    r"refresh[_-]?csrf|sid|qrcode[_-]?key|dedeuserid(?:__?ckmd5)?"
)
_SECRET_PAIR = re.compile(
    r"(?i)(?<![\w])([\"']?(?:" + _SECRET_KEY + r")[\"']?\s*[:=：]\s*)"
    r"(?:\"(?:\\.|[^\"\\])*(?:\"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;，；}\]\"']+)"
)
_HEADER_SECRET = re.compile(
    r"(?im)(?<![\w])([\"']?(?:cookie|set-cookie|authorization|proxy-authorization)"
    r"[\"']?\s*[:=：]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*"
)
_URL = re.compile(r"(?i)(?:https?|ftp)://[^\s<>\"']+|(?<!:)//[^\s<>\"']+")
_BEARER = re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+")


def _text(value):
    return value if isinstance(value, str) else ""


def safe_reason(value, limit=240):
    """Show the error message, never an arbitrary object, credentials or stack."""
    if isinstance(value, dict):
        value = value.get("message")
    value = _text(value)
    if not value.strip():
        return "未记录"
    value = _URL.sub("[链接已隐藏]", value.replace("\\/", "/"))
    value = _HEADER_SECRET.sub(lambda m: m.group(1) + "[已隐藏]", value)
    value = _SECRET_PAIR.sub(lambda m: m.group(1) + "[已隐藏]", value)
    value = _BEARER.sub(lambda m: m.group(1) + " [已隐藏]", value)
    # The backend stores Error.message, but tolerate old/imported stack strings.
    lines = []
    for line in value.splitlines():
        if re.match(r"\s*(?:at\s|File\s+\"|Traceback\b|Caused by:)", line):
            break
        if line.strip():
            lines.append(line.strip())
    return short(" ".join(lines), limit) or "详细原因请在网页查看"


def format_time(value, empty="未设置"):
    """Always use Beijing time, including for legacy offset-free timestamps."""
    try:
        dt = datetime.fromisoformat(_text(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=CHINA_TZ)
        return dt.astimezone(CHINA_TZ).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError, OverflowError):
        return empty


def _job_url(base_url, job):
    return normalize_base_url(base_url) + "/queue/" + quote(_text(job.get("id")), safe="")


def _published_url(job):
    value = _text(job.get("dynamicUrl")).strip()
    try:
        parts = urlsplit(value)
        # Strip queries/fragments instead of echoing imported tokens or trackers.
        if (parts.scheme == "https" and not parts.username and not parts.password
                and parts.port is None):
            if parts.hostname == "t.bilibili.com" and re.fullmatch(r"/[0-9]+/?", parts.path):
                return "https://t.bilibili.com" + parts.path.rstrip("/")
            if parts.hostname == "www.bilibili.com" and re.fullmatch(r"/opus/[0-9]+/?", parts.path):
                return "https://www.bilibili.com" + parts.path.rstrip("/")
    except ValueError:
        pass
    dynamic_id = job.get("dynamicId")
    if isinstance(dynamic_id, (str, int)) and re.fullmatch(r"[0-9]+", str(dynamic_id)):
        return "https://t.bilibili.com/" + str(dynamic_id)
    return ""


def _status(job):
    return STATUSES.get(_text(job.get("status")), "未知状态")


def _recent_key(job):
    for key in ("updatedAt", "createdAt", "scheduledAt"):
        try:
            value = datetime.fromisoformat(_text(job.get(key)).replace("Z", "+00:00"))
            return value.replace(tzinfo=CHINA_TZ).timestamp() if value.tzinfo is None else value.timestamp()
        except (ValueError, TypeError, OverflowError, OSError):
            continue
    return float("-inf")


def format_jobs(jobs, base_url, job_id=""):
    """List recent jobs, or display one exact ID without changing the queue."""
    jobs = [job for job in jobs if isinstance(job, dict)]
    if job_id:
        job = next((item for item in jobs if item.get("id") == job_id), None)
        if job is None:
            return "未找到该任务，请用 /bd queue 查看当前可见任务的完整 ID。"
        attempts = job.get("attempts")
        attempts = str(attempts) if isinstance(attempts, int) and not isinstance(attempts, bool) and attempts >= 0 else "未记录"
        lines = [
            "380nm 任务详情（北京时间）",
            "任务 ID：" + _text(job.get("id")),
            "状态：" + _status(job),
            "标题：" + (short(_text(job.get("title")), 100) or "未设置"),
            "正文：" + (short(_text(job.get("text")), 499) or "无正文"),
            "计划发布：" + format_time(job.get("scheduledAt")),
            "实际发布：" + format_time(job.get("publishedAt"), "尚未发布"),
            "尝试次数（后端记录的失败重试次数）：" + attempts,
            "失败原因：" + safe_reason(job.get("lastError")),
            "网页任务：" + _job_url(base_url, job),
        ]
        published = _published_url(job)
        if published:
            lines.append("已发布动态：" + published)
        return "\n".join(lines)
    if not jobs:
        return "发布队列为空；保存到草稿不会自动入队。\n队列页面：" + normalize_base_url(base_url) + "/queue"
    recent = sorted(jobs, key=_recent_key, reverse=True)[:5]
    lines = [f"380nm 最近任务（{len(recent)}/{len(jobs)}，北京时间）"]
    for job in recent:
        lines.extend([
            "", "任务 ID：" + _text(job.get("id")),
            "状态：" + _status(job) + " | " + (short(_text(job.get("title")) or _text(job.get("text")), 60) or "无标题"),
            "计划发布：" + format_time(job.get("scheduledAt")),
        ])
        if job.get("lastError"):
            lines.append("失败原因：" + safe_reason(job.get("lastError"), 100))
        lines.append("网页任务：" + _job_url(base_url, job))
        published = _published_url(job)
        if published:
            lines.append("已发布动态：" + published)
    lines.append("\n使用 /bd queue <任务ID> 查看详情。")
    return "\n".join(lines)


def _account_state(status):
    if not isinstance(status.get("ok"), bool):
        return "未检测"
    if status["ok"]:
        return "有效"
    # null/unknown is a check failure, not proof that the cookie is valid.
    code = str(status.get("code"))
    if code == "0":
        return "续期异常（登录有效）"
    if code == "-101":
        return "失效"
    return "检查异常"


def format_accounts(accounts, base_url):
    """Render whitelisted account fields from GET /accounts; no network calls."""
    lines = ["B 站账号登录状态（最近检查记录，北京时间）"]
    accounts = [account for account in accounts if isinstance(account, dict)]
    if not accounts:
        lines.append("暂无可见的 B 站账号，请在账号页面添加。")
    for account in accounts:
        status = account.get("cookieStatus")
        status = status if isinstance(status, dict) else {}
        state = _account_state(status)
        name = _text(account.get("name")) or _text(account.get("uname")) or "未命名账号"
        lines.extend([
            "", short(name, 70) + "：" + state,
            "自动续期：" + ("支持" if account.get("canAutoRefresh") is True else "不支持"),
            "最后登录检查：" + format_time(status.get("checkedAt"), "暂无记录"),
        ])
        if account.get("lastCookieRefreshAt"):
            lines.append("最后续期检查：" + format_time(account.get("lastCookieRefreshAt"), "暂无记录"))
        if status.get("ok") is False:
            message = status.get("message")
            if message:
                lines.append("原因：" + safe_reason(message))
            refresh_error = status.get("refreshError")
            if isinstance(refresh_error, dict) and state != "续期异常（登录有效）":
                extra = refresh_error.get("message")
                if extra and extra != message:
                    lines.append("续期异常：" + safe_reason(extra))
            elif isinstance(refresh_error, dict) and not message:
                lines.append("续期异常：" + safe_reason(refresh_error))
    lines.append("账号页面：" + normalize_base_url(base_url) + "/accounts")
    lines.append("本命令只读取已保存的状态；以最后检查时间为准。")
    return "\n".join(lines)
