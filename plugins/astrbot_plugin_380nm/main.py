import asyncio
import re
from datetime import datetime
from urllib.parse import quote

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

from .bridge import BridgeError, CHINA_TZ, Client, DraftBridge, queue_summary
from .commands import parse_command_args
from .views import format_accounts, format_jobs


HELP = (
    "380nm · /bd\n"
    "/bd <X链接> [标题] [时间]：抓取原图与作者说明到草稿。\n"
    "例：/bd https://x.com/artist/status/123 作品标题 明天晚上8点\n"
    "标题、时间可分别省略；标题含空格或日期时用引号包住。\n"
    "时间示例：明天20点、后天晚上八点半、2026-12-25 20:30、12月25日。\n"
    "时间按北京时间；只给日期默认20:00，不填时间则不设排期。\n"
    "/bd status：发布队列状态\n"
    "/bd queue [任务ID]：任务列表或任务详情、失败原因\n"
    "/bd blogin：B站账号登录、续期状态（最近一次检查）\n"
    "/bd help：本说明\n"
    "保存后返回草稿直达链接；设定时间也只保存草稿，需在网页入队后才会发布。"
)


@register("astrbot_plugin_380nm", "380nm", "/bd 链接存草稿、任务与账号状态", "1.1.0")
class Plugin380nm(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.bridge = None
        self._tasks = set()

    def _allowed(self, event):
        sender = str(event.get_sender_id() or "")
        if not sender or sender == str(event.get_self_id() or ""):
            return False
        group = str(event.get_group_id() or "")
        groups = {str(value).strip() for value in self.config.get("allowed_groups", []) if str(value).strip()}
        if not event.is_private_chat() and (not group or group not in groups):
            return False
        users = {str(value).strip() for value in self.config.get("allowed_users", []) if str(value).strip()}
        return sender in users if users else event.is_admin()

    def _get_bridge(self):
        if self.bridge is None:
            self.bridge = DraftBridge(Client(
                self.config.get("base_url", ""), self.config.get("username", ""),
                self.config.get("password", ""), self.config.get("request_timeout", 300),
            ))
        return self.bridge

    @filter.command("bd")
    async def bd(self, event: AstrMessageEvent):
        """/bd <X链接> [标题] [时间]，或 status / queue [任务ID] / blogin。"""
        # AstrBot removes the configured wake prefix before command dispatch.
        # Keep raw text so quotes, spaces and Chinese date phrases survive.
        match = re.fullmatch(r"\s*/?bd(?:\s+(.*))?\s*", event.get_message_str(), re.DOTALL)
        if not match:
            return
        args = (match.group(1) or "").strip()
        if args.lower() in ("", "help"):
            yield event.plain_result(HELP)
            event.stop_event()
            return
        if not self._allowed(event):
            yield event.plain_result("此会话或用户未获 380nm 插件授权，请检查用户和群聊白名单。")
            event.stop_event()
            return
        current = asyncio.current_task()
        self._tasks.add(current)
        try:
            command = parse_command_args(args)
            if command.action == "help":
                yield event.plain_result(HELP)
                return
            bridge = self._get_bridge()
            if command.action == "status":
                data = await bridge.client.request("GET", "/jobs")
                message = queue_summary(data.get("jobs", []))
                message += f"\n链接抓取：处理中 {bridge.active}，等待 {bridge.waiting}"
                message += f"\n{bridge.client.base_url}/queue"
                yield event.plain_result(message)
            elif command.action == "queue":
                data = await bridge.client.request("GET", "/jobs")
                yield event.plain_result(format_jobs(data.get("jobs", []), bridge.client.base_url, command.job_id))
            elif command.action == "blogin":
                data = await bridge.client.request("GET", "/accounts")
                yield event.plain_result(format_accounts(data.get("accounts", []), bridge.client.base_url))
            elif command.action == "import":
                yield event.plain_result("正在检查作品并保存原图、作者说明到草稿。")
                result = await bridge.import_link(command.url, title=command.title, scheduled_at=command.scheduled_at)
                draft = result["draft"]
                if result.get("updated"):
                    message = "已更新已有草稿的标题或时间，未重复抓取。"
                elif result["duplicate"]:
                    message = "已有相同作品的草稿，跳过重复抓取。"
                else:
                    message = "已保存草稿。"
                message += f"\n标题：{draft.get('title') or 'X 作品'}\n图片：{len(draft.get('images', []))} 张"
                when = draft.get("scheduledAt")
                if when:
                    formatted = datetime.fromisoformat(when.replace("Z", "+00:00")).astimezone(CHINA_TZ).strftime("%Y-%m-%d %H:%M")
                    message += f"\n计划时间：{formatted}（北京时间）"
                else:
                    message += "\n计划时间：未设置"
                if command.time_note:
                    message += "\n" + command.time_note
                draft_id = str(draft.get("id") or "")
                message += f"\n未加入发布队列。\n草稿地址：{bridge.client.base_url}/release?draft={quote(draft_id, safe='')}"
                if result["warnings"]:
                    message += "\n提示：" + "；".join(result["warnings"])
                yield event.plain_result(message)
            else:
                yield event.plain_result(HELP)
        except BridgeError as error:
            yield event.plain_result(str(error))
        except Exception as error:
            # Never put credentials, response bodies or raw upstream errors into chat/logs.
            logger.error(f"[380nm] bd failed: {type(error).__name__}")
            yield event.plain_result("处理失败，请先检查网页草稿和插件配置，再重试；发送 /bd help 查看用法。")
        finally:
            self._tasks.discard(current)
            event.stop_event()

    async def terminate(self):
        tasks = [task for task in self._tasks if task is not asyncio.current_task() and not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self.bridge:
            await self.bridge.client.close()
