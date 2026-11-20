"""WebSocket API: $connect, $disconnect, ask 라우트(AI 질의 단계 이벤트 실시간 전송)

- 요청: {action: 'ask', requestId, text, buildingId}, 응답 이벤트는 모두 같은 requestId를 붙여 해당 연결에만 전송
- buildingId: 없으면 main, 알 수 없거나 소속 기업 밖 건물이면 모델 호출 없이 error 이벤트
- 연결 종료(GoneException): 남은 모델 호출 없이 조용히 종료해 비용 차단
- shortcut: $connect 인증 없음(POST /query와 같은 공개 수준), 외부 공개 전 API 키·Cognito 인가 추가
"""
import json
import logging

import boto3

import chat
import common
import query
import tenant


def handler(event, context):
    ctx = event['requestContext']
    if ctx.get('routeKey') != 'ask':
        return {'statusCode': 200}
    api = boto3.client('apigatewaymanagementapi', endpoint_url=f"https://{ctx['domainName']}/{ctx['stage']}")
    req = common.body(event) or {}
    rid = str(req.get('requestId', ''))[:64]

    def emit(e):
        api.post_to_connection(ConnectionId=ctx['connectionId'], Data=json.dumps({**e, 'requestId': rid}, ensure_ascii=False, default=str).encode())

    try:
        text, b = query.clean(req.get('text')), query.building(req.get('buildingId'))
        if not text:
            emit({'type': 'error', 'message': '질의는 1~500자로 입력하십시오.'})
        elif not b:
            emit({'type': 'error', 'message': '알 수 없는 건물입니다. 건물을 다시 선택하십시오.'})
        else:
            try:
                tenant.require_building(event, b['id'])
            except tenant.Forbidden as e:
                emit({'type': 'error', 'message': str(e)})
            else:
                query.converse(text, emit, b['id'], chat.user(event))
    except api.exceptions.GoneException:
        pass
    except Exception:
        logging.exception('ask 처리 실패')
        try:
            emit({'type': 'error', 'message': 'AI 응답을 받지 못했습니다. 잠시 후 다시 시도하십시오.'})
        except api.exceptions.GoneException:
            pass
    return {'statusCode': 200}
