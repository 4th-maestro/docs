"""HTTP API 단일 진입점: 조회·관리 API를 함수 하나에서 처리

- 이유: 화면 하나가 API 7개 이상을 동시에 호출하므로, 함수가 나뉘어 있으면 콜드 스타트가 함수 수만큼 발생(2026-11-20 실측 첫 호출 2.6~2.9초)
- 경로 분기: routeKey의 경로(예: GET /rooms/status) 앞부분으로 기존 모듈 handler 호출, 모듈 코드는 그대로 유지
- 제외: AI 질의(query.py, anthropic SDK 초기화 3.9초)와 WebSocket·인증 트리거는 별도 함수
- 초기화: boto3를 모듈 로드 때 import, Lambda 초기화 단계는 메모리와 무관하게 CPU를 최대로 사용
- 소속 검사: 각 모듈이 tenant.require_building으로 확인, 거부(tenant.Forbidden)는 여기서 403으로 변환(중지 기업은 code 포함)
"""
import boto3  # noqa: F401  초기화 단계 미리 로드

import admin
import anomalies
import chat
import common
import customer
import energy
import history
import plan
import portfolio
import recommend
import schedules
import status
import tenant

ROUTES = [
    ('/rooms/status', status.handler),
    ('/rooms/history', history.handler),
    ('/buildings', portfolio.handler),
    ('/recommendations', recommend.handler),
    ('/anomalies', anomalies.handler),
    ('/schedules', schedules.handler),
    ('/chat', chat.handler),
    ('/energy', energy.handler),
    ('/admin', admin.handler),
    ('/company', customer.handler),
    # /me 하위 경로라 /me보다 먼저 확인
    ('/me/join', customer.handler),
    ('/me', tenant.me),
]


def route(path):
    # 건물 도면(/buildings/{id}/plan)과 건물 정보 수정(/buildings/{id})은 목록(/buildings)보다 먼저 확인
    if path.startswith('/buildings/'):
        return plan.handler if path.endswith('/plan') else customer.handler
    return next((fn for prefix, fn in ROUTES if path == prefix or path.startswith(prefix + '/')), None)


def handler(event, context):
    # routeKey 형식: "GET /schedules/{id}"
    fn = route(event.get('routeKey', '').split(' ', 1)[-1])
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    try:
        return fn(event, context)
    except tenant.Forbidden as e:
        return common.resp(403, e.body())
