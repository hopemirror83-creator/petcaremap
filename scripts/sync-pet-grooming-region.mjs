import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
const OUTPUT_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');

loadDotEnv(ROOT);

const apiKey = process.env.PUBLIC_DATA_API_KEY;
const targetCode = process.argv[2] || process.env.PET_GROOMING_TARGET_LOCAL_GOV_CODE;
const targetLabel = process.argv[3] || process.env.PET_GROOMING_TARGET_LABEL || '';
const numRows = Number(process.env.PET_GROOMING_REGION_NUM_ROWS || '300');

if (!apiKey) throw new Error('PUBLIC_DATA_API_KEY is required.');
if (!targetCode) throw new Error('Target local government code is required.');

const endpoint = process.env.PUBLIC_DATA_GROOMING_API_URL || 'https://apis.data.go.kr/1741000/pet_grooming/info';
const existingRows = await readJson(OUTPUT_FILE, []);
const fetchedRows = await fetchRows();
const normalizedRows = fetchedRows.map(normalizeRow).filter((row) => row.name);

const byId = new Map(existingRows.map((row) => [row.sourceId, row]));
for (const row of normalizedRows) {
  byId.set(row.sourceId, row);
}

const merged = [...byId.values()].sort((a, b) =>
  [a.city, a.district, a.dong, a.name].join(' ').localeCompare([b.city, b.district, b.dong, b.name].join(' '), 'ko')
);

await writeFile(OUTPUT_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

console.log(`Fetched ${normalizedRows.length} grooming rows for ${targetLabel || targetCode}.`);
console.log(`Merged grooming rows: ${merged.length}.`);

async function fetchRows() {
  const rows = [];
  for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('serviceKey', apiKey);
    url.searchParams.set('pageNo', String(pageNo));
    url.searchParams.set('numOfRows', String(numRows));
    url.searchParams.set('returnType', 'json');
    url.searchParams.set('cond[SALS_STTS_CD::EQ]', '01');
    url.searchParams.set('cond[OPN_ATMY_GRP_CD::EQ]', targetCode);

    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) throw new Error(`Public data failed ${response.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    const totalCount = Number(json?.response?.body?.totalCount || 0);
    const item = json?.response?.body?.items?.item || [];
    const pageRows = Array.isArray(item) ? item : [item].filter(Boolean);
    rows.push(...pageRows);
    if (pageNo * numRows >= totalCount || pageRows.length === 0) break;
  }
  return rows;
}

function normalizeRow(row) {
  const roadAddress = pick(row, 'ROAD_NM_ADDR');
  const lotAddress = pick(row, 'LOTNO_ADDR');
  const parsed = parseAddress(roadAddress || lotAddress);
  const name = pick(row, 'BPLC_NM');
  const permitNo = pick(row, 'MNG_NO') || `${targetCode}-${name}-${roadAddress || lotAddress}`;

  return {
    source: 'public-data',
    sourceId: `public-grooming-${permitNo}`,
    businessType: 'grooming',
    name,
    displayName: name,
    category: '애견미용',
    city: parsed.city,
    district: parsed.district,
    dong: parsed.dong,
    roadAddress,
    lotAddress,
    phone: normalizePhone(pick(row, 'TELNO')),
    lat: null,
    lng: null,
    mapx: toNumber(pick(row, 'CRD_INFO_X')),
    mapy: toNumber(pick(row, 'CRD_INFO_Y')),
    openingHours: '',
    operationStatus: [pick(row, 'SALS_STTS_NM'), pick(row, 'DTL_SALS_STTS_NM')].filter(Boolean).join(' / '),
    operationStatusCode: pick(row, 'SALS_STTS_CD'),
    detailStatusCode: pick(row, 'DTL_SALS_STTS_CD'),
    permitNo,
    permitDate: normalizeDate(pick(row, 'LCPMT_YMD')),
    closedDate: normalizeDate(pick(row, 'CLSBIZ_YMD')),
    dataBaseDate: pick(row, 'DAT_UPDT_PNT') || pick(row, 'LAST_MDFCN_PNT'),
    services: ['애견미용'],
    reviewSignals: [],
    sourceRefs: [],
    raw: row
  };
}

function parseAddress(address) {
  const text = String(address || '');
  const parts = text.split(/\s+/).filter(Boolean);
  const dongFromParen = text.match(/\(([^),\s]+(?:동|읍|면|리))/)?.[1] || '';
  return {
    city: normalizeCity(parts[0] || ''),
    district: parts.find((part) => /(?:구|군|시)$/.test(part) && !/(광역시|특별시|특별자치시|특별자치도)$/.test(part)) || '',
    dong: dongFromParen || parts.find((part) => /(?:동|읍|면|리)$/.test(part)) || ''
  };
}

function normalizeCity(value) {
  const map = new Map([
    ['인천광역시', '인천'],
    ['서울특별시', '서울'],
    ['부산광역시', '부산'],
    ['대구광역시', '대구'],
    ['대전광역시', '대전'],
    ['광주광역시', '광주'],
    ['울산광역시', '울산'],
    ['세종특별자치시', '세종'],
    ['경기도', '경기']
  ]);
  return map.get(value) || value;
}

function pick(row, key) {
  const value = row?.[key];
  return value == null ? '' : String(value).trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d-]/g, '').trim();
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return text;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
