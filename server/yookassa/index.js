// Облачная функция оплаты Mentora через ЮKassa (Node.js 18+, без зависимостей).
// Подходит для Yandex Cloud Functions; для другого хостинга поменяйте только обёртку handler.
// Переменные окружения: SHOP_ID, SECRET_KEY (из личного кабинета ЮKassa), SITE_URL (адрес сайта).
const crypto = require('crypto');

const PRICE_KOP = 155000; // 1 550 ₽
// Те же хеши, что на сайте: sha256('mentora-promo:' + КОД). Сумму со скидкой считает только сервер.
const DISCOUNTS = { '30fef3a360c9397d391888ea37edc6b4d12aee889bce496eaebaf8ce81657ad7': 5 };
const API = 'https://api.yookassa.ru/v3/payments';
const PID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const auth = () => 'Basic ' + Buffer.from(process.env.SHOP_ID + ':' + process.env.SECRET_KEY).toString('base64');
const rub = kop => (kop / 100).toFixed(2);

function priceFor(promo) {
  const code = String(promo || '').trim().toUpperCase().slice(0, 64);
  if (!code) return PRICE_KOP;
  const pct = DISCOUNTS[crypto.createHash('sha256').update('mentora-promo:' + code).digest('hex')];
  return pct ? Math.round(PRICE_KOP * (100 - pct) / 100) : PRICE_KOP;
}

async function createPayment(promo) {
  const kop = priceFor(promo);
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: auth(), 'Idempotence-Key': crypto.randomUUID(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: { value: rub(kop), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: process.env.SITE_URL.replace(/#.*$/, '') + '#paid' },
      description: 'Mentora: полный доступ ко всем урокам',
      metadata: { product: 'mentora-full', promo: kop < PRICE_KOP ? 'discount' : '' },
    }),
  });
  const p = await r.json();
  if (!r.ok) throw new Error(p.description || 'create failed');
  return { paymentId: p.id, confirmationUrl: p.confirmation.confirmation_url, amount: p.amount.value };
}

async function paymentStatus(id) {
  if (!PID_RE.test(id)) throw new Error('bad id');
  const r = await fetch(API + '/' + id, { headers: { Authorization: auth() } });
  const p = await r.json();
  if (!r.ok) throw new Error(p.description || 'status failed');
  // Платёж засчитывается, только если он наш и на правильную сумму.
  const ours = p.metadata && p.metadata.product === 'mentora-full';
  const kop = Math.round(parseFloat(p.amount.value) * 100);
  const okSum = kop === PRICE_KOP || Object.values(DISCOUNTS).some(pct => kop === Math.round(PRICE_KOP * (100 - pct) / 100));
  return { status: ours && okSum ? p.status : 'canceled', paid: ours && okSum && p.paid === true };
}

module.exports.handler = async function (event) {
  const origin = (process.env.SITE_URL || '').match(/^https?:\/\/[^/]+/)?.[0] || '*';
  const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const q = event.queryStringParameters || {};
  try {
    if (q.action === 'create' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : (event.body || '{}'));
      return { statusCode: 200, headers, body: JSON.stringify(await createPayment(body.promo)) };
    }
    if (q.action === 'status') return { statusCode: 200, headers, body: JSON.stringify(await paymentStatus(String(q.id || ''))) };
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'unknown action' }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'payment error' }) };
  }
};
