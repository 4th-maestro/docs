"""구조화 응답 렌더링: 칸마다 첫 문장, 스트리밍 중 부분 JSON의 표시 텍스트는 앞부분이 바뀌지 않음"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import query  # noqa: E402

FULL = '{"conclusion": "1위는 A(18.5kW)입니다. 2위는 B입니다.", "detail": "재실 25명입니다.", "action": "설정온도를 점검하십시오."}'


class RenderTest(unittest.TestCase):
    def test_first_sentence_per_field(self):
        self.assertEqual(query.render(FULL), '1위는 A(18.5kW)입니다.\n재실 25명입니다.\n설정온도를 점검하십시오.')

    def test_streaming_prefix_is_stable(self):
        shown = ''
        for i in range(1, len(FULL) + 1):
            now = query.render(FULL[:i])
            self.assertTrue(now.startswith(shown))
            shown = now
        self.assertEqual(shown, query.render(FULL))

    def test_clarify_and_escapes(self):
        self.assertEqual(query.render('{"conclusion": "어느 층에 적용할까요?", "detail": "1F, 2F, 전체", "action": ""}'), '어느 층에 적용할까요?\n1F, 2F, 전체')
        self.assertEqual(query.render('{"conclusion": "끝 \\'), '끝')


if __name__ == '__main__':
    unittest.main()
