"""도면 변환 작업 API(docs/human/reference/plan-ingest.md 4절), 판매사 총관리자(admin 그룹) 전용

- POST /plans/jobs {building, kind, files: [{name, size}]} → 201 {jobId, uploads: [{name, key, url}]}
  - 업로드 키 uploads/<작업>/<파일>, S3 PUT URL 15분. 서명에 Content-Length를 포함해 신고한 크기와 다른 파일은 S3가 거부
- POST /plans/jobs/{jobId}/start {options?: {scale?, pxPerM?}} → 202 {status: 'running'}. 상태 created·failed에서만 시작(실패 후 재시도)
- POST /plans/detect {building, key, pxPerM?} → 202 {jobId}. 인식 전용 작업(kind detect)
  - key: 같은 건물 작업으로 올린 이미지(png, jpg). 결과는 jobs/<작업>/draft.json {floor, detections, model}
- GET /plans/jobs/{jobId} → {jobId, building, kind, status, step, error?, draftUrl?, pages?: [{floor, url, px}]}(GET URL 15분)
- POST /plans/jobs/{jobId}/confirm → 보정본을 판매사 건물 등록·교체 API로 저장, 작업 done 기록
- 건물: 기존 건물 id 또는 새 건물 id(b- + 소문자·숫자 8자리). 판매사가 건물 등록 전에 도면을 변환하므로 존재를 요구하지 않음
- 작업 기록: PLAN_JOBS_TABLE, 7일 뒤 ttl 삭제. 상태 머신(PLAN_STATE_MACHINE, statemachine/plan.asl.json)이 step, status(review·failed), draftKey, error 갱신
- 확정본 저장 검증은 기존 판매사 건물 관리 API를 재사용(plan_confirm.py), 기존 직접 저장 경로도 유지
"""
import json
import os
import re
import time
import uuid

import buildings
import common
import tenant

IMAGE = ('.png', '.jpg', '.jpeg')
# 형식별 허용 확장자. IFC는 실내기 객체가 없을 때 인식할 설비도면 이미지를 같은 작업으로 올릴 수 있음(2절)
KINDS = {'ifc': ('.ifc', *IMAGE), 'cad': ('.dxf', '.dwg'), 'pdf': ('.pdf',), 'image': IMAGE}
MAX_SIZE = 200 * 1024 * 1024
MAX_FILES = 20
URL_SECONDS = 15 * 60
KEEP_SECONDS = 7 * 24 * 3600
RESTARTABLE = ('created', 'failed')
OPTIONS = ('scale', 'pxPerM')
BUILDING_ID = re.compile(r'b-[a-z0-9]{8}')
UPLOAD_KEY = re.compile(r'uploads/([0-9a-f]{32})/[^/]+')
NO_JOB = '없는 작업입니다.'
_c = {}


def _client(name):
    if name not in _c:
        import boto3
        from botocore.config import Config
        # 사전 서명 URL을 리전 주소(<버킷>.s3.<리전>.amazonaws.com)로 발급: 전역 주소의 307 이동은 브라우저 CORS 요청 실패
        _c[name] = boto3.client(name, config=Config(s3={'addressing_style': 'virtual'}))
    return _c[name]


def _jobs():
    return tenant.table('PLAN_JOBS_TABLE')


def _job(jid):
    return _jobs().get_item(Key={'jobId': str(jid or '')}).get('Item')


def _put(job, old=None):
    """작업 기록. old가 있으면 현재 상태가 old일 때만 기록(동시 시작 방지)하고 성공 여부 반환"""
    kw = {'ConditionExpression': '#s = :old', 'ExpressionAttributeNames': {'#s': 'status'},
          'ExpressionAttributeValues': {':old': old}} if old else {}
    try:
        _jobs().put_item(Item=job, **kw)
    except _jobs().meta.client.exceptions.ConditionalCheckFailedException:
        return False
    return True


