"""Cognito 가입 확인 트리거(PostConfirmation): 이메일 인증을 마친 가입자를 기업 구성원으로 등록

- 대상: PostConfirmation_ConfirmSignUp만. 비밀번호 재설정 확인은 그대로 통과
- 등록: 가입 대기 항목(pending#<이메일>)의 기업으로 {sub, companyId, email, role, joinedAt} 저장 후 대기 항목 삭제, 변경 이력 member.join
- 역할: 기업의 첫 구성원은 manager(고객사 관리자), 이후 operator
  - shortcut: 같은 기업 첫 가입자 2명이 동시에 인증하면 둘 다 manager 가능, 가입이 잦아지면 기업 항목 조건부 쓰기로 교체
- 대기 항목 없음·만료: 등록 안 함(소속 없는 계정, 판매사가 확인)
"""
import time

import tenant


def handler(event, context):
    if event.get('triggerSource') != 'PostConfirmation_ConfirmSignUp':
        return event
    attrs = event['request']['userAttributes']
    email = str(attrs.get('email', '')).strip().lower()
    members = tenant.table('MEMBERS_TABLE')
    p = members.get_item(Key={'sub': tenant.PENDING + email}).get('Item')
    # TTL 삭제는 최대 수십 분 지연되므로 만료 시각을 직접 확인
    if not p or p['ttl'] <= time.time():
        return event
    cid = p['companyId']
    m = {'sub': attrs['sub'], 'companyId': cid, 'email': email,
         'role': 'operator' if tenant.company_members(cid) else 'manager', 'joinedAt': tenant.stamp()}
    members.put_item(Item=m)
    members.delete_item(Key={'sub': tenant.PENDING + email})
    tenant.audit(cid, m, 'member.join', m['sub'], {'email': email, 'role': m['role']})
    return event
