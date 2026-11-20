"""GET /buildings: 건물별 현재 상태, 오늘 사용량, 절감 가능량, 점검 순서(전체 현황 화면)

- now: 호실마다 현재 상태 1회 계산(status.py와 같은 요약)
- todayKwh: history.hourly와 같은 15분 표본 평균으로 오늘 0시~현재 합계(GET /rooms/history 오늘 합계와 같은 값)
- savingKwh: recommend 합계(GET /recommendations 건물 전체 totalSavingKwh와 같은 값, 1일, 가상)
- level: alert(이상 1건 이상), warn(절감 가능량이 오늘 사용량의 10% 이상), ok
- 정렬: alert, warn, ok 순, 같은 level은 이상 건수 내림차순
- 소속: 판매사 총관리자는 전체, 고객사 구성원은 소속 기업 건물만, 소속 없으면 빈 목록, 중지 기업 구성원은 403
"""
import json
import time

import buildings
import common
import history
import recommend
import sim
import status
import tenant

LEVELS = ('alert', 'warn', 'ok')
WARN_RATIO = 0.1


# 응답 캐시: 같은 스케줄·건물 정보면 30초 동안 재사용(화면 조회 주기 60초, 현재 전력은 최대 30초 전 값)
# - 스케줄 저장·취소, 건물 정보 수정 시 키가 바뀌어 즉시 재계산
TTL_S = 30
_cache = {'key': None, 'at': 0.0, 'body': None}


def handler(event, context):
    allowed = tenant.allowed_buildings(tenant.caller(event))
    schedules = common.list_schedules()
    key = json.dumps([buildings.version(), schedules], sort_keys=True, default=str)
    if not (_cache['key'] == key and time.monotonic() - _cache['at'] < TTL_S):
        t = sim.now()
        items = sorted((card(b, t, schedules) for b in buildings.LIST), key=lambda c: (LEVELS.index(c['level']), -c['now']['anomaly']))
        _cache.update(key=key, at=time.monotonic(), body={'generatedAt': t.isoformat(), 'virtual': True, 'buildings': items})
    body = _cache['body']
    if allowed is not None:
        body = {**body, 'buildings': [c for c in body['buildings'] if c['id'] in allowed]}
    return common.resp(200, body)


def card(b, t, schedules):
    rooms = buildings.rooms(b['id'])
    now = status.summarize([sim.state(r, t, schedules) for r in rooms])
    day = t.replace(hour=0, minute=0, second=0)
    kwh = round(sum(p['kwh'] for p in history.hourly(rooms, day, t.hour + 1, schedules, t)), 1)
    saving = round(sum(i['savingKwhDay'] for i in recommend.recommend(rooms, t, schedules)), 1)
    return buildings.summary(b) | {'now': now, 'todayKwh': kwh, 'savingKwh': saving, 'level': level(now['anomaly'], saving, kwh)}


def level(anomaly, saving, today):
    if anomaly:
        return 'alert'
    # 절감 0은 사용량과 무관하게 ok(자정 직후 오늘 사용량 0일 때 경고 방지)
    return 'warn' if saving > 0 and saving >= today * WARN_RATIO else 'ok'
