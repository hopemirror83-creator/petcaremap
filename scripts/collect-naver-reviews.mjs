import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';
import { hasNaverSearchCredentials, naverSearch as searchNaver } from './naver-search-api.mjs';

const ROOT = process.cwd();
const PUBLIC_INPUT = path.join(ROOT, 'data', 'public-businesses.json');
const NAVER_INPUT = path.join(ROOT, 'data', 'naver-local-businesses.json');
const OUTPUT = path.join(ROOT, 'data', 'naver-review-sources.json');
const DIAGNOSTIC = path.join(ROOT, 'data', 'naver-review-diagnostic.json');

loadDotEnv(ROOT);

const limit = Number(process.env.NAVER_REVIEW_LIMIT || 20);
const delayMs = Number(process.env.NAVER_REVIEW_DELAY_MS || 350);
const targetCity = process.env.TARGET_CITY || '';
const targetDistrict = process.env.TARGET_DISTRICT || '';
const targetDistricts = new Set(
  (process.env.TARGET_DISTRICTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const force = process.env.FORCE_NAVER_REVIEWS === '1';
const targetSourceIds = new Set(
  (process.env.TARGET_SOURCE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const SEOUL_PRIORITY_DISTRICTS = new Set(['강남구', '송파구', '마포구', '성북구', '도봉구']);
const targetScope = process.env.TARGET_SCOPE || 'incheon-seoul-priority';

if (!hasNaverSearchCredentials()) {
  console.log('NAVER 검색 API 인증 정보가 없어 후기 후보 수집을 건너뜁니다.');
  await writeJson(OUTPUT, await readJson(OUTPUT, []));
  process.exit(0);
}

const businesses = await readJson(PUBLIC_INPUT, []);
const naverRows = await readJson(NAVER_INPUT, []);
const existing = await readJson(OUTPUT, []);
const naverMap = new Map(naverRows.map((row) => [row.sourceId, row]));
const existingMap = new Map(existing.map((row) => [row.sourceId, row]));

const targets = businesses
  .filter((row) => row.businessType === 'clinic')
  .filter((row) => targetSourceIds.size === 0 || targetSourceIds.has(row.sourceId))
  .filter((row) => targetSourceIds.size > 0 || shouldIncludeScope(row))
  .filter((row) => !targetCity || row.city === targetCity)
  .filter((row) => !targetDistrict || row.district === targetDistrict)
  .filter((row) => targetDistricts.size === 0 || targetDistricts.has(row.district))
  .filter((row) => force || !existingMap.has(row.sourceId))
  .slice(0, limit);

const diagnostics = {
  generatedAt: new Date().toISOString(),
  requested: targets.length,
  withSources: 0,
  withoutSources: 0,
  errors: []
};

const targetIds = new Set(targets.map((row) => row.sourceId));
const collected = existing.filter((row) => !targetIds.has(row.sourceId));
for (const base of targets) {
  const row = { ...base, ...(naverMap.get(base.sourceId) || {}) };
  const previous = existingMap.get(row.sourceId);
  const previousHasSources = (previous?.sourceRefs || []).length > 0 || (previous?.reviewSourceCount || 0) > 0;
  try {
    const queries = buildReviewQueries(row);
    const resultMap = new Map();
    for (const query of queries) {
      const [blogs, cafes] = await Promise.all([
        safeNaverSearch('blog', query, 10),
        safeNaverSearch('cafearticle', query, 5)
      ]);
      for (const item of [...blogs, ...cafes]) {
        const ref = toSourceRef(item, row, query);
        const key = ref.link || `${ref.title}-${ref.summary}`;
        const current = resultMap.get(key);
        if (!current || ref.matchScore > current.matchScore) resultMap.set(key, ref);
      }
      await wait(Math.max(80, Math.floor(delayMs / 3)));
    }
    const sourceRefs = [...resultMap.values()]
      .filter((item) => isStrongClinicResult(row, item))
      .filter((item) => isLocalEnough(row, item))
      .filter((item) => !hasOtherNamedClinicInTitle(row, item))
      .filter((item) => item.matchScore >= 35)
      .sort((a, b) => b.matchScore - a.matchScore)
      .filter((item) => item.title || item.summary)
      .slice(0, 8);
    const reviewSignals = extractSignals(sourceRefs);
    const hasSources = sourceRefs.length > 0;
    diagnostics[hasSources ? 'withSources' : 'withoutSources'] += 1;

    if (!hasSources && previousHasSources) {
      collected.push(previous);
      console.log(`Kept existing review sources: ${row.name} (${previous.reviewSourceCount || previous.sourceRefs.length})`);
      await wait(delayMs);
      continue;
    }

    collected.push({
      sourceId: row.sourceId,
      sourceRefs,
      reviewSignals,
      reviewSourceCount: sourceRefs.length,
      collectedAt: new Date().toISOString()
    });
    console.log(`${hasSources ? 'Review sources' : 'No review sources'}: ${row.name} (${sourceRefs.length})`);
  } catch (error) {
    diagnostics.errors.push({ sourceId: row.sourceId, name: row.name, message: error.message });
    if (previous) {
      collected.push(previous);
      console.log(`Kept existing review sources after error: ${row.name} (${error.message})`);
      await wait(delayMs);
      continue;
    }
    console.log(`Error: ${row.name} (${error.message})`);
  }
  await wait(delayMs);
}

await writeJson(OUTPUT, collected);
await writeJson(DIAGNOSTIC, diagnostics);
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${collected.length} rows)`);
console.log(`With sources ${diagnostics.withSources}/${diagnostics.requested}`);

function buildReviewQueries(row) {
  const displayName = row.displayName || row.name;
  const spacedName = spaceShortLatinName(displayName);
  const districtAlias = searchDistrict(row.district);
  const roadKeyword = extractRoadKeyword(row.roadAddress || '');
  const lotKeyword = extractLotKeyword(row.lotAddress || '');
  const baseRegions = [
    [row.city, districtAlias, row.dong].filter(Boolean).join(' '),
    [districtAlias, row.dong].filter(Boolean).join(' '),
    row.dong
  ].filter(Boolean);
  const names = unique([displayName, spacedName]);
  const queries = [];
  for (const name of names) {
    queries.push(name);
    queries.push(`${name} 후기`);
    for (const region of baseRegions) {
      queries.push(`${region} ${name}`);
      queries.push(`${region} ${name} 후기`);
    }
    if (roadKeyword) queries.push(`${roadKeyword} ${name}`);
    if (lotKeyword) queries.push(`${lotKeyword} ${name}`);
    if (row.phone) queries.push(`${name} ${row.phone}`);
  }
  return unique(queries).slice(0, 10);
}

async function safeNaverSearch(type, query, display) {
  try {
    return await searchNaver(type, query, { display, sort: 'sim' });
  } catch (error) {
    diagnostics.errors.push({ type, query, message: error.message });
    return [];
  }
}

function toSourceRef(item, row, query) {
  const ref = {
    title: stripHtml(item.title),
    summary: stripHtml(item.description).slice(0, 220),
    link: item.link || '',
    bloggerName: stripHtml(item.bloggername || item.cafename || ''),
    postDate: item.postdate || '',
    sourceType: item.bloggerlink ? 'blog' : 'cafe',
    query
  };
  ref.matchScore = scoreSourceRef(row, ref, item);
  if (isOfficialBlog(row, item)) ref.sourceType = 'official_blog';
  return ref;
}

function scoreSourceRef(row, ref, rawItem = {}) {
  const name = normalize(row.displayName || row.name);
  const spacedName = normalize(spaceShortLatinName(row.displayName || row.name));
  const shortName = normalize(String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, ''));
  const text = normalize(`${ref.title} ${ref.summary} ${ref.bloggerName}`);
  const title = normalize(ref.title);
  const dong = normalize(row.dong || '');
  const district = normalize(searchDistrict(row.district || ''));
  const road = normalize(extractRoadKeyword(row.roadAddress || ''));
  const lot = normalize(extractLotKeyword(row.lotAddress || ''));
  const phoneTail = String(row.phone || '').replace(/\D/g, '').slice(-4);
  let score = 0;

  if (name && text.includes(name)) score += 45;
  if (spacedName && text.includes(spacedName)) score += 45;
  if (shortName && shortName.length >= 2 && title.includes(shortName)) score += 22;
  if (dong && text.includes(dong)) score += 18;
  if (district && text.includes(district)) score += 8;
  if (road && text.includes(road)) score += 25;
  if (lot && text.includes(lot)) score += 15;
  if (phoneTail && normalize(`${ref.title} ${ref.summary}`).includes(phoneTail)) score += 25;
  if (isOfficialBlog(row, rawItem)) score += 35;
  if (isDirectoryListing(ref)) score -= 70;
  if (!isFocusedOnClinic(row, ref, rawItem)) score -= 90;
  if (isBroadPublicNotice(row, ref)) score -= 60;
  if (/후기|리뷰|진료|수술|검진|접종|예약|진료시간|위치|비용/.test(`${ref.title} ${ref.summary}`)) score += 8;
  if (mentionsOtherHospital(row, ref)) score -= 70;
  return score;
}

function mentionsOtherHospital(row, ref) {
  const own = normalize(row.displayName || row.name);
  const text = `${ref.title} ${ref.summary}`;
  const names = text.match(/[A-Za-z가-힣0-9\s]{1,18}(?:동물병원|동물의료센터|동물메디컬센터|외과동물병원)/g) || [];
  return names
    .map((value) => normalize(value))
    .some((value) => value && value !== own && !value.includes(own) && !own.includes(value));
}

function isOfficialBlog(row, item = {}) {
  const naverLink = String(row.homepage || row.naverMapUrl || row.naverLocal?.link || '');
  const itemBlog = String(item.bloggerlink || item.link || '');
  const bloggerName = normalize(item.bloggername || '');
  const name = normalize(row.displayName || row.name);
  const spacedName = normalize(spaceShortLatinName(row.displayName || row.name));
  const shortName = normalize(String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, ''));
  return (
    (/blog\.naver\.com/.test(naverLink) && itemBlog.startsWith(naverLink.replace(/\/$/, ''))) ||
    (/blog\.naver\.com/.test(itemBlog) &&
      Boolean(
        (name && bloggerName.includes(name)) ||
          (spacedName && bloggerName.includes(spacedName)) ||
          (shortName && shortName.length >= 2 && bloggerName.includes(shortName))
      ))
  );
}

function isDirectoryListing(ref) {
  const text = `${ref.title} ${ref.summary}`;
  return /현황|목록|리스트|업체\s*정보|전화번호부/.test(text) && !/후기|리뷰|진료|수술|검진|예방접종|예약/.test(text);
}

function isFocusedOnClinic(row, ref, item = {}) {
  if (isOfficialBlog(row, item)) return true;
  const name = normalize(row.displayName || row.name);
  const spacedName = normalize(spaceShortLatinName(row.displayName || row.name));
  const shortName = normalize(String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, ''));
  const text = normalize(`${ref.title} ${ref.summary} ${ref.bloggerName}`);
  return Boolean(
    (name && text.includes(name)) ||
      (spacedName && text.includes(spacedName)) ||
      (shortName && shortName.length >= 3 && text.includes(shortName))
  );
}

function isStrongClinicResult(row, ref) {
  if (ref.sourceType === 'official_blog') return true;
  const name = normalize(row.displayName || row.name);
  const spacedName = normalize(spaceShortLatinName(row.displayName || row.name));
  const shortName = normalize(String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, ''));
  const title = normalize(ref.title || '');
  return Boolean(
    (name && title.includes(name)) ||
      (spacedName && title.includes(spacedName)) ||
      (shortName && shortName.length >= 3 && title.includes(shortName))
  );
}

function isLocalEnough(row, ref) {
  const text = normalize(`${ref.title} ${ref.summary} ${ref.bloggerName}`);
  const city = normalize(row.city || '');
  const district = normalize(row.district || '');
  const districtAlias = normalize(searchDistrict(row.district || ''));
  const dong = normalize(row.dong || '');
  const road = normalize(extractRoadKeyword(row.roadAddress || ''));
  const lot = normalize(extractLotKeyword(row.lotAddress || ''));
  const phoneTail = String(row.phone || '').replace(/\D/g, '').slice(-4);
  const localTokens = [dong, district, districtAlias, road, lot, city].filter((value) => value && value.length >= 2);
  return Boolean(
    localTokens.some((token) => text.includes(token)) ||
      (phoneTail && normalize(`${ref.title} ${ref.summary}`).includes(phoneTail))
  );
}

function isBroadPublicNotice(row, ref) {
  const name = normalize(row.displayName || row.name);
  const spacedName = normalize(spaceShortLatinName(row.displayName || row.name));
  const shortName = normalize(String(row.displayName || row.name || '').replace(/\s*동물병원\s*$/, ''));
  const title = normalize(ref.title || '');
  const titleHasClinic = Boolean(
    (name && title.includes(name)) ||
      (spacedName && title.includes(spacedName)) ||
      (shortName && shortName.length >= 3 && title.includes(shortName))
  );
  return /광견병|예방접종\s*실시|무료접종|기간\s*확인|동물병원\s*위치/.test(ref.title || '') && !titleHasClinic;
}

function hasOtherNamedClinicInTitle(row, ref) {
  const own = normalize(row.displayName || row.name);
  const ownSpaced = normalize(spaceShortLatinName(row.displayName || row.name));
  const title = ref.title || '';
  const names = title.match(/[A-Za-z가-힣0-9\s]{1,18}(?:동물의료센터|동물메디컬센터|외과동물병원)/g) || [];
  return names
    .map((value) => normalize(value))
    .some((value) => value && value !== own && value !== ownSpaced && !value.includes(own) && !own.includes(value));
}

function extractSignals(sourceRefs) {
  const text = sourceRefs.map((item) => `${item.title} ${item.summary}`).join(' ');
  const rules = [
    ['친절한 상담', /친절|상담|응대/],
    ['설명이 자세함', /설명|자세|꼼꼼/],
    ['대기시간 언급', /대기|예약|접수/],
    ['시설 청결', /청결|깨끗|시설/],
    ['야간진료 확인 필요', /야간|24시|응급/],
    ['고양이 진료 언급', /고양이|반려묘|냥/],
    ['강아지 진료 언급', /강아지|반려견|애견/],
    ['수술/입원 언급', /수술|입원|검사|검진/],
    ['주차 확인 필요', /주차/]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldIncludeScope(row) {
  if (!targetScope || targetScope === 'all') return true;
  if (targetScope === 'incheon-seoul-priority') return row.city === '인천' || (row.city === '서울' && SEOUL_PRIORITY_DISTRICTS.has(row.district));
  if (targetScope === 'incheon') return row.city === '인천';
  if (targetScope === 'incheon-seogu') {
    return row.city === '인천' && ['서구', '서해구', '검단구'].includes(row.district);
  }
  return true;
}

function searchDistrict(value = '') {
  if (value === '서해구') return '서구';
  return value;
}

function spaceShortLatinName(value = '') {
  return String(value).replace(/^([A-Za-z])동물병원$/, '$1 동물병원');
}

function extractRoadKeyword(address = '') {
  return String(address).match(/[가-힣0-9]+(?:로|길)\s*\d+/)?.[0] || '';
}

function extractLotKeyword(address = '') {
  return String(address).split(/\s+/).find((part) => /동$/.test(part)) || '';
}

function normalize(value = '') {
  return stripHtml(value).replace(/\s+/g, '').toLowerCase();
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

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
