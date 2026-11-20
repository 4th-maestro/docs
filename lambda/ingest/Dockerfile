# 도면 변환 컨테이너 Lambda(app.handler). 빌드: docker build --platform linux/amd64 -t maestro-ingest .
# x86_64 전용: ifcopenshell 0.9.0의 aarch64 바이너리는 GLIBC 2.38을 요구해 Lambda 기본 이미지(2.34)에서 import 실패
# 1단계: libredwg dwg2dxf 정적 빌드. libredwg는 GPL-3.0이며 별도 프로세스(subprocess)로만 호출합니다.
FROM public.ecr.aws/lambda/python:3.12 AS libredwg
ARG LIBREDWG=0.13.3
ARG LIBREDWG_SHA256=83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e
RUN dnf install -y gcc make tar xz && dnf clean all
ADD https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG}.tar.xz /tmp/libredwg.tar.xz
RUN echo "${LIBREDWG_SHA256}  /tmp/libredwg.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/libredwg.tar.xz -C /tmp \
 && cd /tmp/libredwg-${LIBREDWG} \
 && ./configure --prefix=/opt/libredwg --disable-shared --enable-static --disable-bindings --disable-python --disable-werror \
 && make -j4 \
 && make install

# 2단계: 실행 이미지
FROM public.ecr.aws/lambda/python:3.12
COPY --from=libredwg /opt/libredwg/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
# Wheel tags alone did not catch the GLIBC_2.38 dependency in IfcOpenShell 0.9.0.post1.
RUN python -c "import ifcopenshell, ezdxf, shapely, pypdfium2, cv2; from PIL import Image"
COPY app.py cad.py common.py ifc.py match.py pdf.py hvac_types.json ${LAMBDA_TASK_ROOT}/
CMD ["app.handler"]
