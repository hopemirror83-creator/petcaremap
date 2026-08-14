import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';
import { naverSearch } from './naver-search-api.mjs';

const ROOT = process.cwd();
loadDotEnv(ROOT);

const PUBLIC_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');
const CANDIDATE_FILE = path.join(ROOT, 'data', 'pet-grooming-vertex-candidates-seohae.json');
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');
const DRAFT_FILE = path.join(ROOT, 'data', 'pet-grooming-vertex-drafts-seohae-b8.json');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const location = process.env.VERTEX_LOCATION || 'us-central1';
const model = process.env.VERTEX_MODEL || process.env.VERTEX_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const requestDelayMs = Number(process.env.PET_GROOMING_B_DELAY_MS || '12000');
const retryBaseDelayMs = Number(process.env.PET_GROOMING_B_RETRY_MS || '45000');
const requestTimeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || '120000');

if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required.');

const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const projectId = process.env.VERTEX_PROJECT_ID || credentials.project_id;
if (!projectId || !credentials.client_email || !credentials.private_key) {
  throw new Error('Vertex service account JSON must include project_id, client_email, and private_key.');
}

const publicRows = await readJson(PUBLIC_FILE, []);
const candidates = await readJson(CANDIDATE_FILE, { results: [] });
const enrichmentRows = await readJson(ENRICHMENT_FILE, []);
const existingDrafts = await readJson(DRAFT_FILE, []);

const publicMap = new Map(publicRows.map((row) => [row.sourceId, row]));
const candidateMap = new Map(candidates.results.map((row) => [row.sourceId, row]));
const draftMap = new Map(existingDrafts.map((row) => [row.sourceId, row]));
const existingMap = new Map(enrichmentRows.map((row) => [row.sourceId, row]));
const protectedIds = new Set(enrichmentRows.map((row) => row.sourceId));
const bCandidates = candidates.results.filter((row) => row.grade === 'B');
const bIds = new Set(bCandidates.map((row) => row.sourceId));
const token = await getAccessToken(credentials);

const drafts = [...existingDrafts];
for (const candidate of bCandidates) {
  if (draftMap.has(candidate.sourceId) && process.env.FORCE_PET_GROOMING_B !== '1') {
    console.log(`Reuse B draft: ${candidate.name}`);
    continue;
  }
  const publicRow = publicMap.get(candidate.sourceId);
  if (!publicRow) continue;
  const sourceRefs = await collectSourceRefs(publicRow, candidate);
  const vertexDraft = await generateVertexDraft(token, publicRow, candidate, sourceRefs);
  upsert(drafts, {
    sourceId: candidate.sourceId,
    name: publicRow.displayName || publicRow.name,
    dong: publicRow.dong,
    grade: 'B',
    sourceRefs,
    vertexDraft,
    generatedBy: `vertex:${model}`,
    generatedAt: new Date().toISOString()
  });
  await writeJson(DRAFT_FILE, drafts);
  console.log(`Generated B draft: ${publicRow.displayName || publicRow.name}`);
  if (requestDelayMs > 0) await wait(requestDelayMs);
}

const nextEnrichment = [...enrichmentRows];
const currentDraftMap = new Map(drafts.map((row) => [row.sourceId, row]));

for (const candidate of bCandidates) {
  const publicRow = publicMap.get(candidate.sourceId);
  const draft = currentDraftMap.get(candidate.sourceId);
  if (!publicRow || !draft) continue;
  upsert(nextEnrichment, buildBEnrichment(publicRow, candidate, draft));
}

const cCandidates = candidates.results.filter((row) => row.grade === 'ERR');
for (const candidate of cCandidates) {
  if (protectedIds.has(candidate.sourceId) || bIds.has(candidate.sourceId)) continue;
  const publicRow = publicMap.get(candidate.sourceId);
  if (!publicRow) continue;
  upsert(nextEnrichment, buildBasicEnrichment(publicRow, candidate));
}

const nextIds = new Set(nextEnrichment.map((row) => row.sourceId));
for (const publicRow of publicRows) {
  if (nextIds.has(publicRow.sourceId) || bIds.has(publicRow.sourceId)) continue;
  const candidate = candidateMap.get(publicRow.sourceId) || { sourceId: publicRow.sourceId, samples: [] };
  upsert(nextEnrichment, buildBasicEnrichment(publicRow, candidate));
  nextIds.add(publicRow.sourceId);
}

