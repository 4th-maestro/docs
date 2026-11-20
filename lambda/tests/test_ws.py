"""질의 단계 이벤트와 WebSocket 핸들러 테스트(가짜 모델·가짜 연결, 네트워크 호출 없음)"""
import json
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
# anthropic·boto3 미설치 환경에서도 실행되도록 모듈 대체, 모델 클라이언트는 테스트마다 가짜로 교체
sys.modules['anthropic'] = types.SimpleNamespace(AnthropicBedrock=lambda **kw: None)
sys.modules.setdefault('boto3', types.SimpleNamespace(client=None))
import query  # noqa: E402
import tools  # noqa: E402
import ws  # noqa: E402

NS = types.SimpleNamespace


def msg(stop, *blocks):
    return NS(stop_reason=stop, content=list(blocks))


def text(t):
    return NS(type='text', text=t)


def tool(name, args, tid='t1'):
    return NS(type='tool_use', name=name, input=args, id=tid)


class FakeStream:
    def __init__(self, m):
        self.m = m

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        # 실제 SDK처럼 텍스트는 조각 단위 text 이벤트, 블록 끝마다 content_block_stop
        for b in self.m.content:
            if b.type == 'text':
                for i in range(0, len(b.text), 4):
                    yield NS(type='text', text=b.text[i:i + 4])
            yield NS(type='content_block_stop', content_block=b)

    def get_final_message(self):
        return self.m


class FakeClient:
    def __init__(self, *msgs):
        self.msgs, self.calls = list(msgs), []
        self.messages = self

    def stream(self, **kw):
        self.calls.append(kw)
        return FakeStream(self.msgs.pop(0))


QUERY = {'floor': '1F', 'use': 'all', 'metric': 'powerKw', 'order': 'desc', 'limit': 3}
def answer(conclusion, detail='', action=''):
    # 구조화 응답(output_config.format) 형식의 모델 출력
    return json.dumps({'conclusion': conclusion, 'detail': detail, 'action': action}, ensure_ascii=False)


ANSWER_JSON = answer('1층 전력 상위 3곳을 표시했습니다.', action='재실 없는 호실은 OFF를 검토하십시오.')
ANSWER = '1층 전력 상위 3곳을 표시했습니다.\n재실 없는 호실은 OFF를 검토하십시오.'


def steps(events):
    return [(e['id'], e['status']) for e in events if e['type'] == 'step']


