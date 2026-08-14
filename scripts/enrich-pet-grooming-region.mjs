import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
loadDotEnv(ROOT);

const district = process.argv[2] || process.env.PET_GROOMING_TARGET_DISTRICT || '검단구';
const slug = process.argv[3] || district.replace(/\s+/g, '-');
const PUBLIC_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');
const CANDIDATE_FILE = path.join(ROOT, 'data', `pet-grooming-vertex-candidates-${slug}.json`);
const DRAFT_FILE = path.join(ROOT, 'data', `pet-grooming-vertex-drafts-${slug}.json`);
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const location = process.env.VERTEX_LOCATION || 'us-central1';
const model = process.env.VERTEX_MODEL || process.env.VERTEX_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const delayMs = Number(process.env.PET_GROOMING_REGION_VERTEX_DELAY_MS || '9000');
const retryDelayMs = Number(process.env.PET_GROOMING_REGION_VERTEX_RETRY_MS || '70000');
const requestTimeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || '120000');
const limit = Number(process.env.PET_GROOMING_REGION_VERTEX_LIMIT || '9999');
const force = process.env.FORCE_PET_GROOMING_REGION_VERTEX === '1';

if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required.');

const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const projectId = process.env.VERTEX_PROJECT_ID || credentials.project_id;
if (!projectId || !credentials.client_email || !credentials.private_key) {
  throw new Error('Vertex service account JSON must include project_id, client_email, and private_key.');
}

const publicRows = await readJson(PUBLIC_FILE, []);
const candidates = await readJson(CANDIDATE_FILE, { results: [] });
const drafts = await readJson(DRAFT_FILE, []);
const enrichmentRows = await readJson(ENRICHMENT_FILE, []);

const publicMap = new Map(publicRows.map((row) => [row.sourceId, row]));
const draftMap = new Map(drafts.map((row) => [row.sourceId, row]));
const enrichmentMap = new Map(enrichmentRows.map((row) => [row.sourceId, row]));
const targetCandidates = (candidates.results || []).filter((row) => row.district === district);
const vertexTargets = targetCandidates
  .filter((row) => row.grade === 'A' || row.grade === 'B')
  .filter((row) => force || !draftMap.has(row.sourceId))
  .slice(0, limit);

const token = vertexTargets.length ? await getAccessToken(credentials) : '';
const nextDrafts = [...drafts];

for (const candidate of vertexTargets) {
  const row = publicMap.get(candidate.sourceId);
  if (!row) continue;
  const draft = await generateDraft(token, row, candidate);
  upsert(nextDrafts, {
    sourceId: candidate.sourceId,
    name: row.displayName || row.name,
    district: row.district,
    dong: row.dong,
    grade: candidate.grade,
    sourceRefs: candidate.sourceRefs || [],
    vertexDraft: draft,
    generatedBy: `vertex:${model}`,
    generatedAt: new Date().toISOString()
  });
  await writeJson(DRAFT_FILE, nextDrafts);
  console.log(`Vertex ${candidate.grade}: ${row.displayName || row.name}`);
  if (delayMs > 0) await wait(delayMs);
}

const nextDraftMap = new Map(nextDrafts.map((row) => [row.sourceId, row]));

for (const candidate of targetCandidates) {
  const row = publicMap.get(candidate.sourceId);
  if (!row) continue;
  const draft = nextDraftMap.get(candidate.sourceId);
  const enriched = draft && (candidate.grade === 'A' || candidate.grade === 'B')
    ? buildVertexEnrichment(row, candidate, draft)
    : buildBasicEnrichment(row, candidate);
  enrichmentMap.set(row.sourceId, enriched);
}

await writeJson(ENRICHMENT_FILE, [...enrichmentMap.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)));

const summary = [...enrichmentMap.values()]
  .filter((row) => publicMap.get(row.sourceId)?.district === district)
  .reduce((acc, row) => {
    acc[row.generatedBy || 'unknown'] = (acc[row.generatedBy || 'unknown'] || 0) + 1;
    return acc;
  }, {});
console.log(JSON.stringify({ district, candidates: targetCandidates.length, generated: summary }, null, 2));

