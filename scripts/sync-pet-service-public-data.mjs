import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');

loadDotEnv(ROOT);

const apiKey = process.env.PUBLIC_DATA_API_KEY;
const numRows = Number(process.env.PET_SERVICE_PUBLIC_DATA_NUM_ROWS || process.env.PUBLIC_DATA_NUM_ROWS || 100);
const maxPages = Number(process.env.PET_SERVICE_PUBLIC_DATA_MAX_PAGES || 1);
const activeStatusCode = process.env.PET_SERVICE_STATUS_CODE || '01';
const targetLocalCodes = parseCsvEnv(process.env.PET_SERVICE_TARGET_LOCAL_GOV_CODES || process.env.TARGET_LOCAL_GOV_CODES || '');

const SOURCES = [
  {
    key: 'grooming',
    businessType: 'grooming',
    category: '애견미용',
    defaultServices: ['애견미용'],
    url: process.env.PUBLIC_DATA_GROOMING_API_URL || 'https://apis.data.go.kr/1741000/pet_grooming/info',
    output: path.join(DATA_DIR, 'public-grooming-businesses.json')
  },
  {
    key: 'boarding',
    businessType: 'boarding',
    category: '애견호텔',
    defaultServices: ['애견호텔', '위탁관리'],
    url: process.env.PUBLIC_DATA_BOARDING_API_URL || 'https://apis.data.go.kr/1741000/animal_boarding/info',
    output: path.join(DATA_DIR, 'public-boarding-businesses.json')
  }
];

if (!apiKey) {
  console.log('PUBLIC_DATA_API_KEY is missing. Pet service sync skipped.');
  process.exit(0);
}

await mkdir(DATA_DIR, { recursive: true });

const diagnostics = [];
for (const source of SOURCES) {
  const collected = [];
  const localCodes = targetLocalCodes.length ? targetLocalCodes : [''];

  for (const localCode of localCodes) {
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const result = await fetchPage(source, { localCode, pageNo });
      diagnostics.push(result.diagnostic);
      if (!result.ok) continue;

      for (const row of extractRows(result.body)) {
        const item = normalizePetService(row, source);
        if (!item.name) continue;
        if (activeStatusCode && item.operationStatusCode !== activeStatusCode) continue;
        collected.push(item);
      }
    }
  }

  const unique = dedupeBySourceId(collected);
  await writeJson(source.output, unique);
  console.log(`Wrote ${path.relative(ROOT, source.output)} (${unique.length} ${source.businessType} records)`);
}

await writeJson(path.join(DATA_DIR, 'pet-service-public-data-diagnostic.json'), {
  ok: diagnostics.some((item) => item.ok),
  fetchedAt: new Date().toISOString(),
  targetLocalCodes,
  activeStatusCode,
  diagnostics
});

async function fetchPage(source, { localCode, pageNo }) {
  const url = new URL(source.url);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(numRows));
  url.searchParams.set('returnType', 'json');

  if (activeStatusCode) {
    url.searchParams.set('cond[SALS_STTS_CD::EQ]', activeStatusCode);
  }
  const cleanLocalCode = localCode.replace(/_ALL$/i, '');
  if (cleanLocalCode) {
    url.searchParams.set('cond[OPN_ATMY_GRP_CD::EQ]', cleanLocalCode);
  }

  try {
    const response = await fetch(url);
    const text = await response.text();
    const body = parseBody(text);
    const ok = response.ok && !looksLikeFailure(text, body);
    return {
      ok,
      body,
      diagnostic: {
        ok,
        source: source.key,
        status: response.status,
        localCode,
        pageNo,
        itemCount: extractRows(body).length,
        totalCount: body?.response?.body?.totalCount ?? null,
        sample: text.slice(0, 300),
        url: redactUrl(url.toString())
      }
    };
  } catch (error) {
    return {
      ok: false,
      body: null,
      diagnostic: {
        ok: false,
        source: source.key,
        status: 0,
        localCode,
        pageNo,
        error: error.message,
        url: redactUrl(url.toString())
      }
    };
  }
}