class RunTest(unittest.TestCase):
    def ask(self, *msgs, text='1층 전력 높은 곳 3개'):
        query.client = FakeClient(*msgs)
        events = []
        return query.run(text, events.append), events

    def test_floor_unspecified_schedule_is_rejected(self):
        # 층을 말하지 않은 제어 요청의 전체 층 초안은 실행하지 않고 되묻기(7차 평가 q22)
        args = {'floor': 'all', 'use': '진료실', 'action': 'setpoint', 'time': '15:00', 'condition': 'always', 'setpoint': 22}
        client = FakeClient(msg('tool_use', tool('create_schedule', args)), msg('end_turn', text(answer('어느 층에 적용할까요?', '1F, 2F, 전체'))))
        query.client = client
        result = query.run('진료실 설정온도 22도로 오후 3시부터', lambda e: None)
        self.assertIsNone(result['draft'])
        sent = client.calls[1]['messages'][-1]['content'][0]
        self.assertTrue(sent['is_error'] and sent['content'] == query.FLOOR_ASK)
        self.assertEqual(result['answer'], '어느 층에 적용할까요?\n1F, 2F, 전체')

    def test_floor_scope_words_and_memory_allow_all(self):
        self.assertTrue(query.floor_given('현재 재실 0곳인 곳은 꺼줘', None))
        self.assertTrue(query.floor_given('15:30', {'turns': [{'q': '전체 층 사무실 꺼줘'}, {'q': '지금'}]}))
        self.assertTrue(query.floor_given('15:30', {'draft': {'floor': 'all'}}))
        self.assertFalse(query.floor_given('사무실 꺼줘', {'turns': [{'q': '전체 현황'}, {'q': '1층'}, {'q': '회의실'}]}))

    def test_tool_round_event_order(self):
        result, events = self.ask(msg('tool_use', tool('query_spaces', QUERY)), msg('end_turn', text(ANSWER_JSON)))
        self.assertEqual(steps(events), [
            ('understand', 'active'), ('understand', 'done'), ('query', 'active'), ('query', 'done'),
            ('review', 'active'), ('review', 'done'), ('answer', 'active'), ('answer', 'done'),
        ])
        q = next(e for e in events if e['type'] == 'step' and e['id'] == 'query' and e['status'] == 'active')
        self.assertEqual(q['chips'], ['1F', '전체 용도', '전력 높은 순', '3곳'])
        self.assertEqual(next(e for e in events if e.get('id') == 'query' and e['status'] == 'done')['detail'], '3곳')
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'delta'), ANSWER)
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(events[-1]['result'], result)
        self.assertEqual(result['answer'], ANSWER)
        self.assertEqual(len(result['highlight']), 3)
        self.assertEqual([(s['id'], s['status']) for s in result['steps']], [('understand', 'done'), ('query', 'done'), ('review', 'done'), ('answer', 'done')])
        self.assertTrue(all(isinstance(s['ms'], int) for s in result['steps']))
        call = query.client.calls[0]
        self.assertEqual(call['output_config'], {'effort': 'low', 'format': query.ANSWER_FORMAT})
        self.assertNotIn('tool_choice', call)
        self.assertNotIn('temperature', call)
        self.assertEqual(len(query.client.calls), 2)

    def test_ask_back_without_tools(self):
        result, events = self.ask(msg('end_turn', text(answer('몇 층의 회의실인지 알려 주십시오.'))), text='회의실 꺼줘')
        self.assertEqual(steps(events), [('understand', 'active'), ('understand', 'done'), ('answer', 'active'), ('answer', 'done')])
        self.assertEqual([s['id'] for s in result['steps']], ['understand', 'answer'])
        self.assertEqual(result['highlight'], [])
        self.assertIsNone(result['draft'])

    def test_refusal(self):
        result, events = self.ask(msg('refusal'))
        self.assertEqual(result['answer'], query.REFUSAL)
        self.assertEqual(steps(events), [('understand', 'active'), ('understand', 'error')])
        self.assertEqual(events[-1]['type'], 'done')

    def test_preamble_text_is_not_answer(self):
        # 도구 호출 앞 텍스트는 answer 기록에서 제외
        result, _ = self.ask(msg('tool_use', text('조회하겠습니다.'), tool('query_spaces', QUERY)), msg('end_turn', text(ANSWER_JSON)))
        self.assertEqual(result['answer'], ANSWER)
        self.assertEqual([s['id'] for s in result['steps']], ['understand', 'query', 'review', 'answer'])

    def test_tool_error_marks_query_error(self):
        result, events = self.ask(msg('tool_use', tool('query_spaces', {**QUERY, 'floor': '9F'})), msg('end_turn', text(answer('층을 다시 알려 주십시오.'))))
        self.assertIn(('query', 'error'), steps(events))
        self.assertEqual(result['highlight'], [])

    def test_schedule_chips(self):
        args = {'floor': '2F', 'use': '회의실', 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': 0}
        self.assertEqual(tools.chips('create_schedule', args), ['2F', '회의실', '13:00 이후', '재실 없을 때', '운전 OFF'])
        self.assertEqual(tools.chips('create_schedule', {**args, 'action': 'setpoint', 'setpoint': 24.0, 'condition': 'always'}), ['2F', '회의실', '13:00 이후', '설정온도 24℃'])


class HttpTest(unittest.TestCase):
    def test_contract_unchanged(self):
        query.client = FakeClient(msg('tool_use', tool('query_spaces', QUERY)), msg('end_turn', text(ANSWER_JSON)))
        res = query.handler({'body': json.dumps({'text': '1층 전력 높은 곳'})}, None)
        self.assertEqual(res['statusCode'], 200)
        body = json.loads(res['body'])
        self.assertEqual(set(body), {'answer', 'highlight', 'draft', 'steps', 'charts'})
        self.assertEqual(body['answer'], ANSWER)

    def test_rejects_empty_and_long_text(self):
        for t in ['', '   ', 'a' * 501, 3]:
            self.assertEqual(query.handler({'body': json.dumps({'text': t})}, None)['statusCode'], 400)


class Gone(Exception):
    pass


class FakeApi:
    exceptions = NS(GoneException=Gone)

    def __init__(self, gone_after=None):
        self.sent, self.gone_after = [], gone_after

    def post_to_connection(self, ConnectionId, Data):
        if self.gone_after is not None and len(self.sent) >= self.gone_after:
            raise Gone()
        self.sent.append(json.loads(Data))


def ws_event(route, body=None):
    ctx = {'routeKey': route, 'connectionId': 'c1', 'domainName': 'x.execute-api', 'stage': 'prod'}
    return {'requestContext': ctx, 'body': json.dumps(body) if body else None}


class WsTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        ws.boto3 = NS(client=lambda name, endpoint_url: self.api)

    def test_connect_disconnect(self):
        self.assertEqual(ws.handler(ws_event('$connect'), None), {'statusCode': 200})
        self.assertEqual(ws.handler(ws_event('$disconnect'), None), {'statusCode': 200})
        self.assertEqual(self.api.sent, [])

    def test_ask_events_carry_request_id(self):
        query.client = FakeClient(msg('end_turn', text(ANSWER_JSON)))
        ws.handler(ws_event('ask', {'action': 'ask', 'requestId': 'r1', 'text': '전력 높은 곳'}), None)
        self.assertTrue(all(e['requestId'] == 'r1' for e in self.api.sent))
        self.assertEqual(self.api.sent[-1]['type'], 'done')

    def test_gone_stops_quietly(self):
        self.api.gone_after = 1
        query.client = FakeClient(msg('tool_use', tool('query_spaces', QUERY)), msg('end_turn', text(ANSWER_JSON)))
        self.assertEqual(ws.handler(ws_event('ask', {'action': 'ask', 'requestId': 'r1', 'text': '전력'}), None), {'statusCode': 200})
        self.assertEqual(len(query.client.calls), 1)

    def test_bad_text_and_model_error(self):
        ws.handler(ws_event('ask', {'action': 'ask', 'requestId': 'r1', 'text': ''}), None)
        self.assertEqual(self.api.sent[-1]['type'], 'error')
        query.client = NS(messages=NS(stream=lambda **kw: (_ for _ in ()).throw(RuntimeError('bedrock'))))
        with self.assertLogs(level='ERROR'):
            ws.handler(ws_event('ask', {'action': 'ask', 'requestId': 'r2', 'text': '전력'}), None)
        self.assertEqual(self.api.sent[-1], {'type': 'error', 'message': 'AI 응답을 받지 못했습니다. 잠시 후 다시 시도하십시오.', 'requestId': 'r2'})


if __name__ == '__main__':
    unittest.main()
