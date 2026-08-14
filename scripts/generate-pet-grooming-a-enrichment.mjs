import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';
import { naverSearch } from './naver-search-api.mjs';

const ROOT = process.cwd();
loadDotEnv(ROOT);

const PUBLIC_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');
const CANDIDATE_FILE = path.join(ROOT, 'data', 'pet-grooming-vertex-candidates-seohae.json');
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');
const RAW_OUTPUT_FILE = path.join(ROOT, 'data', 'pet-grooming-vertex-drafts-seohae-a9.json');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const location = process.env.VERTEX_LOCATION || 'us-central1';
const model = process.env.VERTEX_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const limit = Number(process.env.PET_GROOMING_VERTEX_LIMIT || '9');
const delayMs = Number(process.env.PET_GROOMING_VERTEX_DELAY_MS || '8000');
const force = process.env.FORCE_PET_GROOMING_VERTEX === '1';

if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required.');

const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const projectId = process.env.VERTEX_PROJECT_ID || credentials.project_id;
if (!projectId || !credentials.client_email || !credentials.private_key) {
  throw new Error('Service account JSON must include project_id, client_email, and private_key.');
}

const publicRows = await readJson(PUBLIC_FILE, []);
const candidateRows = (await readJson(CANDIDATE_FILE, { results: [] })).results
  .filter((row) => row.grade === 'A')
  .slice(0, limit);
const currentEnrichment = await readJson(ENRICHMENT_FILE, []);
const enrichmentMap = new Map(currentEnrichment.map((row) => [row.sourceId, row]));
const rawDrafts = await readJson(RAW_OUTPUT_FILE, []);
const rawDraftMap = new Map(rawDrafts.map((row) => [row.sourceId, row]));

const targets = candidateRows
  .map((candidate) => {
    const base = publicRows.find((row) => row.sourceId === candidate.sourceId);
    return base ? { ...base, candidate } : null;
  })
  .filter(Boolean)
  .filter((row) => force || !isVertexEdited(enrichmentMap.get(row.sourceId)));

const token = targets.length ? await getAccessToken(credentials) : '';
const nextRawDrafts = [...rawDrafts];

