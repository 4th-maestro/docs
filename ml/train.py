"""SageMaker 학습 진입점: 냉난방 실내기 기호 YOLO 미세조정.

SageMaker는 requirements.txt를 먼저 설치하고, 하이퍼파라미터를 --epochs 60 형식 인자로 전달함.
로컬 실행: python3 train.py --data <synth.py 출력 폴더> --out runs --epochs 1 --fraction 0.05
실제 도면 타일(real_tiles.py 출력)을 함께 쓰려면 --real <폴더>. SageMaker에서는 real 채널.
"""
import argparse
import glob
import json
import os

import yaml
from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument('--data', default=os.environ.get('SM_CHANNEL_TRAIN', 'data'))
ap.add_argument('--real', default=os.environ.get('SM_CHANNEL_REAL', ''))
ap.add_argument('--real_repeat', type=int, default=20, help='실제 학습 타일 반복 횟수(합성 약 4,200장 대비 비중 조정)')
ap.add_argument('--out', default=os.environ.get('SM_MODEL_DIR', 'runs'))
ap.add_argument('--model', default='yolo11s.pt')
ap.add_argument('--epochs', type=int, default=60)
ap.add_argument('--imgsz', type=int, default=1024)
ap.add_argument('--batch', type=int, default=16)
ap.add_argument('--fraction', type=float, default=1.0)
a = ap.parse_args()

data = os.path.join(a.data, 'data.yaml')
names = yaml.safe_load(open(data))['names']
real_test = a.real and sorted(glob.glob(os.path.join(a.real, 'images', 'test', '*.png')))
if a.real:
    # 이미지 목록 파일: 라벨은 경로의 /images/를 /labels/로 바꿔 찾음
    work = os.path.join(a.out, 'lists')
    os.makedirs(work, exist_ok=True)
    root = os.path.abspath(a.data)
    real_train = sorted(glob.glob(os.path.join(os.path.abspath(a.real), 'images', 'train', '*.png')))
    with open(os.path.join(work, 'train.txt'), 'w') as f:
        f.write('\n'.join(sorted(glob.glob(os.path.join(root, 'images', 'train', '*.png'))) + real_train * a.real_repeat) + '\n')
    data = os.path.join(work, 'data.yaml')
    with open(data, 'w') as f:
        yaml.safe_dump({'train': os.path.join(work, 'train.txt'), 'val': os.path.join(root, 'images', 'val'),
                        'test': os.path.join(root, 'images', 'test'), 'names': names}, f, allow_unicode=True)
    print(f'real train tiles {len(real_train)} x{a.real_repeat}, real test tiles {len(real_test)}')

model = YOLO(a.model)
# 도면은 방향 의미가 없어 상하 반전도 사용
model.train(data=data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, fraction=a.fraction, patience=15,
            flipud=0.5, project=a.out, name='hvac', exist_ok=True)


def score(m):
    return {'mAP50': m.box.map50, 'mAP50-95': m.box.map,
            'per_class_mAP50-95': {model.names[int(c)]: float(m.box.maps[int(c)]) for c in m.box.ap_class_index}}


# 학습 후 model은 best.pt 가중치. 합성 테스트 분할(CubiCasa5K test 400장) 평가
result = score(model.val(data=data, split='test', imgsz=a.imgsz, project=a.out, name='test', exist_ok=True))
if real_test:
    # 실제 도면 테스트 타일: 학습에 쓰지 않은 건물
    real_yaml = os.path.join(a.out, 'lists', 'real.yaml')
    with open(real_yaml, 'w') as f:
        t = os.path.join(os.path.abspath(a.real), 'images', 'test')
        yaml.safe_dump({'train': t, 'val': t, 'names': names}, f, allow_unicode=True)  # ultralytics는 train 키 필수
    result['real'] = score(model.val(data=real_yaml, split='val', imgsz=a.imgsz, project=a.out, name='real', exist_ok=True))
with open(os.path.join(a.out, 'test_metrics.json'), 'w') as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
print(json.dumps(result, ensure_ascii=False))
