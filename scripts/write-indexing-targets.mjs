import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
const SITE_DATA = path.join(ROOT, 'src', 'data', 'siteData.ts');
const PET_SERVICE_DATA = path.join(ROOT, 'src', 'data', 'petServiceData.ts');
const OUTPUTS = [
  path.join(ROOT, 'docs', 'naver-manual-index-core.txt'),
  path.join(ROOT, 'public', 'naver-manual-index-core.txt')
];
loadDotEnv(ROOT);

const baseUrl = (process.env.SITE_BASE_URL || 'https://petcaremap.product-pack.com').replace(/\/$/, '');

const text = await readFile(SITE_DATA, 'utf8');
const businesses = parseExport(text, 'businesses');
const areaGroups = parseExport(text, 'areaGroups');
const typeGroups = parseExport(text, 'typeGroups');
const longtailGroups = parseExport(text, 'longtailGroups');
const petServiceText = await readFile(PET_SERVICE_DATA, 'utf8').catch(() => '');
const petServiceItems = parseExport(petServiceText, 'petServiceItems');
const petServiceGroups = parseExport(petServiceText, 'petServiceGroups');

const urls = [
  '/',
  ...longtailGroups.map((group) => `/topic/${group.slug}/`),
  ...typeGroups.map((group) => `/type/${group.slug}/`),
  ...areaGroups.map((group) => `/area/${group.slug}/`),
  ...petServiceGroups.map((group) => `/pet-service/${group.slug}/`),
  ...petServiceItems.slice(0, 80).map((item) => `/${item.typePath}/${item.slug}/`),
  ...businesses
    .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0))
    .slice(0, 100)
    .map((item) => `/${item.typePath}/${item.slug}/`)
];

const outputText = `${urls.map((url) => `${baseUrl}${encodeURI(url)}`).join('\n')}\n`;
for (const output of OUTPUTS) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, outputText, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, output)} (${urls.length} URLs)`);
}

function parseExport(source, name) {
  const match = source.match(new RegExp(`export const ${name} = JSON\\.parse\\((.+?)\\) as any\\[];`));
  return match ? JSON.parse(JSON.parse(match[1])) : [];
}
