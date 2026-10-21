const rub = value => value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) + ' ₽';
const byId = id => document.getElementById(id);
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let state;

byId('today').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

function notice(message, isError = false) {
  const el = byId('toast'); el.textContent = message; el.className = isError ? 'show error' : 'show';
  clearTimeout(notice.timer); notice.timer = setTimeout(() => el.className = '', 4000);
}

async function load() {
  const response = await fetch('/api/dashboard');
  if (!response.ok) throw new Error('Не удалось загрузить данные');
  state = await response.json();
  render();
}

function render() {
  const all = state.products.flatMap(p => p.listings);
  const priced = all.filter(l => l.price != null);
  const below = state.products.filter(p => p.listings.some(l => l.price != null && l.price <= p.target_price)).length;
  const changes = all.filter(l => l.previous_price != null && l.previous_price !== l.price).length;
  byId('stats').innerHTML = [
    ['Товаров в каталоге', state.products.length, 'Позиций под наблюдением', '◫'],
    ['Источников цен', all.length, 'Магазины и карточки', '◎'],
    ['Ниже целевой цены', below, 'Товары с выгодной ценой', '↘'],
    ['Изменений цены', changes, 'С последней проверки', '↗']
  ].map(([label, value, hint, icon]) => `<div class="stat"><div class="stat-top"><span>${label}</span><b>${icon}</b></div><strong>${value}</strong><small>${hint}</small></div>`).join('');
  byId('updated').textContent = state.lastChecked ? `Последняя проверка: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.lastChecked))}` : 'Проверок пока нет';
  byId('products').innerHTML = state.products.map(product => {
    const list = product.listings;
    const best = Math.min(...list.map(l => l.price ?? Infinity));
    const columns = list.slice(0, 2).map(l => `<td><span class="store-name">${safe(l.store)}</span><b>${rub(l.price)}</b>${l.last_error ? `<small class="source-error" title="${safe(l.last_error)}">Ошибка проверки</small>` : ''}</td>`);
    while (columns.length < 2) columns.push('<td>—</td>');
    const status = list.some(l => l.last_error) ? '<span class="badge warn">Ошибка источника</span>' : best <= product.target_price ? '<span class="badge good">Выгодная цена</span>' : '<span class="badge neutral">Без изменений</span>';
    return `<tr><td><div class="product-cell"><span class="product-icon">${safe(product.name.charAt(0))}</span><span><b>${safe(product.name)}</b><small>${safe(product.sku)} · ${list.length} ист.</small></span></div></td><td>${rub(product.target_price)}</td>${columns.join('')}<td><strong>${Number.isFinite(best) ? rub(best) : '—'}</strong></td><td>${status}</td></tr>`;
  }).join('');
  const select = byId('productSelect');
  const old = select.value;
  select.innerHTML = state.products.map(p => `<option value="${p.id}">${safe(p.name)}</option>`).join('');
  if (state.products.some(p => String(p.id) === old)) select.value = old;
  renderChart();
}

function renderChart() {
  const p = state.products.find(p => String(p.id) === byId('productSelect').value);
  if (!p) return;
  const series = p.listings.slice(0, 2).map(l => l.history);
  const values = series.flat().map(o => o.price);
  if (!values.length) { byId('chart').innerHTML = '<p class="empty-chart">Проверьте цены, чтобы увидеть историю.</p>'; return; }
  const min = Math.min(...values) * .985, max = Math.max(...values) * 1.015;
  const x = (i, n) => 45 + (i / Math.max(1, n - 1)) * 610;
  const y = value => 195 - ((value - min) / Math.max(1, max - min)) * 155;
  const grid = [0, 1, 2, 3].map(i => `<line x1="45" x2="655" y1="${45 + i * 50}" y2="${45 + i * 50}" stroke="#e9ece8"/><text x="0" y="${49 + i * 50}" fill="#9ba6a1" font-size="10">${Math.round(max - i * (max - min) / 3).toLocaleString('ru-RU')}</text>`).join('');
  const paths = series.map((points, i) => {
    if (!points.length) return '';
    const coords = points.map((point, j) => `${x(j, points.length)},${y(point.price)}`);
    const color = i === 0 ? '#005bff' : '#f1117e';
    return `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.map((point, j) => `<circle cx="${x(j, points.length)}" cy="${y(point.price)}" r="4" fill="${color}"><title>${rub(point.price)}</title></circle>`).join('')}`;
  }).join('');
  const dates = (series[0] || []).map((point, i, items) => i % 2 === 0 || i === items.length - 1 ? `<text x="${x(i, items.length)}" y="225" text-anchor="middle" fill="#9ba6a1" font-size="10">${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(new Date(point.checked_at))}</text>` : '').join('');
  byId('chart').innerHTML = `<svg viewBox="0 0 690 240" role="img" aria-label="График изменения цены">${grid}${paths}${dates}</svg>`;
}

byId('productSelect').addEventListener('change', renderChart);
byId('scan').addEventListener('click', async () => {
  const button = byId('scan'); button.disabled = true; button.textContent = 'Проверяем…';
  try {
    const response = await fetch('/api/scan', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ошибка проверки');
    await load(); notice(`Обновлено источников: ${result.updated}. Ошибок: ${result.failed}.`, result.failed > 0);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; button.innerHTML = '↻ &nbsp; Проверить цены'; }
});

const dialog = byId('addDialog');
byId('addButton').onclick = () => dialog.showModal();
byId('closeDialog').onclick = byId('cancelDialog').onclick = () => dialog.close();
byId('addForm').addEventListener('submit', async event => {
  event.preventDefault();
  byId('formError').textContent = '';
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const response = await fetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось добавить товар');
    dialog.close(); event.currentTarget.reset(); await load(); notice('Товар добавлен. Запустите проверку цен.');
  } catch (error) { byId('formError').textContent = error.message; }
});

load().catch(error => notice(error.message, true));
