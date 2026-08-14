import { areaGroups, businesses, longtailGroups, typeGroups } from '../data/siteData';
import { petServiceGroups, petServiceItems } from '../data/petServiceData';

export function GET({ site }: { site: URL }) {
  const urls = [
    '/',
    '/about/',
    '/privacy/',
    '/correction/',
    ...areaGroups.map((group: any) => `/area/${group.slug}/`),
    ...typeGroups.map((group: any) => `/type/${group.slug}/`),
    ...longtailGroups.map((group: any) => `/topic/${group.slug}/`),
    ...businesses.map((item: any) => `/${item.typePath}/${item.slug}/`),
    ...petServiceGroups.map((group: any) => `/pet-service/${group.slug}/`),
    ...petServiceItems.map((item: any) => `/${item.typePath}/${item.slug}/`)
  ];

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((url) => `  <url><loc>${new URL(url, site).toString()}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml' } }
  );
}