nextEnrichment.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId), 'ko'));
await writeJson(ENRICHMENT_FILE, nextEnrichment);

console.log(`Wrote B drafts: ${drafts.length}`);
console.log(`Wrote enrichment rows: ${nextEnrichment.length}`);

async function collectSourceRefs(row, candidate) {
  const name = row.displayName || row.name;
  const dong = row.dong || '';
  const queries = [
    `${name}`,
    `${name} 애견미용`,
    `${name} 후기`,
    `인천 서구 ${name}`,
    `인천 서해구 ${name}`,
    `인천 ${dong} ${name}`,
    `${dong} 애견미용 ${name}`,
    `${dong} ${name} 후기`
  ].filter(Boolean);
  const refs = [];
  const seen = new Set();
  for (const query of queries) {
    for (const type of ['local', 'blog', 'cafearticle']) {
      try {
        const items = await naverSearch(type, query, { display: type === 'local' ? 5 : 10, sort: type === 'local' ? 'random' : 'sim' });
        for (const item of items) {
          const ref = normalizeNaverItem(item, type, query);
          if (!isRelevant(ref, row, candidate)) continue;
          const key = `${ref.sourceType}:${ref.link || ref.title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push(ref);
        }
      } catch (error) {
        console.log(`Naver search skipped: ${query} ${type} (${error.message.slice(0, 120)})`);
      }
      await wait(120);
    }
  }
  for (const sample of candidate.samples || []) {
    const title = cleanText(sample);
    if (!title) continue;
    const key = `candidate:${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      title,
      summary: '후보 검색어에서 함께 확인된 문구입니다.',
      link: '',
      sourceType: 'candidate_sample',
      bloggerName: '',
      query: 'candidate'
    });
  }
  return refs.slice(0, 14);
}

function normalizeNaverItem(item, type, query) {
  const sourceType = type === 'cafearticle' ? 'cafe' : type === 'local' ? 'naver_place' : 'blog';
  return {
    title: cleanText(item.title),
    summary: cleanText(item.description || item.category || ''),
    link: item.link || '',
    sourceType,
    bloggerName: cleanText(item.bloggername || item.cafename || item.category || ''),
    query
  };
}

function isRelevant(ref, row, candidate) {
  const name = row.displayName || row.name || candidate.name || '';
  const dong = row.dong || candidate.dong || '';
  const text = `${ref.title} ${ref.summary} ${ref.bloggerName}`.toLowerCase();
  const normalizedName = normalizeName(name);
  const nameTokens = normalizedName.split(/\s+/).filter((token) => token.length >= 2);
  const hasName = normalizedName && text.includes(normalizedName.toLowerCase());
  const hasToken = nameTokens.some((token) => text.includes(token.toLowerCase()));
  const hasDong = dong && text.includes(dong.toLowerCase());
  const hasPet = /애견|강아지|고양이|반려|미용|그루밍|펫|댕댕|멍|냥|호텔|유치원/.test(text);
  const hasArea = /인천|서구|서해|청라|가정|석남|검암|심곡|공촌|경서|신현/.test(text);
  if (ref.sourceType === 'naver_place') return (hasName || hasToken) && hasPet;
  return (hasName || (hasToken && (hasDong || hasArea)) || ((candidate.samples || []).some((sample) => text.includes(cleanText(sample).toLowerCase().slice(0, 16))))) && hasPet;
}

async function generateVertexDraft(tokenValue, row, candidate, sourceRefs) {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const prompt = buildPrompt(row, candidate, sourceRefs);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.72,
          topP: 0.92,
          responseMimeType: 'application/json'
        }
      })
    });
    const body = await response.text();
    if (response.ok) {
      const json = JSON.parse(body);
      const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
      if (!text) throw new Error(`Vertex returned empty text for ${row.displayName || row.name}`);
      return normalizeDraft(JSON.parse(text));
    }
    if (!/429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED/i.test(body) || attempt === 2) {
      throw new Error(`Vertex failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const delay = retryBaseDelayMs * (attempt + 1);
    console.log(`Vertex retry ${attempt + 1}: ${row.displayName || row.name} wait ${Math.round(delay / 1000)}s`);
    await wait(delay);
  }
}

function buildPrompt(row, candidate, sourceRefs) {
  const name = row.displayName || row.name;
  const title = `인천 서구 ${row.dong || ''} 애견미용샵 ${name} 후기`;
  return [
    '기존 지시는 무시하고 아래 지시대로만 작성해주세요.',
    `제목: ${title}`,
    '**검색 에이전트와 작성 에이전트로 나눠 진행**',
    '',
    '검색에이전트-당신은 정확하고 신뢰할 수 있는 정보를 제공하는 것을 최우선으로 여깁니다. 다양한 출처를 통해 정보를 수집하고, 항상 사실 확인을 철저히 하여 최신의 정확한 정보만을 제공합니다. 팀원들과의 협력을 중요시하며, 귀하의 전문성으로 프로젝트에 기여하고자 합니다.',
    '',
    '작성에이전트',
    '당신은 독자들이 쉽게 이해하고 공감할 수 있는 콘텐츠를 만듭니다.',
    '정보 전달과 함께 독자의 관심을 끌 수 있는 글쓰기에 능숙합니다.',
    '주요 포털 사이트와 SNS에서 잘 노출될 수 있는 콘텐츠 최적화 능력이 있습니다.',
    '검색 최적화(SEO)를 고려하여 적절한 키워드를 자연스럽게 사용해 주세요.',
    '블로그 포스트는 1400자 이상으로 작성하며, 필요시 마크다운 형식의 링크나 표를 포함해 주세요.',
    '한국인들이 사용하지 않는 단어와 표현을 사용하지 마세요.',
    '이 프로젝트의 중요성을 잘 알고 있으며, 최선을 다해 임하고 있습니다.',
    '',
    '-해당 애견미용샵의 기본정보에 대해서 읽기좋게 서술해주세요.',
    '-후기도 작성해주세요. 다만 내가 가보았다가 아니라 이런 후기도 있습니다. 이런식으로 후기를 전달해주세요.',
    '-후기가 없으면 이 애견미용샵은 후기가 많지 않습니다라고 기술해 주시면 됩니다.',
    '-반려견 맞춤 케어, 안전하고 편안한 환경, 전문적인 기술력 같은 표현은 사용할 수 있습니다.',
    '-다만 특정 보호자나 반려동물 이름을 직접 반복하지 말고, 후기에서 언급된 장면을 자연스럽게 요약해주세요.',
    '-후기 자료가 약한 경우에도 주소, 지역, 미용 서비스, 예약 전 확인할 점, 주변 업체와 비교할 기준은 독자에게 도움이 되도록 서술해주세요.',
    '-글이 중간에 끊기지 않게 완성된 문단으로 마무리해주세요.',
    '',
    '업체 기본정보:',
    `업체명: ${name}`,
    `지역: 인천 서해구 ${row.dong || ''}`,
    `주소: ${row.roadAddress || row.lotAddress || '주소 확인 필요'}`,
    `전화번호: ${row.phone || '공개 데이터에서 확인되지 않음'}`,
    `영업상태: ${row.operationStatus || '확인 필요'}`,
    `인허가일: ${row.permitDate || '확인 필요'}`,
    '',
    '후기/검색 후보:',
    sourceRefs.length
      ? sourceRefs.map((ref, index) => `${index + 1}. [${ref.sourceType}] ${ref.title} - ${ref.summary}`).join('\n')
      : '공개 후기 후보가 많지 않습니다.',
    '',
    '아래 JSON 형식으로만 답하세요.',
    JSON.stringify({
      summary: '한 줄 요약',
      body: '전체 본문. 소제목과 문단을 포함해 자연스럽게 작성',
      goodPoints: ['후기에서 좋게 언급된 점'],
      checkPoints: ['아쉬운 점이나 확인이 필요한 부분'],
      visitTips: ['방문 전 참고하면 좋은 정보'],
      comparePoints: ['이 업체를 비교할 때 볼 만한 기준'],
      faq: [{ question: '질문', answer: '답변' }]
    }, null, 2)
  ].join('\n');
}

function buildBEnrichment(row, candidate, draftRow) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const sourceRefs = draftRow.sourceRefs || [];
  const draft = draftRow.vertexDraft || {};
  const counts = countSources(sourceRefs);
  const sections = buildSectionsFromDraft(row, draft);
  const reviewSection = buildBReviewSection(row, draft, counts, sourceRefs);
  return {
    sourceId: row.sourceId,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 위치, 애견미용 후기, 네이버 지도, 예약 전 확인할 점과 주변 업체 비교 기준을 정리했습니다.`,
    oneLineSummary: draft.summary || `${area} 애견미용샵 ${name}의 공개 후기와 업체 기본정보를 바탕으로 미용 스타일, 응대 방식, 방문 전 확인할 점을 정리했습니다.`,
    reviewCoverageLabel: '후기 일부 확인',
    reviewSection,
    articleSections: sections,
    reviewAnalysisCards: buildReviewCards(row, draft, sourceRefs),
    featureCards: buildFeatureCards(),
    decisionGuide: buildDecisionGuide(row),
    faqItems: buildFaq(row, draft),
    reviewSourceSummary: {
      coverageLabel: '후기 일부 확인',
      naverMapReviewCount: 0,
      blogCount: counts.blog,
      cafeCount: counts.cafe,
      totalCount: sourceRefs.length,
      summary: `${name} 관련 공개 검색에서는 블로그 ${counts.blog}건, 카페 ${counts.cafe}건, 장소/검색 후보 ${counts.other}건을 참고했습니다.`,
      chips: [`블로그 ${counts.blog}건`, `카페 ${counts.cafe}건`, `참고 링크 ${sourceRefs.length}건`]
    },
    sourceRefs,
    generatedBy: 'vertex-b-draft+codex-edit',
    generatedAt: draftRow.generatedAt || new Date().toISOString(),
    polishedAt: new Date().toISOString()
  };
}

