import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';
import { naverSearch } from './naver-search-api.mjs';

const ROOT = process.cwd();
const PUBLIC_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');

loadDotEnv(ROOT);

const district = process.argv[2] || process.env.PET_GROOMING_TARGET_DISTRICT || '검단구';
const outputSlug = process.argv[3] || district.replace(/\s+/g, '-');
const OUTPUT_FILE = path.join(ROOT, 'data', `pet-grooming-vertex-candidates-${outputSlug}.json`);

const publicRows = (await readJson(PUBLIC_FILE, [])).filter((row) => row.district === district);
const existing = await readJson(OUTPUT_FILE, { results: [] });
const existingMap = new Map((existing.results || []).map((row) => [row.sourceId, row]));
const results = process.env.FORCE_GROOMING_CANDIDATES === '1' ? [] : [...(existing.results || [])];

for (const row of publicRows) {
  if (existingMap.has(row.sourceId) && process.env.FORCE_GROOMING_CANDIDATES !== '1') {
    console.log(`Reuse candidate: ${row.displayName || row.name}`);
    continue;
  }

  const refs = await collectRefs(row);
  const grade = refs.length >= 6 ? 'A' : refs.length >= 3 ? 'B' : 'C';
  upsert(results, {
    sourceId: row.sourceId,
    name: row.displayName || row.name,
    district: row.district,
    dong: row.dong,
    grade,
    refCount: refs.length,
    samples: refs.slice(0, 8).map((ref) => ref.title),
    sourceRefs: refs,
    collectedAt: new Date().toISOString()
  });
  await writeJson(OUTPUT_FILE, {
    district,
    generatedAt: new Date().toISOString(),
    results: results.sort(
      (a, b) => scoreGrade(a.grade) - scoreGrade(b.grade) || b.refCount - a.refCount || a.name.localeCompare(b.name, 'ko')
    )
  });
  console.log(`${grade} ${refs.length} refs: ${row.displayName || row.name}`);
  await wait(Number(process.env.GROOMING_CANDIDATE_DELAY_MS || '350'));
}

const summary = results.reduce((acc, row) => {
  acc[row.grade] = (acc[row.grade] || 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({ district, total: results.length, summary }, null, 2));

async function collectRefs(row) {
  const name = row.displayName || row.name;
  const city = row.city || '';
  const districtName = row.district || '';
  const dong = row.dong || '';
  const region = [city, districtName].filter(Boolean).join(' ');
  const localRegion = [city, districtName, dong].filter(Boolean).join(' ');
  const queries = unique([
    name,
    `${name} 후기`,
    `${name} 애견미용`,
    `${region} ${name}`,
    `${localRegion} ${name}`,
    `${dong} 애견미용 ${name}`,
    `${districtName} 애견미용 ${name}`
  ].filter(Boolean));
  const refs = [];
  const seen = new Set();
  for (const query of queries) {
    for (const type of ['blog', 'cafearticle', 'local']) {
      const items = await safeSearch(type, query, type === 'local' ? 5 : 8);
      for (const item of items) {
        const ref = normalizeItem(item, type, query);
        const score = scoreRef(row, ref);
        if (score < 25) continue;
        const key = `${ref.sourceType}:${ref.link || ref.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ ...ref, score });
      }
      await wait(120);
    }
  }
  return refs.sort((a, b) => b.score - a.score).slice(0, 14).map(({ score, ...ref }) => ref);
}

async function safeSearch(type, query, display) {
  try {
    return await naverSearch(type, query, { display, sort: type === 'local' ? 'random' : 'sim' });
  } catch (error) {
    console.log(`Naver skipped ${type}: ${query} (${error.message.slice(0, 100)})`);
    return [];
  }
}

function normalizeItem(item, type, query) {
  return {
    title: cleanText(item.title),
    summary: cleanText(item.description || item.category || item.roadAddress || item.address || ''),
    link: item.link || '',
    sourceType: type === 'cafearticle' ? 'cafe' : type === 'local' ? 'naver_place' : 'blog',
    bloggerName: cleanText(item.bloggername || item.cafename || item.category || ''),
    postDate: item.postdate || '',
    query
  };
}

function scoreRef(row, ref) {
  const name = normalize(row.displayName || row.name);
  const compactName = normalize(String(row.displayName || row.name || '').replace(/\s+/g, ''));
  const dong = normalize(row.dong || '');
  const district = normalize(row.district || '');
  const text = normalize(`${ref.title} ${ref.summary} ${ref.bloggerName}`);
  const rawText = `${ref.title} ${ref.summary} ${ref.bloggerName}`;
  let score = 0;
  if (name && text.includes(name)) score += 60;
  if (compactName && text.includes(compactName)) score += 60;
  if (dong && text.includes(dong)) score += 15;
  if (district && text.includes(district)) score += 8;
  if (/애견|강아지|고양이|반려|미용|그루밍|목욕|스파|위생|펫살롱|펫샵|이발|가위컷|무마취/.test(rawText)) score += 20;
  if (ref.sourceType === 'naver_place') score += 8;
  if (/구인|채용|중고|분양|상품|병원|호텔|유치원|훈련/.test(rawText) && !/미용|그루밍|목욕|펫살롱/.test(rawText)) score -= 35;
  return score;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, '');
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function upsert(rows, next) {
  const index = rows.findIndex((row) => row.sourceId === next.sourceId);
  if (index >= 0) rows[index] = next;
  else rows.push(next);
}

function scoreGrade(grade) {
  return grade === 'A' ? 0 : grade === 'B' ? 1 : 2;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
