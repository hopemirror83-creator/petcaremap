const API_HUB_BASE_URL = 'https://naverapihub.apigw.ntruss.com/search/v1';
const LEGACY_BASE_URL = 'https://openapi.naver.com/v1/search';

export function hasNaverSearchCredentials() {
  return Boolean(
    (process.env.NAVER_API_HUB_CLIENT_ID && process.env.NAVER_API_HUB_CLIENT_SECRET) ||
      (process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET)
  );
}

export function getNaverSearchMode() {
  return process.env.NAVER_API_HUB_CLIENT_ID && process.env.NAVER_API_HUB_CLIENT_SECRET ? 'api-hub' : 'legacy';
}

export async function naverSearch(type, query, options = {}) {
  const display = options.display || 10;
  const start = options.start || 1;
  const sort = options.sort || (type === 'local' ? 'random' : 'sim');
  const mode = getNaverSearchMode();
  const url =
    mode === 'api-hub'
      ? new URL(`${API_HUB_BASE_URL}/${type}`)
      : new URL(`${LEGACY_BASE_URL}/${type}.json`);

  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  url.searchParams.set('start', String(start));
  url.searchParams.set('sort', sort);
  if (mode === 'api-hub') url.searchParams.set('format', 'json');

  const response = await fetch(url, { headers: buildNaverHeaders(mode) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Naver ${mode} ${type} ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = await response.json();
  return json.items || [];
}

function buildNaverHeaders(mode) {
  if (mode === 'api-hub') {
    return {
      'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_API_HUB_CLIENT_ID,
      'X-NCP-APIGW-API-KEY': process.env.NAVER_API_HUB_CLIENT_SECRET
    };
  }
  return {
    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
  };
}
