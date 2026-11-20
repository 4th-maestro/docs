"""도면 보정본을 기존 판매사 등록 API로 저장하고 변환 작업을 done으로 연결."""

import hashlib
import json

import admin
import buildings
import common
import tenant


def confirm(event, job, put):
    """review -> confirming -> done. 같은 보정본 재전송은 등록·버전을 반복하지 않음."""
    if len((event.get('body') or '').encode()) > admin.MAX_BODY:
        return common.resp(413, {'error': '요청 본문은 5MB 이하입니다.'})
    req = common.body(event)
    if not isinstance(req, dict) or req.get('operation') not in ('create', 'replace'):
        return common.resp(400, {'error': 'operation은 create 또는 replace입니다.'})
    body = req.get('registration')
    if not isinstance(body, dict):
        return common.resp(400, {'error': 'registration은 보정한 twin, rooms, plan 객체입니다.'})
    bid = job['building']
    if body.get('id', bid) != bid:
        return common.resp(400, {'error': '등록 건물 id는 도면 작업의 building과 같아야 합니다.'})
    if req['operation'] == 'create' and not isinstance(req.get('companyId'), str):
        return common.resp(400, {'error': '신규 등록은 companyId가 필요합니다.'})
    try:
        fingerprint = hashlib.sha256(json.dumps(req, sort_keys=True, ensure_ascii=False,
                                                allow_nan=False).encode()).hexdigest()
    except (ValueError, RecursionError):
        return common.resp(400, {'error': '요청 본문에 유효하지 않은 숫자나 중첩이 있습니다.'})
    if job['status'] == 'done':
        if job.get('confirmationHash') == fingerprint:
            return common.resp(200, buildings._plain(job['confirmation']))
        return common.resp(409, {'error': '이미 다른 보정본으로 확정한 작업입니다.'})
    if job['kind'] == 'detect' or job['status'] != 'review':
        return common.resp(409, {'error': '보정 대기(review) 상태의 도면 변환 작업만 확정할 수 있습니다.'})
    pending = {**job, 'status': 'confirming', 'step': 'register', 'confirmationHash': fingerprint}
    if not put(pending, 'review'):
        return common.resp(409, {'error': '다른 요청이 이미 이 작업을 확정하고 있습니다.'})
    forwarded = {**event, 'body': json.dumps({**body, 'id': bid}, ensure_ascii=False)}
    try:
        if req['operation'] == 'create':
            forwarded.update(routeKey='POST /admin/companies/{id}/buildings',
                             pathParameters={'id': req['companyId']})
            result = admin.handler(forwarded, None)
        else:
            forwarded.update(routeKey='PUT /buildings/{id}/twin', pathParameters={'id': bid})
            result = admin.twin(forwarded, None)
        if result['statusCode'] not in (200, 201):
            # 입력·기업·호실 충돌 검사는 기존 등록 API가 수행. 수정해서 다시 확정할 수 있음.
            put(job, 'confirming')
            return result
        saved = json.loads(result['body'])
        receipt = {'status': 'done', **{k: saved[k] for k in ('building', 'version') if k in saved}}
        finished = {**pending, 'status': 'done', 'confirmedAt': tenant.stamp(), 'confirmation': receipt}
        finished.pop('error', None)
        if not put(finished, 'confirming'):
            raise RuntimeError('confirmation state changed')
        return common.resp(200, receipt)
    except Exception:
        # 기존 등록 API는 S3·복수 테이블에 순차 기록하므로 중간 실패 때 일부 저장 가능.
        # 성공으로 오인하지 않도록 failed로 기록. 원본 오류·요청 본문은 응답에 노출하지 않음.
        error = '확정 저장 중 오류가 발생했습니다. 건물의 부분 저장 여부를 확인한 뒤 복구하십시오.'
        put({**pending, 'status': 'failed', 'step': 'confirm', 'error': error}, 'confirming')
        return common.resp(500, {'error': error})
