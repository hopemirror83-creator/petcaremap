import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ENRICHMENT_FILE = path.join(ROOT, 'data', 'pet-service-enrichment.json');
const DRAFT_FILE = path.join(ROOT, 'data', 'pet-grooming-vertex-drafts-seohae-a9.json');
const PUBLIC_FILE = path.join(ROOT, 'data', 'public-grooming-businesses.json');

const enrichmentRows = await readJson(ENRICHMENT_FILE, []);
const draftRows = await readJson(DRAFT_FILE, []);
const publicRows = await readJson(PUBLIC_FILE, []);
const draftMap = new Map(draftRows.map((row) => [row.sourceId, row]));
const publicMap = new Map(publicRows.map((row) => [row.sourceId, row]));
const targetIds = new Set(draftRows.map((row) => row.sourceId));

const nextRows = enrichmentRows.map((row) => {
  if (!targetIds.has(row.sourceId)) return row;
  return polishRow(row, publicMap.get(row.sourceId) || {}, draftMap.get(row.sourceId));
});

await writeFile(ENRICHMENT_FILE, `${JSON.stringify(nextRows, null, 2)}\n`, 'utf8');
console.log(`Polished ${targetIds.size} grooming enrichment rows with Vertex-first copy.`);

function polishRow(row, publicRow, draftRow) {
  const draft = draftRow.vertexDraft || {};
  const sourceRefs = draftRow.sourceRefs || row.sourceRefs || [];
  const counts = countSources(sourceRefs);
  const name = publicRow.displayName || publicRow.name || draftRow.name || row.displayName || row.name;
  const dong = publicRow.dong || row.dong || '';
  const area = ['인천 서해구', dong].filter(Boolean).join(' ');
  const goodPoints = normalizeArray(draft.goodPoints).length ? normalizeArray(draft.goodPoints) : extractGoodPointsFromBody(draft.body);
  const checkPoints = normalizeArray(draft.checkPoints);
  const visitTips = normalizeArray(draft.visitTips);
  const comparePoints = normalizeArray(draft.comparePoints);
  const sections = extractArticleSections(draft.body, name, {
    area,
    goodPoints,
    checkPoints,
    visitTips,
    comparePoints
  });

  return {
    ...row,
    title: `${area} 애견미용샵 ${name} 후기 모음`,
    metaDescription: `${area} ${name}의 위치, 애견미용 후기, 네이버 지도, 예약 전 확인할 점과 주변 업체 비교 기준을 정리했습니다.`,
    oneLineSummary: `${area} 애견미용샵 ${name} 관련 공개 후기와 업체 기본정보를 바탕으로 미용 스타일, 응대 방식, 방문 전 확인할 점을 정리했습니다.`,
    reviewCoverageLabel: coverageLabel(sourceRefs.length),
    reviewSection: buildReviewSection({
      name,
      area,
      counts,
      sourceCount: sourceRefs.length,
      goodPoints,
      checkPoints,
      sections
    }),
    articleSections: sections,
    reviewAnalysisCards: buildReviewCards({ sourceRefs, counts, goodPoints, checkPoints, visitTips }),
    reviewSourceSummary: {
      coverageLabel: coverageLabel(sourceRefs.length),
      naverMapReviewCount: 0,
      blogCount: counts.blog,
      cafeCount: counts.cafe,
      totalCount: sourceRefs.length,
      summary: sourceSummaryText(name, counts, sourceRefs.length),
      chips: [`블로그 ${counts.blog}건`, `카페 ${counts.cafe}건`, `참고 링크 ${sourceRefs.length}건`]
    },
    faqItems: polishFaq(row.faqItems, draft.faq, name, sourceRefs.length),
    generatedBy: 'vertex-draft+light-codex-edit',
    polishedAt: new Date().toISOString()
  };
}

