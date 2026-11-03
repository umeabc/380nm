"""Parse /bd arguments and deterministic Chinese dates without an LLM."""

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .bridge import BridgeError, CHINA_TZ, X_LINK, extract_links


USAGE = '用法：/bd X链接 [标题] [时间]；含空格或日期的标题请加引号。'
NUMBER = r'(?:\d+|[零〇一二两三四五六七八九十百]+)'
PERIOD = r'(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|夜里)'
CLOCK = re.compile(
    rf'(?P<period>{PERIOD})?\s*(?P<hour>{NUMBER})\s*'
    rf'(?:(?:点|时)\s*(?P<minute>半|一刻|三刻|{NUMBER}\s*分?)?'
    r'|:(?P<colon>\d{1,2})(?::(?P<second>\d{1,2}))?)'
)
QUOTES = {'"': '"', "'": "'", '“': '”', '‘': '’'}


@dataclass(frozen=True)
class Command:
    action: str
    url: str = ''
    title: str | None = None
    scheduled_at: str | None = None
    time_note: str = ''
    job_id: str = ''


def _now(value):
    if value is None:
        return datetime.now(CHINA_TZ)
    if value.tzinfo is None:
        return value.replace(tzinfo=CHINA_TZ)
    return value.astimezone(CHINA_TZ)