for (const item of targets) {
  console.log(`Collecting sources: ${item.displayName || item.name}`);
  const sourceRefs = await collectSourceRefs(item);
  console.log(`Vertex draft: ${item.displayName || item.name} (${sourceRefs.length} refs)`);
  const draft = await generateDraft(token, item, sourceRefs);
  const edited = buildEditedEnrichment(item, sourceRefs, draft);
  enrichmentMap.set(item.sourceId, edited);

  upsert(nextRawDrafts, {
    sourceId: item.sourceId,
    name: item.displayName || item.name,
    sourceRefs,
    vertexDraft: draft,
    generatedBy: `vertex:${model}`,
    generatedAt: new Date().toISOString()
  });

  await writeJson(ENRICHMENT_FILE, [...enrichmentMap.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  await writeJson(RAW_OUTPUT_FILE, nextRawDrafts.sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  console.log(`Wrote enrichment: ${item.displayName || item.name}`);
  await wait(delayMs);
}

if (targets.length === 0) {
  console.log('No A-grade grooming targets needed generation.');
}

async function collectSourceRefs(item) {
  const queries = buildQueries(item);
  const refs = [];
  for (const query of queries) {
    const [blogs, cafes, locals] = await Promise.all([
      safeSearch('blog', query, 5),
      safeSearch('cafearticle', query, 3),
      safeSearch('local', query, 3, 'comment')
    ]);
    for (const raw of blogs) refs.push(toSourceRef(raw, 'blog', query));
    for (const raw of cafes) refs.push(toSourceRef(raw, 'cafe', query));
    for (const raw of locals) refs.push(toSourceRef(raw, 'naver_place', query));
    await wait(250);
  }

  return dedupe(refs)
    .map((ref) => ({ ...ref, score: scoreRef(item, ref) }))
    .filter((ref) => ref.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score, ...ref }) => ref);
}

function buildQueries(item) {
  const name = item.displayName || item.name;
  return unique([
    name,
    `${name} 애견미용`,
    `${name} 강아지미용`,
    `인천 서구 ${name}`,
    `인천 서해구 ${name}`,
    `인천 ${item.dong || ''} ${name}`,
    `${item.dong || ''} ${name} 후기`,
    `${item.dong || ''} 애견미용 ${name}`
  ].map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

async function safeSearch(type, query, display, sort = 'sim') {
  try {
    return await naverSearch(type, query, { display, sort });
  } catch (error) {
    console.log(`Naver ${type} skipped: ${query} (${error.message.slice(0, 90)})`);
    return [];
  }
}

function toSourceRef(item, sourceType, query) {
  return {
    title: stripHtml(item.title),
    summary: stripHtml(item.description || item.category || item.roadAddress || item.address || '').slice(0, 260),
    link: item.link || '',
    sourceType,
    bloggerName: stripHtml(item.bloggername || item.cafename || item.category || ''),
    postDate: item.postdate || '',
    query
  };
}

function scoreRef(item, ref) {
  const name = normalize(item.displayName || item.name);
  const compactName = normalize(String(item.displayName || item.name || '').replace(/\s+/g, ''));
  const dong = normalize(item.dong || '');
  const text = normalize(`${ref.title} ${ref.summary} ${ref.bloggerName}`);
  let score = 0;
  if (name && text.includes(name)) score += 55;
  if (compactName && text.includes(compactName)) score += 55;
  if (dong && text.includes(dong)) score += 15;
  if (/애견미용|강아지미용|반려견미용|고양이미용|목욕|위생미용|스파|컷|미용/.test(`${ref.title} ${ref.summary}`)) score += 20;
  if (ref.sourceType === 'naver_place') score += 10;
  if (/구인|채용|중고|분양|용품|병원|호텔/.test(`${ref.title} ${ref.summary}`) && !/미용/.test(`${ref.title} ${ref.summary}`)) score -= 30;
  return score;
}

async function generateDraft(token, item, sourceRefs) {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const prompt = buildVertexPrompt(item, sourceRefs);
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || '120000')),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        topP: 0.95,
        responseMimeType: 'application/json'
      }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vertex Gemini failed ${response.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!text) throw new Error(`Vertex returned empty content for ${item.displayName || item.name}`);
  return JSON.parse(text);
}

function buildVertexPrompt(item, sourceRefs) {
  const name = item.displayName || item.name;
  const title = `인천 서해구 ${item.dong} 애견미용샵 ${name} 후기`;
  return [
    '기존 지시는 무시하고 아래 지시대로만 작성해주세요.',
    `제목: ${title}`,
    '**검색 에이전트와 작성 에이전트로 나눠 진행**',
    '',
    '검색에이전트-당신은 정확하고 신뢰할 수 있는 정보를 제공하는 것을 최우선으로 여깁니다. 다양한 출처를 통해 정보를 수집하고, 항상 사실 확인을 철저히 하여 최신의 정확한 정보만을 제공합니다.팀원들과의 협력을 중요시하며, 귀하의 전문성으로 프로젝트에 기여하고자 합니다.',
    '',
    '작성에이전트',
    '당신은 독자들이 쉽게 이해하고 공감할 수 있는 콘텐츠를 만듭니다.',
    '정보 전달과 함께 독자의 관심을 끌 수 있는 글쓰기에 능숙합니다.',
    '주요 포털 사이트와 SNS에서 잘 노출될 수 있는 콘텐츠 최적화 능력이 있습니다.',
    '검색 최적화(SEO)를 고려하여 적절한 키워드를 자연스럽게 사용해 주세요.',
    '블로그 포스트는 2000자 이상으로 작성하며, 필요시 마크다운 형식의 링크나 표를 포함해 주세요.',
    '한국인들이 사용하지 않는 단어와 표현을 사용하지 마세요 (영어식 표현.).',
    '이 프로젝트의 중요성을 잘 알고 있으며, 최선을 다해 임하고 있습니다.',
    '',
    '-해당 업체의 기본정보에 대해서 읽기좋게 서술해주세요.',
    '-후기도 작성해주세요. 다만 내가 가보았다가 아니라 이런 후기도 있습니다. 이런식으로 후기를 전달해주세요. 후기가 없으면 이 애견미용샵은 후기가 없습니다라고 기술해 주시면 됩니다.',
    '',
    '업체 기본정보',
    `업체명: ${name}`,
    `지역: 인천 서해구 ${item.dong || ''}`,
    `주소: ${item.roadAddress || item.lotAddress || ''}`,
    `전화번호: ${item.phone || ''}`,
    '',
    '코덱스가 수집한 공개 후기 후보와 기본정보',
    sourceRefs.length ? sourceRefs.map((ref, index) => `${index + 1}. [${ref.sourceType}] ${ref.title} - ${ref.summary}`).join('\n') : '현재 직접 참고할 공개 후기 후보가 많지 않습니다.',
    '',
    '반드시 JSON으로만 반환해주세요.',
    JSON.stringify({
      title: '제목',
      summary: '한 문장 요약',
      body: '블로그 본문',
      goodPoints: ['좋게 언급된 점'],
      checkPoints: ['확인이 필요한 점'],
      visitTips: ['방문 전 참고 정보'],
      comparePoints: ['비교 기준'],
      faq: [{ question: '질문', answer: '답변' }]
    })
  ].join('\n');
}

