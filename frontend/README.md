# frontend

Maestro 운영 대시보드(React, Vite, TypeScript)입니다. 디자인 기준은 루트 [DESIGN.md](../DESIGN.md), 데이터 시각화 기준은 [디자인 시스템](../docs/human/reference/design-system.md) 6절입니다. 화면 구성 레퍼런스는 [UI 레퍼런스](../docs/human/explanation/research/ui-references.md)에 있습니다.

| 경로 | 내용 |
|---|---|
| `src/App.tsx` | 층 탭, 자연어 질의, 히트맵(온도·전력·습도·이상 감지), AI 응답, 스케줄 초안 |
| `src/heat.ts` | 지표별 순차 색 척도 |
| `src/twin.ts` | 3D 트윈 iframe 연동([규약](../docs/human/reference/twin-embed.md)) |
| `src/twin3d/Twin3D.tsx` | Three.js 층 3D 트윈: `public/floorplan.json` 호실 다각형, 지표 색, HVAC 운전·이상 표시, 호실 선택, 시점 초기화·위에서 보기 |
| `src/api.ts` | Lambda API 호출, 실패하면 목업으로 대체하고 화면에 목업 표시 |
| `src/mock.ts` | 목업: 데모 상태, 정규식 기반 질의 해석, 스케줄 임시 저장 |
| `public/demo-status.json` | 데모 모드 상태(`python3 ../lambda/tools/demo_status.py`로 생성) |

## 실행

```bash
npm install
cp .env.example .env   # VITE_API_BASE_URL, VITE_TWIN_URL 입력
npm run dev
```

`VITE_API_BASE_URL`이 비어 있거나 Lambda 호출이 실패하면 목업으로 대체합니다. 상태는 `public/demo-status.json`, 질의는 예시 문장 형태만 해석하는 정규식, 스케줄은 서버에 기록하지 않는 임시 저장입니다. 상태는 WebSocket 대신 5초마다 다시 조회하며, 온도·습도·전력은 Lambda와 목업 모두 범위 안에서 변동합니다(실시간 목업: 온도 ±0.3℃, 습도 ±1.5%, 전력 ±8%).

## 확인

```bash
npm run lint && npm run build
```

화면을 바꾸면 1440px와 390px 너비에서 버튼 높이·너비와 라벨 잘림을 확인하십시오.

## 배포

```bash
npm run build
aws s3 sync dist s3://<WebBucketName> --delete --profile maestro
```

`WebBucketName`과 `WebUrl`은 `lambda`의 `sam deploy` 출력값입니다.
