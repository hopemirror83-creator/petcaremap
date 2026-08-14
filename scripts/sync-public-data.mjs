import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
const CODE_MAP_FILE = path.join(ROOT, 'data', 'code-maps.json');
const OUTPUT = path.join(ROOT, 'data', 'public-businesses.json');
const DIAGNOSTIC = path.join(ROOT, 'data', 'public-data-diagnostic.json');

loadDotEnv(ROOT);

const apiKey = process.env.PUBLIC_DATA_API_KEY;
const apiUrl = process.env.PUBLIC_DATA_API_URL || process.env.PUBLIC_DATA_LICENSE_API_URL;
const numRows = Number(process.env.PUBLIC_DATA_NUM_ROWS || 100);
const maxPages = Number(process.env.PUBLIC_DATA_MAX_PAGES || 1);
const targetStatusCodes = parseCsvEnv(process.env.TARGET_STATUS_CODES || '1');
const targetLocalCodes = parseCsvEnv(process.env.TARGET_LOCAL_GOV_CODES || '');
const codeMaps = await readJsonIfExists(CODE_MAP_FILE, { localGovernments: [], operationStatuses: [] });

if (!apiKey || !apiUrl) {
  await writeJson(OUTPUT, []);
  await writeJson(DIAGNOSTIC, {
    ok: false,
    message: 'PUBLIC_DATA_API_KEY 또는 PUBLIC_DATA_API_URL이 없어 샘플 데이터 모드로 건너뜁니다.'
  });
  console.log('공공데이터 API 키 또는 URL이 없어 샘플 데이터 모드로 건너뜁니다.');
  process.exit(0);
}

const diagnostics = [];
const collected = [];
const localCodes = targetLocalCodes.length ? targetLocalCodes : [''];

for (const localCode of localCodes) {
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const result = await fetchPage({ localCode, pageNo });
    diagnostics.push(result.diagnostic);

    if (!result.ok) continue;
    const rows = extractRows(result.body);
    for (const row of rows) {
      const item = normalizeAnimalHospital(row, localCode);
      if (!item.name) continue;
      if (targetStatusCodes.length && item.operationStatusCode && !targetStatusCodes.includes(String(item.operationStatusCode))) continue;
      collected.push(item);
    }
  }
}

const unique = dedupeBySourceId(collected);
await writeJson(OUTPUT, unique);
await writeJson(DIAGNOSTIC, {
  ok: unique.length > 0,
  apiUrl: redactUrl(apiUrl),
  targetLocalCodes: localCodes,
  targetStatusCodes,
  fetchedAt: new Date().toISOString(),
  itemCount: unique.length,
  diagnostics
});

