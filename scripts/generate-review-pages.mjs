import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './env.mjs';

const ROOT = process.cwd();
loadDotEnv(ROOT);

const PUBLIC_FILE = path.join(ROOT, 'data', 'public-businesses.json');
const NAVER_FILE = path.join(ROOT, 'data', 'naver-local-businesses.json');
const REVIEW_FILE = path.join(ROOT, 'data', 'naver-review-sources.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'generated-review-pages.json');
const FAILED_FILE = path.join(ROOT, 'data', 'failed-review-pages.json');
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const location = process.env.VERTEX_LOCATION || 'us-central1';
const model = process.env.VERTEX_GEMINI_MODEL || 'gemini-2.5-flash';
const limit = Number(process.env.GEMINI_LIMIT || '10');
const maxRetries = Number(process.env.GEMINI_MAX_RETRIES || '4');
const retryBaseDelayMs = Number(process.env.GEMINI_RETRY_BASE_DELAY_MS || '60000');
const requestTimeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || '90000');
const oauthTimeoutMs = Number(process.env.GEMINI_OAUTH_TIMEOUT_MS || '30000');
const targetCity = process.env.TARGET_CITY || '';
const targetDistrict = process.env.TARGET_DISTRICT || '';
const targetDistricts = new Set(
  (process.env.TARGET_DISTRICTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const targetSourceIds = new Set(
  (process.env.TARGET_SOURCE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const SEOUL_PRIORITY_DISTRICTS = new Set(['강남구', '송파구', '마포구', '성북구', '도봉구']);
const targetScope = process.env.TARGET_SCOPE || 'incheon-seoul-priority';

if (!credentialsPath) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required for Vertex AI Gemini generation.');
}

const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const projectId = process.env.VERTEX_PROJECT_ID || credentials.project_id;
if (!projectId || !credentials.client_email || !credentials.private_key) {
  throw new Error('Service account JSON must include project_id, client_email, and private_key.');
}

const businesses = await readJson(PUBLIC_FILE, []);
const naverRows = await readJson(NAVER_FILE, []);
const reviews = await readJson(REVIEW_FILE, []);
const naverMap = new Map(naverRows.map((row) => [row.sourceId, row]));
const reviewMap = new Map(reviews.map((row) => [row.sourceId, row]));
const existing = await readJson(OUTPUT_FILE, []);
const existingMap = new Map(existing.map((row) => [row.sourceId, row]));
const failed = await readJson(FAILED_FILE, []);
const failedSourceIds = new Set(failed.map((row) => row.sourceId).filter(Boolean));
const token = await getAccessToken(credentials);
const targets = businesses
  .filter((item) => item.businessType === 'clinic')
  .filter((item) => targetSourceIds.size === 0 || targetSourceIds.has(item.sourceId))
  .filter((item) => targetSourceIds.size > 0 || shouldIncludeScope(item))
  .filter((item) => !targetCity || item.city === targetCity)
  .filter((item) => !targetDistrict || item.district === targetDistrict)
  .filter((item) => targetDistricts.size === 0 || targetDistricts.has(item.district))
  .map((item) => ({ ...item, ...(naverMap.get(item.sourceId) || {}) }))
  .filter((item) => process.env.FORCE_GEMINI_ALL === '1' || item.naverLocal || item.naverMatchStatus === 'matched' || (reviewMap.get(item.sourceId)?.sourceRefs || []).length > 0)
  .sort((a, b) => reviewScore(b) - reviewScore(a))
  .filter((item) => !existingMap.has(item.sourceId) || process.env.FORCE_GEMINI === '1')
  .filter((item) => process.env.SKIP_FAILED_GEMINI !== '1' || !failedSourceIds.has(item.sourceId))
  .slice(0, limit);

const generated = [...existing];
await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await mkdir(path.dirname(FAILED_FILE), { recursive: true });
for (const item of targets) {
  const reviewData = reviewMap.get(item.sourceId) || {};
  try {
    const page = await generateArticleWithRetry(token, item, reviewData);
    const existingIndex = generated.findIndex((row) => row.sourceId === item.sourceId);
    const nextPage = { sourceId: item.sourceId, ...page, generatedBy: `vertex:${model}`, generatedAt: new Date().toISOString() };
    if (existingIndex >= 0) {
      generated[existingIndex] = nextPage;
    } else {
      generated.push(nextPage);
    }
    console.log(`Generated SEO article: ${item.displayName || item.name}`);
    generated.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    await writeFile(OUTPUT_FILE, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
  } catch (error) {
    failed.push({
      sourceId: item.sourceId,
      name: item.displayName || item.name,
      message: error.message,
      failedAt: new Date().toISOString()
    });
    await writeFile(FAILED_FILE, `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
    console.log(`Skipped SEO article after retries: ${item.displayName || item.name} (${error.message})`);
  }
  if (Number(process.env.GEMINI_DELAY_MS || '0') > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.GEMINI_DELAY_MS)));
  }
}

generated.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
await writeFile(OUTPUT_FILE, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
console.log(`Wrote ${path.relative(ROOT, OUTPUT_FILE)} (${generated.length} generated pages)`);

async function generateArticleWithRetry(token, item, reviewData) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await generateArticle(token, item, reviewData);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) break;
      const delay = retryBaseDelayMs * Math.pow(2, attempt);
      console.log(`Vertex retry ${attempt + 1}/${maxRetries}: ${item.displayName || item.name} (${error.message.slice(0, 120)}) wait ${Math.round(delay / 1000)}s`);
      await wait(delay);
    }
  }
  throw lastError;
}

async function generateArticle(token, item, reviewData) {
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const prompt = buildPrompt(item, reviewData);
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.35,
        topP: 0.9,
        responseMimeType: 'application/json'
      }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Vertex Gemini failed ${response.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!text) throw new Error(`Vertex Gemini returned empty content for ${item.displayName || item.name}`);
  return sanitizePage(JSON.parse(text), item, reviewData);
}

function isRetryableError(error) {
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED/i.test(error.message || '');
}

function buildPrompt(item, reviewData) {
  const matchedRefs = filterRelevantReviewRefs(item, reviewData.sourceRefs || []);
  return [
    '당신은 동물병원 홍보글 작성자가 아니라, 공개 검색 결과와 후기 후보를 읽고 보호자의 의사결정을 돕는 후기 분석가입니다.',
    '제공된 후기 자료의 제목과 요약에서 반복적으로 보이는 내용을 근거로만 분석해 주세요.',
    '문체는 차분하고 객관적인 정보 사이트 톤으로 작성합니다. 광고 문구, 과장, 미사여구, 병원 입장의 약속 표현은 쓰지 않습니다.',
    '검색 최적화(SEO)를 고려하되 키워드는 자연스럽게만 사용합니다.',
    '한국 독자가 실제로 쓰는 표현을 사용하고, 영어식 표현이나 어색한 번역체는 피합니다.',
    '',
    '작성 기준:',
    '- 전체 글은 후기 분석 중심으로 작성합니다.',
    '- "이런 점이 좋았다고 언급되었습니다", "이런 점은 아쉬웠다고 지적됩니다", "후기에서는 ~라는 반응이 보입니다" 같은 전달형 문장을 사용합니다.',
    '- 좋은 점과 아쉬운 점을 모두 분리해서 정리합니다. 아쉬운 점이 후기 자료에 없으면 "뚜렷하게 반복되는 아쉬운 점은 많지 않습니다"라고 씁니다.',
    '- 병원이 직접 말하는 듯한 표현을 쓰지 않습니다. 예: 최선을 다하겠습니다, 믿고 맡길 수 있습니다, 건강 지킴이, 좋은 선택지, 추천드립니다.',
    '- 후기 자료에 없는 시설, 장비, 진료 철학, 의료진 숙련도, 전문성은 추정해서 쓰지 않습니다.',
    '- 후기가 없으면 억지로 길게 쓰지 말고 "이 병원은 현재 확인 가능한 공개 후기가 많지 않습니다"라고 짧고 정직하게 씁니다.',
    '- 분량은 후기 자료 수준에 따라 다르게 작성합니다.',
    '- 후기 자료 풍부: 공개 후기 후보가 6건 이상이면 1400~1800자로 장점, 아쉬운 점, 비교 기준을 충분히 분석합니다.',
    '- 후기 일부 확인: 공개 후기 후보가 3~5건이면 1000~1400자로 반복 언급과 확인 포인트를 중심으로 정리합니다.',
    '- 후기 자료 제한적: 공개 후기 후보가 1~2건이면 700~1000자로 기본 정보와 확인 가능한 단서만 정리합니다.',
    '- 공개 후기 부족: 공개 후기 후보가 없으면 500~700자로 기본 정보와 방문 전 확인사항만 짧고 정직하게 씁니다.',
    '',
    '업체 기본정보:',
    `업체명: ${item.displayName || item.name}`,
    `주소: ${item.roadAddress || item.lotAddress || ''}`,
    `전화번호: ${item.phone || ''}`,
    `지역: ${[item.city, item.district, item.dong].filter(Boolean).join(' ')}`,
    `네이버 카테고리: ${item.category || ''}`,
    `운영상태: ${item.operationStatus || ''}`,
    '',
    '후기 자료:',
    matchedRefs.length ? summarizeReviewRefs(matchedRefs) : '없음. 이 경우 후기 부분에는 "이 병원은 현재 확인 가능한 공개 후기가 많지 않습니다"라고 작성해 주세요.',
    '',
    '아래 JSON 형식으로만 반환해 주세요:',
    JSON.stringify({
      title: 'SEO 제목',
      metaDescription: '검색 결과 설명 120자 안팎',
      oneLineSummary: '한 문장 요약',
      introSection: '도입 문단',
      serviceSection: '기본정보 설명',
      checkSection: '방문 전 확인할 내용',
      reviewSection: '후기 분석. 좋았던 점, 아쉬운 점, 확인할 점을 포함. 후기가 부족하면 짧게 작성',
      articleSections: [
        { heading: '공개 후기에서 좋게 언급된 점', body: '본문' },
        { heading: '아쉬운 점이나 확인이 필요한 부분', body: '본문' },
        { heading: '방문 전 참고하면 좋은 정보', body: '본문' },
        { heading: '이 병원을 비교할 때 볼 만한 기준', body: '본문' }
      ],
      frequentMentions: ['후기에서 언급된 내용'],
      checkPoints: ['방문 전 참고할 내용'],
      guardianQuestions: ['보호자가 궁금해할 질문'],
      reviewShortage: false,
      confidenceNote: '후기 여부'
    })
  ].join('\n');
}

function sanitizePage(page, item, reviewData) {
  const matchedRefs = filterRelevantReviewRefs(item, reviewData.sourceRefs || []);
  const sourceCount = matchedRefs.length;
  const title = cleanText(page.title || `${item.district} ${item.displayName || item.name} 후기, 진료정보, 위치 정리`).slice(0, 90);
  const metaDescription = cleanText(page.metaDescription || `${item.displayName || item.name}의 주소, 전화번호, 위치, 후기와 방문 전 확인사항을 정리했습니다.`).slice(0, 160);
  const articleSections = normalizeSections(page.articleSections);
  const fallbackReview = sourceCount
    ? '후기에서는 상담, 위치, 진료 경험과 관련된 내용이 확인됩니다. 다만 후기는 보호자별 방문 시점과 상황에 따라 달라질 수 있어 참고용으로 보는 것이 좋습니다.'
    : '현재 이 병원명으로 직접 확인되는 후기는 많지 않습니다. 방문 전에는 운영시간, 진료 가능 범위, 예약 여부를 병원에 직접 확인하는 것이 좋습니다.';

  return {
    title,
    metaDescription,
    oneLineSummary: cleanText(page.oneLineSummary || metaDescription).slice(0, 240),
    introSection: cleanText(page.introSection || ''),
    serviceSection: cleanText(page.serviceSection || ''),
    checkSection: cleanText(page.checkSection || ''),
    reviewSection: cleanText(page.reviewSection || fallbackReview),
    articleSections,
    frequentMentions: normalizeArray(page.frequentMentions, []).slice(0, 8),
    checkPoints: normalizeArray(page.checkPoints, []).slice(0, 8),
    guardianQuestions: normalizeArray(page.guardianQuestions, []).slice(0, 8),
    reviewShortage: Boolean(page.reviewShortage) || sourceCount === 0,
    confidenceNote: cleanText(page.confidenceNote || (sourceCount ? '' : '현재 이 병원명으로 직접 확인되는 후기는 많지 않습니다.')).slice(0, 220),
    cautionPoints: []
  };
}

function shouldIncludeScope(item) {
  if (!targetScope || targetScope === 'all') return true;
  if (targetScope === 'incheon-seoul-priority') return item.city === '인천' || (item.city === '서울' && SEOUL_PRIORITY_DISTRICTS.has(item.district));
  if (targetScope === 'incheon') return item.city === '인천';
  if (targetScope === 'incheon-seogu') {
    return item.city === '인천' && ['서구', '서해구', '검단구'].includes(item.district);
  }
  return true;
}

function reviewScore(item) {
  const data = reviewMap.get(item.sourceId) || {};
  const refs = filterRelevantReviewRefs(item, data.sourceRefs || []);
  const signals = data.reviewSignals || [];
  return refs.length * 10 + signals.length;
}

function filterRelevantReviewRefs(item, refs = []) {
  const names = [
    item.displayName,
    item.name,
    String(item.displayName || item.name || '').replace(/\s+/g, ''),
    String(item.displayName || item.name || '').replace(/\s*동물병원\s*$/, '').replace(/\s+/g, '')
  ]
    .filter(Boolean)
    .filter((name) => String(name).length >= 3);
  return refs.filter((ref) => {
    if (/\.pdf($|\?)/i.test(ref.link || '')) return false;
    const text = `${ref.title || ''} ${ref.summary || ''}`.replace(/\s+/g, '');
    return names.some((name) => text.includes(String(name).replace(/\s+/g, '')));
  });
}

function summarizeReviewRefs(sourceRefs = []) {
  const summaries = sourceRefs
    .filter((ref) => !/\.pdf($|\?)/i.test(ref.link || ''))
    .slice(0, 8)
    .map((ref) => `${ref.title || ''} ${ref.summary || ''}`.trim())
    .filter(Boolean)
    .map((text) => text.slice(0, 240));
  return summaries.length ? summaries.join(' / ') : '없음';
}

function normalizeSections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((section) => ({
      heading: cleanText(section?.heading || section?.title || ''),
      body: cleanText(section?.body || section?.text || '')
    }))
    .filter((section) => section.heading && section.body)
    .slice(0, 8);
}

function normalizeArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item) => {
      if (typeof item === 'string') return cleanText(item);
      if (item && typeof item === 'object') return cleanText(item.label || item.title || item.text || item.summary || '');
      return '';
    })
    .filter(Boolean);
}

function cleanText(value = '') {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    return cleanText(
      value.text ||
      value.body ||
      value.summary ||
      value.content ||
      value.description ||
      Object.values(value).find((item) => typeof item === 'string') ||
      ''
    );
  }

  return String(value || '')
    .replaceAll('[object Object]', '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+\*\s+/g, ' ')
    .replaceAll('후기 신호', '후기')
    .replaceAll('검색 신호', '검색 결과')
    .replaceAll('후기 후보', '후기')
    .replaceAll('제공된 홍보 자료', '검색 결과')
    .replaceAll('홍보 자료', '검색 결과')
    .replaceAll('진료 능력에 대한 기대를 가질 수 있습니다', '관련 진료 경험이 후기에서 언급됩니다')
    .replaceAll('믿고 맡길 수 있는', '방문 전 참고할 만한')
    .replaceAll('좋은 선택지가 될 것입니다', '비교 후보로 살펴볼 수 있습니다')
    .replaceAll('추천드립니다', '살펴볼 수 있습니다')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    signal: AbortSignal.timeout(oauthTimeoutMs),
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