function buildEditedEnrichment(item, sourceRefs, draft) {
  const name = item.displayName || item.name;
  const area = ['인천 서해구', item.dong].filter(Boolean).join(' ');
  const sourceCounts = countSources(sourceRefs);
  const coverageLabel = sourceRefs.length >= 6 ? '후기 자료 풍부' : sourceRefs.length >= 3 ? '후기 일부 확인' : sourceRefs.length > 0 ? '후기 자료 제한적' : '공개 후기 부족';
  const goodPoints = normalizeArray(draft.goodPoints).length ? normalizeArray(draft.goodPoints) : inferGoodPoints(sourceRefs);
  const checkPoints = normalizeArray(draft.checkPoints).length ? normalizeArray(draft.checkPoints) : defaultCheckPoints();
  const visitTips = normalizeArray(draft.visitTips).length ? normalizeArray(draft.visitTips) : defaultVisitTips(item);
  const comparePoints = normalizeArray(draft.comparePoints).length ? normalizeArray(draft.comparePoints) : defaultComparePoints();
  const editedReview = buildReviewSection(name, sourceRefs, draft, coverageLabel);

  return {
    sourceId: item.sourceId,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 위치, 애견미용 후기, 네이버 지도, 예약 전 확인할 점과 주변 업체 비교 기준을 정리했습니다.`,
    oneLineSummary: `${name}은 ${area}에서 확인되는 애견미용 업체로, 공개 후기와 네이버 검색 자료를 바탕으로 미용 스타일, 응대 방식, 방문 전 확인사항을 정리했습니다.`,
    reviewCoverageLabel: coverageLabel,
    reviewSection: editedReview,
    articleSections: [
      {
        heading: '공개 후기에서 좋게 언급된 점',
        body: joinSentences(goodPoints.map((point) => toNaturalSentence(point, '좋게 언급됩니다')))
      },
      {
        heading: '아쉬운 점이나 확인이 필요한 부분',
        body: joinSentences(checkPoints.map((point) => toNaturalSentence(point, '확인하면 좋습니다')))
      },
      {
        heading: '방문 전 참고하면 좋은 정보',
        body: joinSentences(visitTips.map((point) => toNaturalSentence(point, '참고할 만합니다')))
      },
      {
        heading: '이 업체를 비교할 때 볼 만한 기준',
        body: joinSentences(comparePoints.map((point) => toNaturalSentence(point, '비교 기준이 됩니다')))
      }
    ],
    reviewAnalysisCards: [
      {
        label: '응대와 케어',
        value: sourceRefs.length ? '후기 언급' : '개별확인필요',
        description: goodPoints[0] || '반려견 성향에 맞춘 응대 방식은 예약 전 상담에서 확인하는 편이 좋습니다.'
      },
      {
        label: '미용 스타일',
        value: sourceRefs.length ? '사진 확인 추천' : '개별확인필요',
        description: goodPoints[1] || '미용 결과는 취향 차이가 크므로 블로그, 지도, SNS 사진을 함께 보는 편이 좋습니다.'
      },
      {
        label: '예약 방식',
        value: '개별확인필요',
        description: '애견미용은 예약제로 운영되는 경우가 많아 가능한 시간대와 상담 방식을 먼저 확인하는 편이 좋습니다.'
      },
      {
        label: '후기 참고량',
        value: `${sourceRefs.length}건`,
        description: `블로그 ${sourceCounts.blog}건, 카페 ${sourceCounts.cafe}건, 네이버 장소 ${sourceCounts.place}건을 후보로 확인했습니다.`
      }
    ],
    featureCards: [
      { label: '애견미용', value: '확인됨', description: '공공데이터 기준 반려동물 미용 업체로 확인됩니다.' },
      { label: '목욕', value: '개별확인필요', description: '목욕 포함 여부와 사용하는 제품은 예약 상담에서 확인하는 편이 좋습니다.' },
      { label: '위생미용', value: '개별확인필요', description: '발바닥, 발톱, 귀 주변 관리 포함 범위를 업체별로 확인해보세요.' },
      { label: '고양이 미용', value: name.includes('고양이') ? '확인 추천' : '개별확인필요', description: '고양이 미용은 가능 여부와 방식이 업체마다 달라 별도 확인이 필요합니다.' }
    ],
    decisionGuide: {
      goodFor: [
        `${item.dong || '서해구'} 주변에서 가까운 애견미용 업체를 찾는 경우`,
        '공개 후기와 미용 사진을 함께 보고 스타일을 비교하려는 경우',
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
        `${item.dong || '서해구'} 애견미용 업체의 후기 자료량`,
        '블로그나 SNS에 올라온 미용 사진의 스타일',
        '집에서 이동하기 쉬운 거리와 주차 또는 정차 가능성'
      ]
    },
    faqItems: normalizeFaq(draft.faq, item, sourceRefs),
    sourceRefs: sourceRefs.map((ref) => ({
      title: ref.title,
      summary: ref.summary,
      link: ref.link,
      sourceType: ref.sourceType,
      bloggerName: ref.bloggerName
    })),
    reviewSourceSummary: {
      coverageLabel,
      naverMapReviewCount: 0,
      blogCount: sourceCounts.blog,
      cafeCount: sourceCounts.cafe,
      totalCount: sourceRefs.length,
      summary: `${name}은 공개 검색 결과에서 ${sourceRefs.length}건의 후기 후보와 장소 정보를 확인해 미용 응대, 스타일, 방문 전 확인 포인트를 정리했습니다.`,
      chips: [`블로그 ${sourceCounts.blog}건`, `카페 ${sourceCounts.cafe}건`, `참고 링크 ${sourceRefs.length}건`]
    },
    generatedBy: 'vertex-free-draft+codex-edit',
    generatedAt: new Date().toISOString()
  };
}

function buildReviewSection(name, sourceRefs, draft, coverageLabel) {
  const body = cleanText(draft.body || draft.summary || '');
  if (!sourceRefs.length) {
    return `${name}은 현재 직접 확인 가능한 공개 후기가 많지 않습니다. 이 경우 미용 스타일, 예약 방식, 목욕 포함 여부, 추가 비용처럼 실제 이용감에 영향을 주는 항목을 방문 전 직접 확인하는 편이 좋습니다.`;
  }
  const lead = `${name}과 관련해 확인되는 공개 정보에서는 ${coverageLabel} 수준의 후기 후보가 확인됩니다.`;
  const trimmed = body
    .replace(/#{1,6}\s*/g, '')
    .replace(/\|/g, ' ')
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
  return `${lead} ${trimmed}`.slice(0, 900);
}

function inferGoodPoints(sourceRefs) {
  const text = sourceRefs.map((ref) => `${ref.title} ${ref.summary}`).join(' ');
  const points = [];
  if (/스트레스|차분|얌전|처음|예민|순하/.test(text)) points.push('겁이 많거나 예민한 강아지도 차분하게 미용을 받았다는 후기가 보입니다.');
  if (/깔끔|이쁘|예쁘|만족|스타일|컷|곰돌|가위컷/.test(text)) points.push('미용 결과가 깔끔하고 원하는 스타일이 잘 반영됐다는 언급이 보입니다.');
  if (/목욕|스파|피부|털|엉킴|빗질/.test(text)) points.push('목욕, 스파, 털 관리와 관련된 경험담이 함께 확인됩니다.');
  if (/친절|상담|설명|선생님/.test(text)) points.push('상담과 응대가 친절했다는 취지의 후기가 확인됩니다.');
  return points.length ? points : ['공개 후기에서는 미용 스타일과 방문 경험을 참고할 만한 언급이 확인됩니다.'];
}

function defaultCheckPoints() {
  return [
    '공개 후기만으로는 견종별 가능 범위와 정확한 가격을 모두 확인하기 어렵습니다.',
    '털 엉킴, 피부 상태, 원하는 컷에 따라 소요 시간과 비용이 달라질 수 있습니다.',
    '고양이 미용이나 예민한 반려견 미용은 가능 여부를 따로 확인하는 편이 좋습니다.'
  ];
}

function defaultVisitTips(item) {
  return [
    `${item.displayName || item.name} 방문 전 원하는 미용 사진과 최근 미용 시점을 정리해두면 상담이 더 구체적일 수 있습니다.`,
    '피부가 민감하거나 귀, 발, 배 주변을 싫어하는 경우에는 미리 알려주는 편이 좋습니다.',
    '예약 시간, 예상 소요 시간, 보호자 대기 방식, 픽업 시간을 함께 확인해보세요.'
  ];
}

function defaultComparePoints() {
  return [
    '미용 사진의 스타일과 최근 업데이트 여부',
    '예약 방식, 상담 응대, 견종별 가능 범위',
    '목욕, 발톱, 위생미용 포함 여부와 추가 비용 기준'
  ];
}

function normalizeFaq(value, item, sourceRefs) {
  const name = item.displayName || item.name;
  const base = Array.isArray(value)
    ? value
        .map((faq) => ({
          question: cleanText(faq.question || ''),
          answer: cleanText(faq.answer || '')
        }))
        .filter((faq) => faq.question && faq.answer)
        .slice(0, 3)
    : [];
  return [
    ...base,
    {
      question: `${name} 후기는 많은 편인가요?`,
      answer: sourceRefs.length
        ? `공개 검색 기준 ${sourceRefs.length}건의 후기 후보를 확인해 미용 응대와 스타일 관련 내용을 정리했습니다.`
        : '현재 공개적으로 확인되는 후기가 많지 않아 기본 정보 중심으로 정리했습니다.'
    },
    {
      question: '처음 방문할 때 무엇을 준비하면 좋나요?',
      answer: '원하는 미용 사진, 최근 미용 시점, 털 엉킴 정도, 피부나 귀 상태, 낯선 환경에서 예민한 반응이 있는지 등을 미리 정리하면 상담에 도움이 됩니다.'
    }
  ].slice(0, 5);
}

function countSources(sourceRefs) {
  return {
    blog: sourceRefs.filter((ref) => ref.sourceType === 'blog').length,
    cafe: sourceRefs.filter((ref) => ref.sourceType === 'cafe').length,
    place: sourceRefs.filter((ref) => ref.sourceType === 'naver_place').length
  };
}

function isVertexEdited(row) {
  return row?.generatedBy === 'vertex-free-draft+codex-edit';
}

function toNaturalSentence(value, fallbackPredicate) {
  const text = cleanText(value).replace(/[.。]$/g, '');
  if (!text) return '';
  if (/(습니다|니다|해요|좋습니다|어렵습니다|필요합니다)$/.test(text)) return text;
  return `${text} ${fallbackPredicate}.`;
}

function joinSentences(values) {
  return values.filter(Boolean).join(' ');
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean).slice(0, 6);
}

function cleanText(value = '') {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value = '') {
  return stripHtml(value).replace(/\s+/g, '').toLowerCase();
}

function dedupe(refs) {
  const map = new Map();
  for (const ref of refs) {
    const key = ref.link || `${ref.title}-${ref.summary}`;
    if (!key) continue;
    if (!map.has(key)) map.set(key, ref);
  }
  return [...map.values()];
}

function unique(values) {
  return [...new Set(values)];
}

function upsert(rows, row) {
  const index = rows.findIndex((item) => item.sourceId === row.sourceId);
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(credentials.private_key);
  const assertion = `${signingInput}.${base64Url(signature)}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(Number(process.env.GEMINI_OAUTH_TIMEOUT_MS || '30000')),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OAuth token request failed ${response.status}: ${body.slice(0, 500)}`);
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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