function normalizePetService(row, source) {
  const roadAddress = pick(row, ['ROAD_NM_ADDR', 'roadAddress']);
  const lotAddress = pick(row, ['LOTNO_ADDR', 'lotAddress']);
  const parsed = parseAddress(roadAddress || lotAddress);
  const name = pick(row, ['BPLC_NM', 'name']);
  const services = inferServices(`${name} ${roadAddress} ${lotAddress}`, source);
  const sourceId = pick(row, ['MNG_NO', 'permitNo']) || `${source.key}-${name}-${roadAddress || lotAddress}`;

  return {
    source: 'public-data',
    sourceId: `public-${source.key}-${sourceId}`,
    businessType: source.businessType,
    name,
    displayName: name,
    category: source.category,
    city: parsed.city,
    district: parsed.district,
    dong: parsed.dong,
    roadAddress,
    lotAddress,
    phone: normalizePhone(pick(row, ['TELNO', 'phone'])),
    lat: null,
    lng: null,
    mapx: toNumber(pick(row, ['CRD_INFO_X', 'x'])),
    mapy: toNumber(pick(row, ['CRD_INFO_Y', 'y'])),
    openingHours: '',
    operationStatus: [pick(row, ['SALS_STTS_NM']), pick(row, ['DTL_SALS_STTS_NM'])].filter(Boolean).join(' / '),
    operationStatusCode: pick(row, ['SALS_STTS_CD']),
    detailStatusCode: pick(row, ['DTL_SALS_STTS_CD']),
    permitNo: sourceId,
    permitDate: normalizeDate(pick(row, ['LCPMT_YMD'])),
    closedDate: normalizeDate(pick(row, ['CLSBIZ_YMD'])),
    dataBaseDate: pick(row, ['DAT_UPDT_PNT', 'LAST_MDFCN_PNT']),
    services,
    reviewSignals: [],
    sourceRefs: [],
    raw: row
  };
}

function inferServices(text, source) {
  const value = String(text || '');
  const services = new Set(source.defaultServices);
  if (/미용|그루밍|목욕|스파|발톱|위생/.test(value)) services.add('애견미용');
  if (/호텔|위탁|돌봄|케어|보호/.test(value)) services.add('애견호텔');
  if (/유치원|놀이방|데이케어/.test(value)) services.add('유치원');
  if (/훈련|교육|트레이닝/.test(value)) services.add('훈련');
  if (/용품|샵|펫샵|간식|사료/.test(value)) services.add('애견용품');
  return [...services];
}

function parseAddress(address) {
  const text = String(address || '');
  const parts = text.split(/\s+/).filter(Boolean);
  const parenDong = text.match(/\(([^),\s]+(?:동|읍|면|리))/)?.[1] || '';
  return {
    city: normalizeCity(parts[0] || ''),
    district: parts.find((part) => /(?:구|군|시)$/.test(part) && !/(광역시|특별시|특례시|자치시)$/.test(part)) || '',
    dong: parenDong || parts.find((part) => /(?:동|읍|면|리)$/.test(part)) || ''
  };
}

function normalizeCity(value) {
  const map = new Map([
    ['서울특별시', '서울'],
    ['부산광역시', '부산'],
    ['대구광역시', '대구'],
    ['인천광역시', '인천'],
    ['광주광역시', '광주'],
    ['대전광역시', '대전'],
    ['울산광역시', '울산'],
    ['세종특별자치시', '세종'],
    ['경기도', '경기'],
    ['강원특별자치도', '강원'],
    ['강원도', '강원'],
    ['충청북도', '충북'],
    ['충청남도', '충남'],
    ['전북특별자치도', '전북'],
    ['전라북도', '전북'],
    ['전라남도', '전남'],
    ['경상북도', '경북'],
    ['경상남도', '경남'],
    ['제주특별자치도', '제주']
  ]);
  return map.get(value) || value;
}

function extractRows(body) {
  const item = body?.response?.body?.items?.item;
  if (Array.isArray(item)) return item;
  if (item && typeof item === 'object') return [item];
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: text };
  }
}

function looksLikeFailure(text, body) {
  const resultCode = body?.response?.header?.resultCode;
  return /OpenAPI_ServiceResponse|NO_OPENAPI_SERVICE_ERROR|SERVICE ERROR|API not found|INVALID|ERROR/i.test(text) ||
    (resultCode && resultCode !== '0');
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
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

function dedupeBySourceId(items) {
  return [...new Map(items.map((item) => [item.sourceId, item])).values()];
}

function parseCsvEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function redactUrl(value) {
  return String(value).replace(/serviceKey=[^&]+/i, 'serviceKey=REDACTED');
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
