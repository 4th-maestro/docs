"""자동 운영 평가: 실제 모델 + 로컬 데이터, 운영 테이블 접근 없음.

AWS_PROFILE=maestro python tools/eval_operations.py --out eval/operations-results.json
Bedrock 호출 비용이 발생한다. 운영 데이터와 설정은 변경하지 않는다.
"""
import datetime as dt
import os
import sys
from unittest.mock import patch

import eval_ai
import buildings
import operations
import sim


def main():
    t = sim.now()
    rooms = buildings.rooms('main')
    rows = []
    for n, status in enumerate(('pending', 'pending', 'applied', 'accepted', 'rejected', 'expired', 'skipped', 'alert')):
        room = next(r for r in rooms if r['floor'] == ('2F' if status == 'alert' else '1F'))
        created = t - dt.timedelta(minutes=n + 1)
        rows.append({'decisionId': f'{created:%Y%m%dT%H%M}-{n:08d}', 'buildingId': 'main',
                     'roomId': room['id'], 'roomName': room['name'], 'floor': room['floor'], 'use': room['use'],
                     'status': status, 'message': '빈 방 냉난방 끄기 제안' if status == 'pending' else '자동 운영 기록',
                     'createdAt': created.isoformat(), 'expiresAt': (t + dt.timedelta(minutes=10)).isoformat(),
                     'evidence': {'facts': {'idleOnMinutes': 60, 'minutesSinceClose': 100}},
                     'jev': {'choice': 'empty', 'confidence': .92, 'probabilities': {'empty': .95}}})
    if '--only' not in sys.argv:
        sys.argv += ['--only', ','.join(f'o{i:02d}' for i in range(1, 9))]
    with patch.dict(os.environ, {'DECISIONS_TABLE': 'local-fixture', 'OPS_SETTINGS_TABLE': 'local-fixture'}), \
            patch.object(operations, '_recent', return_value=rows), \
            patch.object(operations, '_settings', return_value={'autoApply': False}):
        eval_ai.main()


if __name__ == '__main__':
    main()
