#!/usr/bin/env bash
# 이미지 빌드 전 준비: Frontend 레포의 트윈 계산 코드를 infra/sim/twin/ 으로 복사(커밋하지 않음, .gitignore)
#   bash infra/sim/prepare.sh [Frontend/twin 경로]   기본: Lambda 레포 옆의 ../Frontend/twin
# 복사 대상: sim-runner.mjs가 불러오는 파일(pipeline/energyplus.js·live-day.js·occupancy.js, 외부 패키지 없음)과 데모 건물 data/
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-${TWIN_SRC:-$HERE/../../../Frontend/twin}}
SRC=$(cd "$SRC" && pwd)
test -f "$SRC/tools/sim-runner.mjs" || { echo "트윈 폴더가 아님: $SRC" >&2; exit 1; }
rm -rf "$HERE/twin"
mkdir -p "$HERE/twin/tools"
cp -r "$SRC/pipeline" "$SRC/data" "$HERE/twin/"
cp "$SRC/tools/sim-runner.mjs" "$HERE/twin/tools/"
rm -rf "$HERE/twin/data/host" "$HERE/twin/sim"
# pipeline/*.js는 ES 모듈: Frontend 루트 package.json의 "type": "module"을 대신함
echo '{"type":"module"}' > "$HERE/twin/package.json"
REV=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)
DIRTY=$(git -C "$SRC" status --porcelain -- . 2>/dev/null | head -1)
echo "Frontend twin $REV${DIRTY:+ (커밋 안 된 변경 있음)}" > "$HERE/twin/SOURCE"
cat "$HERE/twin/SOURCE"
