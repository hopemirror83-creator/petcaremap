# 펫케어맵

동물병원, 애견미용, 애견호텔 정보를 공공데이터와 네이버 검색/지도 신호로 보강해 정적 SEO 페이지로 발행하는 Astro 사이트입니다.

## 진행 순서

```bash
npm install
npm run build:data
npm run indexing:list
npm run check
npm run build
```

## 배포 기준

- 사이트명: 펫케어맵
- 개발 주소: `https://petcaremap.hopemirror83.workers.dev`
- 실제 표시 도메인: `https://petcaremap.product-pack.com/`
- 시작 지역: 인천 서구
- 초기 업종: 동물병원
- 확장 업종: 애견미용, 애견호텔
- 원본 스토리지: Cloudflare D1 `petcaremap-db`
- Pages 프로젝트명: `petcaremap`

## Cloudflare Pages 배포 방식

페이지 수가 계속 늘어나는 구조이므로 장기적으로는 `wrangler pages deploy` 직접 업로드보다 GitHub 저장소 연결 배포를 권장합니다.

Cloudflare Pages 설정:

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: `22`
- Environment variable: `PAGES_WRANGLER_MAJOR_VERSION=4`

자세한 연결 순서는 `docs/cloudflare-github-pages-deploy.md`를 참고합니다.

`src/data/siteData.ts`, `src/data/petServiceData.ts`는 대형 생성 파일이므로 GitHub에 올리지 않습니다. `npm run build` 과정에서 자동 생성됩니다.

## 데이터 파이프라인

1. `npm run sync:public-data`  
   공공데이터포털의 지방행정 인허가 데이터를 원본으로 수집합니다. 1차 대상은 동물병원입니다.
2. `npm run sync:naver-local`  
   네이버 검색 API/지도 검색 결과로 실제 노출명, 좌표, 카테고리, 전화번호, 장소 URL 후보를 보강합니다.
3. `npm run collect:naver-reviews`  
   네이버 블로그/카페 검색 API로 후기 후보 링크와 제목을 수집합니다.
4. `npm run generate:review-pages`  
   Gemini로 원문 복사가 아닌 요약 문단을 생성합니다. 의료성 표현은 단정하지 않도록 프롬프트에서 제한합니다.
5. `npm run build:data`  
   정적 페이지 생성을 위한 `src/data/siteData.ts`를 만듭니다.

API 키가 없는 상태에서도 `data/seed-businesses.json`의 동물병원 샘플 기준으로 사이트가 빌드됩니다.

애견미용과 애견호텔은 공공데이터 기반 업체 정보에 네이버 검색 후보와 Vertex AI 초안을 결합해 지역별로 순차 확장합니다.
