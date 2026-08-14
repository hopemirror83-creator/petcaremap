# 데이터 스키마

## 핵심 엔티티

- `businesses`: 업체 원본/보강 통합 테이블
- `business_services`: 진료유형 태그
- `review_sources`: 네이버 블로그/카페 후기 후보
- `generated_pages`: Gemini 요약 문단과 SEO 메타
- `group_pages`: 지역/유형 묶음 페이지 정의
- `collection_runs`: 수집 실행 이력

## 페이지 유형

- `/clinic/[slug]/`: 동물병원 상세
- `/area/[slug]/`: 지역 묶음
- `/type/[slug]/`: 24시, 야간, 응급, 특수동물, 고양이, 강아지, 거북이 등 진료유형 묶음

애견호텔과 애견샵은 추후 확장 단계에서 같은 구조로 추가합니다.
