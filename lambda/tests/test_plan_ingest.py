"""도면 변환 작업 API 테스트: admin 전용, 작업 생성 검증, 업로드 키·서명, 시작·재시작 상태 전환, 인식 전용 작업, 상태 조회, 기호 찾기(가짜 저장소, 네트워크 없음)"""
import json
import os
import pathlib
import re
import sys
import time
import types
import unittest
from decimal import Decimal
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
# anthropic·boto3 미설치 환경에서도 실행되도록 모듈 대체(test_ws.py와 같은 방식)
sys.modules.setdefault('anthropic', types.SimpleNamespace(AnthropicBedrock=lambda **kw: None))
sys.modules.setdefault('boto3', types.SimpleNamespace(client=None))
import api  # noqa: E402
import admin  # noqa: E402
import plan_ingest  # noqa: E402
import tenant  # noqa: E402

ENV = {'PLANS_BUCKET': 'bk', 'PLAN_JOBS_TABLE': 'J', 'PLAN_STATE_MACHINE': 'arn:sm', 'INGEST_FUNCTION': 'ingest-fn'}
ROOT = pathlib.Path(__file__).resolve().parent.parent


class Conditional(Exception):
    pass


class FakeJobs:
    """DynamoDB Table 대체: get·put, 조건 #s = :old(상태 일치)만 지원"""

    def __init__(self):
        self.items = {}
        self.meta = types.SimpleNamespace(client=types.SimpleNamespace(exceptions=types.SimpleNamespace(ConditionalCheckFailedException=Conditional)))

    def get_item(self, Key):
        it = self.items.get(Key['jobId'])
        return {'Item': json.loads(json.dumps(it))} if it else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None, **kw):
        if ConditionExpression and (self.items.get(Item['jobId']) or {}).get('status') != ExpressionAttributeValues[':old']:
            raise Conditional()
        self.items[Item['jobId']] = json.loads(json.dumps(Item))


class FakeS3:
    def __init__(self):
        self.signed, self.objects = [], {}

    def generate_presigned_url(self, method, Params, ExpiresIn):
        self.signed.append((method, Params, ExpiresIn))
        return f"https://{Params['Bucket']}.s3/{Params['Key']}?m={method}"

    def get_object(self, Bucket, Key):
        return {'Body': types.SimpleNamespace(read=lambda: self.objects[Key])}


class FakeSfn:
    def __init__(self, fail=False):
        self.started, self.fail = [], fail

    def start_execution(self, stateMachineArn, input):
        if self.fail:
            raise RuntimeError('throttled')
        self.started.append((stateMachineArn, json.loads(input)))


def http(route, body=None, path=None, groups='admin'):
    return {'routeKey': route, 'pathParameters': path, 'body': json.dumps(body) if body is not None else None,
            'requestContext': {'authorizer': {'jwt': {'claims': {'sub': 'u-admin', 'cognito:groups': groups}}}}}


def call(route, body=None, path=None, groups='admin'):
    r = api.handler(http(route, body, path, groups), None)
    return r['statusCode'], json.loads(r['body'])


