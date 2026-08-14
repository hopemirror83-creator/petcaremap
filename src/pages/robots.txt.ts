export function GET({ site }: { site: URL }) {
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml', site).toString()}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