async function generateDraft(tokenValue, row, candidate) {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const prompt = buildPrompt(row, candidate);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.74,
            topP: 0.92,
            responseMimeType: 'application/json',
            responseSchema: vertexResponseSchema()
          }
        })
      });
    } catch (error) {
      if (attempt === 3) throw error;
      const delay = retryDelayMs * (attempt + 1);
      console.log(`Vertex network retry ${attempt + 1}: ${row.displayName || row.name} wait ${Math.round(delay / 1000)}s (${error.message})`);
      await wait(delay);
      continue;
    }
    const body = await response.text();
    if (response.ok) {
      const json = JSON.parse(body);
      const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
      if (!text) throw new Error(`Vertex returned empty text for ${row.displayName || row.name}`);
      return normalizeDraft(parseVertexJson(text));
    }
    if (!/429|RESOURCE_EXHAUSTED|500|502|503|504|UNAVAILABLE|DEADLINE_EXCEEDED/i.test(body) || attempt === 3) {
      throw new Error(`Vertex failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const delay = retryDelayMs * (attempt + 1);
    console.log(`Vertex retry ${attempt + 1}: ${row.displayName || row.name} wait ${Math.round(delay / 1000)}s`);
    await wait(delay);
  }
}

function vertexResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      body: { type: 'STRING' },
      goodPoints: { type: 'ARRAY', items: { type: 'STRING' } },
      checkPoints: { type: 'ARRAY', items: { type: 'STRING' } },
      visitTips: { type: 'ARRAY', items: { type: 'STRING' } },
      comparePoints: { type: 'ARRAY', items: { type: 'STRING' } },
      faq: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            question: { type: 'STRING' },
            answer: { type: 'STRING' }
          },
          propertyOrdering: ['question', 'answer']
        }
      }
    },
    required: ['summary', 'body', 'goodPoints', 'checkPoints', 'visitTips', 'comparePoints', 'faq'],
    propertyOrdering: ['summary', 'body', 'goodPoints', 'checkPoints', 'visitTips', 'comparePoints', 'faq']
  };
}

function parseVertexJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const repaired = escapeUnsafeJsonStringChars(cleaned).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    return JSON.parse(repaired);
  }
}

function escapeUnsafeJsonStringChars(value) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const char of String(value || '')) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char === '\n') {
      result += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      result += '\\r';
      continue;
    }
    if (inString && char === '\t') {
      result += '\\t';
      continue;
    }
    result += char;
  }
  return result;
}

function buildPrompt(row, candidate) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const refs = candidate.sourceRefs || [];
  return [
    '기존 지시는 무시하고 아래 지시대로만 작성해주세요.',
    `제목: ${area} 애견미용샵 ${name} 후기`,
    '**검색 에이전트와 작성 에이전트로 나눠 진행**',
    '',
    '검색에이전트-당신은 정확하고 신뢰할 수 있는 정보를 제공하는 것을 최우선으로 여깁니다. 다양한 출처를 통해 정보를 수집하고, 항상 사실 확인을 철저히 하여 최신의 정확한 정보만을 제공합니다. 팀원들과의 협력을 중요시하며, 귀하의 전문성으로 프로젝트에 기여하고자 합니다.',
    '',
    '작성에이전트',
    '당신은 독자들이 쉽게 이해하고 공감할 수 있는 콘텐츠를 만듭니다.',
    '정보 전달과 함께 독자의 관심을 끌 수 있는 글쓰기에 능숙합니다.',
    '주요 포털 사이트와 SNS에서 잘 노출될 수 있는 콘텐츠 최적화 능력이 있습니다.',
    '검색 최적화(SEO)를 고려하여 적절한 키워드를 자연스럽게 사용해 주세요.',
    '블로그 포스트는 1600자 이상으로 작성하며, 필요시 마크다운 형식의 링크나 표를 포함해 주세요.',
    '한국인들이 사용하지 않는 단어와 표현을 사용하지 마세요.',
    '이 프로젝트의 중요성을 잘 알고 있으며, 최선을 다해 임하고 있습니다.',
    '',
    '-해당 애견미용샵의 기본정보에 대해서 읽기좋게 서술해주세요.',
    '-후기도 작성해주세요. 다만 내가 가보았다가 아니라 이런 후기도 있습니다, 후기에서는 이런 점이 언급됩니다처럼 전달해주세요.',
    '-후기가 적으면 억지로 꾸미지 말고 확인되는 정보와 방문 전 참고할 점을 자연스럽게 작성해주세요.',
    '-반려견 맞춤 케어, 안전하고 편안한 환경, 전문적인 기술력 같은 표현은 사용할 수 있습니다.',
    '-특정 보호자나 반려동물 이름을 직접 반복하기보다 후기에서 보이는 장면을 요약해주세요.',
    '',
    '업체 기본정보',
    `업체명: ${name}`,
    `지역: ${area}`,
    `주소: ${row.roadAddress || row.lotAddress || '주소 확인 필요'}`,
    `전화번호: ${row.phone || '공개 데이터에서 확인되지 않음'}`,
    `영업상태: ${row.operationStatus || '확인 필요'}`,
    '',
    '코덱스가 수집한 공개 후기 후보와 기본정보',
    refs.length
      ? refs.map((ref, index) => `${index + 1}. [${ref.sourceType}] ${ref.title} - ${ref.summary}`).join('\n')
      : '현재 직접 참고할 공개 후기 후보가 많지 않습니다.',
    '',
    '반드시 아래 JSON 형식으로만 반환해주세요.',
    JSON.stringify({
      summary: '한 문단 요약',
      body: '전체 본문. 소제목과 문단을 포함해 자연스럽게 작성',
      goodPoints: ['후기에서 좋게 언급된 점'],
      checkPoints: ['아쉬운 점이나 확인이 필요한 부분'],
      visitTips: ['방문 전 참고하면 좋은 정보'],
      comparePoints: ['이 업체를 비교할 때 볼 만한 기준'],
      faq: [{ question: '질문', answer: '답변' }]
    }, null, 2)
  ].join('\n');
}

function buildVertexEnrichment(row, candidate, draftRow) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const refs = draftRow.sourceRefs || candidate.sourceRefs || [];
  const draft = draftRow.vertexDraft || {};
  const counts = countSources(refs);
  const body = cleanLongText(draft.body || draft.summary || '');
  const opening = `${area} 애견미용샵 ${name}은 공개된 후기와 업체 기본정보를 함께 참고해 정리했습니다. ${sourceSummary(counts, refs.length)} 확인됩니다.`;
  const reviewSection = [opening, body].filter(Boolean).join('\n\n');

  return {
    sourceId: row.sourceId,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 위치, 애견미용 후기, 네이버 지도, 예약 전 확인사항과 주변 업체 비교 기준을 정리했습니다.`,
    oneLineSummary: draft.summary || `${area} 애견미용샵 ${name}의 공개 후기와 기본정보를 바탕으로 미용 스타일, 응대 방식, 방문 전 확인사항을 정리했습니다.`,
    reviewCoverageLabel: refs.length >= 6 ? '후기 자료 풍부' : '후기 일부 확인',
    reviewSection,
    articleSections: buildArticleSections(row, draft, refs),
    reviewAnalysisCards: buildReviewCards(draft, refs),
    featureCards: buildFeatureCards(),
    decisionGuide: buildDecisionGuide(row),
    faqItems: buildFaq(row, draft),
    reviewSourceSummary: {
      coverageLabel: refs.length >= 6 ? '후기 자료 풍부' : '후기 일부 확인',
      naverMapReviewCount: 0,
      blogCount: counts.blog,
      cafeCount: counts.cafe,
      totalCount: refs.length,
      summary: `${name} 관련 공개 후기 후보 ${refs.length}건을 참고했습니다.`,
      chips: [`블로그 ${counts.blog}건`, `카페 ${counts.cafe}건`, `참고 링크 ${refs.length}건`]
    },
    sourceRefs: refs,
    generatedBy: 'vertex-region-draft+codex-edit',
    generatedAt: draftRow.generatedAt || new Date().toISOString(),
    polishedAt: new Date().toISOString()
  };
}

