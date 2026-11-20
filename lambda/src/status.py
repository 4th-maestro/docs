"""GET /rooms/status?building=main&floor=1F: 건물 호실별 가상 HVAC 상태와 층 요약"""
import datetime as dt
from functools import lru_cache
import logging
import math
import os
import time

import buildings
import common
import sim

_log = logging.getLogger(__name__)
WEATHER_CACHE_SECONDS = 300
WEATHER_MAX_AGE = dt.timedelta(hours=2)
_weather_cache = {'table': None, 'expires': 0.0, 'item': None}


@lru_cache(maxsize=1)
def _weather_table(name):
    # 로컬에서는 SDK를 요구하지 않고, Lambda에서는 연결을 재사용합니다.
    import boto3
    from botocore.config import Config
    return boto3.resource('dynamodb', config=Config(
        connect_timeout=1, read_timeout=1,
        retries={'mode': 'standard', 'total_max_attempts': 1},
    )).Table(name)


def outdoor(t):
    """표시용 외기만 실측으로 대체. 실내 상태·전력 계산은 sim을 유지합니다."""
    name = os.environ.get('WEATHER_TABLE')
    if name:
        now = time.monotonic()
        if _weather_cache['table'] != name or now >= _weather_cache['expires']:
            item = None
            try:
                from boto3.dynamodb.conditions import Key
                items = _weather_table(name).query(
                    KeyConditionExpression=Key('location').eq('98,77'),
                    ScanIndexForward=False, Limit=1,
                ).get('Items', [])
                if items:
                    observed = dt.datetime.fromisoformat(items[0]['ts'])
                    temp = float(items[0]['tempC'])
                    if observed.utcoffset() is None or not math.isfinite(temp):
                        raise ValueError('Invalid weather timestamp or temperature')
                    item = (temp, observed, items[0]['ts'])
            except Exception:
                # 수집 장애·권한 오류·잘못된 관측도 상태 API는 계속 제공합니다.
                _log.warning('Weather observation unavailable; using simulation', exc_info=True)
            # 빈 결과와 실패도 캐시하여 장애 중 요청마다 DynamoDB를 읽지 않습니다.
            _weather_cache.update(table=name, expires=now + WEATHER_CACHE_SECONDS, item=item)
        item = _weather_cache['item']
        if item and dt.timedelta(0) <= t - item[1] <= WEATHER_MAX_AGE:
            return {'outdoorTemp': item[0], 'outdoorSource': 'kma', 'outdoorObservedAt': item[2]}
    return {'outdoorTemp': sim.outdoor_temp(t), 'outdoorSource': 'sim', 'outdoorObservedAt': None}


def handler(event, context):
    try:
        b = common.building(event)
    except ValueError as e:
        return common.bad_building(e)
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    rooms = [sim.state(r, t, schedules) for r in buildings.rooms(b['id']) if not floor or r['floor'] == floor]
    return common.resp(200, {
        'generatedAt': t.isoformat(), 'refreshSeconds': sim.LIVE_SECONDS, 'virtual': True,
        'building': buildings.summary(b), **outdoor(t), 'floors': buildings.floors(b['id']),
        'summary': summarize(rooms), 'rooms': rooms,
    })


def summarize(states):
    return {
        'on': sum(s['onOff'] for s in states), 'off': sum(not s['onOff'] for s in states),
        'anomaly': sum(bool(s['anomaly']) for s in states), 'powerKw': round(sum(s['powerKw'] for s in states), 1),
    }
