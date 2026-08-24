import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');
const ENRICHMENT_DIR = path.join(ROOT, 'data', 'pet-service-enrichment');
const PUBLIC_FILES = [
  path.join(ROOT, 'data', 'public-grooming-businesses.json'),
  path.join(ROOT, 'data', 'public-boarding-businesses.json'),
  path.join(ROOT, 'data', 'manual-pet-service-businesses.json')
];

const enrichmentRows = await readJson(ENRICHMENT_FILE, []);
if (!Array.isArray(enrichmentRows) || enrichmentRows.length === 0) {
  throw new Error(`No enrichment rows found in ${path.relative(ROOT, ENRICHMENT_FILE)}`);
}

const publicMap = new Map();
for (const file of PUBLIC_FILES) {
  const rows = await readJson(file, []);
  for (const row of rows) {
    const sourceId = row.sourceId;
    if (!sourceId) continue;
    publicMap.set(sourceId, {
      city: row.city || inferCity(row),
      district: row.district || inferDistrict(row),
      kind: row.businessType || row.kind || (sourceId.includes('boarding') ? 'boarding' : 'grooming')
    });
  }
}

const groups = new Map();
for (const row of enrichmentRows) {
  const meta = publicMap.get(row.sourceId) || inferMeta(row);
  const kind = meta.kind === 'boarding' ? 'boarding' : 'grooming';
  const city = meta.city || 'unknown-city';
  const district = meta.district || 'unknown-district';
  const key = `${kind}-${slugify(city)}-${slugify(district)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

await rm(ENRICHMENT_DIR, { recursive: true, force: true });
await mkdir(ENRICHMENT_DIR, { recursive: true });

for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  rows.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
  await writeFile(path.join(ENRICHMENT_DIR, `${key}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  inputRows: enrichmentRows.length,
  shardCount: groups.size,
  largestShardRows: Math.max(...[...groups.values()].map((rows) => rows.length)),
  outputDir: path.relative(ROOT, ENRICHMENT_DIR)
}, null, 2));

function inferMeta(row) {
  const title = String(row.title || row.metaDescription || '');
  const [city, district] = title.split(/\s+/);
  const sourceId = String(row.sourceId || '');
  return {
    city,
    district,
    kind: sourceId.includes('boarding') ? 'boarding' : 'grooming'
  };
}

function inferCity(row) {
  return String(row.title || row.metaDescription || '').split(/\s+/)[0] || '';
}

function inferDistrict(row) {
  return String(row.title || row.metaDescription || '').split(/\s+/)[1] || '';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
