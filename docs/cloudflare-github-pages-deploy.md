# Cloudflare Pages GitHub 연결 배포 메모

펫케어맵은 정적 페이지 수가 계속 늘어나는 구조라 `wrangler pages deploy` 직접 업로드 방식보다 GitHub 저장소 연결 배포가 더 안정적입니다.

## 권장 배포 방식

1. 이 프로젝트 폴더를 GitHub 저장소로 push합니다.
2. Cloudflare Pages에서 `petcaremap` 프로젝트를 GitHub 저장소와 연결합니다.
3. 빌드 설정은 아래처럼 둡니다.

| 항목 | 값 |
| --- | --- |
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js version | `22` |

## Cloudflare Pages 환경변수

Cloudflare Pages 프로젝트 설정에서 아래 환경변수를 추가합니다.

| 이름 | 값 |
| --- | --- |
| `PAGES_WRANGLER_MAJOR_VERSION` | `4` |

API 키가 필요한 수집/생성 작업은 로컬에서 수행하고, Cloudflare 빌드는 정적 페이지 생성만 담당하는 흐름을 권장합니다.

## GitHub에 올리지 않는 파일

아래 파일은 빌드 산출물 또는 로컬 작업 로그라 GitHub에 올리지 않습니다.

- `node_modules/`
- `.astro/`
- `dist/`
- `.wrangler/`
- `.env`, `.env.local`
- `*.log`
- `src/data/siteData.ts`
- `src/data/petServiceData.ts`
- `data/d1-public-businesses.sql`
- `data/d1-enrichment.sql`

특히 `src/data/siteData.ts`, `src/data/petServiceData.ts`는 대형 생성 파일입니다. GitHub에 올리지 않고 `npm run build` 과정에서 `scripts/build-site-data.mjs`, `scripts/build-pet-service-site-data.mjs`가 자동 생성합니다.

## 최초 연결 순서

```bash
git add .
git commit -m "Prepare GitHub Pages deployment"
git branch -M main
git remote add origin <GitHub repository URL>
git push -u origin main
```

그다음 Cloudflare 대시보드에서:

`Workers & Pages` → `petcaremap` → `Settings` → `Builds & deployments` → GitHub 저장소 연결

## 확인할 것

- Cloudflare 빌드 로그에서 `npm run build`가 성공하는지 확인합니다.
- `src/data/siteData.ts`, `src/data/petServiceData.ts`가 빌드 중 생성되는지 확인합니다.
- 운영 도메인 `https://petcaremap.product-pack.com/`에서 최근 추가 지역 페이지가 정상 표시되는지 확인합니다.
- 파일 수가 크게 늘어나는 경우에도 직접 업로드 대신 GitHub 연결 배포를 유지합니다.
