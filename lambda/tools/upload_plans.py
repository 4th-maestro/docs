"""도면 버킷 초기 적재: frontend/public/floorplans/<건물>.json → s3://<버킷>/plans/<건물>/v1.json, current.json

- 실행(lambda 폴더): python3 tools/upload_plans.py --bucket <PlansBucketName 출력값> --profile maestro [--dry-run]
- 이미 current.json이 있는 건물은 건너뜀(3단계 이후 판매사·고객사가 수정한 도면을 덮어쓰지 않기 위함)
"""
import argparse
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT.parent / 'frontend' / 'public' / 'floorplans'


def main():
    a = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    a.add_argument('--bucket', required=True)
    a.add_argument('--profile')
    a.add_argument('--region', default='ap-northeast-2')
    a.add_argument('--dry-run', action='store_true')
    args = a.parse_args()
    files = sorted(SRC.glob('*.json'))
    if args.dry_run:
        print('\n'.join(f'{f.stem}: {f.stat().st_size}바이트' for f in files))
        return
    import boto3
    s3 = boto3.Session(profile_name=args.profile, region_name=args.region).client('s3')
    for f in files:
        key = f'plans/{f.stem}/current.json'
        if s3.list_objects_v2(Bucket=args.bucket, Prefix=key).get('KeyCount'):
            print(f'{f.stem}: 이미 있음, 건너뜀')
            continue
        for k in (f'plans/{f.stem}/v1.json', key):
            s3.put_object(Bucket=args.bucket, Key=k, Body=f.read_bytes(), ContentType='application/json')
        print(f'{f.stem}: v1, current 업로드')


if __name__ == '__main__':
    main()
