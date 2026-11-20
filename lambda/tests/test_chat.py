"""대화 메모리·사용자 식별·WebSocket 인증 검증(네트워크 호출 없음)"""
import base64
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import auth  # noqa: E402
import chat  # noqa: E402


def token(payload):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')  # noqa: E731
    return f"{enc({'alg': 'RS256'})}.{enc(payload)}.sig"


class ChatTest(unittest.TestCase):
    def test_user_from_http_and_ws(self):
        self.assertEqual(chat.user({'requestContext': {'authorizer': {'jwt': {'claims': {'sub': 'u1'}}}}}), 'u1')
        self.assertEqual(chat.user({'requestContext': {'authorizer': {'sub': 'u2'}}}), 'u2')
        self.assertIsNone(chat.user({'requestContext': {}}))

    def test_memory_is_small_and_keeps_schedule(self):
        draft = {'roomIds': [f'r{i}' for i in range(200)], 'floor': '2F', 'use': '회의실', 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': None}
        result = {'answer': '가' * 500, 'highlight': [f'room-id-{i:04d}-xxxxxxxx' for i in range(200)], 'draft': draft,
                  'steps': [{'id': 'query', 'chips': ['2F', '회의실', '13:00 이후']}]}
        mem = chat.make_memory({'lastSchedule': {'id': 's1'}}, '질문' * 200, result)
        self.assertLessEqual(len(json.dumps(mem, ensure_ascii=False).encode()), chat.MEMORY_BYTES)
        self.assertEqual(mem['conditions'], ['2F', '회의실', '13:00 이후'])
        self.assertEqual(mem['draft']['targets'], 200)
        self.assertEqual(mem['lastSchedule'], {'id': 's1'})

    def test_memory_keeps_ten_turns_and_draft_across_clarifications(self):
        # 제보 경로: 요청 → 시각 되묻기 → "지금" → 형식 되묻기 → "15:30"에서 처음 요청이 남아야 함
        mem, ask = None, {'answer': '가' * 500, 'steps': [], 'highlight': [], 'draft': None}
        for i in range(12):
            mem = chat.make_memory(mem, f'{i}번 질문 ' + '나' * 300, ask)
        self.assertEqual(len(mem['turns']), chat.MEMORY_TURNS)
        self.assertTrue(mem['turns'][0]['q'].startswith('2번'))
        self.assertLessEqual(len(json.dumps(mem, ensure_ascii=False).encode()), chat.MEMORY_BYTES)
        draft = {'roomIds': ['r1'], 'floor': 'all', 'use': 'all', 'action': 'off', 'time': '15:26', 'condition': 'unused', 'setpoint': 0}
        mem = chat.make_memory(mem, '현재 재실 0곳 꺼줘', {'answer': '초안', 'steps': [], 'highlight': [], 'draft': draft})
        mem = chat.make_memory(mem, '몇 시?', ask)
        self.assertEqual(mem['draft']['time'], '15:26')  # 되묻기 턴에도 초안 유지
        self.assertNotIn('rooms', mem['draft'])

    def test_memory_keeps_room_names_of_name_pick_draft(self):
        draft = {'roomIds': ['r1', 'r2'], 'roomNames': ['회의실 A', '회의실 B'], 'floor': '1F', 'use': 'all', 'pick': 'rooms',
                 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': None}
        mem = chat.make_memory(None, '1층 회의실 A, 회의실 B 꺼줘', {'answer': '초안', 'steps': [], 'highlight': [], 'draft': draft})
        self.assertEqual((mem['draft']['rooms'], mem['draft']['targets']), (['회의실 A', '회의실 B'], 2))

    def test_old_memory_format_carried_over(self):
        mem = chat.make_memory({'lastQuestion': '이전 질문', 'lastAnswer': '이전 답'}, '새 질문', {'answer': '새 답', 'steps': []})
        self.assertEqual([x['q'] for x in mem['turns']], ['이전 질문', '새 질문'])

    def test_handler_requires_login(self):
        self.assertEqual(chat.handler({'requestContext': {'http': {'method': 'GET'}}}, None)['statusCode'], 401)


class AuthTest(unittest.TestCase):
    def setUp(self):
        auth.POOL_ID, auth.CLIENT_ID = 'pool', 'client'
        self.iss = f'https://cognito-idp.{auth.REGION}.amazonaws.com/pool'
        self.calls = []
        auth._idp = type('Idp', (), {'get_user': lambda _, AccessToken: self.calls.append(AccessToken)})()

    def test_rejects_other_pool_without_network(self):
        self.assertIsNone(auth.verify(token({'iss': 'https://cognito-idp.x.amazonaws.com/other', 'client_id': 'client', 'token_use': 'access', 'sub': 's'})))
        self.assertIsNone(auth.verify(token({'iss': self.iss, 'client_id': 'client', 'token_use': 'id', 'sub': 's'})))
        self.assertEqual(self.calls, [])

    def test_accepts_valid_and_returns_sub(self):
        t = token({'iss': self.iss, 'client_id': 'client', 'token_use': 'access', 'sub': 's1'})
        self.assertEqual(auth.verify(t), 's1')
        out = auth.handler({'queryStringParameters': {'token': t}, 'methodArn': 'arn:x'}, None)
        self.assertEqual(out['context'], {'sub': 's1', 'groups': ''})
        t = token({'iss': self.iss, 'client_id': 'client', 'token_use': 'access', 'sub': 's2', 'cognito:groups': ['admin']})
        self.assertEqual(auth.handler({'queryStringParameters': {'token': t}, 'methodArn': 'arn:x'}, None)['context'], {'sub': 's2', 'groups': 'admin'})
        with self.assertRaises(Exception):
            auth.handler({'queryStringParameters': {}, 'methodArn': 'arn:x'}, None)


if __name__ == '__main__':
    unittest.main()
