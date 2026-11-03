"""Deterministic /bd command parsing tests; no network calls."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from astrbot_plugin_380nm.bridge import BridgeError, CHINA_TZ
from astrbot_plugin_380nm.commands import parse_command_args, parse_schedule


URL = 'https://x.com/artist/status/1850000000000000000'
NOW = datetime(2026, 11, 2, 16, 30, tzinfo=CHINA_TZ)  # Monday


class CommandParsingTests(unittest.TestCase):
    def command(self, text):
        return parse_command_args(text, NOW)

    def test_help_and_subcommands(self):
        for text in ('', 'help', '帮助', '?'):
            self.assertEqual(self.command(text).action, 'help')
        for action in ('status', 'queue', 'blogin'):
            self.assertEqual(self.command(action).action, action)
        self.assertEqual(self.command('queue job-123').job_id, 'job-123')
        for text in ('status extra', 'blogin extra', 'queue id second'):
            with self.subTest(text=text), self.assertRaises(BridgeError):
                self.command(text)

    def test_optional_title_and_time(self):
        command = self.command(URL)
        self.assertEqual(command.action, 'import')
        self.assertEqual(command.url, URL)
        self.assertIsNone(command.title)
        self.assertIsNone(command.scheduled_at)
        self.assertEqual(self.command(URL + ' 作品名').title, '作品名')
        command = self.command(URL + ' 标题 明天晚上8点')
        self.assertEqual(command.title, '标题')
        self.assertEqual(command.scheduled_at, '2026-11-03T12:00:00Z')
        command = self.command(URL + ' 明天20点')
        self.assertIsNone(command.title)
        self.assertEqual(command.scheduled_at, '2026-11-03T12:00:00Z')

    def test_quoted_titles_protect_dates_and_spaces(self):
        for title in ('"含 空格 标题"', '“含 空格 标题”', "'含 空格 标题'", '‘含 空格 标题’'):
            command = self.command(f'{URL} {title} 2026-11-05 20:30')
            self.assertEqual(command.title, '含 空格 标题')
            self.assertEqual(command.scheduled_at, '2026-11-05T12:30:00Z')
        command = self.command(URL + ' “明天晚上8点”')
        self.assertEqual(command.title, '明天晚上8点')
        self.assertIsNone(command.scheduled_at)

    def test_links_and_tracking_queries(self):
        for link in (URL, URL.removeprefix('https://'), URL.replace('x.com', 'twitter.com'),
                     URL + '?s=20&t=something', URL + '/photo/1?s=20', URL + '#fragment'):
            with self.subTest(link=link):
                command = self.command(link + ' 作品名')
                self.assertEqual(command.url, URL)
                self.assertEqual(command.title, '作品名')
        self.assertIsNone(self.command(URL + '?s=20').title)
        for text in (URL + ' ' + URL, URL + ' https://x.com/other/status/123',
                     'https://evilx.com/artist/status/1', 'hello ' + URL,
                     'https://evil.test/x.com/artist/status/1'):
            with self.subTest(text=text), self.assertRaises(BridgeError):
                self.command(text)

    def test_title_limit_uses_javascript_utf16_length(self):
        self.assertEqual(self.command(URL + ' ' + '中' * 20).title, '中' * 20)
        self.assertEqual(self.command(URL + ' ' + '🎨' * 10).title, '🎨' * 10)
        for title in ('中' * 21, '🎨' * 11):
            with self.assertRaisesRegex(BridgeError, '20'):
                self.command(URL + ' ' + title)

    def test_invalid_time_is_not_a_title(self):
        for suffix in ('明天25点', '作品 明天25点', '2026-11-31', '作品 2026-11-31',
                       '明天20:99', '2026-11', '明天晚上', '明天 20 oclock',
                       '明天8点 rubbish', '13月2日', '2月30日', '20:aa'):
            with self.subTest(suffix=suffix), self.assertRaises(BridgeError):
                self.command(URL + ' ' + suffix)

    def test_bad_quotes_and_extra_arguments(self):
        for suffix in ('“unclosed', '“”', 'title “another”', '“one” “two”', '“title” nonsense'):
            with self.subTest(suffix=suffix), self.assertRaises(BridgeError):
                self.command(URL + ' ' + suffix)

    def test_default_date_time_is_disclosed(self):
        command = self.command(URL + ' 明天')
        self.assertEqual(command.scheduled_at, '2026-11-03T12:00:00Z')
        self.assertIn('20:00', command.time_note)
        self.assertEqual(self.command(URL + ' 明天20点').time_note, '')

    def test_relative_and_spaced_times_in_commands(self):
        for suffix in ('2小时后', '2 小时后', '两小时后'):
            command = self.command(URL + ' 作品 ' + suffix)
            self.assertEqual(command.title, '作品')
            self.assertEqual(command.scheduled_at, '2026-11-02T10:30:00Z')
        command = self.command(URL + ' 30 分钟后')
        self.assertIsNone(command.title)
        self.assertEqual(command.scheduled_at, '2026-11-02T09:00:00Z')
        command = self.command(URL + ' 20 点')
        self.assertIsNone(command.title)
        self.assertEqual(command.scheduled_at, '2026-11-02T12:00:00Z')
        command = self.command(URL + ' 2026 - 11 - 5 20:30')
        self.assertIsNone(command.title)
        self.assertEqual(command.scheduled_at, '2026-11-05T12:30:00Z')


class ScheduleParsingTests(unittest.TestCase):
    def test_supported_chinese_dates_and_clocks(self):
        cases = {
            '明天晚上8点': '2026-11-03T20:00:00+08:00',
            '明天20点': '2026-11-03T20:00:00+08:00',
            '明天晚上八点半': '2026-11-03T20:30:00+08:00',
            '后天上午九点一刻': '2026-11-04T09:15:00+08:00',
            '大后天20点三刻': '2026-11-05T20:45:00+08:00',
            '今天 20:30': '2026-11-02T20:30:00+08:00',
            '下周星期三晚上8点': '2026-11-11T20:00:00+08:00',
            '本周五': '2026-11-06T20:00:00+08:00',
            '下星期二 20:30': '2026-11-10T20:30:00+08:00',
            '周一20点': '2026-11-02T20:00:00+08:00',
            '星期一8点': '2026-11-09T08:00:00+08:00',
            '2026-11-05 20:30': '2026-11-05T20:30:00+08:00',
            '2026/11/5 20:30': '2026-11-05T20:30:00+08:00',
            '2026年11月5日晚上8点': '2026-11-05T20:00:00+08:00',
            '2026年十一月五号晚上八点': '2026-11-05T20:00:00+08:00',
            '11月5日': '2026-11-05T20:00:00+08:00',
            '11-5': '2026-11-05T20:00:00+08:00',
            '11/5': '2026-11-05T20:00:00+08:00',
            '2026-11-05T20:30': '2026-11-05T20:30:00+08:00',
            '明天２０：３０': '2026-11-03T20:30:00+08:00',
            '2小时后': '2026-11-02T18:30:00+08:00',
            '两小时后': '2026-11-02T18:30:00+08:00',
            '三十分钟后': '2026-11-02T17:00:00+08:00',
            '半小时后': '2026-11-02T17:00:00+08:00',
            '1.5小时后': '2026-11-02T18:00:00+08:00',
            '晚上八点': '2026-11-02T20:00:00+08:00',
            '八点': '2026-11-03T08:00:00+08:00',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_schedule(text, NOW).isoformat(), expected)

    def test_time_only_picks_next_occurrence(self):
        self.assertEqual(parse_schedule('16:30', NOW).isoformat(), '2026-11-03T16:30:00+08:00')
        self.assertEqual(parse_schedule('17:00', NOW).isoformat(), '2026-11-02T17:00:00+08:00')

    def test_yearless_dates_choose_next_valid_occurrence(self):
        self.assertEqual(parse_schedule('11月1日', NOW).isoformat(), '2027-11-01T20:00:00+08:00')
        self.assertEqual(parse_schedule('2月29日', NOW).isoformat(), '2028-02-29T20:00:00+08:00')

    def test_explicit_past_dates_and_invalid_dates_rejected(self):
        for text in ('今天8点', '2026-11-01 20:00', '2025-11-05', '2027-02-29',
                     '2026-13-01', '明天24:00', '明天8:60', '0小时后',
                     '明天晚上20点', '2026-11-05 20:00+08:00', ''):
            with self.subTest(text=text), self.assertRaises(BridgeError):
                parse_schedule(text, NOW)

    def test_utc_reference_and_naive_reference_use_china_time(self):
        utc_now = NOW.astimezone(timezone.utc)
        self.assertEqual(parse_schedule('明天20点', utc_now), parse_schedule('明天20点', NOW))
        self.assertEqual(parse_schedule('明天20点', NOW.replace(tzinfo=None)), parse_schedule('明天20点', NOW))

    def test_ambiguous_twelve_and_subsecond_delays_rejected(self):
        for text in ('明天晚上12点', '明天上午12点', '明天早上12点', '明天夜里12点'):
            with self.subTest(text=text), self.assertRaisesRegex(BridgeError, '歧义'):
                parse_schedule(text, NOW)
        self.assertEqual(parse_schedule('明天中午12点', NOW).hour, 12)
        self.assertEqual(parse_schedule('明天凌晨12点', NOW).hour, 0)
        for text in ('0.001分钟后', '0.0001小时后'):
            with self.subTest(text=text), self.assertRaises(BridgeError):
                parse_schedule(text, NOW)


if __name__ == '__main__':
    unittest.main()
