"""GET /buildings: 건물별 현재 상태, 오늘 사용량, 절감 가능량, 점검 순서(전체 현황 화면)

- now: 호실마다 현재 상태 1회 계산(status.py와 같은 요약)
- todayKwh: history.hourly와 같은 15분 표본 평균으로 오늘 0시~현재 합계(GET /rooms/history 오늘 합계와 같은 값)
- savingKwh: recommend 합계(GET /recommendations 건물 전체 totalSavingKwh와 같은 값, 1일, 가상)
- level: alert(이상 1건 이상), warn(절감 가능량이 오늘 사용량의 10% 이상), ok
- 정렬: alert, warn, ok 순, 같은 level은 이상 건수 내림차순
"""
import buildings
import common
import history
import recommend
import sim
import status

LEVELS = ('alert', 'warn', 'ok')
WARN_RATIO = 0.1


def handler(event, context):
    t, schedules = sim.now(), common.list_schedules()
    items = sorted((card(b, t, schedules) for b in buildings.LIST), key=lambda c: (LEVELS.index(c['level']), -c['now']['anomaly']))
    return common.resp(200, {'generatedAt': t.isoformat(), 'virtual': True, 'buildings': items})


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
