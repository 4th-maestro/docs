# 도면 변환 컨테이너 ifcopenshell GLIBC 불일치

> **요약** (기준일 2026-11-20)
>
> - 증상: 배포 직후 도면 변환 상태 머신의 Parse 단계에서 IngestFunction이 `IfcOpenShell not built for 'linux/64bit/python3.12'` 오류로 시작하지 못함
> - 원인: ifcopenshell 0.9.0.post1 휠은 태그가 `manylinux_2_31_aarch64`이지만, 실제 바이너리는 GLIBC 2.38을 요구함. Lambda python:3.12 이미지의 GLIBC는 2.34
> - 해결: IngestFunction만 x86_64로 변경(같은 버전 x86_64 바이너리는 GLIBC 2.34 요구). 재배포 후 Parse, Detect, Merge, SaveDraft 모두 성공
>
> | 항목 | 값 | 비교 기준 |
> |---|---|---|
> | ifcopenshell 0.9.0.post1 aarch64 요구 GLIBC | 2.38 | Lambda 이미지 2.34 |
> | 같은 버전 x86_64 요구 GLIBC | 2.34 | Lambda 이미지 2.34 |
> | 장애 시간 | 약 50분(배포 후 첫 실행부터 재배포까지) | 운영 사용자 영향 없음(기능 공개 전) |
>
> **다음 작업**: 없음

## 1. 증상: Parse 단계에서 모듈 import 실패

**1-1. 배포 후 첫 검증 실행에서 IngestFunction이 `Unable to import module 'app'` 오류를 냈습니다.**

오류 원문은 `IfcOpenShell not built for 'linux/64bit/python3.12' (/lib64/libc.so.6: version 'GLIBC_2.38' not found)`입니다. 상태 머신은 설계대로 `MarkFailed`에서 작업을 `failed`로 기록했습니다. 도면 변환 화면은 아직 운영 사용자에게 공개하기 전이었습니다.

배경: Lambda 컨테이너 이미지 `public.ecr.aws/lambda/python:3.12`는 Amazon Linux 2023 기반이며 GLIBC 2.34를 제공합니다. pip은 휠 파일 이름의 `manylinux_2_31` 태그를 보고 GLIBC 2.31 이상이면 설치 가능하다고 판단합니다.

## 2. 조사 난점: 휠 태그와 실제 요구 버전이 다름

**2-1. 배포 전 확인은 휠 태그만 봤기 때문에 문제를 찾지 못했습니다.**

파서 구현 단계에서는 aarch64 휠이 있는지와 태그(`manylinux_2_31`)만 확인했습니다. 개발 PC(macOS)와 로컬 테스트에서는 다른 플랫폼 휠을 쓰므로 오류가 나지 않았습니다. Docker 데몬이 꺼져 있어 배포 전에 컨테이너를 실행해 보지도 못했습니다.

## 3. 조사 과정: 휠 바이너리의 GLIBC 심볼 검사

**3-1. 휠 안 `_ifcopenshell_wrapper*.so`의 GLIBC 심볼 버전을 직접 읽어 비교했습니다.**

| ifcopenshell | aarch64 요구 GLIBC | x86_64 요구 GLIBC | 판단 |
|---|---|---|---|
| 0.9.0.post1 | 2.38 | 2.34 | aarch64만 실패 |
| 0.8.4.post1 | 2.27 | 2.27 | 둘 다 실행 가능 |

| 가설 | 결과 |
|---|---|
| 0.8.4.post1로 내려 arm64 유지 | 제외. 테스트 픽스처 IFC의 형상 꼭짓점이 0개로 나와 파서와 픽스처를 함께 고쳐야 함 |
| 이미지 기반을 GLIBC 2.38 이상 배포판으로 교체 | 제외. 런타임 인터페이스 클라이언트 구성까지 바뀌어 변경 범위가 큼 |
| IngestFunction만 x86_64 | 채택. 실제 IFC 2종으로 검증한 0.9.0 유지, 템플릿과 문서만 변경 |

## 4. 원인: aarch64 바이너리의 GLIBC 2.38 요구

**4-1. ifcopenshell 0.9.0.post1의 aarch64 휠은 태그와 달리 GLIBC 2.38 심볼을 사용합니다.**

## 5. 해결: IngestFunction만 x86_64

**5-1. 템플릿에서 IngestFunction에 `Architectures: [x86_64]`를 지정했습니다(Lambda #41).**

SAM Globals의 목록 속성은 함수 값과 합쳐지므로, Globals의 `Architectures`를 지우고 함수마다 지정했습니다. 나머지 7개 함수와 Pillow 계층은 arm64를 유지합니다. 이미지 빌드는 Apple Silicon에서 colima `arm` 프로필 빌더의 amd64 에뮬레이션으로 했으며, libredwg 컴파일 때문에 약 20분 걸렸습니다.

## 6. 검증: 재배포 후 전 단계 성공

**6-1. 재배포 후 상태 머신을 직접 실행해 모든 단계가 성공했습니다.**

- 빌드 결과 템플릿(`.aws-sam/build/template.yaml`)에서 IngestFunction x86_64, 나머지 7개 함수 arm64 확인
- 입력: 테스트 IFC(층 1개, 호실 2개, 실내기 없음)와 춘천초 설비도면 PNG(350dpi, 1m당 68.9px)
- 결과: Parse, Detect(Serverless Endpoint), Merge, SaveDraft 성공, 작업 상태 `review`, 인식 16개(신뢰도 0.5 이상 11개)

## 7. 교훈: 네이티브 휠은 바이너리 요구 버전까지 확인

**7-1. 네이티브 확장이 들어 있는 휠은 태그가 아니라 바이너리의 GLIBC 심볼로 실행 가능 여부를 판단하십시오.**

배포 전에 대상 아키텍처 컨테이너에서 `python -c "import ifcopenshell"`을 한 번 실행하면 같은 문제를 찾을 수 있습니다.

## 8. 같은 증상 재발 시 확인 순서

1. CloudWatch 로그에서 `GLIBC_2.xx not found` 문구를 확인하십시오.
2. 해당 패키지 휠의 `.so`에서 `strings <파일> | grep -o 'GLIBC_2\.[0-9]*' | sort -V | tail -1`로 요구 버전을 확인하십시오.
3. 함수 아키텍처(`aws lambda get-function-configuration --query Architectures`)와 휠 아키텍처가 같은지 확인하십시오.

## 관련 코드

- Lambda 저장소 `template.yaml`(IngestFunction `Architectures`), `ingest/Dockerfile`, `ingest/README.md` 3절
- Lambda PR #41(수정), #42(main 반영)
