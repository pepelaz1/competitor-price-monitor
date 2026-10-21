export function extractPrice(html) {
  const text = String(html);
  const metaTags = text.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const property = attr(tag, 'property') || attr(tag, 'itemprop') || attr(tag, 'name');
    if (/^(product:price:amount|price)$/i.test(property)) {
      const amount = parseAmount(attr(tag, 'content'));
      if (amount !== null) return amount;
    }
  }
  const blocks = [...text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, block] of blocks) {
    try {
      const price = findJsonPrice(JSON.parse(block));
      if (price !== null) return price;
    } catch { /* Some shops emit invalid JSON-LD. */ }
  }
  return null;
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

export function parseAmount(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).replace(/\s|\u00a0/g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const amount = Number(value);
  return value && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function findJsonPrice(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJsonPrice(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.price !== undefined) {
    const price = parseAmount(node.price);
    if (price !== null) return price;
  }
  if (node.lowPrice !== undefined) {
    const price = parseAmount(node.lowPrice);
    if (price !== null) return price;
  }
  for (const key of ['offers', '@graph', 'mainEntity']) {
    const found = findJsonPrice(node[key]);
    if (found !== null) return found;
  }
  return null;
}

export function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}
