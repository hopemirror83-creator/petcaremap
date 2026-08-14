import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import proj4 from 'proj4';

const ROOT = process.cwd();
const GROOMING_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');
const BOARDING_FILE = path.join(ROOT, 'data', 'public-boarding-businesses.json');
const MANUAL_FILE = path.join(ROOT, 'data', 'manual-pet-service-businesses.json');
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');
const OUTPUT_FILE = path.join(ROOT, 'src', 'data', 'petServiceData.ts');
const PUBLIC_COORDINATE_CRS = 'EPSG:5174';
const CP1252_REVERSE = new Map(
  Object.entries({
    0x80: '\u20ac',
    0x82: '\u201a',
    0x83: '\u0192',
    0x84: '\u201e',
    0x85: '\u2026',
    0x86: '\u2020',
    0x87: '\u2021',
    0x88: '\u02c6',
    0x89: '\u2030',
    0x8a: '\u0160',
    0x8b: '\u2039',
    0x8c: '\u0152',
    0x8e: '\u017d',
    0x91: '\u2018',
    0x92: '\u2019',
    0x93: '\u201c',
    0x94: '\u201d',
    0x95: '\u2022',
    0x96: '\u2013',
    0x97: '\u2014',
    0x98: '\u02dc',
    0x99: '\u2122',
    0x9a: '\u0161',
    0x9b: '\u203a',
    0x9c: '\u0153',
    0x9e: '\u017e',
    0x9f: '\u0178'
  }).map(([byte, char]) => [char, Number(byte)])
);

proj4.defs(
  PUBLIC_COORDINATE_CRS,
  '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-146.43,507.89,681.46'
);

const configuredDistricts = process.env.PET_SERVICE_SITE_DISTRICTS || process.env.PET_SERVICE_SITE_DISTRICT || '';
const TARGET_DISTRICTS = configuredDistricts
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const groomingRows = repairMojibakeDeep(await readJson(GROOMING_FILE, []));
const boardingRows = repairMojibakeDeep(await readJson(BOARDING_FILE, []));
const manualRows = repairMojibakeDeep(await readJson(MANUAL_FILE, []));
const enrichmentRows = repairMojibakeDeep(await readJson(ENRICHMENT_FILE, []));
const enrichmentMap = new Map(enrichmentRows.map((row) => [row.sourceId, row]));

const items = [
  ...groomingRows.map((row) => normalize(row, 'grooming')),
  ...boardingRows.map((row) => normalize(row, 'boarding')),
  ...manualRows.map((row) => normalize(row, row.businessType || row.kind || 'grooming'))
]
  .filter((item) => TARGET_DISTRICTS.length === 0 || TARGET_DISTRICTS.includes(item.district))
  .map((item) => ({ ...item, ...(enrichmentMap.get(item.sourceId) || {}) }))
  .map(sanitizeAddressDisplay)
  .sort((a, b) => a.dong.localeCompare(b.dong, 'ko') || a.name.localeCompare(b.name, 'ko'));

const groups = buildGroups(items);

await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await writeFile(
  OUTPUT_FILE,
  [
    `export const petServiceItems = JSON.parse(${JSON.stringify(JSON.stringify(items))}) as any[];`,
    `export const petServiceGroups = JSON.parse(${JSON.stringify(JSON.stringify(groups))}) as any[];`,
    ''
  ].join('\n'),
  'utf8'
);