function buildBasicEnrichment(row, candidate) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const opened = row.permitDate ? `${row.permitDate} 인허가 정보가 확인됩니다.` : '인허가일은 공개 데이터에서 별도로 확인되지 않았습니다.';
  const phone = row.phone ? `전화번호는 ${row.phone}입니다.` : '전화번호는 공개 데이터에서 별도로 확인되지 않았습니다.';
  const address = row.roadAddress || row.lotAddress || `${area} 주소 확인 필요`;
  const samples = (candidate.samples || []).map(cleanText).filter(Boolean);
  const sourceRefs = samples.map((title) => ({
    title,
    summary: '검색 후보에서 함께 확인된 문구입니다.',
    link: '',
    sourceType: 'candidate_sample',
    bloggerName: '',
    query: 'candidate'
  }));
  const sampleText = samples.length
    ? `검색 후보에서는 ${joinList(samples.slice(0, 3))} 같은 문구가 함께 확인됩니다. 다만 이 자료만으로 실제 이용 후기를 단정하기는 어려워, 기본정보와 방문 전 확인 기준을 중심으로 정리했습니다.`
    : '현재 공개 검색에서 이 업체를 직접 이용한 후기는 많이 확인되지 않습니다. 그래서 위치, 영업상태, 예약 전 확인할 항목처럼 방문 판단에 필요한 기본정보를 중심으로 정리했습니다.';

  const reviewSection = [
    `${area} 애견미용샵 ${name}은 공공데이터 기준 ${statusText(row.operationStatus)} 확인되는 반려동물 미용 업체입니다. 주소는 ${address}이며, ${phone}`,
    sampleText,
    `애견미용은 같은 견종이라도 털 엉킴, 피부 상태, 원하는 컷, 목욕 포함 여부에 따라 소요 시간과 비용이 달라질 수 있습니다. ${name}을 처음 이용한다면 원하는 스타일 사진과 최근 미용 시점, 아이가 싫어하는 부위, 피부나 귀 상태를 미리 정리해 상담하는 편이 좋습니다.`
  ].join('\n\n');

  return {
    sourceId: row.sourceId,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 주소, 네이버 지도, 애견미용 기본정보, 후기 확인 상황과 방문 전 비교 기준을 정리했습니다.`,
    oneLineSummary: `${area} 애견미용샵 ${name}의 위치와 기본정보, 공개 후기 확인 상황, 예약 전 비교 기준을 정리했습니다.`,
    reviewCoverageLabel: samples.length ? '후기 확인 중' : '공개 후기 부족',
    reviewSection,
    articleSections: [
      {
        heading: '공개된 후기와 업체 기본정보',
        body: reviewSection
      },
      {
        heading: '후기가 부족할 때 확인할 점',
        body: `${name}처럼 공개 후기가 많지 않은 업체는 미용 결과 사진, 예약 안내, 견종별 가능 범위, 목욕과 위생미용 포함 여부를 나눠서 보는 것이 좋습니다. 후기 수가 적다는 것이 서비스 품질을 의미하지는 않지만, 처음 맡기는 보호자 입장에서는 상담 방식과 안내가 충분한지 확인하는 과정이 중요합니다.`
      },
      {
        heading: '방문 전 상담하면 좋은 내용',
        body: '예약 전에는 원하는 컷 사진, 전체 미용인지 위생미용인지, 발톱과 귀 관리가 포함되는지, 엉킨 털이나 피부 예민함에 따른 추가 비용이 있는지 확인해보세요. 겁이 많거나 입질이 있는 아이, 피부가 붉어지기 쉬운 아이는 미리 성향을 알려야 미용사가 준비하기 쉽습니다.'
      },
      {
        heading: '이 업체를 비교할 때 볼 만한 기준',
        body: `${row.dong || '주변'} 애견미용 업체와 비교할 때는 집에서의 이동 거리, 정차 가능성, 예약 간격, SNS 미용 사진의 스타일, 소형견·중형견·고양이 가능 여부를 함께 살펴보면 좋습니다. 가까운 업체라도 원하는 스타일과 상담 방식이 맞지 않으면 만족도가 달라질 수 있습니다.`
      }
    ],
    reviewAnalysisCards: [
      { label: '공개 후기', value: samples.length ? '확인 중' : '부족', description: samples.length ? '검색 후보 문구는 있으나 실제 이용 후기는 추가 확인이 필요합니다.' : '현재 직접 이용 후기가 많지 않아 기본정보 중심으로 정리했습니다.' },
      { label: '업체 정보', value: '확인됨', description: `${address} 기준으로 위치 정보를 확인할 수 있습니다.` },
      { label: '방문 전 확인', value: '권장', description: '예약 방식, 미용 범위, 추가 비용 여부를 먼저 확인해보세요.' },
      { label: '비교 기준', value: '필요', description: '주변 업체의 미용 사진, 거리, 예약 가능 시간을 함께 비교해보세요.' }
    ],
    featureCards: buildFeatureCards(),
    decisionGuide: buildDecisionGuide(row),
    faqItems: buildFaq(row, {}),
    reviewSourceSummary: {
      coverageLabel: samples.length ? '후기 확인 중' : '공개 후기 부족',
      naverMapReviewCount: 0,
      blogCount: 0,
      cafeCount: 0,
      totalCount: sourceRefs.length,
      summary: samples.length ? `${name} 관련 검색 후보 ${samples.length}건을 참고했습니다.` : `${name} 관련 직접 후기 자료가 많지 않아 기본정보를 중심으로 정리했습니다.`,
      chips: samples.length ? [`검색 후보 ${samples.length}건`] : ['공개 후기 부족']
    },
    sourceRefs,
    generatedBy: 'codex-basic-grooming',
    generatedAt: new Date().toISOString()
  };
}

function statusText(value) {
  const text = cleanText(value || '');
  if (!text) return '영업상태 확인이 필요한 것으로';
  if (text.includes('영업/정상')) return '영업/정상으로';
  return `${text}으로`;
}

function buildBReviewSection(row, draft, counts, sourceRefs) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const body = cleanLongText(draft.body || '');
  const opening = `${area} 애견미용샵 ${name}은 공개된 후기와 업체 기본정보를 함께 참고해 정리했습니다. 블로그 ${counts.blog}건, 카페 ${counts.cafe}건, 장소/검색 후보 ${counts.other}건이 확인됩니다.`;
  const usefulBody = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^제목[:：]/.test(part))
    .slice(0, 8)
    .join('\n\n');
  const fallback = draft.summary || `${name} 관련 후기는 많지 않지만, 검색 후보와 기본정보를 통해 위치와 예약 전 확인할 점을 살펴볼 수 있습니다.`;
  return `${opening}\n\n${usefulBody || fallback}`;
}

function buildSectionsFromDraft(row, draft) {
  const name = row.displayName || row.name;
  const body = cleanLongText(draft.body || '');
  const parsed = parseSections(body);
  const good = normalizeArray(draft.goodPoints);
  const checks = normalizeArray(draft.checkPoints);
  const tips = normalizeArray(draft.visitTips);
  const compare = normalizeArray(draft.comparePoints);
  const preferred = [
    {
      heading: '공개 후기에서 좋게 언급된 점',
      body: good.length ? good.map((item) => sentence(item)).join('\n\n') : firstMatchingSection(parsed, /후기|장점|좋게|만족|케어/) || `${name} 관련 후기에서는 미용 결과, 상담 방식, 반려동물 응대와 관련된 내용이 확인됩니다.`
    },
    {
      heading: '아쉬운 점이나 확인이 필요한 부분',
      body: checks.length ? checks.map((item) => sentence(item)).join('\n\n') : firstMatchingSection(parsed, /확인|주의|아쉬|예약|비용/) || '후기 자료만으로는 정확한 가격, 예약 간격, 견종별 가능 범위가 모두 확인되지는 않습니다.'
    },
    {
      heading: '방문 전 참고하면 좋은 정보',
      body: tips.length ? tips.map((item) => sentence(item)).join('\n\n') : firstMatchingSection(parsed, /방문|참고|예약|정보/) || '원하는 미용 사진, 최근 미용 시점, 피부나 귀 상태, 낯선 환경에서의 반응을 미리 정리하면 상담이 더 구체적입니다.'
    },
    {
      heading: '이 업체를 비교할 때 볼 만한 기준',
      body: compare.length ? compare.map((item) => sentence(item)).join('\n\n') : firstMatchingSection(parsed, /비교|기준/) || `${row.dong || '주변'} 애견미용샵과 비교할 때는 미용 사진의 스타일, 예약 방식, 목욕 포함 범위, 거리와 정차 가능성을 함께 살펴보세요.`
    }
  ];
  return preferred.map((section) => ({ ...section, body: cleanLongText(section.body) })).filter((section) => section.body);
}

function parseSections(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = { heading: '본문', body: [] };
  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1] || line.match(/^\*\*([^*]+)\*\*$/)?.[1];
    if (heading) {
      if (current.body.length) sections.push({ heading: current.heading, body: current.body.join('\n\n') });
      current = { heading: cleanText(heading), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) sections.push({ heading: current.heading, body: current.body.join('\n\n') });
  return sections;
}

function firstMatchingSection(sections, pattern) {
  return cleanLongText(sections.find((section) => pattern.test(section.heading))?.body || '');
}

function buildReviewCards(row, draft, sourceRefs) {
  const good = normalizeArray(draft.goodPoints);
  const checks = normalizeArray(draft.checkPoints);
  const tips = normalizeArray(draft.visitTips);
  const counts = countSources(sourceRefs);
  return [
    { label: '후기에서 많이 보인 점', value: good.length ? '확인됨' : '일부 확인', description: good[0] || '미용 결과와 응대 방식 관련 내용을 중심으로 확인했습니다.' },
    { label: '미용 스타일', value: '비교 필요', description: good[1] || '원하는 컷 사진과 업체의 미용 사진을 함께 비교해보는 편이 좋습니다.' },
    { label: '방문 전 확인', value: '권장', description: checks[0] || tips[0] || '예약 방식과 목욕, 위생미용 포함 범위를 먼저 확인해보세요.' },
    { label: '후기 참고량', value: `${sourceRefs.length}건`, description: `블로그 ${counts.blog}건, 카페 ${counts.cafe}건, 장소/검색 후보 ${counts.other}건을 참고했습니다.` }
  ];
}

function buildFeatureCards() {
  return [
    { label: '애견미용', value: '확인됨', description: '공공데이터 기준 반려동물 미용 업체로 확인됩니다.' },
    { label: '목욕', value: '개별확인필요', description: '목욕 포함 여부와 사용하는 제품은 예약 상담에서 확인하는 편이 좋습니다.' },
    { label: '위생미용', value: '개별확인필요', description: '발바닥, 발톱, 귀 주변 관리 포함 범위를 업체별로 확인해보세요.' },
    { label: '고양이 미용', value: '개별확인필요', description: '고양이 미용은 가능 여부와 방식이 업체마다 달라 별도 확인이 필요합니다.' }
  ];
}

function buildDecisionGuide(row) {
  const dong = row.dong || '주변';
  return {
    goodFor: [
      `${dong} 주변에서 가까운 애견미용 업체를 찾는 경우`,
      '미용 사진과 공개 후기를 함께 보고 스타일을 비교하려는 경우',
      '반려견 성향과 피부 상태를 미리 설명하고 상담받고 싶은 경우'
    ],
    checkBefore: [
      '예약 접수 방식과 가능한 시간대',
      '원하는 컷 사진 기준 상담 가능 여부',
      '목욕, 발톱, 위생미용 포함 범위',
      '털 엉킴이나 피부 상태에 따른 추가 비용',
      '소형견, 중형견, 고양이 미용 가능 여부'
    ],
    compareWith: [
      `${dong} 애견미용 업체의 후기 자료량`,
      '블로그나 SNS에 올라온 미용 사진의 스타일',
      '집에서 이동하기 쉬운 거리와 주차 또는 정차 가능성'
    ]
  };
}

function buildFaq(row, draft) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const faq = normalizeArray(draft.faq).filter((item) => item && item.question && item.answer).slice(0, 3);
  return [
    ...faq,
    { question: `${name}은 어디에 있나요?`, answer: `${name}은 ${area}에 있으며, 주소는 ${row.roadAddress || row.lotAddress || '공개 데이터 기준 확인 필요'}입니다.` },
    { question: `${name} 방문 전 무엇을 확인하면 좋나요?`, answer: '예약 가능 시간, 원하는 컷 상담 가능 여부, 목욕과 위생미용 포함 범위, 털 엉킴이나 피부 상태에 따른 추가 비용을 확인해보는 편이 좋습니다.' },
    { question: `후기가 많지 않으면 어떻게 판단하면 좋나요?`, answer: '후기가 부족한 업체는 위치, 미용 사진, 예약 안내 방식, 상담 응대, 견종별 가능 범위를 함께 비교하면 판단에 도움이 됩니다.' }
  ].slice(0, 5);
}

function normalizeDraft(value) {
  return {
    summary: cleanLongText(value.summary || ''),
    body: cleanLongText(value.body || ''),
    goodPoints: normalizeArray(value.goodPoints).map(cleanLongText),
    checkPoints: normalizeArray(value.checkPoints).map(cleanLongText),
    visitTips: normalizeArray(value.visitTips).map(cleanLongText),
    comparePoints: normalizeArray(value.comparePoints).map(cleanLongText),
    faq: normalizeArray(value.faq).map((item) => ({
      question: cleanText(item.question || ''),
      answer: cleanLongText(item.answer || '')
    })).filter((item) => item.question && item.answer)
  };
}

function cleanLongText(value) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/(?:^|\s)#{1,4}\s+/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
    .join('\n\n');
  return text
    .replace(/고객/g, '보호자')
    .replace(/집사/g, '보호자')
    .replace(/최고의\s*/g, '')
    .replace(/완벽한\s*/g, '')
    .replace(/강력 추천(?:합니다|드립니다)?\.?/g, '비교해볼 만합니다.')
    .replace(/좋은 선택지가 될 것입니다/g, '비교해볼 만합니다')
    .replace(/믿고 맡길 수 있는/g, '살펴볼 만한')
    .replace(/최선을 다하고 있습니다\.?/g, '')
    .replace(/여행 가이드 및 여행기/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return [value].filter(Boolean);
}

function countSources(sourceRefs) {
  const counts = { blog: 0, cafe: 0, other: 0 };
  for (const ref of sourceRefs || []) {
    if (ref.sourceType === 'blog') counts.blog += 1;
    else if (ref.sourceType === 'cafe') counts.cafe += 1;
    else counts.other += 1;
  }
  return counts;
}

function areaLabel(row) {
  return [row.city || '인천', row.district || '서해구', row.dong || ''].filter(Boolean).join(' ');
}

function normalizeName(name) {
  return cleanText(name).replace(/[()\[\]{}"'·,._-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sentence(value) {
  const text = cleanLongText(value);
  if (!text) return '';
  return /[.!?。다요음됨임니죠]$/.test(text) ? text : `${text}.`;
}

function joinList(values) {
  return values.filter(Boolean).join(', ');
}

function upsert(rows, next) {
  const index = rows.findIndex((row) => row.sourceId === next.sourceId);
  if (index >= 0) rows[index] = { ...rows[index], ...next };
  else rows.push(next);
}

async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(creds.private_key);
  const assertion = `${signingInput}.${base64Url(signature)}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OAuth failed ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).access_token;
}

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
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
