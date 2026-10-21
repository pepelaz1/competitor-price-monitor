import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrice, parseAmount, csvCell } from '../lib.mjs';

test('reads product meta price', () => {
  assert.equal(extractPrice('<meta content="12 990,50" property="product:price:amount">'), 12990.5);
});

test('reads nested JSON-LD offer', () => {
  assert.equal(extractPrice('<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"18500"}}</script>'), 18500);
});

test('does not invent a price from unrelated page text', () => {
  assert.equal(extractPrice('<h1>Телефон за 1000 рублей</h1>'), null);
});

test('rejects invalid amounts and escapes CSV', () => {
  assert.equal(parseAmount('0'), null);
  assert.equal(csvCell('A "quoted" name'), '"A ""quoted"" name"');
});
