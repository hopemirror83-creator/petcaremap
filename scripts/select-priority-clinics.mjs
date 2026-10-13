import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const businesses = JSON.parse(await readFile(path.join(ROOT, 'data', 'public-businesses.json'), 'utf8'));
const reviewRows = JSON.parse(await readFile(path.join(ROOT, 'data', 'naver-review-sources.json'), 'utf8'));
const generatedRows = JSON.parse(await readFile(path.join(ROOT, 'data', 'generated-review-pages.json'), 'utf8'));
const reviewMap = new Map(reviewRows.map((row) => [row.sourceId, row]));
const generatedIds = new Set(generatedRows.map((row) => row.sourceId));

const observedQueries = [
  { query: '서울든든동물병원', names: ['서울든든동물병원'], city: '인천' },
  { query: '디디동물병원', names: ['디디동물병원'], city: '인천' },
  { query: '한양한방동물병원', names: ['한양한방동물병원'], city: '인천', district: '제물포구' },
  { query: '진현우동물병원', names: ['진현우동물병원'], city: '인천' },
  { query: '송림동물병원', names: ['송림동물병원'], city: '인천' },
  { query: '서진동물병원', names: ['서진동물병원'] },
  { query: '찬샘동물병원', names: ['찬샘동물병원'], city: '인천' },
  { query: '24시더원동물병원', names: ['24시 더원 동물병원', '24시더원동물병원'], city: '인천' },
  { query: '해림동물병원', names: ['해림동물병원'], city: '인천' },
  { query: '조재진동물병원', names: ['조재진동물병원'], city: '인천' },
  { query: '부평세림동물병원', names: ['세림동물병원', '부평세림동물병원'], city: '인천' },
  { query: '주안동물메디컬센터', names: ['주안동물메디컬센터'], city: '인천' },
  { query: '리베동물병원', names: ['리베동물메디컬센터', '리베동물병원'] },
  { query: '신공항동물병원', names: ['신공항동물병원'], city: '인천' },
  { query: '잠실동물병원 햄스터', names: ['잠실동물병원'], city: '서울' }
];

const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
const clinics = businesses.filter((row) => row.businessType === 'clinic' && /정상/.test(row.operationStatus || ''));
const selected = [];
const selectedIds = new Set();

for (const seed of observedQueries) {
  const matches = clinics
    .filter((row) => !seed.city || row.city === seed.city)
    .filter((row) => !seed.district || row.district === seed.district)
    .filter((row) => seed.names.some((name) => normalize(row.displayName || row.name) === normalize(name)));
  for (const row of matches) add(row, 'search-query-top30', seed.query);
}

const expansion = clinics
  .filter((row) => ['서울', '인천'].includes(row.city))
  .filter((row) => !selectedIds.has(row.sourceId))
  .filter((row) => /24시|동물메디컬센터|동물의료센터|특수동물/.test(row.displayName || row.name || ''))
  .map((row) => ({ row, score: expansionScore(row) }))
  .sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name), 'ko'));

for (const item of expansion) {
  if (selected.length >= 50) break;
  add(item.row, 'seoul-incheon-high-intent', `score:${item.score}`);
}

if (selected.length < 50) {
  const fallback = clinics
    .filter((row) => ['서울', '인천'].includes(row.city) && !selectedIds.has(row.sourceId))
    .map((row) => ({ row, score: expansionScore(row) }))
    .sort((a, b) => b.score - a.score || String(a.row.name).localeCompare(String(b.row.name), 'ko'));
  for (const item of fallback) {
    if (selected.length >= 50) break;
    add(item.row, 'seoul-incheon-review-signal', `score:${item.score}`);
  }
}

await writeFile(path.join(ROOT, 'data', 'priority-clinic-refresh-top50.json'), `${JSON.stringify(selected, null, 2)}\n`);
await writeFile(path.join(ROOT, 'data', 'priority-clinic-refresh-top50.txt'), `${selected.map((row) => row.sourceId).join(',')}\n`);
console.log(`Selected ${selected.length} priority clinics (${selected.filter((row) => row.reason === 'search-query-top30').length} observed-query matches).`);
for (const [index, row] of selected.entries()) {
  console.log(`${index + 1}\t${row.reason}\t${row.city} ${row.district}\t${row.name}\t${row.sourceId}`);
}

function add(row, reason, evidence) {
  if (!row || selectedIds.has(row.sourceId) || selected.length >= 50) return;
  selectedIds.add(row.sourceId);
  selected.push({
    rank: selected.length + 1,
    sourceId: row.sourceId,
    name: row.displayName || row.name,
    city: row.city,
    district: row.district,
    dong: row.dong,
    reason,
    evidence
  });
}

function expansionScore(row) {
  const refs = reviewMap.get(row.sourceId)?.sourceRefs?.length || 0;
  const name = row.displayName || row.name || '';
  return refs * 12
    + (generatedIds.has(row.sourceId) ? 8 : 0)
    + (/24시/.test(name) ? 30 : 0)
    + (/특수동물/.test(name) ? 24 : 0)
    + (/동물메디컬센터|동물의료센터/.test(name) ? 15 : 0)
    + (row.city === '인천' ? 6 : 0);
}
