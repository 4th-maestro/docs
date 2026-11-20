"""Cognito 가입 전 검사(PreSignUp 트리거): 기업 코드로만 자체 가입 허용

- 웹 가입: clientMetadata.companyCode가 존재하고 기업 상태 active, 만료 전이면 허용하고 가입 대기 항목(pending#<이메일>, 2일) 저장
- 관리자 CLI 발급(PreSignUp_AdminCreateUser): 판매사 계정 발급 경로라 검사 생략
- 그 밖의 경로(외부 로그인 등): 거부
- 거부: 예외 문구 → Cognito가 UserLambdaValidationException으로 전달, 화면이 문구 표시
- 자동 확인 안 함: 이메일 인증 코드 확인 후 가입 확인 트리거(confirm.py)가 구성원 등록
"""
import time

import tenant

INVALID = '기업 코드가 올바르지 않거나 만료되었습니다.'
PENDING_SECONDS = 2 * 86400


def handler(event, context):
    source = event.get('triggerSource')
    if source == 'PreSignUp_AdminCreateUser':
        return event
    if source != 'PreSignUp_SignUp':
        raise Exception('지원하지 않는 가입 방식입니다.')
    req = event.get('request') or {}
    c = tenant.company_by_code((req.get('clientMetadata') or {}).get('companyCode'))
    if not c:
        raise Exception(INVALID)
    email = str((req.get('userAttributes') or {}).get('email', '')).strip().lower()
    tenant.table('MEMBERS_TABLE').put_item(Item={'sub': tenant.PENDING + email, 'companyId': c['companyId'], 'ttl': int(time.time()) + PENDING_SECONDS})
    return event
