import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const INPUT = process.env.CSV_SOURCE_PATH || path.join(ROOT, 'data', 'raw-animal-hospitals.csv');
const PUBLIC_OUTPUT = path.join(ROOT, 'data', 'public-businesses.json');
const SUMMARY_OUTPUT = path.join(ROOT, 'data', 'csv-import-summary.json');
const D1_SQL_OUTPUT = path.join(ROOT, 'data', 'd1-public-businesses.sql');

const text = await readCsvText(INPUT);
const rows = parseCsv(text);
const headers = rows.shift() || [];
const records = rows
  .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])))
  .filter(isActiveClinic)
  .map(normalizeRow)
  .filter((row) => row.name && (row.roadAddress || row.lotAddress));

await mkdir(path.dirname(PUBLIC_OUTPUT), { recursive: true });
await writeFile(PUBLIC_OUTPUT, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
await writeFile(SUMMARY_OUTPUT, `${JSON.stringify(buildSummary(records, rows.length), null, 2)}\n`, 'utf8');
await writeFile(D1_SQL_OUTPUT, buildD1Sql(records), 'utf8');

console.log(`CSV rows: ${rows.length}`);
console.log(`Active animal hospitals: ${records.length}`);
console.log(`Wrote ${path.relative(ROOT, PUBLIC_OUTPUT)}`);
console.log(`Wrote ${path.relative(ROOT, D1_SQL_OUTPUT)}`);

async function readCsvText(file) {
  const buffer = await readFile(file);
  const preferredEncoding = process.env.CSV_ENCODING || 'euc-kr';
  if (preferredEncoding.toLowerCase() !== 'auto') {
    return stripBom(new TextDecoder(preferredEncoding).decode(buffer));
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if ((utf8.match(/\uFFFD/g) || []).length < 5) return stripBom(utf8);
  return stripBom(new TextDecoder('euc-kr').decode(buffer));
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((item) => item.some(Boolean));
}

function isActiveClinic(row) {
  const statusCode = clean(row['영업상태코드']);
  const statusName = `${row['영업상태명'] || ''} ${row['상세영업상태명'] || ''}`;
  return statusCode === '01' || /영업\/정상|정상/.test(statusName);
}

function normalizeRow(row) {
  const roadAddress = clean(row['도로명주소']);
  const lotAddress = clean(row['지번주소']);
  const parsed = parseAddress(roadAddress || lotAddress);
  const name = clean(row['사업장명']);
  const mapx = toNumber(row['좌표정보(X)']);
  const mapy = toNumber(row['좌표정보(Y)']);
  const services = inferServices(`${name} ${roadAddress} ${lotAddress}`);
  const sourceId = clean(row['관리번호']) || slugSource(`${clean(row['개방자치단체코드'])}-${name}-${roadAddress || lotAddress}`);

  return {
    source: 'public-csv',
    sourceId,
    businessType: 'clinic',
    name,
    displayName: name,
    category: '동물병원',
    city: parsed.city,
    district: parsed.district,
    dong: parsed.dong,
    roadAddress,
    lotAddress,
    phone: normalizePhone(row['전화번호']),
    lat: null,
    lng: null,
    mapx,
    mapy,
    openingHours: '',
    operationStatus: [clean(row['영업상태명']), clean(row['상세영업상태명'])].filter(Boolean).join(' / '),
    permitNo: sourceId,
    permitDate: normalizeDate(row['인허가일자']),
    closedDate: normalizeDate(row['폐업일자']),
    dataBaseDate: clean(row['데이터갱신시점']) || clean(row['최종수정시점']),
    services,
    reviewSignals: [],
    sourceRefs: [],
    rawJson: row
  };
}

function parseAddress(address) {
  const cleaned = clean(address);
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const city = normalizeCity(parts[0] || '');
  let district = parts[1] || '';
  if (city === '세종' && !/[구군시]$/.test(district)) district = '세종시';
  const dong = extractDong(cleaned, parts);
  return { city, district, dong };
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
    ['강원도', '강원'],
    ['강원특별자치도', '강원'],
    ['충청북도', '충북'],
    ['충청남도', '충남'],
    ['전라북도', '전북'],
    ['전북특별자치도', '전북'],
    ['전라남도', '전남'],
    ['전남광주통합특별시', '전남'],
    ['경상북도', '경북'],
    ['경상남도', '경남'],
    ['제주특별자치도', '제주']
  ]);
  return map.get(value) || value;
}

function extractDong(address, parts) {
  const paren = address.match(/\(([^),\s]+)/);
  if (paren) return paren[1];
  return parts.find((part, index) => index > 1 && /[읍면동가리]$/.test(part)) || '';
}

function inferServices(text) {
  const pairs = [
    ['24시', /24|24시|24시간|야간|응급/],
    ['야간진료', /야간/],
    ['응급진료', /응급/],
    ['특수동물', /특수동물|이색|거북|햄스터|조류|파충류|토끼/],
    ['거북이', /거북/],
    ['햄스터', /햄스터/],
    ['조류', /조류|새/],
    ['강아지', /강아지|반려견|애견/],
    ['고양이', /고양이|반려묘|고양/]
  ];
  return pairs.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function buildSummary(records, sourceRows) {
  const byCity = countBy(records, (row) => row.city || '미분류');
  const byStatus = countBy(records, (row) => row.operationStatus || '미분류');
  return {
    source: path.relative(ROOT, INPUT),
    sourceRows,
    activeClinics: records.length,
    generatedAt: new Date().toISOString(),
    byCity,
    byStatus
  };
}

function countBy(rows, getter) {
  return Object.fromEntries(
    [...rows.reduce((map, row) => {
      const key = getter(row);
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))
  );
}

function buildD1Sql(records) {
  const columns = [
    'source',
    'source_id',
    'business_type',
    'name',
    'display_name',
    'category',
    'city',
    'district',
    'dong',
    'road_address',
    'lot_address',
    'phone',
    'lat',
    'lng',
    'mapx',
    'mapy',
    'opening_hours',
    'operation_status',
    'permit_no',
    'permit_date',
    'closed_date',
    'data_base_date',
    'raw_json',
    'updated_at'
  ];
  const lines = ["DELETE FROM businesses WHERE source = 'public-csv';"];
  for (const row of records) {
    const values = [
      row.source,
      row.sourceId,
      row.businessType,
      row.name,
      row.displayName,
      row.category,
      row.city,
      row.district,
      row.dong,
      row.roadAddress,
      row.lotAddress,
      row.phone,
      row.lat,
      row.lng,
      row.mapx,
      row.mapy,
      row.openingHours,
      row.operationStatus,
      row.permitNo,
      row.permitDate,
      row.closedDate,
      row.dataBaseDate,
      JSON.stringify(row.rawJson),
      new Date().toISOString()
    ].map(sqlValue);
    lines.push(`INSERT INTO businesses (${columns.join(', ')}) VALUES (${values.join(', ')});`);
  }
  lines.push('');
  return lines.join('\n');
}

function sqlValue(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizePhone(value) {
  const phone = clean(value);
  if (!phone) return '';
  return phone.replace(/[^\d-]/g, '');
}

function normalizeDate(value) {
  const date = clean(value);
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '';
}

function toNumber(value) {
  const number = Number(clean(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clean(value) {
  return String(value || '').trim();
}

function slugSource(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[^\w가-힣-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}