function buildReviewSection({ name, area, counts, sourceCount, goodPoints, checkPoints, sections }) {
  const paragraphs = [];
  paragraphs.push(
    sourceCount
      ? `${area} 애견미용샵 ${name}${topicJosa(name)} 공개 후기와 업체 기본정보를 함께 참고해 정리했습니다. ${sourceSummaryText('', counts, sourceCount).replace(/^은\s*/, '')}이 확인됩니다.`
      : `${area} 애견미용샵 ${name}${topicJosa(name)} 현재 공개적으로 확인되는 후기가 많지 않아 기본 정보와 위치를 중심으로 정리했습니다.`
  );

  const reviewText = collectReviewText(sections);
  if (reviewText) {
    paragraphs.push(reviewText);
  } else if (goodPoints.length) {
    paragraphs.push(`${name} 관련 후기에서는 ${joinKoreanList(goodPoints)} 등이 주로 언급됩니다.`);
  }

  if (checkPoints.length) {
    paragraphs.push(`다만 ${formatCheckList(checkPoints)} 같은 항목은 예약 전에 업체 채널에서 한 번 더 확인하는 편이 좋습니다.`);
  }

  return paragraphs.filter(Boolean).join('\n\n');
}

function collectReviewText(sections) {
  const reviewSection = sections.find((section) => /후기|장점|좋아|만족|이용/.test(section.heading));
  if (!reviewSection?.body) return '';
  const chunks = reviewSection.body
    .split(/\n{2,}/)
    .map((text) => cleanText(text))
    .filter(Boolean)
    .filter((text) => !/^업체명:|^지역:|^주소:|^전화번호:|^주요 서비스:/i.test(text))
    .filter((text) => !/방문해 보시는 것은 어떨까요|강력 추천|최고의 서비스를 선물/.test(text));
  const selected = chunks.slice(0, 5).join('\n\n');
  return splitLabeledParagraphs(trimParagraph(selected, 1400));
}

function splitLabeledParagraphs(value) {
  const labels = [
    '숙련된 무마취 미용 기술',
    '깔끔하고 쾌적한 환경',
    '고양이를 사랑하는 전문가',
    '주차 편의성',
    '반려견 및 반려묘 모두 이용 가능',
    '만족스러운 미용 결과',
    '스파 및 추가 관리',
    '빠르고 섬세한 무마취 미용',
    '친절한 실장님과 전문적인 케어',
    '고양이 호텔링 서비스',
    '다양한 견종 맞춤 미용',
    '고양이 무마취 미용도 가능'
  ];
  let next = String(value || '');
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    next = next.replace(new RegExp(`\\s+(${escaped}:)`, 'g'), '\n\n$1');
  }
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