function buildBasicEnrichment(row, candidate) {
  const name = row.displayName || row.name;
  const area = areaLabel(row);
  const refs = candidate.sourceRefs || [];
  const samples = refs.slice(0, 4).map((ref) => ref.title).filter(Boolean);
  const address = row.roadAddress || row.lotAddress || `${area} 주소 확인 필요`;
  const phone = row.phone ? `전화번호는 ${row.phone}입니다.` : '전화번호는 공개 데이터에서 별도로 확인되지 않았습니다.';
  const status = statusText(row.operationStatus);
  const sampleText = samples.length
    ? `검색 후보에서는 ${joinList(samples)} 같은 문구가 함께 확인됩니다. 다만 이 자료만으로 실제 이용 후기를 단정하기는 어려워, 기본정보와 방문 전 확인 기준을 중심으로 정리했습니다.`
    : '현재 공개 검색에서 이 업체를 직접 이용한 후기는 많이 확인되지 않습니다. 그래서 위치, 영업상태, 예약 전 확인할 항목처럼 방문 판단에 필요한 기본정보를 중심으로 정리했습니다.';
  const reviewSection = [
    `${area} 애견미용샵 ${name}은 공공데이터 기준 ${status} 확인되는 반려동물 미용 업체입니다. 주소는 ${address}이며, ${phone}`,
    sampleText,
    `애견미용은 같은 견종이라도 털 엉킴, 피부 상태, 원하는 컷, 목욕 포함 여부에 따라 소요 시간과 비용이 달라질 수 있습니다. ${name}을 처음 이용한다면 원하는 스타일 사진과 최근 미용 시점, 아이가 싫어하는 부위, 피부나 귀 상태를 미리 정리해 상담하는 편이 좋습니다.`
  ].join('\n\n');

  return {
    sourceId: row.sourceId,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 주소, 네이버 지도, 애견미용 기본정보, 후기 확인 상황과 방문 전 비교 기준을 정리했습니다.`,
    oneLineSummary: `${area} 애견미용샵 ${name}의 위치와 기본정보, 공개 후기 확인 상황, 예약 전 비교 기준을 정리했습니다.`,
    reviewCoverageLabel: refs.length ? '후기 확인 중' : '공개 후기 부족',
    reviewSection,
    articleSections: [
      { heading: '공개된 후기와 업체 기본정보', body: reviewSection },
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
      { label: '공개 후기', value: refs.length ? '확인 중' : '부족', description: refs.length ? '검색 후보 문구는 있으나 실제 이용 후기는 추가 확인이 필요합니다.' : '현재 직접 이용 후기가 많지 않아 기본정보 중심으로 정리했습니다.' },
      { label: '업체 정보', value: '확인됨', description: `${address} 기준으로 위치 정보를 확인할 수 있습니다.` },
      { label: '방문 전 확인', value: '권장', description: '예약 방식, 미용 범위, 추가 비용 여부를 먼저 확인해보세요.' },
      { label: '비교 기준', value: '필요', description: '주변 업체의 미용 사진, 거리, 예약 가능 시간을 함께 비교해보세요.' }
    ],
    featureCards: buildFeatureCards(),
    decisionGuide: buildDecisionGuide(row),
    faqItems: buildFaq(row, {}),
    reviewSourceSummary: {
      coverageLabel: refs.length ? '후기 확인 중' : '공개 후기 부족',
      naverMapReviewCount: 0,
      blogCount: 0,
      cafeCount: 0,
      totalCount: refs.length,
      summary: refs.length ? `${name} 관련 검색 후보 ${refs.length}건을 참고했습니다.` : `${name} 관련 직접 후기 자료가 많지 않아 기본정보를 중심으로 정리했습니다.`,
      chips: refs.length ? [`검색 후보 ${refs.length}건`] : ['공개 후기 부족']
    },
    sourceRefs: refs,
    generatedBy: 'codex-basic-grooming',
    generatedAt: new Date().toISOString()
  };
}

function buildArticleSections(row, draft, refs) {
  const name = row.displayName || row.name;
  const bodySections = parseSections(draft.body || '');
  return [
    {
      heading: '공개된 후기와 업체 기본정보',
      body: cleanLongText(draft.summary || firstSection(bodySections) || `${name} 관련 공개 후기와 업체 기본정보를 함께 정리했습니다.`)
    },
    {
      heading: '공개 후기에서 좋게 언급된 점',
      body: listToParagraph(draft.goodPoints) || findSection(bodySections, /좋|장점|만족|후기|케어|미용/) || `${name} 관련 후기에서는 미용 결과, 상담 방식, 반려동물 응대와 관련된 내용이 주로 확인됩니다.`
    },
    {
      heading: '아쉬운 점이나 확인이 필요한 부분',
      body: listToParagraph(draft.checkPoints) || findSection(bodySections, /아쉬|확인|주의|비용|예약/) || '예약 방식, 비용, 견종별 가능 범위는 업체마다 달라 방문 전 확인이 필요합니다.'
    },
    {
      heading: '방문 전 참고하면 좋은 정보',
      body: listToParagraph(draft.visitTips) || findSection(bodySections, /방문|준비|참고|예약/) || '원하는 스타일 사진, 최근 미용 시점, 털 엉킴 정도, 피부 예민함을 미리 정리하면 상담이 더 구체적입니다.'
    },
    {
      heading: '이 업체를 비교할 때 볼 만한 기준',
      body: listToParagraph(draft.comparePoints) || findSection(bodySections, /비교|기준/) || `${row.dong || '주변'} 애견미용 업체와 비교할 때는 미용 사진, 예약 간격, 목욕 포함 여부, 정차 가능성을 함께 보면 좋습니다.`
    }
  ].map((section) => ({ ...section, body: cleanLongText(section.body) })).filter((section) => section.body);
}

function buildReviewCards(draft, refs) {
  const points = normalizeArray(draft.goodPoints);
  const labels = ['맞춤 케어', '미용 스타일', '상담/응대', '예약 정보'];
  return labels.map((label, index) => ({
    label,
    value: points[index] ? '언급 있음' : refs.length ? '확인 필요' : '자료 부족',
    description: points[index] ? sentence(points[index]) : `${label}는 후기와 업체 안내를 함께 확인해보는 편이 좋습니다.`
  }));
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
  const area = areaLabel(row);
  return {
    goodFor: [
      `${area} 주변에서 가까운 애견미용 업체를 찾는 경우`,
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
      `${row.dong || '주변'} 애견미용 업체의 후기 자료량`,
      '블로그나 SNS에 올라온 미용 사진의 스타일',
      '집에서 이동하기 쉬운 거리와 주차 또는 정차 가능성'
    ]
  };
}

function buildFaq(row, draft) {
  const name = row.displayName || row.name;
  const draftFaq = normalizeFaq(draft.faq);
  if (draftFaq.length >= 2) return draftFaq.slice(0, 4);
  return [
    {
      question: `${name}은 어디에 있나요?`,
      answer: `${name}은 ${areaLabel(row)}에 있으며, 주소는 ${row.roadAddress || row.lotAddress || '공개 데이터 기준 주소 확인 필요'}입니다.`
    },
    {
      question: `${name} 방문 전 무엇을 확인하면 좋나요?`,
      answer: '예약 가능 시간, 원하는 컷 상담 가능 여부, 목욕과 위생미용 포함 범위, 털 엉킴이나 피부 상태에 따른 추가 비용을 확인해보는 편이 좋습니다.'
    },
    {
      question: '후기가 많지 않으면 어떻게 판단하면 좋나요?',
      answer: '후기가 부족한 업체는 위치, 미용 사진, 예약 안내 방식, 상담 응대, 견종별 가능 범위를 함께 비교하면 판단에 도움이 됩니다.'
    }
  ];
}

function countSources(refs) {
  return {
    blog: refs.filter((ref) => ref.sourceType === 'blog').length,
    cafe: refs.filter((ref) => ref.sourceType === 'cafe').length,
    place: refs.filter((ref) => ref.sourceType === 'naver_place').length
  };
}

function sourceSummary(counts, total) {
  return `블로그 ${counts.blog}건, 카페 ${counts.cafe}건, 장소/검색 후보 ${counts.place}건 등 총 ${total}건의 참고 자료가`;
}

function parseSections(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = { heading: '본문', body: [] };
  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1] || line.match(/^\*\*([^*]+)\*\*$/)?.[1];
    if (heading) {
      if (current.body.length) sections.push({ heading: current.heading, body: current.body.join('\n\n') });
      current = { heading, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length) sections.push({ heading: current.heading, body: current.body.join('\n\n') });
  return sections;
}

function firstSection(sections) {
  return sections[0]?.body || '';
}

function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.heading) || pattern.test(section.body))?.body || '';
}

function normalizeDraft(value) {
  return {
    summary: cleanLongText(value.summary || ''),
    body: cleanLongText(value.body || ''),
    goodPoints: normalizeArray(value.goodPoints),
    checkPoints: normalizeArray(value.checkPoints),
    visitTips: normalizeArray(value.visitTips),
    comparePoints: normalizeArray(value.comparePoints),
    faq: normalizeFaq(value.faq)
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(cleanLongText).filter(Boolean);
  if (typeof value === 'string') return value.split(/\n|ㆍ|•|-/).map(cleanLongText).filter(Boolean);
  return [];
}

function normalizeFaq(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      question: cleanLongText(item?.question || ''),
      answer: cleanLongText(item?.answer || '')
    }))
    .filter((item) => item.question && item.answer);
}

function listToParagraph(value) {
  return normalizeArray(value).map(sentence).join('\n\n');
}

function sentence(value) {
  const text = cleanLongText(value);
  if (!text) return '';
  return /[.!?。]$/.test(text) || /[다요음함됨됨니다습니다]$/.test(text) ? text : `${text}라는 내용이 언급됩니다.`;
}

function cleanLongText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/(?:^|\s)#{1,4}\s+/g, '\n\n')
    .replace(/\*\*/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function areaLabel(row) {
  return [row.city || '인천', row.district || district, row.dong].filter(Boolean).join(' ');
}

function statusText(value) {
  const text = cleanLongText(value || '');
  if (!text) return '영업상태 확인이 필요한 것으로';
  if (text.includes('영업/정상')) return '영업/정상으로';
  return `${text}으로`;
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