PDF = {'building': 'main', 'kind': 'pdf', 'files': [{'name': '1층 평면도.pdf', 'size': 1234}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.jobs, self.s3, self.sfn = FakeJobs(), FakeS3(), FakeSfn()
        tenant._tables['J'] = self.jobs
        plan_ingest._c.update(s3=self.s3, stepfunctions=self.sfn)
        self.env = patch.dict(os.environ, ENV)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        tenant._tables.pop('J', None)
        plan_ingest._c.clear()

    def create(self, body=PDF):
        code, out = call('POST /plans/jobs', body)
        self.assertEqual(code, 201, out)
        return out


class AuthTest(Base):
    def test_admin_only(self):
        for route, body, path in (('POST /plans/jobs', PDF, None), ('POST /plans/jobs/{jobId}/start', {}, {'jobId': 'x'}),
                                  ('POST /plans/detect', {}, None), ('GET /plans/jobs/{jobId}', None, {'jobId': 'x'})):
            self.assertEqual(call(route, body, path, groups='')[0], 403, route)
        self.assertEqual(self.jobs.items, {})

    def test_routes(self):
        for p in ('/plans/jobs', '/plans/jobs/{jobId}/start', '/plans/detect', '/plans/jobs/{jobId}'):
            self.assertIs(api.route(p), plan_ingest.handler, p)


class CreateTest(Base):
    def test_validation(self):
        f = PDF['files']
        bad = [
            {**PDF, 'building': 'nope'}, {**PDF, 'building': 'b-ABCD1234'}, {**PDF, 'building': 'b-abc123'}, {**PDF, 'building': None},
            {**PDF, 'kind': 'dwg'}, {**PDF, 'kind': None},
            {**PDF, 'files': []}, {**PDF, 'files': 'a.pdf'}, {**PDF, 'files': f * 21},
            {**PDF, 'files': [{'name': 'a.dwg', 'size': 1}]},  # pdf 작업에 CAD 파일
            {**PDF, 'files': [{'name': 'a/b.pdf', 'size': 1}]}, {**PDF, 'files': [{'name': '..\\b.pdf', 'size': 1}]},
            {**PDF, 'files': [{'name': 'a.pdf', 'size': 200 * 1024 * 1024 + 1}]}, {**PDF, 'files': [{'name': 'a.pdf', 'size': 0}]},
            {**PDF, 'files': [{'name': 'a.pdf', 'size': True}]}, {**PDF, 'files': [{'name': 'a.pdf', 'size': 1.5}]},
            {**PDF, 'files': [{'name': 'a.pdf', 'size': 1}, {'name': 'a.pdf', 'size': 2}]},
            ['not', 'object'],
        ]
        for body in bad:
            self.assertEqual(call('POST /plans/jobs', body)[0], 400, body)
        self.assertEqual(self.jobs.items, {})
        self.assertEqual(self.s3.signed, [])

    def test_kinds_and_new_building(self):
        ok = [('ifc', ['a.IFC', 'equip.png']), ('cad', ['a.dxf', 'b.DWG']), ('pdf', ['a.pdf']), ('image', ['a.jpg', 'b.jpeg', 'c.png'])]
        for kind, names in ok:
            self.create({'building': 'b-abcd1234', 'kind': kind, 'files': [{'name': n, 'size': 10} for n in names]})
        self.assertEqual(len(self.jobs.items), 4)

    def test_upload_keys_and_signature(self):
        out = self.create({**PDF, 'files': [{'name': '1층 평면도.pdf', 'size': 1234}, {'name': '2층.pdf', 'size': 200 * 1024 * 1024}]})
        jid = out['jobId']
        self.assertEqual([u['key'] for u in out['uploads']], [f'uploads/{jid}/1층 평면도.pdf', f'uploads/{jid}/2층.pdf'])
        # PUT URL 15분, Content-Length 서명(신고 크기와 다른 업로드는 S3가 거부)
        self.assertEqual([(m, p['Key'], p['ContentLength'], e) for m, p, e in self.s3.signed],
                         [('put_object', f'uploads/{jid}/1층 평면도.pdf', 1234, 900), ('put_object', f'uploads/{jid}/2층.pdf', 200 * 1024 * 1024, 900)])
        job = self.jobs.items[jid]
        self.assertEqual((job['status'], job['building'], job['kind']), ('created', 'main', 'pdf'))
        self.assertAlmostEqual(job['ttl'], time.time() + 7 * 86400, delta=60)
        self.assertEqual(self.sfn.started, [])


class StartTest(Base):
    def start(self, jid, body=None):
        return call('POST /plans/jobs/{jobId}/start', body, {'jobId': jid})

    def test_start_and_conflict(self):
        jid = self.create()['jobId']
        self.assertEqual(self.start('nope')[0], 404)
        for bad in ({'options': {'dpi': 300}}, {'options': {'pxPerM': -1}}, {'options': {'scale': '1/200'}}, {'options': []}):
            self.assertEqual(self.start(jid, bad)[0], 400, bad)
        self.assertEqual(self.start(jid, {'options': {'scale': 200}}), (202, {'status': 'running'}))
        job = self.jobs.items[jid]
        self.assertEqual((job['status'], job['step']), ('running', 'parse'))
        arn, payload = self.sfn.started[0]
        self.assertEqual(arn, 'arn:sm')
        self.assertEqual(payload, {'jobId': jid, 'building': 'main', 'kind': 'pdf', 'keys': [f'uploads/{jid}/1층 평면도.pdf'],
                                   'bucket': 'bk', 'options': {'scale': 200}})
        self.assertEqual(self.start(jid)[0], 409)
        self.assertEqual(len(self.sfn.started), 1)

    def test_restart_after_failure(self):
        jid = self.create()['jobId']
        self.jobs.items[jid].update(status='failed', error='x')
        self.assertEqual(self.start(jid)[0], 202)
        self.assertNotIn('error', self.jobs.items[jid])
        self.assertEqual(self.sfn.started[0][1]['options'], {})
        self.jobs.items[jid]['status'] = 'review'
        self.assertEqual(self.start(jid)[0], 409)

    def test_concurrent_start(self):
        jid = self.create()['jobId']
        # 조회 뒤 다른 요청이 먼저 시작한 경우: 조건부 기록 실패 → 409, 상태 머신 시작 안 함
        real = self.jobs.get_item

        def read_then_race(Key):
            item = real(Key)
            self.jobs.items[jid]['status'] = 'running'
            return item
        self.jobs.get_item = read_then_race
        self.assertEqual(self.start(jid)[0], 409)
        self.assertEqual(self.sfn.started, [])

    def test_start_failure_marks_failed(self):
        jid = self.create()['jobId']
        plan_ingest._c['stepfunctions'] = FakeSfn(fail=True)
        with self.assertRaises(RuntimeError):
            self.start(jid)
        self.assertEqual(self.jobs.items[jid]['status'], 'failed')
        self.assertIn('throttled', self.jobs.items[jid]['error'])


class DetectTest(Base):
    def test_detect_only_job(self):
        src = self.create({'building': 'b-abcd1234', 'kind': 'image', 'files': [{'name': 'plan.png', 'size': 10}, {'name': 'plan2.png', 'size': 10}]})
        key = src['uploads'][0]['key']
        bad = [{'building': 'main', 'key': key},  # 다른 건물
               {'building': 'b-abcd1234', 'key': 'plans/main/current.json'}, {'building': 'b-abcd1234', 'key': f"uploads/{src['jobId']}/none.png"},
               {'building': 'b-abcd1234', 'key': key, 'pxPerM': 0}, {'building': 'b-abcd1234', 'key': key, 'pxPerM': True}, {'building': 'b-abcd1234'}]
        for body in bad:
            self.assertEqual(call('POST /plans/detect', body)[0], 400, body)
        code, out = call('POST /plans/detect', {'building': 'b-abcd1234', 'key': key, 'pxPerM': 40})
        self.assertEqual(code, 202)
        job = self.jobs.items[out['jobId']]
        self.assertEqual((job['kind'], job['status'], job['step'], job['files'][0]['key']), ('detect', 'running', 'detect', key))
        self.assertEqual(self.sfn.started[-1][1], {'jobId': out['jobId'], 'building': 'b-abcd1234', 'bucket': 'bk',
                                                   'detect': [{'floor': None, 'imageKey': key, 'pxPerM': 40, 'toPlan': None}]})
        # 인식 전용 작업은 /start로 다시 시작하지 않음
        job['status'] = 'failed'
        self.assertEqual(call('POST /plans/jobs/{jobId}/start', None, {'jobId': out['jobId']})[0], 409)

    def test_non_image_rejected(self):
        src = self.create()
        self.assertEqual(call('POST /plans/detect', {'building': 'main', 'key': src['uploads'][0]['key']})[0], 400)


class FakeLambda:
    """Lambda invoke 대체: result는 컨테이너 응답(dict) 또는 예외"""

    def __init__(self, result, error=None):
        self.calls, self.result, self.error = [], result, error

    def invoke(self, FunctionName, Payload):
        self.calls.append((FunctionName, json.loads(Payload)))
        if isinstance(self.result, Exception):
            raise self.result
        out = {'Payload': types.SimpleNamespace(read=lambda: json.dumps(self.result).encode())}
        return {**out, 'FunctionError': self.error} if self.error else out


class ReadTimeoutError(Exception):
    pass


class MatchTest(Base):
    KEY = 'jobs/' + 'a' * 32 + '/pages/1.png'

    def match(self, body, groups='admin'):
        return call('POST /plans/match', body, groups=groups)

    def test_admin_only_and_body_checks(self):
        plan_ingest._c['lambda'] = FakeLambda({'matches': [], 'size': [10, 10], 'ms': 1})
        self.assertEqual(self.match({'key': self.KEY, 'box': [0, 0, 20, 20]}, groups='')[0], 403)
        box = [10, 20, 64, 74]
        bad = [{'key': 'plans/main/building.json', 'box': box}, {'key': 'jobs/' + 'a' * 32 + '/draft.json', 'box': box},
               {'key': 'uploads/' + 'a' * 32 + '/plan.pdf', 'box': box}, {'key': 'jobs/x/../plans/1.png', 'box': box},
               {'key': self.KEY, 'box': [10, 20, 64]}, {'key': self.KEY, 'box': [64, 20, 10, 74]}, {'key': self.KEY, 'box': [-1, 20, 64, 74]},
               {'key': self.KEY, 'box': [False, 20, 64, 74]}, {'key': self.KEY, 'box': '10,20,64,74'},
               {'key': self.KEY, 'box': box, 'min': 0}, {'key': self.KEY, 'box': box, 'min': 1.5}, {'key': self.KEY, 'box': box, 'rotate': 'yes'}]
        for body in bad:
            self.assertEqual(self.match(body)[0], 400, body)
        self.assertEqual(plan_ingest._c['lambda'].calls, [])

    def test_invoke_and_relay(self):
        result = {'matches': [{'box': [10, 20, 64, 74], 'score': 1.0}], 'size': [800, 600], 'ms': 120}
        fake = plan_ingest._c['lambda'] = FakeLambda(result)
        upload = 'uploads/' + 'b' * 32 + '/설비도.JPG'
        self.assertEqual(self.match({'key': upload, 'box': [0, 20.5, 64, 74], 'min': .5, 'rotate': False}), (200, result))
        self.assertEqual(fake.calls[-1], ('ingest-fn', {'op': 'match', 'bucket': 'bk', 'key': upload, 'box': [0, 20.5, 64, 74], 'min': .5, 'rotate': False}))
        self.match({'key': self.KEY, 'box': [10, 20, 64, 74]})
        self.assertEqual((fake.calls[-1][1]['min'], fake.calls[-1][1]['rotate']), (.35, True))
        # 컨테이너가 판정한 오류(이미지 밖 상자, 없는 이미지)는 상태 코드와 문구 그대로
        plan_ingest._c['lambda'] = FakeLambda({'status': 404, 'error': '도면 이미지가 없습니다.'})
        self.assertEqual(self.match({'key': self.KEY, 'box': [10, 20, 64, 74]}), (404, {'error': '도면 이미지가 없습니다.'}))
        plan_ingest._c['lambda'] = FakeLambda({'errorMessage': 'MemoryError', 'errorType': 'MemoryError'}, error='Unhandled')
        code, out = self.match({'key': self.KEY, 'box': [10, 20, 64, 74]})
        self.assertEqual(code, 500)
        self.assertNotIn('MemoryError', out['error'])
        plan_ingest._c['lambda'] = FakeLambda(ReadTimeoutError())
        self.assertEqual(self.match({'key': self.KEY, 'box': [10, 20, 64, 74]})[0], 504)


class StatusTest(Base):
    def get(self, jid):
        return call('GET /plans/jobs/{jobId}', None, {'jobId': jid})

    def test_running_review_failed(self):
        jid = self.create()['jobId']
        self.assertEqual(self.get('nope')[0], 404)
        self.jobs.items[jid].update(status='running', step='detect')
        self.assertEqual(self.get(jid), (200, {'jobId': jid, 'building': 'main', 'kind': 'pdf', 'status': 'running', 'step': 'detect'}))
        # 상태 머신 SaveDraft 결과: 초안 URL, 층별 도면 이미지 URL과 크기
        self.jobs.items[jid].update(status='review', step='merge', draftKey=f'jobs/{jid}/draft.json')
        self.s3.objects[f'jobs/{jid}/draft.json'] = json.dumps({'schema': 'twin.building/v1', 'floors': [
            {'id': '1F', 'background': {'key': f'jobs/{jid}/pages/1.png', 'px': [3000, 2000], 'toPlan': None}},
            {'id': '2F'}]}).encode()
        code, out = self.get(jid)
        self.assertEqual((code, out['status']), (200, 'review'))
        self.assertEqual(out['draftUrl'], f'https://bk.s3/jobs/{jid}/draft.json?m=get_object')
        self.assertEqual(out['pages'], [{'floor': '1F', 'url': f'https://bk.s3/jobs/{jid}/pages/1.png?m=get_object', 'px': [3000, 2000]}])
        self.assertTrue(all(e == 900 for _, _, e in self.s3.signed))
        # 상태 머신 MarkFailed 결과: Lambda 오류는 errorMessage, 그 밖의 오류는 원문
        cause = json.dumps({'errorMessage': '도면 층을 찾지 못했습니다.', 'errorType': 'ValueError', 'stackTrace': []}, ensure_ascii=False)
        self.jobs.items[jid] = {**self.jobs.items[jid], 'status': 'failed', 'error': cause}
        del self.jobs.items[jid]['draftKey']
        self.assertEqual(self.get(jid)[1]['error'], '도면 층을 찾지 못했습니다.')
        self.jobs.items[jid]['error'] = 'States.Timeout'
        self.assertEqual(self.get(jid)[1]['error'], 'States.Timeout')

    def test_detect_job_has_no_pages(self):
        self.jobs.items['d1'] = {'jobId': 'd1', 'building': 'main', 'kind': 'detect', 'status': 'review', 'step': 'detect', 'draftKey': 'jobs/d1/draft.json'}
        out = self.get('d1')[1]
        self.assertEqual(out['draftUrl'], 'https://bk.s3/jobs/d1/draft.json?m=get_object')
        self.assertNotIn('pages', out)


class ConfirmTest(Base):
    def setUp(self):
        super().setUp()
        self.jid = self.create({'building': 'b-abcd1234', 'kind': 'pdf', 'files': [{'name': 'a.pdf', 'size': 10}]})['jobId']
        self.jobs.items[self.jid].update(status='review', step='merge')
        self.request = {'operation': 'create', 'companyId': 'co-a', 'registration': {'name': '보정한 건물'}}

    def confirm(self, body=None, groups='admin'):
        return call('POST /plans/jobs/{jobId}/confirm', self.request if body is None else body,
                    {'jobId': self.jid}, groups=groups)

    def test_admin_only_and_missing_job(self):
        self.assertEqual(self.confirm(groups='')[0], 403)
        self.assertEqual(call('POST /plans/jobs/{jobId}/confirm', self.request, {'jobId': 'missing'})[0], 404)
        self.assertEqual(self.jobs.items[self.jid]['status'], 'review')

    def test_create_uses_existing_registration_and_replay_is_idempotent(self):
        result = {'building': {'id': 'b-abcd1234', 'roomCount': 2}}
        with patch.object(admin, 'handler', return_value={'statusCode': 201, 'body': json.dumps(result)}) as save:
            code, receipt = self.confirm()
            self.assertEqual((code, receipt['status'], receipt['building']), (200, 'done', result['building']))
            forwarded = save.call_args[0][0]
            self.assertEqual(forwarded['routeKey'], 'POST /admin/companies/{id}/buildings')
            self.assertEqual(forwarded['pathParameters'], {'id': 'co-a'})
            self.assertEqual(json.loads(forwarded['body'])['id'], 'b-abcd1234')
            self.assertEqual(self.confirm(), (code, receipt))
            save.assert_called_once()
        job = self.jobs.items[self.jid]
        self.assertEqual(job['status'], 'done')
        self.assertEqual(call('GET /plans/jobs/{jobId}', path={'jobId': self.jid})[1]['confirmation'], receipt)
        self.assertEqual(self.confirm({**self.request, 'companyId': 'co-b'})[0], 409)

    def test_replace_uses_existing_twin_validation_and_returns_version(self):
        with patch.object(admin, 'twin', return_value={'statusCode': 200, 'body': json.dumps({'building': {'id': 'b-abcd1234'}, 'version': 3})}) as save:
            code, receipt = self.confirm({'operation': 'replace', 'registration': {'twin': {}}})
            self.assertEqual((code, receipt['version']), (200, 3))
            self.assertEqual(save.call_args[0][0]['pathParameters'], {'id': 'b-abcd1234'})

    def test_dynamodb_receipt_numbers_remain_numbers_on_replay_and_status(self):
        saved = {'building': {'id': 'b-abcd1234', 'roomCount': 2, 'hours': [9, 18]}}
        with patch.object(admin, 'handler', return_value={'statusCode': 201, 'body': json.dumps(saved)}):
            original = self.confirm()
        stored = {**self.jobs.items[self.jid], 'confirmation': {'status': 'done', 'building': {
            'id': 'b-abcd1234', 'roomCount': Decimal(2), 'hours': [Decimal(9), Decimal(18)]}}}
        with patch.object(plan_ingest, '_job', return_value=stored):
            self.assertEqual(self.confirm(), original)
            status = call('GET /plans/jobs/{jobId}', path={'jobId': self.jid})[1]
            self.assertEqual(status['confirmation'], original[1])

    def test_invalid_state_or_request_never_saves(self):
        with patch.object(admin, 'handler') as save:
            for status in ('created', 'running', 'failed', 'confirming'):
                self.jobs.items[self.jid]['status'] = status
                self.assertEqual(self.confirm()[0], 409)
            self.jobs.items[self.jid]['status'] = 'review'
            for body in ([], {'operation': 'erase'}, {'operation': 'create', 'registration': {}},
                         {**self.request, 'registration': {'id': 'office'}},
                         {**self.request, 'registration': {'number': float('nan')}}):
                self.assertEqual(self.confirm(body)[0], 400, body)
            self.jobs.items[self.jid]['kind'] = 'detect'
            self.assertEqual(self.confirm()[0], 409)
            save.assert_not_called()

    def test_concurrent_confirm_never_registers_twice(self):
        real = self.jobs.get_item
        def read_then_race(Key):
            item = real(Key)
            self.jobs.items[self.jid]['status'] = 'confirming'
            return item
        self.jobs.get_item = read_then_race
        with patch.object(admin, 'handler') as save:
            self.assertEqual(self.confirm()[0], 409)
            save.assert_not_called()

    def test_validation_error_can_be_corrected(self):
        result = {'statusCode': 400, 'body': json.dumps({'error': '호실 id 중복'})}
        with patch.object(admin, 'handler', return_value=result):
            self.assertEqual(self.confirm(), (400, {'error': '호실 id 중복'}))
        self.assertEqual(self.jobs.items[self.jid]['status'], 'review')

    def test_storage_failure_is_not_reported_as_done(self):
        with patch.object(admin, 'handler', side_effect=RuntimeError('internal details')):
            code, body = self.confirm()
        self.assertEqual(code, 500)
        self.assertNotIn('internal details', str(body))
        self.assertEqual(self.jobs.items[self.jid]['status'], 'failed')
        self.assertEqual(self.jobs.items[self.jid]['step'], 'confirm')


class StateMachineTest(unittest.TestCase):
    """statemachine/plan.asl.json 구조: 전이 대상 존재, 오류 처리, 템플릿 치환 이름(식 평가는 README의 TestState 확인 기록)"""

    def test_definition(self):
        asl = json.loads((ROOT / 'statemachine/plan.asl.json').read_text())
        states = asl['States']
        inner = states['Detect']['ItemProcessor']['States']
        names = set(states) | set(inner)
        targets = [s.get('Next') or s.get('Default') for s in states.values()]
        targets += [c['Next'] for s in states.values() for c in s.get('Choices', []) + s.get('Catch', [])]
        self.assertTrue({t for t in targets if t} <= names)
        for name, s in states.items():
            if s['Type'] in ('Task', 'Map') and name != 'MarkFailed':
                self.assertEqual(s['Catch'][0]['Next'], 'MarkFailed', name)
        self.assertEqual(states['Detect']['MaxConcurrency'], 2)
        tpl = (ROOT / 'template.yaml').read_text()
        for sub in {m for m in re.findall(r'\$\{(\w+)\}', json.dumps(asl))}:
            self.assertIn(f'        {sub}: ', tpl, sub)


if __name__ == '__main__':
    unittest.main()