function extractArticleSections(body = '', name, fallback) {
  const lines = String(body || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = [];
  let current = { heading: '업체 소개와 기본정보', lines: [] };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      pushSection(sections, current);
      current = { heading, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  pushSection(sections, current);

  const cleaned = sections
    .map((section) => ({
      heading: cleanHeading(section.heading, name),
      body: cleanBody(section.lines.join('\n'), name)
    }))
    .filter((section) => section.heading && section.body)
    .filter((section) => !/여행|가이드|결론|마무리/.test(section.heading))
    .slice(0, 6);

  if (cleaned.length >= 3) return cleaned;
  return fallbackSections(name, fallback);
}

function pushSection(sections, section) {
  if (!section || !section.lines?.length) return;
  sections.push(section);
}

function parseHeading(line) {
  const markdown = line.match(/^#{2,4}\s+(.+)$/);
  if (markdown) return markdown[1];
  const bold = line.match(/^\*\*([^*]+)\*\*$/);
  if (bold) return bold[1];
  if (/^(업체 기본 정보|기본 정보|방문 전 참고 정보|이용 후기|솔직한 이용 후기|다양한 후기|장점 및 후기|이런 후기|이런 점들이 좋아요|이용 시 참고사항|자주 묻는 질문)/.test(line)) {
    return line.replace(/[:：]$/, '');
  }
  return '';
}

function cleanHeading(heading, name) {
  return cleanText(heading)
    .replace(/['"]/g, '')
    .replace(new RegExp(`^${escapeRegExp(name)}\\s*`, 'i'), '')
    .replace(/방문 후기$/, '후기')
    .replace(/^이용 후기 엿보기$/, '이용 후기')
    .replace(/^솔직한 이용 후기 살펴보기$/, '이용 후기')
    .replace(/^다양한 후기 속 .*$/, '이용 후기')
    .replace(/^,\s*어떤 곳인가요\??$/, '업체 소개')
    .replace(/^,\s*이런 점들이 좋습니다$/, '후기에서 좋게 언급된 점')
    .replace(/^,\s*이런 점들이 좋아요!?$/, '후기에서 좋게 언급된 점')
    .replace(/^,\s*방문 전 참고하세요$/, '방문 전 참고 정보')
    .replace(/^,\s*더 알아볼까요\??$/, '추가로 확인할 정보')
    .replace(/^다양한 서비스로 반려견의 건강과 아름다움을 관리해요$/, '서비스와 관리 방식')
    .replace(/^(.+)의 장점 및 후기$/, '후기에서 언급된 장점')
    .replace(/^의\s+장점\s+및\s+후기$/, '후기에서 언급된 장점')
    .replace(/^(.+), 어떤 곳인가요\??$/, '업체 소개')
    .replace(/^(.+) 기본 정보$/, '기본 정보')
    .replace(/^이런 점들이 좋아요!?$/, '후기에서 좋게 언급된 점')
    .replace(/^더 알아볼까요\??$/, '추가로 확인할 정보')
    .trim();
}

function cleanBody(value, name) {
  const text = String(value || '')
    .split('\n')
    .map((line) => cleanLine(line, name))
    .filter(Boolean)
    .filter((line) => !/자세한_사항은_구매_페이지|정가:|할인가:|할인율:/.test(line))
    .join('\n');

  const paragraphs = text
    .split(/\n(?=(?:\d+\.\s|\*\s|-|\S))/)
    .map((part) => part.trim())
    .filter(Boolean);

  return paragraphs
    .map((part) => normalizeParagraph(part, name))
    .filter(Boolean)
    .join('\n\n');
}

function cleanLine(line, name) {
  let next = cleanText(line)
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  next = removeAdTone(next);
  if (!next) return '';
  if (/^안녕하세요!?$/.test(next)) return '';
  if (/^Q\.?\s*/.test(next) || /^A\.?\s*/.test(next)) return next;
  if (/방문해 보시는 것은 어떨까요|강력 추천|최선을 다할 것을 약속/.test(next)) return '';
  return next;
}

function normalizeParagraph(paragraph, name) {
  let next = paragraph
    .replace(/안녕하세요!\s*/g, '')
    .replace(/오늘은\s+/g, '')
    .replace(/소개해 드리려고 합니다/g, '정리해보겠습니다')
    .replace(/공유해 드릴게요/g, '정리했습니다')
    .replace(/주목해 주세요\.?/g, '')
    .replace(/큰 장점입니다/g, '눈에 띄는 부분입니다')
    .replace(/큰 장점으로 보입니다/g, '눈에 띄는 부분으로 보입니다')
    .replace(/매우 중요하죠/g, '중요합니다')
    .replace(/큰 도움이 됩니다/g, '도움이 된다는 의견이 있습니다')
    .replace(/기대할 수 있습니다/g, '기대된다는 설명이 있습니다')
    .replace(/좋은 선택지가 될 수 있습니다/g, '비교해볼 만한 곳으로 언급됩니다')
    .replace(/믿고 맡길 수 있는 곳/g, '안심하고 맡겼다는 후기가 있는 곳')
    .replace(/많은 사랑을 받고 있습니다/g, '후기에서 자주 언급됩니다')
    .replace(/고객/g, '보호자')
    .replace(/고객들/g, '보호자들')
    .replace(/집사님/g, '보호자')
    .replace(/집사님들/g, '보호자들')
    .replace(new RegExp(`${escapeRegExp(name)}을 이용`, 'g'), `${name}을 이용`)
    .replace(new RegExp(`${escapeRegExp(name)} 방문`, 'g'), `${name} 방문`)
    .trim();

  next = removeAdTone(next);
  if (/^업체명:|^지역:|^주소:|^전화번호:|^위치:|^주요 서비스:|^특징:/.test(next)) return next;
  return trimParagraph(next, 900);
}

function removeAdTone(text) {
  return String(text || '')
    .replace(/현재 코덱스에서 수집된 정보 중에서는/g, '현재 공개 자료에서는')
    .replace(/최고 수준의/g, '높은 수준의')
    .replace(/최적의/g, '잘 맞는')
    .replace(/완벽한/g, '만족스러운')
    .replace(/책임집니다/g, '관리한다는 설명이 있습니다')
    .replace(/최상의/g, '좋은')
    .replace(/책임져요/g, '관리해요')
    .replace(/선사하고자 노력하는/g, '제공하는')
    .replace(/차별화된 서비스를 제공하며/g, '여러 서비스를 제공하며')
    .replace(/많은 반려인들의 관심을 받고 있습니다/g, '후기와 소개글에서 언급됩니다')
    .replace(/아름다움을 책임집니다/g, '미용 관리를 돕는다고 소개됩니다')
    .replace(/많은 보호자들의 재방문을 이끌어내고 있습니다/g, '재방문 후기도 보입니다')
    .replace(/칭찬을 아끼지 않습니다/g, '좋게 언급합니다')
    .replace(/고려해 보시는 것은 어떨까요\??/g, '비교해볼 만합니다')
    .replace(/방문해 보시는 것은 어떨까요\??/g, '비교해볼 만합니다')
    .replace(/강력 추천합니다/g, '참고해볼 만합니다')
    .replace(/최고의 서비스를 선물해보는 것은 어떨까요\??/g, '서비스 내용을 비교해볼 만합니다')
    .replace(/우리 아이에게 최고의 서비스를 선물해보는 것은 어떨까요\??/g, '서비스 내용을 비교해볼 만합니다')
    .replace(/고객/g, '보호자')
    .trim();
}

function fallbackSections(name, { goodPoints, checkPoints, visitTips, comparePoints }) {
  return [
    {
      heading: '공개 후기에서 좋게 언급된 점',
      body: `${name} 관련 후기에서는 ${joinKoreanList(goodPoints)} 등이 언급됩니다. 미용 결과나 응대 방식은 반려동물의 성향과 털 상태에 따라 다르게 느껴질 수 있으므로, 사진 후기와 상담 내용을 함께 보는 편이 좋습니다.`
    },
    {
      heading: '방문 전 참고하면 좋은 정보',
      body: `${joinKoreanList(visitTips.length ? visitTips : checkPoints)} 부분을 방문 전에 확인하면 좋습니다. 원하는 미용 사진, 최근 미용 시점, 피부나 귀 상태, 낯선 환경에서 예민한 반응이 있는지 등을 미리 알려주면 상담이 더 구체적입니다.`
    },
    {
      heading: '이 업체를 비교할 때 볼 만한 기준',
      body: `${joinKoreanList(comparePoints.length ? comparePoints : ['미용 스타일', '예약 방식', '후기 사진', '목욕과 위생미용 포함 범위'])}을 함께 비교해보세요.`
    }
  ];
}

function buildReviewCards({ sourceRefs, counts, goodPoints, checkPoints, visitTips }) {
  return [
    {
      label: '후기에서 많이 보인 점',
      value: sourceRefs.length ? '후기 확인' : '개별확인필요',
      description: firstUseful(goodPoints) || '공개 후기에서 반복되는 표현을 중심으로 정리했습니다.'
    },
    {
      label: '미용 스타일',
      value: hasAny(goodPoints, /미용|스타일|컷|가위|무마취|스파/) ? '언급 있음' : '사진 확인 추천',
      description: findUseful(goodPoints, /미용|스타일|컷|가위|무마취|스파/) || '원하는 컷 사진과 실제 후기 사진을 함께 보는 편이 좋습니다.'
    },
    {
      label: '방문 전 확인',
      value: checkPoints.length || visitTips.length ? '확인 추천' : '개별확인필요',
      description: firstUseful(checkPoints) || firstUseful(visitTips) || '예약 방식과 가능한 시간대를 먼저 확인해보세요.'
    },
    {
      label: '후기 참고량',
      value: `${sourceRefs.length}건`,
      description: `블로그 ${counts.blog}건, 카페 ${counts.cafe}건, 네이버 장소 ${counts.place}건을 참고했습니다.`
    }
  ];
}

function polishFaq(existingFaq = [], draftFaq = [], name, sourceCount) {
  const merged = [...(Array.isArray(draftFaq) ? draftFaq : []), ...(Array.isArray(existingFaq) ? existingFaq : [])]
    .map((faq) => ({ question: cleanText(faq.question || ''), answer: normalizeParagraph(faq.answer || '', name) }))
    .filter((faq) => faq.question && faq.answer)
    .filter((faq) => !/강력 추천|방문해 보시는 것은 어떨까요/.test(faq.answer));
  const seen = new Set();
  return merged.filter((faq) => {
    const key = faq.question.replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5).concat([
    {
      question: `${name} 후기는 어느 정도 참고할 수 있나요?`,
      answer: sourceCount > 0
        ? `공개 검색에서 ${sourceCount}건의 참고 링크를 확인했고, 반복적으로 보이는 내용을 중심으로 정리했습니다.`
        : '현재 공개적으로 확인되는 후기가 많지 않아 기본 정보 중심으로 정리했습니다.'
    }
  ]).slice(0, 5);
}

function sourceSummaryText(name, counts, sourceCount) {
  if (!sourceCount) return `${name ? `${name}은 ` : ''}공개 후기 자료가 많지 않습니다`;
  const parts = [
    counts.blog ? `블로그 ${counts.blog}건` : '',
    counts.cafe ? `카페 ${counts.cafe}건` : '',
    counts.place ? `네이버 장소 정보 ${counts.place}건` : ''
  ].filter(Boolean);
  return `${name ? `${name} 관련 공개 검색에서는 ` : ''}${parts.join(', ') || `${sourceCount}건의 자료`}`;
}

function coverageLabel(count) {
  if (count >= 6) return '후기 자료 충분';
  if (count >= 3) return '후기 일부 확인';
  if (count > 0) return '후기 참고 가능';
  return '공개 후기 부족';
}

function countSources(sourceRefs) {
  return {
    blog: sourceRefs.filter((ref) => ref.sourceType === 'blog').length,
    cafe: sourceRefs.filter((ref) => ref.sourceType === 'cafe').length,
    place: sourceRefs.filter((ref) => ref.sourceType === 'naver_place').length
  };
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).map(removeAdTone).filter(Boolean).slice(0, 8);
}

function extractGoodPointsFromBody(body = '') {
  const text = String(body);
  const points = [];
  if (/무마취/.test(text)) points.push('무마취 미용');
  if (/깔끔|쾌적|청결/.test(text)) points.push('깔끔한 환경');
  if (/친절|안심|세심|전문/.test(text)) points.push('세심한 응대');
  if (/주차/.test(text)) points.push('주차 편의');
  if (/만족|예쁘|스타일|가위컷/.test(text)) points.push('미용 결과 만족');
  return points.length ? points : ['미용 스타일과 방문 경험'];
}

function joinKoreanList(items) {
  const list = items.map(cleanText).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')}, ${list.at(-1)}`;
}

function formatCheckList(items) {
  const cleaned = items.map((item) => cleanText(item)
    .replace(/[.。]+$/g, '')
    .replace(/\(수집된 정보에 일부만 기재됨\)/g, '')
    .replace(/\(이용 시 직접 확인\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/확인 필요/g, '확인')
    .replace(/확인해야 함/g, '확인')
    .replace(/문의 필요/g, '문의')
    .replace(/필수임/g, '필수')
    .replace(/해야 함/g, '여부')
    .replace(/필요합니다/g, '확인')
    .replace(/필요$/g, '확인')
    .replace(/정보 미제공/g, '정보')
    .replace(/정보 부재/g, '정보')
    .replace(/정보 부족/g, '정보')
    .replace(/공식적인 확인이$/g, '공식 정보')
    .replace(/상세 정보는 매장$/g, '상세 정보')
    .replace(/사전 예약이$/g, '사전 예약')
    .replace(/가능 여부를$/g, '가능 여부')
    .replace(/부족$/g, '자료')
    .replace(/확인$/g, '')
    .replace(/문의$/g, '')
    .replace(/권장$/g, '')
    .replace(/필수$/g, '')
    .replace(/여부$/g, '')
    .trim())
    .filter(Boolean);
  return joinKoreanList(cleaned);
}

function topicJosa(value) {
  const last = Array.from(String(value || '').trim()).at(-1);
  if (!last) return '은';
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return '은';
  return (code - 0xac00) % 28 === 0 ? '는' : '은';
}

function cleanText(value = '') {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\d+\.\s*/gm, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function trimParagraph(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength);
  const stops = ['습니다.', '니다.', '어요.', '죠.', '다.', '.'];
  const lastStop = Math.max(...stops.map((stop) => sliced.lastIndexOf(stop)));
  if (lastStop > 160) return sliced.slice(0, lastStop + 1).trim();
  return sliced.replace(/\s+\S*$/, '').trim();
}

function firstUseful(items) {
  return items.find((item) => item && item.length >= 4) || '';
}

function findUseful(items, pattern) {
  return items.find((item) => pattern.test(item)) || '';
}

function hasAny(items, pattern) {
  return items.some((item) => pattern.test(item));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readJson(file, fallback = []) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
