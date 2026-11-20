"""WebSocket $connect 인증(REQUEST 권한 부여자)

- 입력: 쿼리 token = Cognito 액세스 토큰(브라우저 WebSocket은 헤더 지정 불가)
- 검증: GetUser 호출로 서명·만료 확인 후 토큰의 iss·client_id가 이 사용자 풀·앱 클라이언트인지 확인
  (GetUser는 다른 사용자 풀의 토큰도 통과시키므로 iss 확인 필수)
- 결과: 허용 정책 + context.sub, ask 라우트 이벤트의 requestContext.authorizer.sub로 전달
"""
import base64
import json
import os

REGION = os.environ.get('AWS_REGION', 'ap-northeast-2')
POOL_ID = os.environ.get('USER_POOL_ID', '')
CLIENT_ID = os.environ.get('USER_POOL_CLIENT_ID', '')
_idp = None


def _client():
    global _idp
    if _idp is None:
        import boto3
        _idp = boto3.client('cognito-idp', region_name=REGION)
    return _idp


def claims(token):
    # 서명 검증은 GetUser가 수행, 여기서는 본문만 해석
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def verify(token):
    # 유효하면 sub, 아니면 None
    try:
        c = claims(token)
        if c.get('iss') != f'https://cognito-idp.{REGION}.amazonaws.com/{POOL_ID}' or c.get('client_id') != CLIENT_ID or c.get('token_use') != 'access':
            return None
        _client().get_user(AccessToken=token)
        return c['sub']
    except Exception:
        return None


def handler(event, context):
    sub = verify((event.get('queryStringParameters') or {}).get('token', ''))
    if not sub:
        raise Exception('Unauthorized')  # API Gateway가 401로 응답
    return {
        'principalId': sub,
        'policyDocument': {'Version': '2012-10-17', 'Statement': [{'Action': 'execute-api:Invoke', 'Effect': 'Allow', 'Resource': event['methodArn']}]},
        'context': {'sub': sub},
    }