console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${unique.length} animal hospitals)`);
console.log(`Wrote ${path.relative(ROOT, DIAGNOSTIC)}`);
if (!unique.length) {
  console.log('공공데이터 응답에서 동물병원 행을 확보하지 못했습니다. data/public-data-diagnostic.json을 확인하세요.');
}

async function fetchPage({ localCode, pageNo }) {
  const url = new URL(apiUrl);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(numRows));
  url.searchParams.set('type', 'json');

  if (localCode) {
    const cleanLocalCode = localCode.replace(/_ALL$/i, '');
    url.searchParams.set('localCode', cleanLocalCode);
    url.searchParams.set('opnSfTeamCode', cleanLocalCode);
    url.searchParams.set('sidoCode', cleanLocalCode);
  }

  if (targetStatusCodes.length === 1) {
    url.searchParams.set('trdStateGbn', targetStatusCodes[0]);
  }

  try {
    const response = await fetch(url);
    const text = await response.text();
    const body = parseBody(text);
    return {
      ok: response.ok && !looksLikeFailure(text, body),
      body,
      diagnostic: {
        status: response.status,
        localCode,
        pageNo,
        contentType: response.headers.get('content-type') || '',
        sample: text.slice(0, 500),
        url: redactUrl(url.toString())
      }
    };
  } catch (error) {
    return {
      ok: false,
      body: null,
      diagnostic: {
        status: 0,
        localCode,
        pageNo,
        error: error.message,
        url: redactUrl(url.toString())
      }
    };
  }
}

function normalizeAnimalHospital(row, localCode = '') {
  const name = pick(row, ['bplcNm', 'BPLCNM', '사업장명', '업소명', '상호', 'name']);
  const roadAddress = pick(row, ['rdnWhlAddr', 'RDNWHLADDR', '도로명전체주소', '도로명주소', 'roadAddress']);
  const lotAddress = pick(row, ['siteWhlAddr', 'SITEWHLADDR', '소재지전체주소', '지번주소', 'lotAddress']);
  const address = `${roadAddress} ${lotAddress}`;
  const inferred = inferLocation(address);
  const statusCode = String(pick(row, ['trdStateGbn', 'TRDSTATEGBN', '영업상태구분코드', '영업상태코드', 'operationStatusCode']) || '');
  const statusName =
    pick(row, ['trdStateNm', 'TRDSTATENM', 'dtlStateNm', 'DTLSTATENM', '영업상태명', '상세영업상태명', 'operationStatus']) ||
    codeMaps.operationStatuses?.find((status) => String(status.code) === statusCode)?.name ||
    '';
  const sourceId = pick(row, ['mgtNo', 'MGTNO', '관리번호', '인허가번호', 'permitNo']) || `${localCode}-${name}-${roadAddress || lotAddress}`;

  return {
    source: 'public-data',
    sourceId: `public-${sourceId}`,
    businessType: 'clinic',
    name,
    displayName: name,
    category: pick(row, ['opnSvcNm', 'OPNSVCNM', '개방서비스명', '업태구분명']) || '동물병원',
    city: inferred.city,
    district: inferred.district,
    dong: inferred.dong,
    roadAddress,
    lotAddress,
    phone: pick(row, ['siteTel', 'SITETEL', '소재지전화', '전화번호', 'phone']),
    lat: toNumber(pick(row, ['y', 'Y', 'lat', '위도', '좌표정보Y'])),
    lng: toNumber(pick(row, ['x', 'X', 'lng', '경도', '좌표정보X'])),
    openingHours: '',
    operationStatus: statusName,
    operationStatusCode: statusCode,
    permitNo: pick(row, ['mgtNo', 'MGTNO', '관리번호', '인허가번호']),
    permitDate: pick(row, ['apvPermYmd', 'APVPERMYMD', '인허가일자']),
    closedDate: pick(row, ['dcbYmd', 'DCBYMD', '폐업일자']),
    dataBaseDate: pick(row, ['lastModTs', 'LASTMODTS', '최종수정시점', '데이터갱신일자']),
    services: inferServicesFromHospital(row),
    reviewSignals: [],
    sourceRefs: [],
    raw: row
  };
}

function extractRows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body.flatMap(extractRows);
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.item)) return body.item;
  if (body.response) return extractRows(body.response);
  if (body.body) return extractRows(body.body);
  if (body.result) return extractRows(body.result);
  if (body.AnimalHospital) return extractRows(body.AnimalHospital);
  if (body.animal_hospitals) return extractRows(body.animal_hospitals);

  const values = Object.values(body);
  const arrays = values.filter(Array.isArray);
  if (arrays.length) return arrays.flatMap(extractRows);
  return [];
}

function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { raw: text };
    }
  }
  return { raw: text };
}

function looksLikeFailure(text, body) {
  return /Unexpected errors|SERVICE ERROR|OpenAPI_ServiceResponse|API not found|INVALID|ERROR/i.test(text) ||
    body?.cmmMsgHeader?.returnReasonCode ||
    body?.OpenAPI_ServiceResponse;
}

function pick(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return '';
}

function inferLocation(address) {
  const parts = String(address || '').split(/\s+/).filter(Boolean);
  return {
    city: normalizeCity(parts[0] || ''),
    district: parts.find((part) => /(구|군|시)$/.test(part) && !/특별시|광역시|특별자치시|특별자치도|도$/.test(part)) || '',
    dong: parts.find((part) => /(동|읍|면|리)$/.test(part)) || ''
  };
}

function normalizeCity(value) {
  const map = {
    서울특별시: '서울',
    부산광역시: '부산',
    대구광역시: '대구',
    인천광역시: '인천',
    광주광역시: '광주',
    대전광역시: '대전',
    울산광역시: '울산',
    세종특별자치시: '세종',
    경기도: '경기',
    강원특별자치도: '강원',
    충청북도: '충북',
    충청남도: '충남',
    전북특별자치도: '전북',
    전라북도: '전북',
    전라남도: '전남',
    경상북도: '경북',
    경상남도: '경남',
    제주특별자치도: '제주'
  };
  return map[value] || value;
}

function inferServicesFromHospital(row) {
  const text = Object.values(row || {}).join(' ');
  const services = ['강아지', '고양이'];
  const pairs = [
    ['24시', /24|24시|야간|응급/],
    ['야간진료', /야간/],
    ['응급진료', /응급/],
    ['수술', /수술/],
    ['입원', /입원/],
    ['검진', /검진|건강검진/],
    ['예방접종', /예방접종|접종/],
    ['중성화', /중성화/],
    ['치과', /치과|스케일링/],
    ['특수동물', /특수동물|희귀|거북|햄스터|조류|파충류/],
    ['거북이', /거북/],
    ['햄스터', /햄스터/],
    ['조류', /조류|새/]
  ];
  for (const [label, pattern] of pairs) {
    if (pattern.test(text)) services.push(label);
  }
  return [...new Set(services)];
}

function dedupeBySourceId(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.sourceId)) map.set(item.sourceId, item);
  }
  return [...map.values()];
}

function parseCsvEnv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function redactUrl(value) {
  return String(value || '').replace(/serviceKey=([^&]+)/, 'serviceKey=[REDACTED]');
}

async function readJsonIfExists(file, fallback) {
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
