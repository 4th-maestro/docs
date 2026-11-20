# 운전 시뮬레이션 계산 서버: Node.js 22 + EnergyPlus 24.2(e7ecb2d53b, 5R1C 보정에 쓴 Windows판과 같은 빌드)
# 빌드 전에 prepare.sh로 twin/ 을 준비해야 함
# - 베이스: Debian 12(glibc 2.36). EnergyPlus Linux판(Ubuntu 22.04 빌드)은 glibc 2.35 이상 + libgomp·libX11 필요
#   Lambda 기본 이미지(Amazon Linux 2023)는 glibc 2.34라 실행 불가(2026-11-21 빌드 확인)
# - Lambda 연결: AWS Lambda Web Adapter(확장)가 Function URL 요청을 컨테이너 안 HTTP 서버(server.mjs, 8080)로 전달
ARG EP=EnergyPlus-24.2.0-e7ecb2d53b-Linux-Ubuntu22.04-x86_64

FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 AS adapter

FROM public.ecr.aws/docker/library/node:22-bookworm-slim
ARG EP
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 libx11-6 \
 && curl -fsSL -o /tmp/ep.tar.gz "https://github.com/NREL/EnergyPlus/releases/download/v24.2.0/${EP}.tar.gz" \
 && mkdir -p /opt/energyplus && tar -xzf /tmp/ep.tar.gz -C /opt/energyplus --strip-components=1 && rm /tmp/ep.tar.gz \
 # 계산에 쓰지 않는 예제·문서·기상 파일 제외(이미지 크기)
 && rm -rf /opt/energyplus/ExampleFiles /opt/energyplus/Documentation /opt/energyplus/WeatherData /opt/energyplus/workflows \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter
ENV ENERGYPLUS_DIR=/opt/energyplus TWIN_SRC=/app/twin TWIN_WORK=/tmp/twin \
    PORT=8080 AWS_LWA_PORT=8080 AWS_LWA_READINESS_CHECK_PATH=/healthz
WORKDIR /app
# 대시보드 건물 설정 조회용 DynamoDB 클라이언트(이 이미지는 Lambda 기본 이미지가 아니라 AWS SDK가 없음)
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY handler.mjs server.mjs default-tariff.json /app/
COPY twin /app/twin
# 빌드 때 실행 확인: 라이브러리가 모자라면 여기서 실패
RUN ! (ldd /opt/energyplus/energyplus /opt/energyplus/PostProcess/ReadVarsESO | grep 'not found') && /opt/energyplus/energyplus --version
CMD ["node", "/app/server.mjs"]
