import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { extractPrice, csvCell } from './lib.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4175);
const host = '127.0.0.1';
mkdirSync(join(root, 'data'), { recursive: true });
const db = new DatabaseSync(join(root, 'data', 'monitor.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL UNIQUE, target_price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), store TEXT NOT NULL, url TEXT NOT NULL, demo_price REAL, last_error TEXT);
CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES listings(id), price REAL NOT NULL, checked_at TEXT NOT NULL);`);

const demo = [
  ['Беспроводные наушники Sonic One', 'AUDIO-101', 8500, [['Маркет А', 8990], ['Маркет Б', 8290]]],
  ['Кофемашина Barista Mini', 'HOME-204', 16800, [['Маркет А', 17490], ['Маркет Б', 16990]]],
  ['Умная колонка Nova', 'SMART-310', 6500, [['Маркет А', 6990], ['Маркет Б', 6790]]],
  ['Робот-пылесос Orbit S', 'HOME-412', 21900, [['Маркет А', 22990], ['Маркет Б', 21490]]]
];

if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const putProduct = db.prepare('INSERT INTO products (name, sku, target_price) VALUES (?, ?, ?)');
  const putListing = db.prepare('INSERT INTO listings (product_id, store, url, demo_price) VALUES (?, ?, ?, ?)');
  const putObservation = db.prepare('INSERT INTO observations (listing_id, price, checked_at) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const [name, sku, target, stores] of demo) {
      const productId = Number(putProduct.run(name, sku, target).lastInsertRowid);
      for (const [store, current] of stores) {
        const listingId = Number(putListing.run(productId, store, `/demo-feed/${productId}/${store === 'Маркет А' ? 'a' : 'b'}`, current).lastInsertRowid);
        for (let days = 7; days >= 1; days--) {
          const date = new Date(Date.now() - days * 86400000).toISOString();
          const offset = [0, 500, -200, 300, 100, -100, 400, 200][days];
          putObservation.run(listingId, current + offset, date);
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const queryListings = db.prepare(`SELECT l.id, l.product_id, l.store, l.url, l.demo_price, l.last_error,
  (SELECT o.price FROM observations o WHERE o.listing_id=l.id ORDER BY o.checked_at DESC, o.id DESC LIMIT 1) AS price,
  (SELECT o.checked_at FROM observations o WHERE o.listing_id=l.id ORDER BY o.checked_at DESC, o.id DESC LIMIT 1) AS checked_at,
  (SELECT o.price FROM observations o WHERE o.listing_id=l.id ORDER BY o.checked_at DESC, o.id DESC LIMIT 1 OFFSET 1) AS previous_price
  FROM listings l ORDER BY l.id`);

function dashboard() {
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();
  const listings = queryListings.all();
  const history = db.prepare(`SELECT listing_id, price, checked_at FROM observations ORDER BY checked_at DESC, id DESC LIMIT 500`).all();
  return {
    products: products.map(product => ({ ...product,
      listings: listings.filter(item => item.product_id === product.id).map(item => ({
        ...item, history: history.filter(point => point.listing_id === item.id).slice(0, 8).reverse()
      }))
    })),
    lastChecked: db.prepare('SELECT MAX(checked_at) AS date FROM observations').get().date
  };
}

function respond(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10000) throw new Error('Слишком большой запрос');
  }
  return JSON.parse(text || '{}');
}

async function getListingHtml(listing) {
  if (listing.url.startsWith('/demo-feed/')) {
    return `<html><head><meta property="product:price:amount" content="${listing.demo_price}"></head><body>Демонстрационная карточка товара</body></html>`;
  }
  const url = new URL(listing.url);
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Для реального товара нужна публичная HTTPS-ссылка');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'PriceMonitorDemo/1.0 (portfolio demo)' } });
  if (!response.ok) throw new Error(`Сайт ответил HTTP ${response.status}`);
  if (!(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Ссылка не ведёт на HTML-страницу');
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error('Страница слишком большая');
  return html;
}

async function scan() {
  const rows = queryListings.all();
  let updated = 0;
  let failed = 0;
  for (const listing of rows) {
    try {
      const html = await getListingHtml(listing);
      const price = extractPrice(html);
      if (price === null) throw new Error('Цена не найдена в JSON-LD или meta-разметке');
      db.prepare('INSERT INTO observations (listing_id, price, checked_at) VALUES (?, ?, ?)').run(listing.id, price, new Date().toISOString());
      db.prepare('UPDATE listings SET last_error=NULL WHERE id=?').run(listing.id);
      updated++;
    } catch (error) {
      db.prepare('UPDATE listings SET last_error=? WHERE id=?').run(String(error.message).slice(0, 300), listing.id);
      failed++;
    }
  }
  return { updated, failed };
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/theme.css': ['theme.css', 'text/css; charset=utf-8']
};

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, `http://${host}:${port}`).pathname;
    if (req.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      return respond(res, 200, readFileSync(join(root, 'public', file)), type);
    }
    if (req.method === 'GET' && path === '/api/dashboard') return respond(res, 200, dashboard());
    if (req.method === 'POST' && path === '/api/scan') return respond(res, 200, await scan());
    if (req.method === 'POST' && path === '/api/products') {
      const input = await readJson(req);
      const name = String(input.name || '').trim();
      const sku = String(input.sku || '').trim();
      const store = String(input.store || '').trim();
      const url = String(input.url || '').trim();
      const target = Number(input.targetPrice);
      if (!name || !sku || !store || !url || !Number.isFinite(target) || target <= 0) return respond(res, 400, { error: 'Заполните все поля корректно' });
      if (!/^https:\/\//i.test(url)) return respond(res, 400, { error: 'Для товара нужна HTTPS-ссылка' });
      try { new URL(url); } catch { return respond(res, 400, { error: 'Некорректная ссылка' }); }
      const existing = db.prepare('SELECT id FROM products WHERE sku=?').get(sku);
      const productId = existing?.id ?? Number(db.prepare('INSERT INTO products (name, sku, target_price) VALUES (?, ?, ?)').run(name, sku, target).lastInsertRowid);
      db.prepare('INSERT INTO listings (product_id, store, url) VALUES (?, ?, ?)').run(productId, store, url);
      return respond(res, 201, { productId });
    }
    if (req.method === 'GET' && path === '/api/export.csv') {
      const rows = db.prepare(`SELECT p.sku, p.name, l.store, l.url, o.price, o.checked_at
        FROM observations o JOIN listings l ON l.id=o.listing_id JOIN products p ON p.id=l.product_id
        ORDER BY o.checked_at DESC, o.id DESC`).all();
      const lines = [['Артикул', 'Товар', 'Магазин', 'URL', 'Цена, ₽', 'Дата проверки'], ...rows.map(row => Object.values(row))];
      res.setHeader('Content-Disposition', 'attachment; filename="price-history.csv"');
      return respond(res, 200, '\uFEFF' + lines.map(row => row.map(csvCell).join(';')).join('\r\n'), 'text/csv; charset=utf-8');
    }
    respond(res, 404, { error: 'Не найдено' });
  } catch (error) {
    respond(res, 500, { error: String(error.message) });
  }
});

server.listen(port, host, () => console.log(`Price monitor: http://${host}:${port}/`));
