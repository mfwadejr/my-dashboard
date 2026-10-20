/** The small files a status page hands out besides its web page: an SVG badge and an RSS feed. */

const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const width = (t: string) => Math.ceil(t.length * 6.4 + 12);

/** A flat two-part badge: a grey label and a coloured value. Colours are fixed hex values because the file is shown on other websites. */
export function badgeSvg(label: string, value: string, tone: "ok" | "warn" | "bad" | "info" | "mute"): string {
  const colour = { ok: "#2fb872", warn: "#d9a21b", bad: "#d64550", info: "#3d7fe0", mute: "#8a8f99" }[tone];
  const l = label.slice(0, 40), v = value.slice(0, 40), lw = width(l), vw = width(v), w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(l)}: ${esc(v)}"><title>${esc(l)}: ${esc(v)}</title>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${colour}"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(l)}</text><text x="${lw + vw / 2}" y="14">${esc(v)}</text></g></svg>`;
}

export interface FeedItem { id: string; title: string; body: string; style: string; resolved: boolean; createdAt: number; updatedAt: number }

export function rssXml(title: string, link: string, items: FeedItem[]): string {
  const rows = items.map(i => `<item><title>${esc(`${i.resolved ? "[Resolved] " : ""}${i.title}`)}</title><link>${esc(link)}</link><guid isPermaLink="false">${esc(`${i.id}-${i.updatedAt}`)}</guid>` +
    `<pubDate>${new Date(i.updatedAt).toUTCString()}</pubDate><category>${esc(i.resolved ? "resolved" : i.style)}</category><description>${esc(i.body || i.title)}</description></item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title><link>${esc(link)}</link><description>${esc(`Notices from ${title}`)}</description><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${rows}</channel></rss>`;
}
