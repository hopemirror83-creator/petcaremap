import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';
import { hasNaverSearchCredentials, naverSearch as searchNaver } from './naver-search-api.mjs';

const ROOT = process.cwd();
const INPUT = path.join(ROOT, 'data', 'public-businesses.json');
const OUTPUT = path.join(ROOT, 'data', 'naver-local-businesses.json');
const DIAGNOSTIC = path.join(ROOT, 'data', 'naver-local-diagnostic.json');

loadDotEnv(ROOT);

const limit = Number(process.env.NAVER_LOCAL_LIMIT || 20);
const delayMs = Number(process.env.NAVER_LOCAL_DELAY_MS || 350);
const targetCity = process.env.TARGET_CITY || '';
const targetDistrict = process.env.TARGET_DISTRICT || '';
const targetDistricts = new Set(
  (process.env.TARGET_DISTRICTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const targetSourceIds = new Set(
  (process.env.TARGET_SOURCE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const force = process.env.FORCE_NAVER_LOCAL === '1';

if (!hasNaverSearchCredentials()) {
  console.log('NAVER 검색 API 인증 정보가 없어 네이버 장소 보강을 건너뜁니다.');
  await writeJson(OUTPUT, await readJson(OUTPUT, []));
  process.exit(0);
}

const businesses = await readJson(INPUT, []);
const existing = await readJson(OUTPUT, []);
const existingMap = new Map(existing.map((row) => [row.sourceId, row]));

const targets = businesses
  .filter((row) => row.businessType === 'clinic')
  .filter((row) => targetSourceIds.size === 0 || targetSourceIds.has(row.sourceId))
  .filter((row) => !targetCity || row.city === targetCity)
  .filter((row) => !targetDistrict || row.district === targetDistrict)
  .filter((row) => targetDistricts.size === 0 || targetDistricts.has(row.district))
  .filter((row) => force || !existingMap.has(row.sourceId))
  .slice(0, limit);

const diagnostics = {
  generatedAt: new Date().toISOString(),
  requested: targets.length,
  matched: 0,
  unmatched: 0,
  errors: []
};

const enrichedMap = new Map(existing.map((row) => [row.sourceId, row]));
for (const row of targets) {
  const previous = enrichedMap.get(row.sourceId);
  const previousMatched = previous && previous.naverMatchStatus !== 'needs_review';
  try {
    const query = buildQuery(row);
    const items = await naverSearch(query, 5);
    const best = pickBestMatch(row, items);
    if (!best) {
      diagnostics.unmatched += 1;
      if (previousMatched) {
        console.log(`Kept existing local match: ${row.name}`);
        await wait(delayMs);
        continue;
      }
      enrichedMap.set(row.sourceId, toNeedsReviewRow(row, items.length, 'no_local_match'));
      console.log(`No local match: ${row.name}`);
      await wait(delayMs);
      continue;
    }

    diagnostics.matched += 1;
    enrichedMap.set(row.sourceId, toNaverRow(row, best, items.length));
    console.log(`Matched: ${row.name} -> ${stripHtml(best.title)}`);
  } catch (error) {
    diagnostics.errors.push({ sourceId: row.sourceId, name: row.name, message: error.message });
    if (previous) {
      console.log(`Kept existing local row after error: ${row.name} (${error.message})`);
      await wait(delayMs);
      continue;
    }
    enrichedMap.set(row.sourceId, toNeedsReviewRow(row, 0, error.message));
    console.log(`Error: ${row.name} (${error.message})`);
  }
  await wait(delayMs);
}

const enriched = [...enrichedMap.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
await writeJson(OUTPUT, enriched);
await writeJson(DIAGNOSTIC, diagnostics);
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${enriched.length} rows)`);
console.log(`Matched ${diagnostics.matched}/${diagnostics.requested}`);

function buildQuery(row) {
  return [row.city, row.district, row.name, '\uB3D9\uBB3C\uBCD1\uC6D0'].filter(Boolean).join(' ');
}

async function naverSearch(query, display) {
  return searchNaver('local', query, { display, sort: 'random' });
}

function pickBestMatch(row, items) {
  const normalizedName = normalize(row.name);
  const district = normalize(row.district);
  const city = normalize(row.city);
  const candidates = items
    .map((item) => ({ item, score: scoreMatch(row, item, normalizedName, district, city) }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 35 ? candidates[0].item : null;
}

function scoreMatch(row, item, normalizedName, district, city) {
  const title = normalize(stripHtml(item.title));
  const address = normalize(`${item.roadAddress || ''} ${item.address || ''}`);
  const category = normalize(item.category || '');
  const looseName = normalizeNameLoose(row.name);
  const looseTitle = normalizeNameLoose(stripHtml(item.title));
  let score = 0;
  if (title.includes(normalizedName) || normalizedName.includes(title)) score += 40;
  if (looseTitle && looseName && (looseTitle.includes(looseName) || looseName.includes(looseTitle))) score += 35;
  if (title.replace(/\\uB3D9\\uBB3C\\uBCD1\\uC6D0$/, '') && normalizedName.includes(title.replace(/\\uB3D9\\uBB3C\\uBCD1\\uC6D0$/, ''))) score += 20;
  if (district && address.includes(district)) score += 20;
  if (city && address.includes(city)) score += 10;
  if (category.includes('\uB3D9\uBB3C\uBCD1\uC6D0') || title.includes('\uB3D9\uBB3C\uBCD1\uC6D0')) score += 15;
  if (row.phone && normalize(item.telephone || '').endsWith(normalize(row.phone).slice(-4))) score += 10;
  return score;
}

function toNaverRow(row, item, candidateCount) {
  const displayName = stripHtml(item.title);
  const roadAddress = item.roadAddress || row.roadAddress;
  const lotAddress = item.address || row.lotAddress;
  const mapx = Number(item.mapx) || row.mapx || null;
  const mapy = Number(item.mapy) || row.mapy || null;
  const category = stripHtml(item.category || row.category || '\uB3D9\uBB3C\uBCD1\uC6D0');
  const naverMapUrl = item.link || `https://map.naver.com/p/search/${encodeURIComponent(`${roadAddress || lotAddress || ''} ${displayName}`.trim())}`;
  const collectedAt = new Date().toISOString();
  const placeId = extractPlaceId(item.link);

  return {
    source: row.source,
    sourceId: row.sourceId,
    naverMatchStatus: 'matched',
    matchedAt: collectedAt,
    placeId,
    displayName,
    category,
    roadAddress,
    lotAddress,
    phone: item.telephone || row.phone || '',
    mapx,
    mapy,
    naverMapUrl,
    homepage: item.link || '',
    openingHours: row.openingHours || '',
    reviewCount: null,
    blogReviewCount: null,
    needsPlaceDetail: true,
    naverLocal: {
      title: displayName,
      category,
      link: item.link || '',
      placeId,
      candidateCount,
      collectedAt
    }
  };
}

function toNeedsReviewRow(row, candidateCount, reason) {
  return {
    source: row.source,
    sourceId: row.sourceId,
    naverMatchStatus: 'needs_review',
    matchFailureReason: reason,
    displayName: row.displayName || row.name,
    category: row.category,
    roadAddress: row.roadAddress,
    lotAddress: row.lotAddress,
    phone: row.phone || '',
    mapx: row.mapx || null,
    mapy: row.mapy || null,
    naverMapUrl: '',
    candidateCount,
    needsPlaceDetail: true,
    naverLocal: null,
    collectedAt: new Date().toISOString()
  };
}

function extractPlaceId(link = '') {
  const value = String(link || '');
  const match = value.match(/place\/(\d+)/) || value.match(/[?&]id=(\d+)/);
  return match?.[1] || '';
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalize(value = '') {
  return stripHtml(value).replace(/\s+/g, '').toLowerCase();
}

function normalizeNameLoose(value = '') {
  return normalize(value)
    .replace(/24??24?쒓컙/g, '')
    .replace(/\\uB3D9\\uBB3C\\uBCD1\\uC6D0$/g, '');
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
