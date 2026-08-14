import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SEED_FILE = path.join(ROOT, 'data', 'seed-businesses.json');
const PUBLIC_FILE = path.join(ROOT, 'data', 'public-businesses.json');
const NAVER_FILE = path.join(ROOT, 'data', 'naver-local-businesses.json');
const REVIEW_FILE = path.join(ROOT, 'data', 'naver-review-sources.json');
const GENERATED_FILE = path.join(ROOT, 'data', 'generated-review-pages.json');
const MANUAL_PLACE_FILE = path.join(ROOT, 'data', 'manual-place-signals.json');
const OUTPUT_FILE = path.join(ROOT, 'src', 'data', 'siteData.ts');
const ACTIVE_BUSINESS_TYPES = new Set(['clinic']);
const TARGET_SOURCE_IDS = new Set(
  (process.env.TARGET_SOURCE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const TARGET_DISTRICTS = new Set(
  (process.env.TARGET_DISTRICTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const SEOUL_PRIORITY_DISTRICTS = new Set(['강남구', '송파구', '마포구', '성북구', '도봉구']);
const TARGET_SCOPE = process.env.TARGET_SCOPE || 'incheon-seoul-priority';
const SEOUL_SECOND_BATCH_DISTRICTS = new Set([
  '\uC11C\uCD08\uAD6C',
  '\uAC15\uB3D9\uAD6C',
  '\uC591\uCC9C\uAD6C',
  '\uAC15\uC11C\uAD6C'
]);
const SEOUL_THIRD_BATCH_DISTRICTS = new Set([
  '\uB178\uC6D0\uAD6C',
  '\uC740\uD3C9\uAD6C',
  '\uC601\uB4F1\uD3EC\uAD6C',
  '\uAD11\uC9C4\uAD6C'
]);
const SEOUL_FOURTH_BATCH_DISTRICTS = new Set([
  '\uB3D9\uB300\uBB38\uAD6C',
  '\uC911\uB791\uAD6C',
  '\uAD6C\uB85C\uAD6C',
  '\uC6A9\uC0B0\uAD6C',
  '\uAC15\uBD81\uAD6C'
]);
const SEOUL_FINAL_BATCH_DISTRICTS = new Set([
  '\uC11C\uB300\uBB38\uAD6C',
  '\uAD00\uC545\uAD6C',
  '\uC131\uB3D9\uAD6C',
  '\uB3D9\uC791\uAD6C',
  '\uC911\uAD6C',
  '\uAE08\uCC9C\uAD6C',
  '\uC885\uB85C\uAD6C'
]);

const TYPE_DEFS = [
  ['24h-clinic', '24시 동물병원', '24시 동물병원 위치, 야간진료, 후기 정리', ['24시', '야간진료']],
  ['night-clinic', '야간진료 동물병원', '야간진료 동물병원 방문 전 확인사항', ['야간진료', '24시']],
  ['emergency-clinic', '응급 동물병원', '응급 동물병원 위치와 전화 확인사항', ['응급진료', '응급수술', '24시']],
  ['exotic-clinic', '특수동물병원', '특수동물병원 진료 가능성 확인 정리', ['특수동물', '거북이', '햄스터', '조류']],
  ['cat-clinic', '고양이 동물병원', '고양이 진료 동물병원 후기와 위치', ['고양이']],
  ['dog-clinic', '강아지 동물병원', '강아지 진료 동물병원 후기와 위치', ['강아지']],
  ['parking-clinic', '주차 가능한 동물병원', '동물병원 주차, 예약, 방문 전 확인사항', ['주차']]
];

const LONGTAIL_DEFS = [
  ['incheon-24h-animal-hospital', '인천 24시 동물병원', '인천 24시 동물병원 위치, 야간진료, 후기 정리', '인천 전역에서 24시 또는 야간진료 가능성을 방문 전 확인해야 하는 동물병원 후보입니다.', isIncheon, /24시|24|야간|응급/],
  ['incheon-night-animal-hospital', '인천 야간진료 동물병원', '인천 야간진료 동물병원 후기, 운영시간 확인', '늦은 시간 문의가 필요한 보호자를 위해 인천 전역의 야간진료 관련 후보를 모았습니다.', isIncheon, /야간|24시|24|응급/],
  ['incheon-emergency-animal-hospital', '인천 응급 동물병원', '인천 응급 동물병원 위치, 전화 확인사항', '응급 접수, 야간 내원, 수술 가능성은 병원별로 달라 전화 확인이 필요한 인천 동물병원 후보입니다.', isIncheon, /응급|24시|24|수술|입원/],
  ['incheon-exotic-animal-hospital', '인천 특수동물병원', '인천 특수동물병원 후기, 진료 가능성 확인', '거북이, 햄스터, 조류 등 특수동물 진료 가능성은 병원마다 달라 방문 전 확인이 필요한 후보입니다.', isIncheon, /특수동물|거북이|햄스터|조류|파충류|토끼/],
  ['incheon-cat-animal-hospital', '인천 고양이 동물병원', '인천 고양이 동물병원 후기, 진료 확인사항', '고양이 진료 언급이나 반려묘 관련 후기가 확인되는 인천 동물병원 후보입니다.', isIncheon, /고양이|반려묘|cat/],
  ['incheon-dog-animal-hospital', '인천 강아지 동물병원', '인천 강아지 동물병원 후기, 위치 정리', '강아지 진료와 반려견 후기가 확인되는 인천 동물병원 후보입니다.', isIncheon, /강아지|반려견|dog/],
  ['incheon-parking-animal-hospital', '인천 주차 가능한 동물병원', '인천 동물병원 주차, 예약, 방문 전 확인사항', '차량 방문 전 주차 관련 언급이나 위치 확인이 필요한 인천 동물병원 후보입니다.', isIncheon, /주차/],
  ['incheon-seogu-24h-animal-hospital', '인천 서구 24시 동물병원', '인천 서구 24시 동물병원 위치, 야간진료, 후기 정리', '24시 또는 야간진료 가능성을 방문 전 확인해야 하는 인천 서구권 동물병원 후보입니다.', isIncheonSeogu, /24시|24|야간|응급/],
  ['incheon-seogu-night-animal-hospital', '인천 서구 야간진료 동물병원', '인천 서구 야간진료 동물병원 후기, 운영시간 확인', '야간진료나 늦은 시간 문의가 필요한 보호자를 위해 인천 서구권 후보를 모았습니다.', isIncheonSeogu, /야간|24시|24|응급/],
  ['incheon-seogu-emergency-animal-hospital', '인천 서구 응급 동물병원', '인천 서구 응급 동물병원 위치, 전화 확인사항', '응급 접수, 야간 내원, 수술 가능성은 병원별로 달라 전화 확인이 필요한 후보입니다.', isIncheonSeogu, /응급|24시|24|수술|입원/],
  ['incheon-seogu-exotic-animal-hospital', '인천 서구 특수동물병원', '인천 서구 특수동물병원 후기, 거북이 햄스터 조류 진료 확인', '거북이, 햄스터, 조류처럼 병원별 진료 가능 범위가 달라 방문 전 확인이 필요한 인천 서구권 후보입니다.', isIncheonSeogu, /특수동물|거북이|거북|햄스터|조류|새|파충류|토끼/],
  ['incheon-seogu-turtle-animal-hospital', '인천 서구 거북이 동물병원', '인천 서구 거북이 진료 동물병원 후기, 특수동물 확인', '거북이 진료는 병원마다 가능 범위가 달라 사육 환경과 증상을 함께 설명하고 확인하기 좋은 후보입니다.', isIncheonSeogu, /거북이|거북|파충류|특수동물/],
  ['incheon-seogu-hamster-animal-hospital', '인천 서구 햄스터 동물병원', '인천 서구 햄스터 진료 동물병원 후기, 특수동물 확인', '햄스터 같은 소동물 진료 가능성은 병원별로 다르므로 방문 전 확인이 필요한 인천 서구권 후보입니다.', isIncheonSeogu, /햄스터|소동물|특수동물/],
  ['incheon-seogu-surgery-check-animal-hospital', '인천 서구 수술 입원 검진 동물병원', '인천 서구 수술, 입원, 검진 동물병원 확인사항', '수술, 입원, 검진 같은 진료 목적을 방문 전 함께 확인하기 좋은 인천 서구권 후보입니다.', isIncheonSeogu, /수술|입원|검진|건강검진|메디컬|센터/],
  ['incheon-seogu-vaccination-animal-hospital', '인천 서구 예방접종 동물병원', '인천 서구 강아지 고양이 예방접종 동물병원 후기, 위치 정리', '강아지와 고양이 예방접종, 광견병 접종, 기본 건강관리 목적으로 비교하기 좋은 인천 서구권 후보입니다.', isIncheonSeogu, /예방접종|접종|광견병|백신/],
  ['incheon-seogu-neutering-animal-hospital', '인천 서구 중성화 동물병원', '인천 서구 고양이 강아지 중성화 동물병원 후기, 확인사항', '중성화 상담이나 수술 관련 후기가 확인되는 인천 서구권 동물병원 후보입니다.', isIncheonSeogu, /중성화|수술|입원/],
  ['incheon-seogu-cat-animal-hospital', '인천 서구 고양이 동물병원', '인천 서구 고양이 동물병원 후기, 진료 확인사항', '고양이 진료 언급이나 반려묘 관련 후기가 확인되는 인천 서구권 후보입니다.', isIncheonSeogu, /고양이|반려묘|cat/],
  ['incheon-seogu-dog-animal-hospital', '인천 서구 강아지 동물병원', '인천 서구 강아지 동물병원 후기, 위치 정리', '강아지 진료와 반려견 후기가 확인되는 인천 서구권 동물병원 후보입니다.', isIncheonSeogu, /강아지|반려견|dog/],
  ['incheon-seogu-parking-animal-hospital', '인천 서구 주차 가능한 동물병원', '인천 서구 동물병원 주차, 예약, 방문 전 확인사항', '차량 방문 전 주차 관련 언급이나 위치 확인이 필요한 인천 서구권 후보입니다.', isIncheonSeogu, /주차/],
  ['cheongna-animal-hospital', '청라 동물병원', '청라 동물병원 위치, 후기, 진료정보 정리', '청라와 경서동 일대에서 확인되는 동물병원 후보를 후기 기준으로 정리했습니다.', isCheongna, /동물병원|메디컬|센터|진료/],
  ['cheongna-24h-animal-hospital', '청라 24시 동물병원', '청라 24시 동물병원 야간진료, 응급 확인사항', '청라 일대에서 24시, 야간, 응급 관련 확인이 필요한 동물병원 후보입니다.', isCheongna, /24시|24|야간|응급/],
  ['cheongna-cat-animal-hospital', '청라 고양이 동물병원', '청라 고양이 동물병원 후기, 진료 확인사항', '청라 일대에서 고양이 진료 관련 후기가 확인되는 동물병원 후보입니다.', isCheongna, /고양이|반려묘/],
  ['geomdan-animal-hospital', '검단 동물병원', '검단 동물병원 위치, 후기, 진료정보 정리', '검단, 원당, 마전, 당하, 아라동 일대 동물병원 후보를 정리했습니다.', isGeomdan, /동물병원|메디컬|센터|진료/],
  ['geomdan-24h-animal-hospital', '검단 24시 동물병원', '검단 24시 동물병원 야간진료, 응급 확인사항', '검단 일대에서 24시, 야간, 응급 관련 확인이 필요한 동물병원 후보입니다.', isGeomdan, /24시|24|야간|응급/],
  ['geomdan-emergency-animal-hospital', '검단 응급 동물병원', '검단 응급 동물병원 위치, 전화 확인사항', '검단권 응급 접수와 야간 내원 가능성은 전화로 확인해야 하는 후보입니다.', isGeomdan, /응급|24시|24|수술|입원/],
  ['geomdan-cat-animal-hospital', '검단 고양이 동물병원', '검단 고양이 동물병원 후기, 진료 확인사항', '검단 일대에서 고양이 진료 관련 후기가 확인되는 동물병원 후보입니다.', isGeomdan, /고양이|반려묘/],
  ['lu1-animal-hospital', '루원시티 동물병원', '루원시티 동물병원 위치, 후기, 진료정보 정리', '루원시티와 가정동 주변에서 확인되는 동물병원 후보를 정리했습니다.', isLu1, /동물병원|메디컬|센터|진료/]
];

const seedRows = await readJson(SEED_FILE, []);
const publicRows = await readJson(PUBLIC_FILE, []);
const naverRows = await readJson(NAVER_FILE, []);
const reviewRows = await readJson(REVIEW_FILE, []);
const generatedRows = await readJson(GENERATED_FILE, []);
const manualPlaceRows = await readJson(MANUAL_PLACE_FILE, []);

const baseRows = publicRows.length > 0 ? publicRows : seedRows;
const reviewMap = new Map(reviewRows.map((row) => [row.sourceId, row]));
const generatedMap = new Map(generatedRows.map((row) => [row.sourceId, row]));
const naverMap = new Map(naverRows.map((row) => [row.sourceId, row]));
const manualPlaceMap = new Map(manualPlaceRows.map((row) => [row.sourceId, row]));

const mergedAll = mergeBySourceId(baseRows, naverMap)
  .filter((row) => shouldIncludeTarget(row))
  .map((row) => normalizeBusiness(row, reviewMap.get(row.sourceId), generatedMap.get(row.sourceId), manualPlaceMap.get(row.sourceId)))
  .filter((row) => ACTIVE_BUSINESS_TYPES.has(row.businessType))
  .sort(compareBusinesses);

const merged = mergedAll.filter((row) => row.pageStatus === 'published');
const areaGroups = buildAreaGroups(merged);
const typeGroups = buildTypeGroups(merged);
const longtailGroups = buildLongtailGroups(merged);

await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await writeFile(
  OUTPUT_FILE,
  [
    `export const businesses = JSON.parse(${JSON.stringify(JSON.stringify(merged))}) as any[];`,
    `export const areaGroups = JSON.parse(${JSON.stringify(JSON.stringify(areaGroups))}) as any[];`,
    `export const typeGroups = JSON.parse(${JSON.stringify(JSON.stringify(typeGroups))}) as any[];`,
    `export const longtailGroups = JSON.parse(${JSON.stringify(JSON.stringify(longtailGroups))}) as any[];`,
    `export const draftBusinessCount = ${mergedAll.length - merged.length};`,
    ''
  ].join('\n'),
  'utf8'
);

console.log(`Businesses published: ${merged.length}/${mergedAll.length}`);
console.log(`Draft businesses: ${mergedAll.length - merged.length}`);
console.log(`Area pages: ${areaGroups.length}`);
console.log(`Type pages: ${typeGroups.length}`);
console.log(`Longtail pages: ${longtailGroups.length}`);
console.log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)}`);

function mergeBySourceId(rows, externalMap) {
  return rows.map((row) => ({ ...row, ...(externalMap.get(row.sourceId) || {}) }));
}

function shouldIncludeTarget(row) {
  if (TARGET_SOURCE_IDS.size > 0) return TARGET_SOURCE_IDS.has(row.sourceId);
  if (TARGET_DISTRICTS.size > 0 && !TARGET_DISTRICTS.has(row.district)) return false;
  if (!TARGET_SCOPE || TARGET_SCOPE === 'all') return true;
  if (TARGET_SCOPE === 'incheon-seoul-priority') return isIncheon(row) || isSeoulPriority(row);
  if (TARGET_SCOPE === 'incheon-seoul-gyeonggi-priority') return isIncheon(row) || isSeoulPriority(row) || isGyeonggiPriority(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi') return isIncheonSeogu(row) || isGyeonggi(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-seoul-priority') return isIncheonSeogu(row) || isGyeonggi(row) || isSeoulPriority(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-seoul-9districts') return isIncheonSeogu(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-seoul-13districts') return isIncheonSeogu(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-seoul-18districts') return isIncheonSeogu(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-seoul-all') return isIncheonSeogu(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row) || isSeoulFinalBatch(row);
  if (TARGET_SCOPE === 'incheon-gyeonggi-seoul-all') return isIncheon(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row) || isSeoulFinalBatch(row);
  if (TARGET_SCOPE === 'incheon-gyeonggi-seoul-busan') return isIncheon(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row) || isSeoulFinalBatch(row) || isBusan(row);
  if (TARGET_SCOPE === 'incheon-gyeonggi-seoul-busan-daegu') return isIncheon(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row) || isSeoulFinalBatch(row) || isBusan(row) || isDaegu(row);
  if (TARGET_SCOPE === 'incheon-gyeonggi-seoul-busan-daegu-daejeon') return isIncheon(row) || isGyeonggi(row) || isSeoulPriority(row) || isSeoulSecondBatch(row) || isSeoulThirdBatch(row) || isSeoulFourthBatch(row) || isSeoulFinalBatch(row) || isBusan(row) || isDaegu(row) || isDaejeon(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top5') return isIncheonSeogu(row) || isGyeonggiTop5(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top6') return isIncheonSeogu(row) || isGyeonggiTop6(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top7') return isIncheonSeogu(row) || isGyeonggiTop7(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top8') return isIncheonSeogu(row) || isGyeonggiTop8(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top9') return isIncheonSeogu(row) || isGyeonggiTop9(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top10') return isIncheonSeogu(row) || isGyeonggiTop10(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top11') return isIncheonSeogu(row) || isGyeonggiTop11(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top12') return isIncheonSeogu(row) || isGyeonggiTop12(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top13') return isIncheonSeogu(row) || isGyeonggiTop13(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top14') return isIncheonSeogu(row) || isGyeonggiTop14(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top15') return isIncheonSeogu(row) || isGyeonggiTop15(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top16') return isIncheonSeogu(row) || isGyeonggiTop16(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top17') return isIncheonSeogu(row) || isGyeonggiTop17(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top18') return isIncheonSeogu(row) || isGyeonggiTop18(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top19') return isIncheonSeogu(row) || isGyeonggiTop19(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top20') return isIncheonSeogu(row) || isGyeonggiTop20(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top21') return isIncheonSeogu(row) || isGyeonggiTop21(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top22') return isIncheonSeogu(row) || isGyeonggiTop22(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top23') return isIncheonSeogu(row) || isGyeonggiTop23(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top24') return isIncheonSeogu(row) || isGyeonggiTop24(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top25') return isIncheonSeogu(row) || isGyeonggiTop25(row);
  if (TARGET_SCOPE === 'incheon-seogu-gyeonggi-top26') return isIncheonSeogu(row) || isGyeonggiTop26(row);
  if (TARGET_SCOPE === 'incheon') return isIncheon(row);
  if (TARGET_SCOPE === 'incheon-seogu') return isIncheonSeogu(row);
  return true;
}

function normalizeBusiness(row, reviewData = {}, generated = {}, manualPlace = {}) {
  const businessType = row.businessType || inferBusinessType(row);
  const rawSourceRefs = reviewData.sourceRefs || row.sourceRefs || [];
  const relevantSourceRefs = filterRelevantReviewRefs(row, rawSourceRefs);
  const sourceRefs = sanitizeReviewRefs(rawSourceRefs);
  const sourceCount = sourceRefs.length;
  const reviewSignalSourceCount = relevantSourceRefs.length;
  const reviewSignalCoverageWeak = sourceCount > 0 && reviewSignalSourceCount === 0;
  const naverMapReviewCount = Number(manualPlace.naverMapReviewCount || row.naverMapReviewCount || 0);
  const reviewSignals = unique([...(reviewData.reviewSignals || []), ...(row.reviewSignals || [])]);
  const serviceSourceRefs = relevantSourceRefs.length ? relevantSourceRefs : [];
  const serviceSignals = relevantSourceRefs.length ? reviewSignals : [];
  const services = unique([...(row.services || []), ...inferServices(row, serviceSignals, serviceSourceRefs)]);
  const district = row.district;
  const areaLabel = [row.city, district, row.dong].filter(Boolean).join(' ');
  const name = row.displayName || row.name;
  const roadAddress = row.roadAddress;
  const lotAddress = row.lotAddress;
  const naverMapUrl = isNaverMapUrl(row.naverMapUrl) ? row.naverMapUrl : buildNaverMapUrl(name, roadAddress || lotAddress);
  const hasNaverMatch = Boolean(row.naverLocal || row.naverMatchStatus === 'matched');
  const hasReviews = sourceCount > 0;
  const hasGenerated = Boolean(generated.generatedBy || generated.oneLineSummary || generated.title || generated.reviewSection);
  const quality = computePageStatus({ ...row, naverMapUrl, sourceCount }, { hasNaverMatch, hasReviews, hasGenerated });
  const reviewSignalLevel = computeReviewSignalLevel(reviewSignalCoverageWeak ? 0 : reviewSignalSourceCount, reviewSignalCoverageWeak ? [] : reviewSignals);
  const reviewCoverageLabel = buildReviewCoverageLabel({
    naverMapReviewCount,
    reviewSourceCount: reviewSignalSourceCount,
    reviewSignalCoverageWeak
  });
  const aiReviewSummary = buildAiReviewSummary(generated, row, reviewSignals, sourceCount, naverMapReviewCount);
  if (reviewSignalCoverageWeak) {
    aiReviewSummary.confidenceNote = naverMapReviewCount
      ? `블로그·카페 후기는 많지 않지만 네이버 지도에는 리뷰 ${naverMapReviewCount.toLocaleString('ko-KR')}개가 표시됩니다.`
      : '이 병원명으로 직접 확인되는 후기가 많지 않아 주소, 전화, 운영 여부를 함께 확인하는 편이 좋습니다.';
    if (naverMapReviewCount) {
      aiReviewSummary.oneLineSummary = `${name}은 블로그 후기는 많지 않지만 네이버 지도에는 리뷰 ${naverMapReviewCount.toLocaleString('ko-KR')}개가 표시되는 동물병원입니다.`;
    }
    aiReviewSummary.reviewShortage = true;
  }
  const mentionedCards = buildMentionedCards(generated, reviewSignalCoverageWeak ? [] : reviewSignals, services);
  const visitChecklist = buildVisitChecklist(row, services);
  const faqItems = buildFaqItems(row, services, sourceCount, naverMapReviewCount);
  const articleSections = withMapReviewContext(
    buildArticleSections(generated, { ...row, district, name, areaLabel }, services, relevantSourceRefs),
    naverMapReviewCount
  );
  const reviewLinks = buildReviewLinks(relevantSourceRefs);
  const reviewSourceSummary = buildReviewSourceSummary(relevantSourceRefs, naverMapReviewCount, reviewCoverageLabel);
  const reviewAnalysisCards = buildReviewAnalysisCards({ generated, reviewSignals, services, relevantSourceRefs, naverMapReviewCount });
  const featureCards = buildFeatureCards({ services, relevantSourceRefs, naverMapReviewCount });
  const decisionGuide = buildDecisionGuide({ row: { ...row, name, areaLabel }, services, relevantSourceRefs, naverMapReviewCount });
  const searchIntentCards = buildSearchIntentCards({ row: { ...row, district, name, areaLabel }, services, relevantSourceRefs });
  const intentLinks = buildIntentLinks({ ...row, district, dong: row.dong, businessType, typePath: typePath(businessType), slug: '' }, services);
  const reviewSection = withMapReviewContextText(cleanVisibleText(generated.reviewSection) || aiReviewSummary.oneLineSummary, naverMapReviewCount);

  return {
    ...row,
    roadAddress,
    lotAddress,
    businessType,
    district,
    slug: slugify(`${typePath(businessType)}-${row.city}-${district}-${name}-${row.sourceId}`),
    typePath: typePath(businessType),
    name,
    areaLabel,
    naverMapUrl,
    services,
    serviceLabels: services,
    reviewSignals,
    hasReviews,
    hasNaverMatch,
    hasGenerated,
    sourceCount,
    reviewSignalSourceCount,
    reviewSignalCoverageWeak,
    naverMapReviewCount,
    naverMapPhotoAvailable: Boolean(manualPlace.naverMapPhotoAvailable || row.naverMapPhotoAvailable),
    reviewLinks,
    reviewSourceSummary,
    reviewAnalysisCards,
    featureCards,
    decisionGuide,
    searchIntentCards,
    intentLinks,
    sourceRefs,
    pageStatus: quality.status,
    pageStatusReason: quality.reasons,
    reviewSignalLevel,
    reviewCoverageLabel,
    reviewSignalStars: '',
    aiReviewSummary,
    mentionedCards,
    visitChecklist,
    faqItems,
    title: buildDetailTitle({ ...row, name, areaLabel }, services),
    metaDescription: buildMetaDescription({ ...row, name, areaLabel, naverMapReviewCount }, services, reviewCoverageLabel),
    introSection: cleanVisibleText(generated.introSection) || `${name}은 ${areaLabel || '해당 지역'}에서 확인되는 동물병원입니다. 방문 전에는 운영시간, 예약 필요 여부, 진료 가능 범위를 병원에 직접 확인하는 것이 좋습니다.`,
    serviceSection: cleanVisibleText(generated.serviceSection) || buildServiceSection(services),
    checkSection: cleanVisibleText(generated.checkSection) || buildCheckSection(services),
    reviewSection,
    articleSections,
    fieldNoteSection: cleanVisibleText(generated.fieldNoteSection) || '',
    cautionPoints: generated.cautionPoints || buildCautionPoints(services, sourceCount),
    rankScore: scoreBusiness({ ...row, services, sourceCount, hasNaverMatch, hasGenerated })
  };
}

function computePageStatus(row) {
  const reasons = [];
  if (!(row.roadAddress || row.lotAddress)) reasons.push('address_required');
  if (!(row.naverMapUrl || row.lat || row.lng || row.mapx || row.mapy)) reasons.push('map_required');
  return { status: reasons.length ? 'draft' : 'published', reasons };
}

function filterRelevantReviewRefs(row, refs = []) {
  const names = unique([
    row.displayName,
    row.name,
    String(row.displayName || row.name || '').replace(/\s+/g, ''),
    String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, '').replace(/\s+/g, '')
  ]).filter((name) => String(name).length >= 3);
  return refs.filter((ref) => {
    const text = `${ref.title || ''} ${ref.summary || ''}`.replace(/\s+/g, '');
    return names.some((name) => text.includes(String(name).replace(/\s+/g, '')));
  });
}

function buildAreaGroups(items) {
  const groups = new Map();
  for (const item of items) {
    addGroup(groups, {
      slug: slugify(`${item.city}-${typeLabel(item.businessType)}`),
      type: 'city',
      name: `${item.city} ${typeLabel(item.businessType)}`,
      title: `${item.city} ${typeLabel(item.businessType)} 위치, 후기, 방문 전 확인사항`,
      description: `${item.city}에서 네이버 장소 매칭과 후기가 확인된 ${typeLabel(item.businessType)} 정보를 지역 기준으로 정리했습니다.`,
      item
    });
    if (item.district) {
      addGroup(groups, {
        slug: slugify(`${item.city}-${item.district}-${typeLabel(item.businessType)}`),
        type: 'district',
        name: `${item.city} ${item.district} ${typeLabel(item.businessType)}`,
        title: `${item.city} ${item.district} ${typeLabel(item.businessType)} 후기, 위치, 진료정보 정리`,
        description: `${item.city} ${item.district}에서 방문 전 확인할 수 있는 동물병원을 후기와 위치 중심으로 정리했습니다.`,
        item
      });
    }
    if (item.dong) {
      addGroup(groups, {
        slug: slugify(`${item.city}-${item.district}-${item.dong}-${typeLabel(item.businessType)}`),
        type: 'dong',
        name: `${item.city} ${item.district} ${item.dong} ${typeLabel(item.businessType)}`,
        title: `${item.city} ${item.district} ${item.dong} ${typeLabel(item.businessType)} 후기와 위치`,
        description: `${item.dong} 주변에서 확인되는 동물병원 정보를 주소, 전화, 후기 기준으로 정리했습니다.`,
        item
      });
    }
  }
  return [...groups.values()].map(sortGroupItems).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function buildTypeGroups(items) {
  return TYPE_DEFS.map(([slug, name, title, keys]) => {
    const matched = items.filter((item) => keys.some((key) => item.services.includes(key) || searchText(item).includes(key)));
    return {
      slug,
      type: 'service',
      name,
      title,
      description: `${name}을 찾는 보호자가 방문 전에 확인해야 할 위치, 전화, 예약, 주차, 후기를 정리했습니다.`,
      intent: keys.join(', '),
      body: buildGroupBody(name, matched),
      items: matched.map(toListItem).sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0))
    };
  }).filter((group) => group.items.length > 0);
}

function buildLongtailGroups(items) {
  const fixedGroups = LONGTAIL_DEFS.map(([slug, name, title, description, scopeMatch, intentPattern]) => {
    const matched = items.filter((item) => scopeMatch(item) && intentPattern.test(searchText(item)));
    if (!matched.length) return null;
    return {
      slug,
      type: 'longtail',
      name,
      title,
      description,
      intent: name,
      body: buildLongtailBody(name, description, matched),
      items: matched.map(toListItem).sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0))
    };
  }).filter(Boolean);
  const dynamicGroups = buildDistrictLongtailGroups(items);
  const seen = new Set();
  return [...fixedGroups, ...dynamicGroups].filter((group) => {
    if (seen.has(group.slug)) return false;
    seen.add(group.slug);
    return true;
  });
}

function buildDistrictLongtailGroups(items) {
  const intents = [
    ['24h-animal-hospital', '24시 동물병원', '24시 동물병원 위치, 야간진료, 후기 정리', '24시 또는 야간진료 가능성을 방문 전 확인해야 하는 동물병원 후보입니다.', /24시|24|야간|응급/],
    ['night-animal-hospital', '야간진료 동물병원', '야간진료 동물병원 후기, 운영시간 확인', '늦은 시간 문의가 필요한 보호자를 위해 야간진료 관련 후보를 모았습니다.', /야간|24시|24|응급/],
    ['emergency-animal-hospital', '응급 동물병원', '응급 동물병원 위치, 전화 확인사항', '응급 접수, 야간 내원, 수술 가능성은 병원별로 달라 전화 확인이 필요한 후보입니다.', /응급|24시|24|수술|입원/],
    ['exotic-animal-hospital', '특수동물병원', '특수동물병원 후기, 진료 가능성 확인', '거북이, 햄스터, 조류 등 특수동물 진료 가능성은 병원마다 달라 방문 전 확인이 필요한 후보입니다.', /특수동물|거북이|햄스터|조류|파충류|토끼/],
    ['turtle-animal-hospital', '거북이 동물병원', '거북이 진료 동물병원 후기, 특수동물 확인', '거북이 진료 가능성은 병원마다 다르므로 사육 환경과 증상을 함께 설명하고 확인하기 좋은 후보입니다.', /거북이|거북|파충류|특수동물/],
    ['hamster-animal-hospital', '햄스터 동물병원', '햄스터 진료 동물병원 후기, 특수동물 확인', '햄스터 같은 소동물 진료 가능성은 병원별로 달라 방문 전 확인이 필요한 후보입니다.', /햄스터|소동물|특수동물/],
    ['vaccination-animal-hospital', '예방접종 동물병원', '강아지 고양이 예방접종 동물병원 후기, 위치 정리', '예방접종, 광견병 접종, 기본 건강관리 목적으로 비교하기 좋은 후보입니다.', /예방접종|접종|광견병|백신/],
    ['neutering-animal-hospital', '중성화 동물병원', '고양이 강아지 중성화 동물병원 후기, 확인사항', '중성화 상담이나 수술 관련 후기가 확인되는 동물병원 후보입니다.', /중성화|수술|입원/],
    ['cat-animal-hospital', '고양이 동물병원', '고양이 동물병원 후기, 진료 확인사항', '고양이 진료 언급이나 반려묘 관련 후기가 확인되는 동물병원 후보입니다.', /고양이|반려묘|cat/],
    ['dog-animal-hospital', '강아지 동물병원', '강아지 동물병원 후기, 위치 정리', '강아지 진료와 반려견 후기가 확인되는 동물병원 후보입니다.', /강아지|반려견|dog/],
    ['parking-animal-hospital', '주차 가능한 동물병원', '동물병원 주차, 예약, 방문 전 확인사항', '차량 방문 전 주차 관련 언급이나 위치 확인이 필요한 후보입니다.', /주차/]
  ];
  const districtGroups = new Map();
  for (const item of items.filter((item) => item.businessType === 'clinic')) {
    const key = [item.city, item.district].filter(Boolean).join('|');
    if (!item.district) continue;
    if (!districtGroups.has(key)) districtGroups.set(key, []);
    districtGroups.get(key).push(item);
  }
  const groups = [];
  for (const [key, districtItems] of districtGroups.entries()) {
    const [city, district] = key.split('|');
    for (const [suffix, intentName, titleSuffix, descriptionSuffix, pattern] of intents) {
      const matched = districtItems.filter((item) => pattern.test(searchText(item)));
      if (!matched.length) continue;
      const name = `${city} ${district} ${intentName}`;
      groups.push({
        slug: slugify(`${city}-${district}-${suffix}`),
        type: 'longtail',
        name,
        title: `${city} ${district} ${titleSuffix}`,
        description: `${city} ${district}에서 ${descriptionSuffix}`,
        intent: name,
        body: buildLongtailBody(name, `${city} ${district}에서 ${descriptionSuffix}`, matched),
        items: matched.map(toListItem).sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0))
      });
    }
  }
  return groups;
}

function addGroup(groups, config) {
  const group = groups.get(config.slug) || {
    slug: config.slug,
    type: config.type,
    name: config.name,
    title: config.title,
    description: config.description,
    items: []
  };
  if (!group.items.some((item) => item.slug === config.item.slug)) group.items.push(toListItem(config.item));
  groups.set(config.slug, group);
}

function sortGroupItems(group) {
  group.items.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0) || a.name.localeCompare(b.name, 'ko'));
  return group;
}

function toListItem(item) {
  return {
    slug: item.slug,
    typePath: item.typePath,
    businessType: item.businessType,
    name: item.name,
    city: item.city,
    district: item.district,
    dong: item.dong,
    areaLabel: item.areaLabel,
    category: item.category,
    roadAddress: item.roadAddress,
    lotAddress: item.lotAddress,
    phone: item.phone,
    lat: item.lat,
    lng: item.lng,
    mapx: item.mapx,
    mapy: item.mapy,
    naverMapUrl: item.naverMapUrl,
    services: item.services,
    reviewSignals: item.reviewSignals,
    reviewSignalLevel: item.reviewSignalLevel,
    reviewCoverageLabel: item.reviewCoverageLabel,
    reviewSignalStars: '',
    naverMapReviewCount: item.naverMapReviewCount,
    reviewLinksCount: item.reviewLinks?.length || 0,
    sourceCount: item.sourceCount,
    rankScore: item.rankScore
  };
}

function buildLongtailBody(name, description, items) {
  const count = items.length.toLocaleString('ko-KR');
  const reviewCount = items.filter((item) => item.sourceCount > 0).length.toLocaleString('ko-KR');
  const commonSignals = topSignals(items).join(', ') || '상담, 설명, 대기시간, 시설, 예약';
  return [
    `${name} 페이지는 단순히 가까운 병원 목록만 보여주기보다 방문 전에 실제로 확인해야 할 기준을 함께 정리합니다. ${description} 현재 이 묶음에는 ${count}곳이 포함되어 있고, ${reviewCount}곳은 네이버 블로그나 카페 검색 결과에서 후기가 확인됩니다.`,
    `24시, 야간진료, 응급 접수 같은 표현은 실제 가능 여부가 병원 운영 상황에 따라 달라질 수 있습니다. 방문 전에는 전화 연결 여부, 당일 담당 진료진, 접수 마감 시간, 주차 가능 여부, 예약 필요 여부를 먼저 확인하는 편이 안전합니다.`,
    `후기 후보에서는 ${commonSignals} 같은 표현이 자주 보입니다. 다만 후기는 보호자별 경험과 방문 시점에 따라 달라질 수 있으므로 원문을 그대로 옮기지 않고, 반복적으로 보이는 경향만 참고용으로 요약합니다.`,
    `고양이, 강아지, 특수동물, 수술, 입원, 검진처럼 목적이 분명한 방문이라면 동물 종류와 증상, 필요한 검사나 처치 범위를 미리 설명하고 가능 여부를 문의하는 것이 좋습니다. 이 페이지는 치료 효과를 보장하지 않으며, 최종 판단은 병원 상담과 수의사의 진료를 기준으로 해야 합니다.`
  ];
}

function buildGroupBody(name, items) {
  const signals = topSignals(items).join(', ') || '상담, 설명, 예약, 주차';
  return [
    `${name}을 찾을 때는 병원명보다 지역과 방문 목적을 함께 확인하는 검색이 더 유용합니다. 같은 지역 안에서도 운영시간, 예약 방식, 주차 동선, 진료 가능 동물 종류가 다를 수 있습니다.`,
    `후기에서는 ${signals} 같은 내용이 반복적으로 언급됩니다. 방문 전 확인할 요소를 정리하기 위한 참고 정보로 보면 좋습니다.`,
    `응급, 야간, 수술, 입원, 특수동물 진료는 병원 상황과 진료진 일정에 따라 달라질 수 있으므로 전화 문의 후 이동하는 것을 권장합니다.`
  ];
}

function buildDetailTitle(row, services = []) {
  const area = row.areaLabel || [row.city, row.district].filter(Boolean).join(' ');
  const keyword = buildTitleKeyword(services);
  return `${area} ${row.name} ${keyword} 후기 모음`;
}

function buildTitleKeyword(services = []) {
  const priority = [];
  if (services.includes('24시')) priority.push('24시');
  else if (services.includes('야간진료')) priority.push('야간진료');
  if (services.includes('응급진료') || services.includes('응급수술')) priority.push('응급');
  if (services.includes('특수동물')) priority.push('특수동물');
  else if (services.includes('거북이')) priority.push('거북이');
  else if (services.includes('햄스터')) priority.push('햄스터');
  else if (services.includes('조류')) priority.push('조류');
  if (services.includes('고양이') && priority.length < 2) priority.push('고양이');
  if (services.includes('강아지') && priority.length < 2) priority.push('강아지');
  if (services.includes('예방접종') && priority.length < 2) priority.push('예방접종');
  if ((services.includes('수술') || services.includes('중성화')) && priority.length < 2) priority.push('수술');
  if (priority.length) return `${priority.slice(0, 2).join(' ')}`;
  return '진료정보 위치';
}

function buildMetaDescription(row, services, coverageLabel) {
  const area = row.areaLabel || [row.city, row.district].filter(Boolean).join(' ');
  const serviceText = services.slice(0, 4).join(', ') || '동물병원';
  const reviewText = row.naverMapReviewCount
    ? `네이버 지도 리뷰 ${Number(row.naverMapReviewCount).toLocaleString('ko-KR')}개`
    : coverageLabel || '후기 자료 여부';
  return `${area} ${row.name}의 주소, 전화번호, 네이버 지도, ${serviceText}, ${reviewText}와 방문 전 확인사항을 정리했습니다.`;
}

function buildAiReviewSummary(generated, row, signals, sourceCount, naverMapReviewCount = 0) {
  const oneLineSummary = cleanVisibleText(
    generated.oneLineSummary ||
    generated.reviewSection ||
    (naverMapReviewCount
      ? `블로그 후기는 많지 않지만 네이버 지도에는 리뷰 ${Number(naverMapReviewCount).toLocaleString('ko-KR')}개가 표시됩니다.`
      : '') ||
    (sourceCount
      ? `후기에서는 ${signals.slice(0, 4).join(', ') || '상담과 설명'} 관련 언급이 확인됩니다.`
      : '현재 확인 가능한 공개 후기는 많지 않습니다.')
  );
  return {
    oneLineSummary,
    frequentMentions: normalizeArray(generated.frequentMentions || generated.mentionedTopics, signals.slice(0, 6)),
    checkPoints: normalizeArray(generated.checkPoints, buildCautionPoints(row.services || [], sourceCount)).slice(0, 6),
    guardianQuestions: normalizeArray(generated.guardianQuestions, [
      '접수 마감 시간과 점심시간이 겹치지 않는지 확인하면 헛걸음을 줄일 수 있습니다.',
      '대기 시간이 길 수 있는 시간대와 예약 접수 가능 여부를 함께 물어보면 방문 시간을 잡기 쉽습니다.',
      '차량 방문이라면 병원 앞 정차가 가능한지, 가까운 공영주차장이 있는지까지 확인하는 편이 좋습니다.'
    ]),
    reviewShortage: Boolean(generated.reviewShortage) || sourceCount < 3,
    confidenceNote: cleanVisibleText(generated.confidenceNote) || (sourceCount < 3 ? '현재 확인 가능한 후기가 많지 않아 방문 전 전화 확인이 더 중요합니다.' : '')
  };
}

function buildReviewLinks(refs = []) {
  return refs
    .filter((ref) => ref.link && /^https?:\/\//.test(ref.link))
    .filter((ref) => ['blog', 'official_blog', 'cafe'].includes(ref.sourceType))
    .slice(0, 8)
    .map((ref) => ({
      title: cleanVisibleText(ref.title || ''),
      url: ref.link,
      sourceType: ref.sourceType,
      sourceName: ref.bloggerName || (ref.sourceType === 'cafe' ? '네이버 카페' : '네이버 블로그'),
      postDate: ref.postDate || ''
    }))
    .filter((ref) => ref.title && ref.url);
}

function sanitizeReviewRefs(refs = []) {
  return refs.map((ref) => ({
    ...ref,
    title: cleanVisibleText(ref.title || ''),
    summary: cleanVisibleText(ref.summary || '')
  }));
}

function buildReviewSourceSummary(refs = [], naverMapReviewCount = 0, coverageLabel = '') {
  const blogCount = refs.filter((ref) => ref.sourceType === 'blog' || ref.sourceType === 'official_blog').length;
  const cafeCount = refs.filter((ref) => ref.sourceType === 'cafe').length;
  const total = Number(naverMapReviewCount || 0) + blogCount + cafeCount;
  return {
    total,
    coverageLabel: coverageLabel || buildReviewCoverageLabel({ naverMapReviewCount, reviewSourceCount: blogCount + cafeCount }),
    naverMapReviewCount: Number(naverMapReviewCount || 0),
    blogCount,
    cafeCount,
    analyzedTextCount: blogCount + cafeCount,
    insightLine: blogCount + cafeCount
      ? `AI는 공개 후기 ${Number(blogCount + cafeCount).toLocaleString('ko-KR')}건을 기준으로 반복 언급된 특징을 요약했습니다.`
      : naverMapReviewCount
        ? `네이버 지도에는 공개 리뷰 ${Number(naverMapReviewCount).toLocaleString('ko-KR')}개가 표시됩니다.`
        : '현재 확인 가능한 공개 후기 자료가 많지 않아 기본정보와 지도 정보를 중심으로 정리했습니다.',
    insightNote: blogCount + cafeCount
      ? '블로그·카페 후기 제목과 요약, 네이버 지도 리뷰 수처럼 공개적으로 확인 가능한 자료만 참고합니다.'
      : naverMapReviewCount
        ? '블로그·카페 후기 후보가 부족한 경우에는 지도 리뷰 수, 위치, 전화번호, 방문 전 확인 항목을 중심으로 보여줍니다.'
        : '후기가 부족한 페이지는 억지로 평가하지 않고 방문 전 확인할 항목을 우선 보여줍니다.',
    label: [
      naverMapReviewCount ? `네이버 지도 리뷰 ${Number(naverMapReviewCount).toLocaleString('ko-KR')}개` : '',
      blogCount ? `블로그 ${blogCount}건` : '',
      cafeCount ? `카페 ${cafeCount}건` : ''
    ].filter(Boolean).join(' + ') || '공개 후기 자료 부족'
  };
}

function buildReviewAnalysisCards({ generated = {}, reviewSignals = [], services = [], relevantSourceRefs = [], naverMapReviewCount = 0 }) {
  const text = searchText({ reviewSignals, sourceRefs: relevantSourceRefs, services, ...generated });
  const specs = [
    ['친절한 설명', '😊', /친절|상담|설명|선생님|응대/, '상담 태도, 설명 방식, 보호자 응대와 관련된 표현이 얼마나 자주 보이는지 기준으로 정리했습니다.'],
    ['시설', '🏥', /시설|청결|대기실|넓고|병원도|깔끔|상가/, '대기 공간, 병원 환경, 청결도처럼 방문자가 체감하는 시설 관련 표현을 모았습니다.'],
    ['대기시간', '⏰', /대기|접수|마감|운영\s*시간|휴게\s*시간|시간/, '대기시간, 접수 마감, 운영시간처럼 방문 시간을 정할 때 필요한 표현을 기준으로 잡았습니다.'],
    ['주차', '🚗', /주차|공용주차장|상가|위치|주소/, '주차장, 상가 위치, 주소 안내처럼 실제 방문 동선에 필요한 단서를 모았습니다.'],
    ['예약', '📞', /예약|문의|전화|접수|마감/, '예약, 전화 문의, 접수 마감처럼 방문 전에 연락이 필요한 단서를 확인했습니다.'],
    ['비용/과잉', '💳', /과잉|정직|필요한\s*진료|비용|부담/, '비용 부담이나 필요한 진료만 안내받았다는 취지의 표현이 있는지 확인했습니다.'],
    ['수술/중성화', '🩺', /수술|중성화|슬개골|외과/, '중성화, 슬개골, 수술 상담처럼 비교 전 확인하려는 방문 목적이 있는지 살펴봤습니다.'],
    ['고양이 진료', '🐱', /고양이|반려묘|수컷/, '반려묘, 고양이 중성화, 고양이 건강검진처럼 고양이 보호자 후기가 있는지 봤습니다.']
  ];
  const cards = specs.map(([label, icon, pattern, note]) => {
    const hits = countMatches(text, pattern);
    const score = hits > 2 ? 5 : hits > 1 ? 4 : hits > 0 ? 3 : naverMapReviewCount && ['친절한 설명', '대기시간', '예약'].includes(label) ? 2 : 0;
    return {
      label,
      icon,
      score,
      evidenceLabel: evidenceLabelForScore(score),
      stars: '',
      note: score ? note : '현재 블로그·카페 후기에서는 뚜렷한 반복 언급이 많지 않습니다.'
    };
  });
  const generatedMentions = normalizeArray(generated.frequentMentions || [], [])
    .slice(0, 3)
    .map((label) => ({
      label,
      icon: iconForReviewLabel(label),
      score: 4,
      evidenceLabel: evidenceLabelForScore(4),
      stars: '',
      note: '수집된 후기 제목과 요약에서 주요 방문 목적이나 평가 항목으로 분류된 내용입니다.'
    }));
  return uniqueByLabel([...cards, ...generatedMentions]).slice(0, 8);
}

function buildFeatureCards({ services = [], relevantSourceRefs = [], naverMapReviewCount = 0 }) {
  const text = searchText({ services, sourceRefs: relevantSourceRefs });
  const features = [
    ['24시', '24시', /24시|24시간|24h/i, 'strict'],
    ['야간', '야간진료', /야간|늦은\s*시간|밤진료/, 'soft'],
    ['응급', '응급진료', /응급|응급실/, 'soft'],
    ['고양이', '고양이', /고양이|반려묘/, 'soft'],
    ['강아지', '강아지', /강아지|반려견/, 'soft'],
    ['특수동물', '특수동물', /특수동물|거북|햄스터|조류|파충류/, 'soft'],
    ['주차', '주차', /주차|공용주차장|상가/, 'soft'],
    ['예약', '예약', /예약|접수|마감/, 'soft']
  ];
  return features.map(([label, service, pattern, mode]) => {
    const confirmed = services.includes(service);
    const mentioned = pattern.test(text);
    const mapHint = naverMapReviewCount && ['주차', '예약'].includes(label);
    const symbol = confirmed || mentioned ? '✔' : mode === 'strict' ? '❌' : '△';
    const status = confirmed
      ? featurePositiveStatus(label)
      : mentioned
        ? featureMentionStatus(label)
        : mapHint
          ? '지도 확인'
          : '확인 필요';
    return {
      label,
      symbol,
      status,
      tone: symbol === '✔' ? 'strong' : status === '지도 확인' ? 'soft' : 'muted'
    };
  });
}

function iconForReviewLabel(label = '') {
  if (/친절|상담|설명/.test(label)) return '😊';
  if (/시설|청결/.test(label)) return '🏥';
  if (/대기|시간/.test(label)) return '⏰';
  if (/주차|위치/.test(label)) return '🚗';
  if (/예약|전화|문의/.test(label)) return '📞';
  if (/과잉|비용|정직/.test(label)) return '💳';
  if (/수술|중성화|검진|접종/.test(label)) return '🩺';
  if (/고양이|반려묘/.test(label)) return '🐱';
  if (/강아지|반려견/.test(label)) return '🐶';
  return '•';
}

function featurePositiveStatus(label = '') {
  if (label === '주차') return '가능성 있음';
  if (label === '예약') return '권장';
  return '후기 언급';
}

function featureMentionStatus(label = '') {
  if (label === '주차') return '언급 있음';
  if (label === '예약') return '권장';
  return '언급 있음';
}

function buildDecisionGuide({ row, services = [], relevantSourceRefs = [], naverMapReviewCount = 0 }) {
  const text = searchText({ ...row, services, sourceRefs: relevantSourceRefs });
  const goodFor = [];
  const checkBefore = [];
  if (naverMapReviewCount) goodFor.push(`네이버 지도 리뷰가 많은 ${row.areaLabel} 병원을 먼저 비교하고 싶은 경우`);
  if (relevantSourceRefs.length >= 5) goodFor.push('블로그·카페 후기를 읽고 병원 분위기를 확인하고 싶은 경우');
  if (/접종|예방접종/.test(text)) goodFor.push('예방접종 후기를 참고하고 싶은 경우');
  if (/검진|건강검진/.test(text)) goodFor.push('건강검진 방문 후기를 찾는 경우');
  if (/중성화|수술|슬개골/.test(text)) goodFor.push('중성화나 수술 관련 후기를 비교하고 싶은 경우');
  if (/고양이|반려묘/.test(text)) goodFor.push('고양이 진료 경험이 언급된 병원을 찾는 경우');
  if (!goodFor.length) goodFor.push(`${row.areaLabel} 근처 동물병원 위치와 지도 리뷰를 먼저 확인하려는 경우`);

  if (!services.includes('24시')) checkBefore.push('24시 또는 야간진료가 필요한 경우');
  if (!services.includes('응급진료')) checkBefore.push('응급 상황으로 바로 이동해야 하는 경우');
  if (!services.includes('특수동물')) checkBefore.push('거북이, 햄스터, 조류 등 특수동물 진료가 필요한 경우');
  if (!services.includes('주차')) checkBefore.push('차량 방문과 주차 동선이 중요한 경우');
  if (!services.includes('예약')) checkBefore.push('예약제 운영 여부와 접수 마감 시간이 중요한 경우');

  return {
    goodFor: goodFor.slice(0, 5),
    checkBefore: checkBefore.slice(0, 5)
  };
}

function buildSearchIntentCards({ row, services = [], relevantSourceRefs = [] }) {
  const text = searchText({ ...row, services, sourceRefs: relevantSourceRefs });
  const intents = [
    ['🐶', '강아지 예방접종 상담', /강아지|반려견|예방접종|접종|광견병/, '접종 시기, 이전 접종 기록, 최근 컨디션을 함께 정리해 가면 상담이 수월합니다.'],
    ['🐱', '고양이 건강검진', /고양이|반려묘|건강검진|검진/, '이동장, 최근 식욕과 배변 변화, 스트레스 반응을 함께 확인해보면 좋습니다.'],
    ['🩺', '중성화 상담', /중성화|수술/, '사전 검사, 금식 여부, 회복 관리, 비용 범위를 차례로 확인해보세요.'],
    ['🦴', '슬개골·관절 상담', /슬개골|관절|보행|다리/, '걷는 영상이나 절뚝거리는 시점이 있으면 상담에 참고가 됩니다.'],
    ['🌙', '야간·응급 상황', /24시|야간|응급|늦은\s*시간/, '늦은 시간에는 가능한 진료 범위가 달라질 수 있어 전화 연결 후 이동하는 편이 좋습니다.'],
    ['🐢', '거북이·햄스터·특수동물', /특수동물|거북|햄스터|조류|파충류|토끼/, '동물 종류, 나이, 증상, 사육 환경을 구체적으로 말하고 가능 여부를 확인하세요.'],
    ['🧴', '피부질환 상담', /피부|가려움|귓병|털|알레르기/, '증상이 생긴 시점, 사료 변경 여부, 긁는 부위를 사진으로 준비하면 설명이 쉽습니다.'],
    ['🐕', '노령견 검진', /노령|노견|검진|건강검진|치과|스케일링/, '기존 질환, 복용 중인 약, 최근 활동량 변화를 정리해두면 좋습니다.']
  ];
  const scored = intents.map(([icon, label, pattern, note], index) => ({
    icon,
    label,
    note,
    score: countMatches(text, pattern),
    order: index
  }));
  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const fallback = scored.filter((item) => item.score === 0).slice(0, 4);
  return [...selected, ...fallback].slice(0, 6).map(({ icon, label, note }) => ({ icon, label, note }));
}

function buildIntentLinks(row, services = []) {
  const areaSlug = slugify(`${row.city}-${row.district}-동물병원`);
  const dongSlug = row.dong ? slugify(`${row.city}-${row.district}-${row.dong}-동물병원`) : '';
  const labels = [
    ['지역 동물병원', `/area/${areaSlug}/`],
    row.dong ? [`${row.dong} 동물병원`, `/area/${dongSlug}/`] : null,
    services.includes('고양이') ? [`${row.district} 고양이 동물병원`, `/area/${areaSlug}/`] : null,
    services.includes('강아지') ? [`${row.district} 강아지 동물병원`, `/area/${areaSlug}/`] : null,
    services.includes('예방접종') ? [`${row.district} 예방접종 동물병원`, `/area/${areaSlug}/`] : null,
    services.includes('검진') ? [`${row.district} 건강검진 동물병원`, `/area/${areaSlug}/`] : null,
    [`${row.district} 24시 동물병원`, `/area/${areaSlug}/`],
    [`${row.district} 애견호텔`, `/area/${areaSlug}/`],
    [`${row.district} 애견미용`, `/area/${areaSlug}/`]
  ].filter(Boolean);
  return labels.map(([label, href]) => ({ label, href })).slice(0, 9);
}

function buildMentionedCards(generated, signals, services) {
  const labels = unique([
    ...normalizeArray(generated.frequentMentions || generated.mentionedTopics, []),
    ...signals,
    ...services.filter((service) => ['24시', '야간진료', '응급진료', '주차', '예약'].includes(service))
  ]);
  return labels
    .map((label) => cleanMentionLabel(typeof label === 'string' ? label : label.label || '후기'))
    .filter(Boolean)
    .slice(0, 8)
    .map((label) => ({
      label,
      note: describeMention(label)
    }));
}

function cleanMentionLabel(label = '') {
  return cleanVisibleText(label)
    .replace('정확한 진료', '진료 설명')
    .replace('진단 정확', '진료 설명')
    .trim();
}

function describeMention(label = '') {
  if (/친절|상담/.test(label)) return '상담 태도나 응대 방식에 대한 언급이 보입니다. 처음 방문한다면 증상과 기존 검사 기록을 정리해 가면 상담 흐름을 잡기 쉽습니다.';
  if (/설명/.test(label)) return '진료 과정이나 검사 이유를 설명받았다는 내용이 보입니다. 검사 전후로 비용, 소요 시간, 다음 확인 시점을 함께 물어보면 좋습니다.';
  if (/대기/.test(label)) return '대기시간을 언급한 후기가 있습니다. 퇴근 시간대나 주말에는 접수 마감과 예상 대기 시간을 먼저 확인하는 편이 좋습니다.';
  if (/야간|24/.test(label)) return '늦은 시간 방문과 관련된 언급이 있습니다. 야간에는 가능한 진료 범위가 달라질 수 있어 이동 전 전화 확인이 중요합니다.';
  if (/고양이|반려묘/.test(label)) return '고양이 진료 경험이 언급됩니다. 이동장, 스트레스 관리, 대기 공간 분리 여부처럼 고양이 방문에 영향을 주는 부분을 확인해보세요.';
  if (/강아지|반려견/.test(label)) return '강아지 진료 경험이 언급됩니다. 증상 발생 시점, 식욕, 배변 상태, 복용 중인 약을 정리해 가면 상담에 도움이 됩니다.';
  if (/수술|입원|중성화/.test(label)) return '수술이나 입원 관련 경험이 언급됩니다. 상담 시 사전 검사, 예상 일정, 회복 관리, 면회 가능 여부를 함께 확인하는 편이 좋습니다.';
  if (/검진|예방접종|접종/.test(label)) return '건강검진이나 예방접종 관련 언급이 있습니다. 이전 접종 기록과 최근 컨디션을 함께 준비하면 일정 상담이 수월합니다.';
  if (/주차/.test(label)) return '주차 관련 언급이 있습니다. 건물 주차장 이용 여부, 병원 앞 정차 가능 여부, 주변 공영주차장 위치를 함께 확인해보세요.';
  if (/시설|청결/.test(label)) return '시설이나 청결에 대한 언급이 있습니다. 대기실 규모, 진료실 동선, 반려동물 분리 대기 가능 여부를 참고해보세요.';
  return '후기에서 반복적으로 보이는 항목입니다. 방문 목적과 맞는지 확인해보세요.';
}

function buildVisitChecklist(row, services) {
  const checks = [
    ['예약', services.includes('예약') ? '예약제로 운영되는 시간대가 있는지, 초진도 예약이 필요한지 확인하면 대기 시간을 줄이는 데 도움이 됩니다.' : ''],
    ['주차', services.includes('주차') ? '차량 방문 후기가 보이는 곳은 병원 앞 정차, 건물 주차장, 주변 공영주차장 중 어디를 이용하는지 미리 확인하면 좋습니다.' : ''],
    ['응급', services.includes('응급진료') ? '응급 방문은 접수 가능 시간과 당일 진료 가능한 범위가 달라질 수 있어 이동 전에 증상과 도착 예정 시간을 먼저 전달하는 편이 좋습니다.' : ''],
    ['24시', services.includes('24시') ? '24시로 검색되더라도 야간에는 가능한 진료 범위가 제한될 수 있으니, 야간 담당 진료 여부와 접수 마감 시간을 함께 확인하세요.' : ''],
    ['특수동물', services.includes('특수동물') ? '거북이, 햄스터, 조류 등은 병원마다 진료 가능 범위가 다르므로 동물 종류, 나이, 증상을 구체적으로 말하고 가능 여부를 확인하세요.' : ''],
    ['예방접종', services.includes('예방접종') ? '접종은 반려동물 나이, 기존 접종 기록, 컨디션에 따라 일정이 달라질 수 있어 접종수첩이나 이전 기록을 준비하면 상담이 수월합니다.' : ''],
    ['수술/입원', services.includes('수술') || services.includes('입원') ? '수술이나 입원 상담은 당일 진행보다 사전 검사와 일정 확인이 필요한 경우가 많아 가능한 날짜와 준비사항을 먼저 확인하는 편이 좋습니다.' : ''],
    ['검진/치과', services.includes('검진') || services.includes('치과') ? '검진이나 치과 진료는 소요 시간과 금식 여부가 달라질 수 있어 방문 전 준비사항을 확인하면 좋습니다.' : '']
  ];
  if (!row.phone) checks.unshift(['전화', '현재 전화번호 확인이 필요합니다.']);
  return checks.filter(([, note]) => note).map(([label, note]) => ({ label, note }));
}

function buildArticleSections(generated, row, services, relevantSourceRefs = []) {
  const generatedSections = Array.isArray(generated.articleSections)
    ? generated.articleSections
        .map((section) => ({
          heading: cleanVisibleText(section?.heading || section?.title || ''),
          body: cleanVisibleText(section?.body || section?.text || '')
        }))
        .filter((section) => section.heading && section.body)
        .slice(0, 8)
    : [];
  if (generatedSections.length) return generatedSections;

  const name = row.name || row.displayName || '이 동물병원';
  const area = row.areaLabel || [row.city, row.district, row.dong].filter(Boolean).join(' ');
  const refs = relevantSourceRefs.slice(0, 8);
  const reviewInsights = buildFallbackReviewInsights(refs, services);
  const sourceCount = refs.length;

  if (sourceCount) {
    return [
      {
        heading: '공개 후기에서 확인되는 방문 목적',
        body: `${name}은 ${area || '해당 지역'}에서 검색되는 동물병원입니다. 공개 블로그·카페 제목과 요약을 보면 ${reviewInsights.purposes} 관련 내용이 먼저 눈에 띕니다. 단순히 병원 위치만 찾는 검색보다, 보호자들이 실제로는 어떤 진료나 상황 때문에 이 병원을 찾아봤는지를 가늠할 수 있는 단서입니다.`
      },
      {
        heading: '좋게 언급된 점',
        body: reviewInsights.positive
      },
      {
        heading: '아쉬운 점이나 확인이 필요한 부분',
        body: reviewInsights.caution
      },
      {
        heading: '방문 전 비교하면 좋은 기준',
        body: reviewInsights.compare
      }
    ];
  }

  const serviceLabels = services.length ? services.join(', ') : '일반 진료';
  return [
    {
      heading: '현재 확인 가능한 정보',
      body: `${name}은 ${area || '해당 지역'}에서 확인되는 동물병원입니다. 현재 이 병원명으로 연결되는 공개 블로그·카페 후기는 많지 않아, 페이지에서는 주소, 전화번호, 지도 위치, 진료 관련 키워드처럼 확인 가능한 정보만 우선 정리했습니다.`
    },
    {
      heading: '페이지에서 함께 보는 진료 키워드',
      body: `현재 함께 분류된 항목은 ${serviceLabels}입니다. 이 항목은 병원 선택을 위한 검색 단서이며, 실제 제공 범위나 당일 가능 여부는 병원 운영 상황에 따라 달라질 수 있습니다.`
    },
    {
      heading: '후기 자료 상태',
      body: `현재 ${name}은 공개 후기 자료가 제한적입니다. 이 경우 억지로 장단점을 만들기보다, 네이버 지도와 병원 기본정보를 통해 최근 운영 여부와 방문 목적에 맞는 진료 가능 여부를 확인하는 쪽이 더 정확합니다.`
    }
  ];
}

function buildFallbackReviewInsights(refs = [], services = []) {
  const text = refs.map((ref) => `${ref.title || ''} ${ref.summary || ''}`).join(' ');
  const purposes = [];
  if (/24시|24시간|야간|응급/.test(text) || services.includes('24시')) purposes.push('24시·야간 진료');
  if (/슬개골|탈구|수술|입원|재진료|외과/.test(text) || services.includes('수술')) purposes.push('수술·재진료');
  if (/백내장|핵경화|안과|눈|귀|피부|치과/.test(text)) purposes.push('눈·귀·피부 같은 증상 상담');
  if (/검진|건강검진|예방|접종/.test(text) || services.includes('검진')) purposes.push('검진·예방 관리');
  if (/고양이|반려묘|수컷|중성화/.test(text) || services.includes('고양이')) purposes.push('고양이 진료');
  if (/강아지|반려견|노령견/.test(text) || services.includes('강아지')) purposes.push('강아지 진료');
  const purposeText = unique(purposes).slice(0, 4).join(', ') || '진료 경험과 위치 확인';

  const positives = [];
  if (/24시|24시간|야간|응급/.test(text)) positives.push('24시간 운영이나 야간 이용 가능성을 보고 찾는 글이 확인됩니다');
  if (/내돈내산|검진 후기|재진료|받다|다녀/.test(text)) positives.push('실제 방문 후기 형식의 글이 포함되어 있어 진료 경험을 참고할 수 있습니다');
  if (/삼성중앙역|도보|위치|주소|주차|지하철/.test(text)) positives.push('위치, 접근성, 이동 방법을 함께 언급한 후기 후보가 보입니다');
  if (/여러 과|세분화|전문|센터|의료진|스탭/.test(text)) positives.push('병원 규모나 진료 체계를 설명하는 글이 확인됩니다');
  if (/슬개골|백내장|핵경화|귀|수술|재진료/.test(text)) positives.push('특정 증상이나 수술, 재진료 경험을 다룬 글이 있어 방문 목적을 비교하기 좋습니다');

  const cautions = [];
  if (/광고|파트너샵|소개|병원.*블로그|공식/.test(text)) cautions.push('일부 글은 병원 소개나 제휴·홍보 성격일 수 있어 실제 보호자 후기와 구분해서 보는 편이 좋습니다');
  if (/수술|백내장|슬개골|응급|입원/.test(text)) cautions.push('수술, 안과, 응급처럼 중요한 진료는 글만 보고 판단하기보다 현재 담당 진료와 가능 범위를 따로 확인해야 합니다');
  if (!cautions.length) cautions.push('뚜렷하게 반복되는 아쉬운 점은 많지 않지만, 공개 글의 성격이 모두 같지는 않아 원문을 함께 보는 편이 좋습니다');

  const positiveText = positives.length
    ? `후기 후보에서는 ${unique(positives).join('. ')}. 이런 단서는 보호자가 병원을 고를 때 실제로 궁금해하는 운영 방식, 접근성, 진료 목적을 파악하는 데 도움이 됩니다.`
    : '후기 후보가 많지는 않지만, 병원명과 지역을 기준으로 연결되는 공개 글이 확인됩니다. 현재 페이지에서는 과장된 평가 대신 확인 가능한 제목과 요약의 흐름만 반영했습니다.';

  const cautionText = `${unique(cautions).join('. ')}. 특히 동물병원 후기는 반려동물의 상태와 방문 시점에 따라 체감이 달라질 수 있으므로, 같은 증상이라도 실제 진료 가능 여부는 병원 안내를 기준으로 확인하는 것이 좋습니다.`;

  const compareParts = [];
  if (/24시|24시간|야간/.test(text) || services.includes('24시')) compareParts.push('야간 담당 진료가 실제로 상시 가능한지');
  if (/수술|입원|슬개골|백내장/.test(text) || services.includes('수술')) compareParts.push('수술·입원 상담 시 사전 검사와 일정 안내가 어떻게 되는지');
  if (/위치|도보|지하철|주차/.test(text) || services.includes('주차')) compareParts.push('차량 또는 대중교통 이동이 편한지');
  if (/고양이|강아지|노령/.test(text)) compareParts.push('반려동물 종류와 나이에 맞는 방문 경험이 있는지');
  const compareText = compareParts.length
    ? `${unique(compareParts).join(', ')}를 비교하면 이 병원이 현재 방문 목적에 맞는지 더 빨리 판단할 수 있습니다. 페이지 하단의 참고 링크에서 원문 제목과 출처를 함께 확인할 수 있습니다.`
    : '비슷한 지역의 다른 병원과 비교할 때는 후기 원문 수, 지도 리뷰 수, 주소 접근성, 전화 연결 여부를 함께 보는 것이 좋습니다. 페이지 하단의 참고 링크에서 원문 제목과 출처를 확인할 수 있습니다.';

  return {
    purposes: purposeText,
    positive: positiveText,
    caution: cautionText,
    compare: compareText
  };
}

function withMapReviewContext(sections, count = 0) {
  if (!count) return sections;
  return sections.map((section) => ({
    ...section,
    body: withMapReviewContextText(section.body, count)
  }));
}

function withMapReviewContextText(value = '', count = 0) {
  if (!count) return value;
  const message = `블로그·카페 후기는 많지 않지만 네이버 지도에는 리뷰 ${Number(count).toLocaleString('ko-KR')}개가 표시됩니다.`;
  return String(value || '')
    .replaceAll('[object Object]', '')
    .replaceAll('이 병원은 후기가 없습니다.', message)
    .replaceAll('이 병원은 후기가 없습니다', message)
    .replaceAll('후기가 없습니다.', message)
    .replaceAll('후기가 없습니다', message)
    .replaceAll('온라인상에 많은 후기가 없지만', '블로그·카페 후기는 많지 않지만')
    .replaceAll('아직 온라인상에 많은 후기가 없지만', '블로그·카페 후기는 많지 않지만');
}

function buildFaqItems(row, services, sourceCount, naverMapReviewCount = 0) {
  const area = [row.city, row.district].filter(Boolean).join(' ');
  const name = row.displayName || row.name;
  const has = (service) => services.includes(service);
  const reviewAnswer = naverMapReviewCount
    ? `네이버 지도에는 리뷰 ${Number(naverMapReviewCount).toLocaleString('ko-KR')}개가 표시됩니다. 블로그·카페 후기가 있는 경우 페이지 하단 참고 링크에서 원문을 열어볼 수 있습니다.`
    : sourceCount
      ? '블로그·카페 검색 결과의 제목과 요약에서 반복적으로 보이는 내용을 참고용으로 정리했습니다. 원문은 페이지 하단 참고 링크에서 확인할 수 있습니다.'
      : '현재 블로그·카페 후기는 많지 않습니다. 대신 주소, 전화번호, 네이버 지도 위치처럼 방문 전에 필요한 기본 정보를 먼저 정리했습니다.';
  return [
    {
      question: `${name} 예약이 필요한가요?`,
      answer: has('예약')
        ? '예약이나 접수 관련 언급이 있어, 초진 방문이나 주말 방문 전에는 가능한 시간대를 먼저 잡는 편이 좋습니다.'
        : '예약제 운영 여부가 뚜렷하게 확인되지는 않습니다. 다만 동물병원은 접수 마감 시간이 진료 시간보다 빠를 수 있어 첫 방문 전에는 전화 연결 후 이동하는 편이 안정적입니다.'
    },
    {
      question: `${name} 주차가 가능한가요?`,
      answer: has('주차')
        ? '주차 관련 언급이 확인됩니다. 차량으로 방문한다면 병원 앞 정차, 건물 주차장, 주변 공영주차장 중 실제 이용 가능한 동선을 함께 확인해보면 좋습니다.'
        : '주차 가능 여부는 확정 정보가 부족합니다. 차량 방문이 필요하다면 네이버 지도에서 주변 도로와 주차장을 먼저 살펴보는 것이 좋습니다.'
    },
    {
      question: `${name} 고양이도 진료하나요?`,
      answer: has('고양이')
        ? '고양이 진료나 반려묘 방문 후기가 확인됩니다. 이동장 사용, 대기 공간, 스트레스 관리처럼 고양이 방문에 영향을 주는 부분을 함께 살펴보세요.'
        : '현재 정리된 정보만으로 고양이 진료 범위를 분명히 말하기는 어렵습니다. 고양이 특화 진료가 필요하다면 증상과 나이를 알려주고 가능 여부를 확인하는 것이 좋습니다.'
    },
    {
      question: `${name} 강아지 예방접종이나 건강검진 후기가 있나요?`,
      answer: has('예방접종') || has('검진')
        ? '예방접종이나 건강검진 목적의 방문 후기가 보입니다. 접종수첩, 이전 검사 결과, 최근 컨디션을 준비하면 상담 흐름을 잡기 쉽습니다.'
        : '예방접종이나 건강검진 후기는 뚜렷하게 많지 않습니다. 기본 진료 가능 여부와 필요한 준비물은 병원 안내를 확인하는 편이 좋습니다.'
    },
    {
      question: `${area}에서 야간이나 응급 진료가 가능한가요?`,
      answer: has('24시') || has('야간진료') || has('응급진료')
        ? '야간, 24시, 응급 관련 단서가 있습니다. 다만 야간에는 가능한 검사나 처치 범위가 달라질 수 있어 증상과 도착 시간을 먼저 전달하는 편이 좋습니다.'
        : '야간이나 응급 진료 가능 여부는 현재 정보만으로 분명하지 않습니다. 응급 상황이라면 이동 전 전화 연결 여부와 접수 가능 시간을 먼저 보는 것이 중요합니다.'
    },
    {
      question: `${name} 중성화나 수술 상담 후기가 있나요?`,
      answer: has('중성화') || has('수술') || has('입원')
        ? '중성화, 수술, 입원 관련 후기가 확인됩니다. 상담 시 사전 검사, 예상 일정, 회복 관리, 비용 범위를 차례로 물어보면 비교가 쉽습니다.'
        : '수술이나 입원 관련 후기는 많지 않습니다. 해당 목적의 방문이라면 장비, 입원 가능 여부, 수술 일정, 회복 관리 방식을 별도로 확인하는 편이 좋습니다.'
    },
    {
      question: `${name} 네이버 지도 리뷰는 어디서 확인하나요?`,
      answer: reviewAnswer
    },
    {
      question: '후기 요약은 직접 이용 후기인가요?',
      answer: sourceCount
        ? '직접 방문 경험담이 아니라 공개 검색 결과와 참고 링크에서 보이는 흐름을 요약한 정보입니다. 자세한 분위기는 하단의 블로그·카페 링크와 네이버 지도 리뷰를 함께 보는 편이 좋습니다.'
        : '현재 확인 가능한 공개 후기가 많지 않아 기본정보와 지도 중심으로 안내합니다.'
    }
  ];
}

function buildServiceSection(services) {
  const labels = services.length ? services.join(', ') : '일반 동물병원';
  return `현재 분류 가능한 진료 및 방문 확인 항목은 ${labels}입니다. 다만 응급, 야간, 수술, 입원, 특수동물 진료 가능 여부는 병원별 상황과 진료진 일정에 따라 달라질 수 있어 전화 문의가 필요합니다.`;
}

function buildCheckSection(services) {
  const exotic = services.filter((service) => ['특수동물', '거북이', '햄스터', '조류'].includes(service));
  const animalQuestion = exotic.length ? `${exotic.join(', ')} 진료 가능 여부` : '해당 동물 진료 가능 여부';
  return `방문 전에는 운영시간, 예약 필요 여부, 주차, 응급 접수 가능 여부를 먼저 확인하세요. 특히 ${animalQuestion}는 동물 종류와 증상에 따라 가능 범위가 달라질 수 있으므로 구체적으로 문의하는 것이 좋습니다.`;
}

function buildCautionPoints(services, sourceCount) {
  const points = [
    '운영시간과 휴무일은 네이버 지도 또는 전화로 다시 확인하세요.',
    '후기 요약은 참고용이며 실제 진료 결과를 보장하지 않습니다.',
    '원하는 진료가 가능한지, 접수 마감 시간이 언제인지 방문 전에 확인하세요.'
  ];
  if (services.includes('특수동물')) points.push('특수동물 진료는 동물 종류와 상태를 먼저 설명하고 가능 여부를 확인하세요.');
  if (!sourceCount) points.push('확인 가능한 후기 후보가 적은 곳은 최근 사진과 영업상태를 추가로 확인하세요.');
  return points;
}

function inferServices(row, reviewSignals = [], sourceRefs = []) {
  const text = searchText({ ...row, reviewSignals, sourceRefs });
  const pairs = [
    ['24시', /24시|24시간|24\s*hour|24h/i],
    ['야간진료', /야간|밤진료|늦은\s*시간/],
    ['응급진료', /응급|응급진료|응급실/],
    ['응급수술', /응급수술/],
    ['특수동물', /특수동물|이색동물|거북|햄스터|조류|파충류|토끼/],
    ['거북이', /거북/],
    ['햄스터', /햄스터/],
    ['조류', /조류|새/],
    ['강아지', /강아지|반려견|애견/],
    ['고양이', /고양이|반려묘/],
    ['수술', /수술/],
    ['입원', /입원/],
    ['검진', /검진|건강검진/],
    ['예방접종', /예방접종|접종/],
    ['중성화', /중성화/],
    ['치과', /치과|스케일링/],
    ['주차', /주차/],
    ['예약', /예약/]
  ];
  return pairs.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function inferBusinessType(row) {
  const text = `${row.category || ''} ${row.name || ''}`;
  if (/호텔|유치원|놀이터|놀이방/.test(text)) return 'hotel';
  if (/샵|미용|용품|판매/.test(text)) return 'shop';
  return 'clinic';
}

function scoreBusiness(item) {
  let score = 0;
  score += item.sourceCount * 10;
  score += item.hasNaverMatch ? 20 : 0;
  score += item.hasGenerated ? 12 : 0;
  score += item.phone ? 8 : 0;
  score += item.lat && item.lng ? 8 : 0;
  score += item.mapx && item.mapy ? 6 : 0;
  score += item.roadAddress ? 6 : 0;
  score += item.services.includes('24시') ? 12 : 0;
  score += item.services.includes('특수동물') ? 10 : 0;
  return score;
}

function compareBusinesses(a, b) {
  return b.rankScore - a.rankScore || a.city.localeCompare(b.city, 'ko') || a.name.localeCompare(b.name, 'ko');
}

function searchText(item) {
  return [
    item.name,
    item.displayName,
    item.category,
    item.city,
    item.district,
    item.dong,
    item.roadAddress,
    item.lotAddress,
    item.openingHours,
    ...(item.services || []),
    ...(item.reviewSignals || []),
    ...(item.sourceRefs || []).flatMap((ref) => [ref.title, ref.summary])
  ].filter(Boolean).join(' ');
}

function isIncheonSeogu(item) {
  return item.businessType === 'clinic' && item.city === '인천' && ['서구', '서해구', '검단구'].includes(item.district);
}

function isIncheon(item) {
  return item.businessType === 'clinic' && item.city === '인천';
}

function isBusan(item) {
  return item.businessType === 'clinic' && item.city === '부산';
}

function isDaegu(item) {
  return item.businessType === 'clinic' && item.city && item.city.charCodeAt(0) === 45824 && item.city.charCodeAt(1) === 44396;
}

function isDaejeon(item) {
  return item.businessType === 'clinic' && item.city && item.city.charCodeAt(0) === 45824 && item.city.charCodeAt(1) === 51204;
}

function isSeoulPriority(item) {
  return item.businessType === 'clinic' && item.city === '서울' && SEOUL_PRIORITY_DISTRICTS.has(item.district);
}

function isSeoulSecondBatch(item) {
  return item.businessType === 'clinic' && item.city === '\uC11C\uC6B8' && SEOUL_SECOND_BATCH_DISTRICTS.has(item.district);
}

function isSeoulThirdBatch(item) {
  return item.businessType === 'clinic' && item.city === '\uC11C\uC6B8' && SEOUL_THIRD_BATCH_DISTRICTS.has(item.district);
}

function isSeoulFourthBatch(item) {
  return item.businessType === 'clinic' && item.city === '\uC11C\uC6B8' && SEOUL_FOURTH_BATCH_DISTRICTS.has(item.district);
}

function isSeoulFinalBatch(item) {
  return item.businessType === 'clinic' && item.city === '\uC11C\uC6B8' && SEOUL_FINAL_BATCH_DISTRICTS.has(item.district);
}

function isGyeonggi(item) {
  return item.businessType === 'clinic' && item.city === '경기';
}

function isGyeonggiPriority(item) {
  return item.businessType === 'clinic' && item.city === '경기' && [
    '수원시',
    '성남시',
    '고양시',
    '용인시',
    '화성시',
    '부천시',
    '남양주시',
    '평택시',
    '안양시',
    '김포시',
    '파주시'
  ].includes(item.district);
}

function isGyeonggiTop5(item) {
  return item.businessType === 'clinic' && item.city === '경기' && [
    '고양시',
    '수원시',
    '용인시',
    '성남시',
    '화성시'
  ].includes(item.district);
}

function isGyeonggiTop6(item) {
  return isGyeonggiTop5(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '부천시'
  );
}

function isGyeonggiTop7(item) {
  return isGyeonggiTop6(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '남양주시'
  );
}

function isGyeonggiTop8(item) {
  return isGyeonggiTop7(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '평택시'
  );
}

function isGyeonggiTop9(item) {
  return isGyeonggiTop8(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '안양시'
  );
}

function isGyeonggiTop10(item) {
  return isGyeonggiTop9(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '김포시'
  );
}

function isGyeonggiTop11(item) {
  return isGyeonggiTop10(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '파주시'
  );
}

function isGyeonggiTop12(item) {
  return isGyeonggiTop11(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '안산시'
  );
}

function isGyeonggiTop13(item) {
  return isGyeonggiTop12(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '시흥시'
  );
}

function isGyeonggiTop14(item) {
  return isGyeonggiTop13(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '하남시'
  );
}

function isGyeonggiTop15(item) {
  return isGyeonggiTop14(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '광주시'
  );
}

function isGyeonggiTop16(item) {
  return isGyeonggiTop15(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '의정부시'
  );
}

function isGyeonggiTop17(item) {
  return isGyeonggiTop16(item) || (
    item.businessType === 'clinic' &&
    item.city === '경기' &&
    item.district === '이천시'
  );
}

function isGyeonggiTop18(item) {
  return isGyeonggiTop17(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uc548\uc131\uc2dc'
  );
}

function isGyeonggiTop19(item) {
  return isGyeonggiTop18(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uc591\uc8fc\uc2dc'
  );
}

function isGyeonggiTop20(item) {
  return isGyeonggiTop19(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\ud3ec\ucc9c\uc2dc'
  );
}

function isGyeonggiTop21(item) {
  return isGyeonggiTop20(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uad11\uba85\uc2dc'
  );
}

function isGyeonggiTop22(item) {
  return isGyeonggiTop21(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uc624\uc0b0\uc2dc'
  );
}

function isGyeonggiTop23(item) {
  return isGyeonggiTop22(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uad6c\ub9ac\uc2dc'
  );
}

function isGyeonggiTop24(item) {
  return isGyeonggiTop23(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uad70\ud3ec\uc2dc'
  );
}

function isGyeonggiTop25(item) {
  return isGyeonggiTop24(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\uc5ec\uc8fc\uc2dc'
  );
}

function isGyeonggiTop26(item) {
  return isGyeonggiTop25(item) || (
    item.businessType === 'clinic' &&
    item.city === '\uacbd\uae30' &&
    item.district === '\ub3d9\ub450\ucc9c\uc2dc'
  );
}

function isCheongna(item) {
  return isIncheonSeogu(item) && /청라|경서동/.test(searchText(item));
}

function isGeomdan(item) {
  return isIncheonSeogu(item) && /검단|원당|마전|당하|아라동|불로|왕길/.test(searchText(item));
}

function isLu1(item) {
  return isIncheonSeogu(item) && /루원|가정동/.test(searchText(item));
}

function topSignals(items) {
  const counts = new Map();
  for (const item of items) {
    for (const signal of item.reviewSignals || []) {
      counts.set(signal, (counts.get(signal) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
    .slice(0, 6)
    .map(([signal]) => signal);
}

function computeReviewSignalLevel(sourceCount, signals) {
  if (sourceCount <= 0 && signals.length === 0) return 0;
  if (sourceCount >= 8 || signals.length >= 6) return 5;
  if (sourceCount >= 5 || signals.length >= 4) return 4;
  if (sourceCount >= 3 || signals.length >= 2) return 3;
  if (sourceCount >= 1) return 2;
  return 0;
}

function buildReviewCoverageLabel({ naverMapReviewCount = 0, reviewSourceCount = 0, reviewSignalCoverageWeak = false } = {}) {
  const total = Number(naverMapReviewCount || 0) + Number(reviewSourceCount || 0);
  if (reviewSignalCoverageWeak && !naverMapReviewCount) return '후기 자료 제한적';
  if (naverMapReviewCount >= 100 || reviewSourceCount >= 6 || total >= 100) return '후기 자료 풍부';
  if (naverMapReviewCount >= 20 || reviewSourceCount >= 3 || total >= 20) return '후기 일부 확인';
  if (naverMapReviewCount > 0 || reviewSourceCount > 0) return '후기 자료 제한적';
  return '공개 후기 부족';
}

function evidenceLabelForScore(score) {
  if (score >= 5) return '반복 언급 많음';
  if (score >= 3) return '일부 언급';
  if (score >= 1) return '간접 단서';
  return '정보 부족';
}

function countMatches(text = '', pattern) {
  const matches = String(text || '').match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  return matches ? matches.length : 0;
}

function uniqueByLabel(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.label || seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
}

function normalizeArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.label || item.title || item.text || item.summary || '';
      return '';
    })
    .filter(Boolean);
}

function cleanVisibleText(value = '') {
  if (Array.isArray(value)) {
    return value.map((item) => cleanVisibleText(item)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    return cleanVisibleText(
      value.text ||
      value.body ||
      value.summary ||
      value.content ||
      value.description ||
      Object.values(value).find((item) => typeof item === 'string') ||
      ''
    );
  }

  return String(value || '')
    .replace(/[★☆]/g, '')
    .replaceAll('후기 신호', '후기')
    .replaceAll('검색 신호', '검색 결과')
    .replaceAll('후기 후보', '후기')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function typePath(type) {
  return type === 'hotel' ? 'hotel' : type === 'shop' ? 'shop' : 'clinic';
}

function typeLabel(type) {
  return type === 'hotel' ? '애견호텔' : type === 'shop' ? '애견샵' : '동물병원';
}

function buildNaverMapUrl(name, address) {
  return `https://map.naver.com/p/search/${encodeURIComponent(`${address || ''} ${name || ''}`.trim())}`;
}

function isNaverMapUrl(value = '') {
  return /^https?:\/\/map\.naver\.com\//.test(String(value || ''));
}

function slugify(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[^\w\s가-힣-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