console.log(`Pet service pages: ${items.length}`);
console.log(`Pet service groups: ${groups.length}`);
console.log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)}`);

function normalize(row, kind) {
  const typePath = kind === 'boarding' ? 'boarding' : 'grooming';
  const typeLabel = kind === 'boarding' ? '애견호텔' : '애견미용';
  const city = row.city || '인천';
  const district = row.district || '';
  const dong = row.dong || '';
  const name = row.displayName || row.name || '';
  const serviceText =
    typePath === 'grooming'
      ? '애견미용, 목욕, 위생미용, 발톱 관리'
      : '애견호텔, 위탁관리, 유치원, 돌봄 서비스';
  const areaLabel = [city, district, dong].filter(Boolean).join(' ');
  const sourceId = row.sourceId || `manual-${typePath}-${slugify(`${city}-${district}-${dong}-${name}`)}`;
  const displayAddress = row.displayAddress || buildDisplayAddress(row.roadAddress, row.lotAddress, areaLabel);
  const naverMapUrl = row.naverMapUrl || buildNaverMapUrl(name, displayAddress || row.roadAddress || row.lotAddress);
  const coordinates = normalizeCoordinates(row);

  return {
    ...row,
    source: row.source || 'public-data',
    sourceId,
    businessType: typePath,
    kind: typePath,
    typePath,
    typeLabel,
    name,
    displayName: row.displayName || name,
    category: row.category || typeLabel,
    city,
    district,
    dong,
    areaLabel,
    displayAddress,
    slug: row.slug || slugify(`${typePath}-${city}-${district}-${dong}-${name}-${sourceId}`),
    title: row.title || `${areaLabel} ${name} ${typeLabel} 후기 모음`,
    metaDescription:
      row.metaDescription ||
      `${areaLabel} ${name}의 주소, 네이버 지도, ${serviceText}, 공개 후기와 방문 전 비교 기준을 정리했습니다.`,
    naverMapUrl,
    lat: coordinates.lat,
    lng: coordinates.lng,
    mapx: coordinates.mapx,
    mapy: coordinates.mapy,
    reviewCoverageLabel: row.reviewCoverageLabel || '후기 보강 예정',
    serviceText,
    services: row.services?.length ? row.services : [typeLabel]
  };
}

function sanitizeAddressDisplay(item) {
  const displayAddress = item.displayAddress || buildDisplayAddress(item.roadAddress, item.lotAddress, item.areaLabel);
  const maskedAddresses = [item.roadAddress, item.lotAddress]
    .filter((value) => typeof value === 'string' && value.includes('*'));
  if (maskedAddresses.length === 0) return { ...item, displayAddress };

  const next = { ...item, displayAddress };
  for (const key of ['oneLineSummary', 'metaDescription', 'reviewSection']) {
    if (typeof next[key] === 'string') next[key] = replaceMaskedAddresses(next[key], maskedAddresses, displayAddress);
  }
  if (Array.isArray(next.articleSections)) {
    next.articleSections = next.articleSections.map((section) => ({
      ...section,
      body: replaceMaskedAddresses(section.body, maskedAddresses, displayAddress)
    }));
  }
  if (Array.isArray(next.reviewAnalysisCards)) {
    next.reviewAnalysisCards = next.reviewAnalysisCards.map((card) => ({
      ...card,
      description: replaceMaskedAddresses(card.description, maskedAddresses, displayAddress)
    }));
  }
  if (Array.isArray(next.faqItems)) {
    next.faqItems = next.faqItems.map((faq) => ({
      ...faq,
      answer: replaceMaskedAddresses(faq.answer, maskedAddresses, displayAddress)
    }));
  }
  return next;
}

function normalizeCoordinates(row) {
  const currentLat = Number(row.lat);
  const currentLng = Number(row.lng);
  const mapx = Number(row.mapx || row.raw?.CRD_INFO_X || 0);
  const mapy = Number(row.mapy || row.raw?.CRD_INFO_Y || 0);

  if (isValidLat(currentLat) && isValidLng(currentLng)) {
    return { lat: currentLat, lng: currentLng, mapx, mapy };
  }

  if (mapx > 1000000 && mapy > 1000000) {
    const lng = mapx / 10000000;
    const lat = mapy / 10000000;
    if (isValidLat(lat) && isValidLng(lng)) return { lat, lng, mapx, mapy };
  }

  if (mapx > 10000 && mapy > 10000) {
    try {
      const [lng, lat] = proj4(PUBLIC_COORDINATE_CRS, 'EPSG:4326', [mapx, mapy]);
      if (isValidLat(lat) && isValidLng(lng)) return { lat, lng, mapx, mapy };
    } catch {
      // Keep the original values and let the page fall back to a Naver search link.
    }
  }

  return { lat: null, lng: null, mapx, mapy };
}

function isValidLat(value) {
  return Number.isFinite(value) && value >= 33 && value <= 39;
}

function isValidLng(value) {
  return Number.isFinite(value) && value >= 124 && value <= 132;
}

function replaceMaskedAddresses(value, maskedAddresses, displayAddress) {
  let text = String(value || '');
  for (const address of maskedAddresses) {
    text = text.split(address).join(displayAddress);
  }
  return text;
}

function buildDisplayAddress(roadAddress, lotAddress, areaLabel) {
  return cleanMaskedAddress(roadAddress) || cleanMaskedAddress(lotAddress) || areaLabel || '';
}

function cleanMaskedAddress(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!text.includes('*')) return text;
  const beforeMask = text.slice(0, text.indexOf('*')).replace(/[,\s]+$/g, '').trim();
  return beforeMask || '';
}

function buildGroups(items) {
  const areas = [
    ...new Map(
      items
        .filter((item) => item.city && item.district)
        .map((item) => [`${item.city}|${item.district}`, { city: item.city, district: item.district }])
    ).values()
  ];
  const defs = areas.flatMap(({ city, district }) => [
    {
      city,
      district,
      slug: `${slugify(city)}-${slugify(district)}-grooming`,
      typePath: 'grooming',
      typeLabel: '애견미용',
      title: `${city} ${district} 애견미용 후기 모음`,
      description: `${city} ${district} 애견미용 업체의 위치, 서비스 유형, 네이버 지도와 방문 전 확인할 점을 정리했습니다.`
    },
    {
      city,
      district,
      slug: `${slugify(city)}-${slugify(district)}-boarding`,
      typePath: 'boarding',
      typeLabel: '애견호텔',
      title: `${city} ${district} 애견호텔·유치원 후기 모음`,
      description: `${city} ${district} 애견호텔과 유치원, 위탁관리 업체의 위치와 돌봄 서비스 비교 기준을 정리했습니다.`
    }
  ]);

  return defs
    .map((def) => {
      const matched = items.filter(
        (item) => item.typePath === def.typePath && item.city === def.city && item.district === def.district
      );
      return {
        ...def,
        items: matched,
        body: buildGroupBody(def, matched)
      };
    })
    .filter((group) => group.items.length > 0);
}

function buildGroupBody(group, items) {
  const dongs = [...new Set(items.map((item) => item.dong).filter(Boolean))].slice(0, 12);
  const intro = `${group.title} 페이지는 공공데이터와 네이버 장소 정보를 바탕으로 확인되는 업체를 정리한 페이지입니다. ${group.district} 생활권에서 주소, 동네, 업종 분류, 서비스 범위를 먼저 비교하고, 공개 후기 자료가 확인되는 업체는 개별 페이지에서 더 자세히 볼 수 있도록 구성했습니다.`;
  const standard =
    group.typePath === 'grooming'
      ? '애견미용은 미용 스타일, 목욕 가능 여부, 소형견과 중형견 가능 범위, 예약 방식, 대기 공간, 고양이 미용 여부처럼 방문 전에 확인할 내용이 많습니다. 같은 미용업으로 등록되어 있어도 위생미용 중심인지, 전체 미용과 스파까지 함께 보는지 차이가 있을 수 있습니다.'
      : '애견호텔과 유치원은 위탁 시간, 분리 공간, 급여 방식, 사진 공유 여부, 야간 관리 방식, 픽업 가능 여부가 선택 기준이 됩니다. 공공데이터는 인허가 중심 자료이므로 실제 운영 방식은 업체별 안내를 함께 확인하는 편이 좋습니다.';
  const local = dongs.length
    ? `현재 ${group.district}에서는 ${dongs.join(', ')} 일대 업체가 확인됩니다. 생활권에 따라 이동 동선이 크게 달라질 수 있어 집이나 직장과 가까운 곳부터 비교하는 방식이 효율적입니다.`
    : '현재 공개 정보와 주소에서 확인 가능한 범위 안에서 정리했습니다.';
  return [intro, standard, local];
}

function buildNaverMapUrl(name, address) {
  const query = [address, name].filter(Boolean).join(' ');
  return `https://map.naver.com/p/search/${encodeURIComponent(query || name)}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function repairMojibakeDeep(value) {
  if (typeof value === 'string') return repairMojibake(value);
  if (Array.isArray(value)) return value.map(repairMojibakeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairMojibakeDeep(item)]));
  }
  return value;
}

function repairMojibake(value) {
  let text = value;
  for (let i = 0; i < 2 && looksMojibake(text); i += 1) {
    const repaired = decodeCp1252AsUtf8(text);
    if (!repaired || repaired === text) break;
    text = repaired;
  }
  return text;
}

function looksMojibake(value) {
  return /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ€�‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/.test(
    value
  );
}

function decodeCp1252AsUtf8(value) {
  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code <= 0xff) {
      bytes.push(code);
    } else if (CP1252_REVERSE.has(char)) {
      bytes.push(CP1252_REVERSE.get(char));
    } else {
      return value;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
