import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const selectionFile = path.join(ROOT, 'data', 'priority-clinic-refresh-top50.json');
const generatedFile = path.join(ROOT, 'data', 'generated-review-pages.json');
const businessesFile = path.join(ROOT, 'data', 'public-businesses.json');

const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
const generated = JSON.parse(await readFile(generatedFile, 'utf8'));
const businesses = JSON.parse(await readFile(businessesFile, 'utf8'));
const selectedMap = new Map(selection.map((row) => [row.sourceId, row]));
const businessMap = new Map(businesses.map((row) => [row.sourceId, row]));

let changed = 0;
for (const page of generated) {
  const selected = selectedMap.get(page.sourceId);
  if (!selected) continue;
  const business = businessMap.get(page.sourceId) || selected;
  const name = business.displayName || business.name || selected.name;
  const area = [business.city, business.district].filter(Boolean).join(' ');
  const compactName = String(name).replace(/\s+/g, '');
  const isOvernight = /24시/.test(name) || (business.services || []).includes('24시');
  const isExoticIntent = page.sourceId === '351050001020240001';
  const isHamsterIntent = page.sourceId === '323000001020220006';

  if (isExoticIntent) {
    page.title = `${name} 후기, 특수동물 진료·위치 확인 | ${area}`;
    page.metaDescription = `${area} ${name}의 공개 후기와 특수동물 진료 관련 언급, 주소, 전화번호, 위치, 방문 전 확인사항을 정리했습니다.`;
  } else if (isHamsterIntent) {
    page.title = `${name} 햄스터 진료 가능 여부·후기 | ${area}`;
    page.metaDescription = `${area} ${name}의 공개 후기와 햄스터 진료 가능 여부, 주소, 전화번호, 위치, 방문 전 확인사항을 정리했습니다.`;
  } else if (isOvernight) {
    page.title = `${name} 후기, 야간·응급진료 전 확인 | ${area}`;
    page.metaDescription = `${area} ${name}의 공개 후기와 야간·응급진료 전 확인할 운영시간, 전화번호, 위치 정보를 정리했습니다.`;
  } else {
    page.title = `${name} 후기, 진료시간·전화번호·위치 | ${area}`;
    page.metaDescription = `${area} ${name}의 공개 후기와 진료시간, 전화번호, 주소, 위치, 방문 전 확인사항을 정리했습니다.`;
  }

  page.title = page.title.slice(0, 90);
  page.metaDescription = page.metaDescription.slice(0, 160);
  page.priorityRefresh = true;
  page.titlePolishedAt = new Date().toISOString();
  changed += 1;

  if (!page.title.replace(/\s+/g, '').startsWith(compactName)) {
    throw new Error(`Title does not start with clinic name: ${name}`);
  }
}

if (changed !== selection.length) {
  throw new Error(`Expected ${selection.length} priority titles, updated ${changed}.`);
}

await writeFile(generatedFile, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
console.log(`Polished ${changed} priority clinic titles.`);
