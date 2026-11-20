"""건물 도면·트윈 파일: GET /buildings/{id}/plan, GET /buildings/{id}/twin → 도면 버킷 파일 그대로 응답

- 형식: 도면은 내장 3D 도면(frontend/src/twin3d/Twin3D.tsx)의 floors·bounds·rooms(polys, hvac), 좌표 단위 m. 트윈은 트윈 파이프라인 building.json
- 버킷(PLANS_BUCKET): plans/<건물>/ 아래 도면 current.json(현재)과 v<번호>.json(버전), 트윈 building.json(현재)과 building-v<번호>.json(버전)
  - 트윈 키는 도면 변환 규약(docs/human/reference/plan-ingest.md 4절)과 같음. 같은 저장의 도면·트윈 버전 번호는 같음
- 기록: 판매사 건물 등록·트윈 확정 저장·삭제, 호실 이름·용도 변경(admin.py)이 아래 저장 함수 사용. 초기 적재는 tools/upload_plans.py
- 권한: admin, 또는 건물 소속 기업(사용 중)의 구성원(tenant.require_building)
"""
import json
import os
import re
import time

import buildings
import common
import tenant

# 경로 마지막 부분 → (버킷 키 형식, 파일이 없을 때 문구)
FILES = {'plan': ('plans/{}/current.json', '등록된 도면이 없습니다.'), 'twin': ('plans/{}/building.json', '트윈 데이터가 없습니다.')}
TWIN_KEY = re.compile(r'plans/([^/]+)/building\.json')
_s3 = None


def _client():
    global _s3
    if _s3 is None:
        import boto3
        _s3 = boto3.client('s3')
    return _s3


def bucket():
    return os.environ.get('PLANS_BUCKET')


def put(key, obj):
    _client().put_object(Bucket=bucket(), Key=key, Body=json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode(),
                         ContentType='application/json')


def get(key):
    """버킷 JSON 파일. 없으면 None"""
    try:
        return json.loads(_client().get_object(Bucket=bucket(), Key=key)['Body'].read())
    except _client().exceptions.NoSuchKey:
        return None


def keys(prefix):
    """접두어 아래 모든 키(1,000개 단위 페이지 이어 받기)"""
    out, kw = [], {'Bucket': bucket(), 'Prefix': prefix}
    while True:
        r = _client().list_objects_v2(**kw)
        out += [o['Key'] for o in r.get('Contents', [])]
        if not r.get('IsTruncated'):
            return out
        kw['ContinuationToken'] = r['NextContinuationToken']


def delete(prefix):
    ks = keys(prefix)
    for i in range(0, len(ks), 1000):
        _client().delete_objects(Bucket=bucket(), Delete={'Objects': [{'Key': k} for k in ks[i:i + 1000]], 'Quiet': True})


# 변경 표시: 건물·소속·구성원·기업 상태를 바꾼 요청이 갱신, 각 실행 환경은 3초마다 ETag를 비교해 캐시를 비움(buildings._data)
REV_KEY = 'plans/_rev'


def rev():
    """변경 표시 ETag. 버킷이 없거나 표시가 없으면 None(조회 실패도 None: 60초 캐시로 동작)"""
    if not bucket():
        return None
    try:
        return _client().head_object(Bucket=bucket(), Key=REV_KEY)['ETag']
    except Exception:
        return None


def bump():
    """변경 표시 갱신. 실패해도 쓰기 결과는 유지(다른 실행 환경은 60초 안에 반영)"""
    if bucket():
        try:
            put(REV_KEY, {'at': time.time()})
        except Exception:
            pass


def twin_ids():
    """트윈 파일(plans/<건물>/building.json)이 있는 건물 id 집합(plans/ 목록 조회 1회). 버킷이 없으면 빈 집합"""
    if not bucket():
        return set()
    return {m.group(1) for k in keys('plans/') if (m := TWIN_KEY.fullmatch(k))}


def handler(event, context):
    try:
        b = buildings.get((event.get('pathParameters') or {}).get('id'))
    except ValueError as e:
        return common.bad_building(e)
    tenant.require_building(event, b['id'])
    if not bucket():
        return common.resp(404, {'error': '도면 저장소가 설정되지 않았습니다.'})
    key, missing = FILES[event.get('routeKey', '').rsplit('/', 1)[-1]]
    try:
        obj = _client().get_object(Bucket=bucket(), Key=key.format(b['id']))
    except _client().exceptions.NoSuchKey:
        return common.resp(404, {'error': missing})
    # 저장된 JSON을 그대로 전달(도면은 건물당 20~47KB, 다시 직렬화하지 않음)
    return {'statusCode': 200, 'headers': {'content-type': 'application/json'}, 'body': obj['Body'].read().decode()}