def _url(method, key, **params):
    return _client('s3').generate_presigned_url(method, Params={'Bucket': os.environ['PLANS_BUCKET'], 'Key': key, **params},
                                                ExpiresIn=URL_SECONDS)


def _new(bid, kind, files, **fields):
    return {'jobId': uuid.uuid4().hex, 'building': bid, 'kind': kind, 'files': files,
            'createdAt': tenant.stamp(), 'ttl': int(time.time()) + KEEP_SECONDS, **fields}


def _run(job, payload):
    """상태 머신 시작. 시작하지 못하면 작업을 failed로 기록하고 예외 전달(API 500)"""
    try:
        _client('stepfunctions').start_execution(stateMachineArn=os.environ['PLAN_STATE_MACHINE'],
                                                 input=json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        _put({**job, 'status': 'failed', 'error': f'변환 작업을 시작하지 못했습니다: {e}'})
        raise


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < float('inf')


def _building(v):
    return isinstance(v, str) and bool(BUILDING_ID.fullmatch(v) or v in {b['id'] for b in buildings.LIST})


def _files_error(kind, files):
    if not (isinstance(files, list) and 1 <= len(files) <= MAX_FILES):
        return f'files는 파일 1~{MAX_FILES}개 목록입니다.'
    names = [f.get('name') if isinstance(f, dict) else None for f in files]
    for f, name in zip(files, names):
        if not (isinstance(name, str) and 1 <= len(name) <= 200 and '/' not in name and '\\' not in name):
            return '파일 이름은 1~200자이고 경로 구분자(/, \\)를 포함하지 않습니다.'
        if not name.lower().endswith(KINDS[kind]):
            return f"{kind} 작업에 올릴 수 있는 파일 형식은 {', '.join(KINDS[kind])}입니다: {name}"
        size = f.get('size')
        if not (isinstance(size, int) and not isinstance(size, bool) and 0 < size <= MAX_SIZE):
            return f'파일 크기는 1바이트 이상 200MB 이하입니다: {name}'
    if len(set(names)) != len(names):
        return '같은 이름의 파일이 있습니다.'
    return None


def create(event):
    req = common.body(event)
    if not isinstance(req, dict):
        return common.resp(400, {'error': '요청 본문이 JSON 객체가 아닙니다.'})
    if not _building(req.get('building')):
        return common.resp(400, {'error': '건물 id는 기존 건물 또는 b- 뒤 소문자·숫자 8자리입니다.'})
    kind = req.get('kind')
    if kind not in KINDS:
        return common.resp(400, {'error': 'kind는 ifc, cad, pdf, image 중 하나입니다.'})
    err = _files_error(kind, req.get('files'))
    if err:
        return common.resp(400, {'error': err})
    job = _new(req['building'], kind, [], status='created')
    job['files'] = [{'name': f['name'], 'key': f"uploads/{job['jobId']}/{f['name']}", 'size': f['size']} for f in req['files']]
    _put(job)
    return common.resp(201, {'jobId': job['jobId'], 'uploads': [
        {'name': f['name'], 'key': f['key'], 'url': _url('put_object', f['key'], ContentLength=f['size'])} for f in job['files']]})


def start(event):
    job = _job((event.get('pathParameters') or {}).get('jobId'))
    if not job:
        return common.resp(404, {'error': NO_JOB})
    req = common.body(event)
    opts = req.get('options', {}) if isinstance(req, dict) else None
    if not (isinstance(opts, dict) and set(opts) <= set(OPTIONS) and all(_num(v) for v in opts.values())):
        return common.resp(400, {'error': 'options는 scale(축척 분모), pxPerM(1m당 픽셀) 양수만 받습니다.'})
    old = job['status']
    if job['kind'] not in KINDS or old not in RESTARTABLE:
        return common.resp(409, {'error': '시작할 수 없는 작업입니다(진행 중, 완료, 인식 전용 작업).'})
    job.update(status='running', step='parse')
    job.pop('error', None)
    if not _put(job, old):
        return common.resp(409, {'error': '이미 시작한 작업입니다.'})
    _run(job, {'jobId': job['jobId'], 'building': job['building'], 'kind': job['kind'], 'keys': [f['key'] for f in job['files']],
               'bucket': os.environ['PLANS_BUCKET'], 'options': opts})
    return common.resp(202, {'status': 'running'})


def detect(event):
    req = common.body(event)
    if not isinstance(req, dict):
        return common.resp(400, {'error': '요청 본문이 JSON 객체가 아닙니다.'})
    bid, key, px = req.get('building'), req.get('key'), req.get('pxPerM')
    if not _building(bid):
        return common.resp(400, {'error': '건물 id는 기존 건물 또는 b- 뒤 소문자·숫자 8자리입니다.'})
    if px is not None and not _num(px):
        return common.resp(400, {'error': 'pxPerM은 양수입니다.'})
    # 다른 건물 작업의 파일이나 업로드 폴더 밖 키(확정 도면 등)는 인식 대상에서 제외
    m = UPLOAD_KEY.fullmatch(key) if isinstance(key, str) else None
    src = _job(m.group(1)) if m else None
    f = next((f for f in src['files'] if f['key'] == key), None) if src and src['building'] == bid else None
    if not (f and key.lower().endswith(IMAGE)):
        return common.resp(400, {'error': 'key는 같은 건물 작업으로 올린 이미지(png, jpg)입니다.'})
    job = _new(bid, 'detect', [f], status='running', step='detect')
    _put(job)
    _run(job, {'jobId': job['jobId'], 'building': bid, 'bucket': os.environ['PLANS_BUCKET'],
               'detect': [{'floor': None, 'imageKey': key, 'pxPerM': px, 'toPlan': None}]})
    return common.resp(202, {'jobId': job['jobId']})


def _message(cause):
    # 상태 머신이 기록한 오류: Lambda 오류는 {"errorMessage", "errorType", "stackTrace"} JSON 문자열
    try:
        return json.loads(cause)['errorMessage']
    except (ValueError, TypeError, KeyError):
        return cause


def status(event):
    job = _job((event.get('pathParameters') or {}).get('jobId'))
    if not job:
        return common.resp(404, {'error': NO_JOB})
    out = {k: job.get(k) for k in ('jobId', 'building', 'kind', 'status', 'step')}
    if job.get('error'):
        out['error'] = _message(job['error'])
    if job.get('confirmation'):
        out.update(confirmation=buildings._plain(job['confirmation']), confirmedAt=job['confirmedAt'])
    if job.get('draftKey'):
        out['draftUrl'] = _url('get_object', job['draftKey'])
    if job.get('draftKey') and job['kind'] != 'detect':
        obj = _client('s3').get_object(Bucket=os.environ['PLANS_BUCKET'], Key=job['draftKey'])
        floors = json.loads(obj['Body'].read()).get('floors') or []
        out['pages'] = [{'floor': fl.get('id'), 'url': _url('get_object', bg['key']), 'px': bg.get('px')}
                        for fl in floors if isinstance(bg := fl.get('background'), dict) and bg.get('key')]
    return common.resp(200, out)


def confirm(event):
    import plan_confirm
    job = _job((event.get('pathParameters') or {}).get('jobId'))
    if not job:
        return common.resp(404, {'error': NO_JOB})
    return plan_confirm.confirm(event, job, _put)


ROUTES = {
    'POST /plans/jobs': create,
    'POST /plans/jobs/{jobId}/start': start,
    'POST /plans/detect': detect,
    'GET /plans/jobs/{jobId}': status,
    'POST /plans/jobs/{jobId}/confirm': confirm,
}


def handler(event, context):
    if tenant.caller(event)['role'] != tenant.ADMIN:
        return common.resp(403, {'error': '관리자만 사용할 수 있습니다.'})
    fn = ROUTES.get(event.get('routeKey', ''))
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    return fn(event)
