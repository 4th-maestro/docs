"""건물 도면: GET /buildings/{id}/plan → 도면 버킷 plans/<건물>/current.json

- 형식: 내장 3D 도면(frontend/src/twin3d/Twin3D.tsx)의 floors·bounds·rooms(polys, hvac), 좌표 단위 m
- 버킷(PLANS_BUCKET): plans/<건물>/current.json(현재), plans/<건물>/v<번호>.json(버전, 되돌리기용)
- 판매사·고객사 구조 1단계(2026-11-20): 웹 번들의 public/floorplans 대신 API로 제공. 올리기는 tools/upload_plans.py
"""
import os

import buildings
import common

_s3 = None


def _client():
    global _s3
    if _s3 is None:
        import boto3
        _s3 = boto3.client('s3')
    return _s3


def handler(event, context):
    try:
        b = buildings.get((event.get('pathParameters') or {}).get('id'))
    except ValueError as e:
        return common.bad_building(e)
    bucket = os.environ.get('PLANS_BUCKET')
    if not bucket:
        return common.resp(404, {'error': '도면 저장소가 설정되지 않았습니다.'})
    try:
        obj = _client().get_object(Bucket=bucket, Key=f"plans/{b['id']}/current.json")
    except _client().exceptions.NoSuchKey:
        return common.resp(404, {'error': '등록된 도면이 없습니다.'})
    # 저장된 JSON을 그대로 전달(건물당 20~47KB, 다시 직렬화하지 않음)
    return {'statusCode': 200, 'headers': {'content-type': 'application/json'}, 'body': obj['Body'].read().decode()}
