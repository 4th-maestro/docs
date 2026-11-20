"""판매사·고객사 구조 2단계 이전: 데모 기업 생성, 기존 건물 4개 소속 지정, 기존 사용자 구성원 등록

- 실행(lambda 폴더): python3 tools/migrate_tenancy.py --user-pool-id <UserPoolId 출력값> --profile maestro [--dry-run]
- 테이블: maestro 스택(--stack)의 CompaniesTable, MembersTable, BuildingOwnersTable 실제 이름을 CloudFormation에서 조회
- 데모 기업: id co-demo0000, 이름 "데모 기업". 이미 있으면 그대로 유지(코드 재발급 안 함)
- 건물: main, office, edu, lab 중 소속이 없는 건물만 데모 기업에 지정(판매사가 바꾼 소속은 유지)
- 사용자: admin 그룹이 아닌 기존 Cognito 사용자 중 구성원 항목이 없는 사용자만 데모 기업 operator로 등록
- 여러 번 실행해도 결과 동일
"""
import argparse
import datetime as dt
import secrets

DEMO = 'co-demo0000'
DEMO_NAME = '데모 기업'
BUILDINGS = ('main', 'office', 'edu', 'lab')
KST = dt.timezone(dt.timedelta(hours=9))
# tenant.py와 같은 코드 형식(src를 가져오지 않고 독립 실행)
ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'


def code():
    s = ''.join(secrets.choice(ALPHABET) for _ in range(8))
    return f'EGE-{s[:4]}-{s[4:]}'


def pages(fn, token, **kw):
    # Cognito 목록 페이지: 응답의 다음 토큰을 같은 이름의 요청 인자로 전달
    while True:
        r = fn(**kw)
        yield r
        if token not in r:
            return
        kw[token] = r[token]


def main():
    a = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    a.add_argument('--user-pool-id', required=True)
    a.add_argument('--stack', default='maestro')
    a.add_argument('--profile')
    a.add_argument('--region', default='ap-northeast-2')
    a.add_argument('--dry-run', action='store_true')
    args = a.parse_args()
    import boto3
    s = boto3.Session(profile_name=args.profile, region_name=args.region)
    cfn, ddb, idp = s.client('cloudformation'), s.resource('dynamodb'), s.client('cognito-idp')
    t = {k: ddb.Table(cfn.describe_stack_resource(StackName=args.stack, LogicalResourceId=k)['StackResourceDetail']['PhysicalResourceId'])
         for k in ('CompaniesTable', 'MembersTable', 'BuildingOwnersTable')}
    now = dt.datetime.now(KST)
    tag = '[확인만] ' if args.dry_run else ''

    if t['CompaniesTable'].get_item(Key={'companyId': DEMO}).get('Item'):
        print(f'기업 {DEMO}: 이미 있음, 유지')
    else:
        item = {'companyId': DEMO, 'name': DEMO_NAME, 'contactName': '', 'contactEmail': '', 'phone': '', 'address': '',
                'status': 'active', 'code': code(), 'codeExpiresAt': (now + dt.timedelta(days=30)).isoformat(timespec='seconds'),
                'createdAt': now.isoformat(timespec='seconds')}
        if not args.dry_run:
            t['CompaniesTable'].put_item(Item=item)
        print(f"{tag}기업 {DEMO} 생성, 코드 {item['code']}")

    for bid in BUILDINGS:
        item = t['BuildingOwnersTable'].get_item(Key={'buildingId': bid}).get('Item') or {}
        cur = item.get('companyId')
        if cur:
            print(f'건물 {bid}: 소속 {cur}, 유지')
            continue
        if not args.dry_run:
            # 건물 수정 정보(overrides) 보존
            t['BuildingOwnersTable'].put_item(Item={**item, 'buildingId': bid, 'companyId': DEMO})
        print(f'{tag}건물 {bid}: {DEMO} 지정')

    admins = {u['Username'] for r in pages(idp.list_users_in_group, 'NextToken', UserPoolId=args.user_pool_id, GroupName='admin', Limit=60) for u in r['Users']}
    for r in pages(idp.list_users, 'PaginationToken', UserPoolId=args.user_pool_id, Limit=60):
        for u in r['Users']:
            attrs = {x['Name']: x['Value'] for x in u.get('Attributes', [])}
            email = attrs.get('email', '').lower()
            if u['Username'] in admins:
                print(f'사용자 {email}: 판매사 관리자, 제외')
                continue
            if t['MembersTable'].get_item(Key={'sub': attrs['sub']}).get('Item'):
                print(f'사용자 {email}: 이미 구성원, 유지')
                continue
            if not args.dry_run:
                t['MembersTable'].put_item(Item={'sub': attrs['sub'], 'companyId': DEMO, 'email': email, 'role': 'operator',
                                                 'joinedAt': now.isoformat(timespec='seconds')})
            print(f'{tag}사용자 {email}: {DEMO} operator 등록')


if __name__ == '__main__':
    main()
