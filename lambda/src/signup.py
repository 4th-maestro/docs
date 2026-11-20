"""Cognito 가입 전 검사(PreSignUp 트리거): 허용 목록의 이메일 또는 @도메인만 가입 허용

- 관리자 CLI 발급(PreSignUp_AdminCreateUser)은 검사 생략
- 거부: 예외 문구 NOT_ALLOWED → Cognito가 UserLambdaValidationException으로 전달, 화면이 한국어 안내로 변환
- 자동 확인 안 함: 이메일 인증 코드 확인 후 로그인 가능
"""
import allow


def handler(event, context):
    if event.get('triggerSource') == 'PreSignUp_AdminCreateUser':
        return event
    if not allow.allowed(event['request']['userAttributes'].get('email', '')):
        raise Exception('NOT_ALLOWED')
    return event
