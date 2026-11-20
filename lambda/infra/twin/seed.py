"""건물·호실·설비 초기 적재: src/buildings.json·rooms.json → maestro-twin 스택의 Buildings·Rooms·Equipment 테이블

- 원본은 src/buildings.py(가상 건물 호실 생성 포함)와 sim.rated()(정격 전력)를 import만 해서 사용, 현재 API와 같은 데이터
- 같은 키는 덮어씀(여러 번 실행해도 결과 동일). 원본에서 사라진 항목은 지우지 않음
- 실행(Lambda 폴더에서, Windows는 -X utf8 필수: 팀 모듈이 인코딩 없이 JSON을 읽음)
    python -X utf8 infra/twin/seed.py --dry-run
    python -X utf8 infra/twin/seed.py --profile maestro
"""
import argparse
import json
import pathlib
import sys
from collections import Counter
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src'))

ROOM_FIELDS = ('name', 'floor', 'use', 'areaM2', 'idu')


def _ddb(value):
    # DynamoDB는 float 대신 Decimal 필요
    return json.loads(json.dumps(value, ensure_ascii=False), parse_float=Decimal)


def build_items():
    """테이블별 적재 항목 {'Buildings': [...], 'Rooms': [...], 'Equipment': [...]}"""
    import buildings
    import sim

    out = {'Buildings': [], 'Rooms': [], 'Equipment': []}
    for b in buildings.LIST:
        bid = b['id']
        out['Buildings'].append({'buildingId': bid, **{k: v for k, v in b.items() if k != 'id'}})
        rooms = buildings.rooms(bid)
        dup = [k for k, n in Counter(r['idu'] for r in rooms).items() if n > 1]
        if dup:
            raise ValueError(f'{bid}: 실내기 id 중복 {dup[:5]}')
        for r in rooms:
            out['Rooms'].append({'buildingId': bid, 'roomId': r['id'], **{k: r[k] for k in ROOM_FIELDS}})
            out['Equipment'].append({
                'buildingId': bid, 'equipmentId': r['idu'], 'roomId': r['id'], 'floor': r['floor'],
                'type': 'IDU', 'ratedKw': sim.rated(r),
            })
    return {name: [_ddb(i) for i in items] for name, items in out.items()}


def main():
    a = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    a.add_argument('--prefix', default='maestro', help='테이블 이름 앞머리(template.yaml Prefix)')
    a.add_argument('--profile')
    a.add_argument('--region', default='ap-northeast-2')
    a.add_argument('--dry-run', action='store_true', help='적재하지 않고 건수와 예시만 출력')
    args = a.parse_args()
    if not sys.flags.utf8_mode:
        sys.exit('python -X utf8 로 실행하십시오(팀 모듈의 JSON 읽기가 시스템 인코딩을 따름)')

    items = build_items()
    for name, rows in items.items():
        print(f'{args.prefix}-{name}: {len(rows)}건')
    if args.dry_run:
        for name, rows in items.items():
            print(f'\n[{name} 예시]', json.dumps(rows[0], ensure_ascii=False, default=str))
        return

    import boto3  # 실제 적재 때만 필요

    ddb = boto3.Session(profile_name=args.profile, region_name=args.region).resource('dynamodb')
    keys = {'Buildings': ['buildingId'], 'Rooms': ['buildingId', 'roomId'], 'Equipment': ['buildingId', 'equipmentId']}
    for name, rows in items.items():
        with ddb.Table(f'{args.prefix}-{name}').batch_writer(overwrite_by_pkeys=keys[name]) as w:
            for row in rows:
                w.put_item(Item=row)
        print(f'{args.prefix}-{name}: 적재 완료')


if __name__ == '__main__':
    main()