def _number(value):
    value = value.strip().removesuffix('分').strip()
    if value.isdecimal():
        return int(value)
    digits = dict(zip('零〇一二两三四五六七八九', (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))
    if value in digits:
        return digits[value]
    if value.count('十') == 1:
        tens, units = value.split('十')
        if (not tens or tens in digits) and (not units or units in digits):
            return digits.get(tens, 1) * 10 + digits.get(units, 0)
    raise BridgeError('无法识别时间中的数字，请使用阿拉伯数字，例如“明天 20:30”。')


def _invalid_time(text):
    return BridgeError(
        f'无法识别或无效的时间“{text}”。请使用“明天晚上8点”、“2026-11-05 20:30”等格式；'
        '如果这是标题，请给标题加引号。'
    )


def _clock(text):
    matched = CLOCK.fullmatch(text.strip())
    if not matched:
        raise _invalid_time(text)
    hour = _number(matched['hour'])
    raw_minute = matched['minute']
    minute = ({'半': 30, '一刻': 15, '三刻': 45}.get(raw_minute)
              if raw_minute in ('半', '一刻', '三刻')
              else _number(raw_minute) if raw_minute else int(matched['colon'] or 0))
    second = int(matched['second'] or 0)
    period = matched['period']
    if period:
        # Reject contradictory 12-hour qualifiers instead of guessing.
        if not 0 <= hour <= 12:
            raise _invalid_time(text)
        if hour == 12 and period not in ('中午', '凌晨'):
            raise BridgeError('带“上午／晚上”等词的 12 点容易产生歧义，请改为“中午12点”、'
                              '“凌晨0点”，或明确日期及 24 小时制时间，例如“明天00:00”。')
        if period in ('下午', '傍晚', '晚上', '晚间', '夜里') and 1 <= hour < 12:
            hour += 12
        elif period == '中午' and 1 <= hour <= 2:
            hour += 12
        elif period == '凌晨' and hour == 12:
            hour = 0
    if not 0 <= hour <= 23 or not 0 <= minute <= 59 or not 0 <= second <= 59:
        raise _invalid_time(text)
    return hour, minute, second


def _date_clock(rest):
    rest = rest.strip().lstrip('Tt').strip()
    if not rest:
        return (20, 0, 0), True
    return _clock(rest), False


def _parsed_schedule(text, now=None):
    original = str(text).strip()
    text = unicodedata.normalize('NFKC', original).strip()
    current = _now(now)
    if not text:
        raise _invalid_time(original)

    duration = re.fullmatch(rf'({NUMBER}|\d+\.\d+|半)\s*(小时|分钟|分)\s*(?:后|以后)', text)
    if duration:
        raw = duration[1]
        amount = .5 if raw == '半' else float(raw) if re.fullmatch(r'\d+(?:\.\d+)?', raw) else _number(raw)
        if amount <= 0:
            raise _invalid_time(original)
        try:
            result = current + timedelta(minutes=amount * (60 if duration[2] == '小时' else 1))
        except (OverflowError, ValueError):
            raise _invalid_time(original) from None
        result = result.replace(microsecond=0)
        if result <= current:
            raise BridgeError('相对时间需要至少晚于现在 1 秒，请增加时间间隔。')
        return result, False

    date = None
    date_only = False
    relative = re.match(r'^(大后天|后天|明天|今天|今日|明日)(.*)$', text)
    weekly = re.match(r'^(本周|这周|下周|本星期|这星期|下星期)(?:星期|周)?([一二三四五六日天1-7])(.*)$', text)
    weekday = re.match(r'^(?:星期|周)([一二三四五六日天1-7])(.*)$', text)
    year_date = re.match(r'^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(.*)$', text)
    chinese_year = re.match(rf'^(\d{{4}})年\s*({NUMBER})月\s*({NUMBER})[日号]?(.*)$', text)
    month_date = re.match(r'^(\d{1,2})\s*[-/]\s*(\d{1,2})(.*)$', text)
    chinese_month = re.match(rf'^({NUMBER})月\s*({NUMBER})[日号]?(.*)$', text)

    try:
        if relative:
            offset = {'今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3}[relative[1]]
            date = (current + timedelta(days=offset)).date()
            clock, date_only = _date_clock(relative[2])
        elif weekly or weekday:
            week_map = dict(zip('一二三四五六日天1234567', (0, 1, 2, 3, 4, 5, 6, 6, 0, 1, 2, 3, 4, 5, 6)))
            day = week_map[weekly[2] if weekly else weekday[1]]
            offset = day - current.weekday()
            if weekly:
                offset += 7 if weekly[1].startswith('下') else 0
                rest = weekly[3]
            else:
                offset %= 7
                rest = weekday[2]
            date = (current + timedelta(days=offset)).date()
            clock, date_only = _date_clock(rest)
            if not weekly and datetime.combine(date, datetime.min.time(), CHINA_TZ).replace(
                    hour=clock[0], minute=clock[1], second=clock[2]) <= current:
                date += timedelta(days=7)
        elif year_date or chinese_year:
            matched = year_date or chinese_year
            date = datetime(int(matched[1]), _number(matched[2]), _number(matched[3])).date()
            clock, date_only = _date_clock(matched[4])
        elif month_date or chinese_month:
            matched = month_date or chinese_month
            month, day = _number(matched[1]), _number(matched[2])
            clock, date_only = _date_clock(matched[3])
            # A yearless date means the next valid occurrence, including leap day.
            for year in range(current.year, min(current.year + 9, 10000)):
                try:
                    candidate = datetime(year, month, day, *clock, tzinfo=CHINA_TZ)
                except ValueError:
                    continue
                if candidate > current:
                    return candidate, date_only
            raise _invalid_time(original)
        else:
            clock = _clock(text)
            candidate = current.replace(hour=clock[0], minute=clock[1], second=clock[2], microsecond=0)
            if candidate <= current:
                candidate += timedelta(days=1)
            return candidate, False

        result = datetime.combine(date, datetime.min.time(), CHINA_TZ).replace(
            hour=clock[0], minute=clock[1], second=clock[2])
    except (ValueError, OverflowError):
        raise _invalid_time(original) from None
    if result <= current:
        raise BridgeError(f'时间“{original}”已经过去，请填写未来的北京时间。')
    return result, date_only


def parse_schedule(text: str, now: datetime | None = None) -> datetime:
    """Return a future timezone-aware datetime in Asia/Shanghai (UTC+8)."""
    return _parsed_schedule(text, now)[0]


def _time_like(text):
    """Recognize time intent before parsing so malformed dates are not titles."""
    text = unicodedata.normalize('NFKC', text)
    return bool(re.search(
        rf'(?:今天|今日|明天|明日|后天|星期|(?:本|这|下)周|周[一二三四五六日天1-7]|{PERIOD}'
        rf'|\d{{1,4}}\s*[-/]\s*\d|\d{{4}}\.\d|{NUMBER}\s*(?:年|月|点|时|小时|分钟|分后)'
        r'|\d{1,2}\s*:|半小时)', text))


def _temporal_index(tokens):
    for index, (token, _) in enumerate(tokens):
        remainder = ' '.join(value for value, _ in tokens[index:])
        # Number and unit may have been separated by whitespace: "2 小时后".
        separated_number = re.match(
            rf'^(?:{NUMBER}|\d+\.\d+|半)\s*(?:年|月|点|时|小时|分钟|分后|[-/:])',
            unicodedata.normalize('NFKC', remainder),
        )
        if _time_like(token) or separated_number:
            return index
    return None


def _split_arguments(text):
    """Keep quoted spans intact and record their protection from time parsing."""
    tokens = []
    index = 0
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        if text[index] in QUOTES:
            quote = QUOTES[text[index]]
            end = text.find(quote, index + 1)
            if end < 0:
                raise BridgeError('标题引号没有闭合。' + USAGE)
            tokens.append((text[index + 1:end], True))
            index = end + 1
        else:
            end = index
            while end < len(text) and not text[end].isspace() and text[end] not in QUOTES:
                end += 1
            tokens.append((text[index:end], False))
            index = end
    return tokens


def parse_command_args(text: str, now: datetime | None = None) -> Command:
    """Parse the full command payload after the /bd prefix."""
    text = (text or '').strip()
    if not text or text.lower() in ('help', '帮助', '?', '？'):
        return Command('help')
    subcommand = text.split(None, 1)
    action = subcommand[0].lower()
    if action in ('status', 'queue', 'blogin'):
        if len(subcommand) == 2 and action != 'queue':
            raise BridgeError(f'/bd {action} 不需要额外参数。')
        job_id = subcommand[1].strip() if len(subcommand) == 2 else ''
        if re.search(r'\s', job_id):
            raise BridgeError('用法：/bd queue [任务ID]，一次查询一个任务。')
        return Command(action, job_id=job_id)

    matches = list(X_LINK.finditer(text))
    if len(matches) > 1:
        raise BridgeError('一次只能填写一个 X 链接（一条一稿），请分开发送。')
    if not matches or matches[0].start() != 0:
        raise BridgeError('请在 /bd 后先填写一个有效的 X 推文链接。' + USAGE)
    match = matches[0]
    end = match.end()
    # URL tracking query/fragment belongs to the URL and is never a title.
    if end < len(text) and text[end] in ('?', '#'):
        while end < len(text) and not text[end].isspace():
            end += 1
    elif end < len(text) and not text[end].isspace():
        raise BridgeError('X 链接与标题或时间之间请使用空格。' + USAGE)
    url = extract_links(match.group())[0]
    tokens = _split_arguments(text[end:].strip())
    title = None
    schedule_text = ''
    if tokens:
        quoted = [index for index, (_, protected) in enumerate(tokens) if protected]
        if quoted:
            if quoted != [0]:
                raise BridgeError('请把一个完整的引号标题放在链接后、时间前。' + USAGE)
            title = tokens[0][0].strip()
            schedule_text = ' '.join(token for token, _ in tokens[1:])
            if not title:
                raise BridgeError('标题不能为空；不需要标题时请直接省略。')
        else:
            temporal = _temporal_index(tokens)
            if temporal is None:
                title = ' '.join(token for token, _ in tokens)
            else:
                title = ' '.join(token for token, _ in tokens[:temporal]) or None
                schedule_text = ' '.join(token for token, _ in tokens[temporal:])
    if title and len(title.encode('utf-16-le')) // 2 > 20:
        raise BridgeError('标题最多 20 个字（表情等部分字符占 2 个位置），请缩短标题。')
    scheduled_at = None
    note = ''
    if schedule_text:
        scheduled, date_only = _parsed_schedule(schedule_text, now)
        scheduled_at = scheduled.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        if date_only:
            note = '只填写了日期，已默认设为当天北京时间 20:00。'
    return Command('import', url=url, title=title, scheduled_at=scheduled_at, time_note=note)
