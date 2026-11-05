// Shop catalogs ("Shelf"): load, search, quote, import, and scan listings for hidden instructions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'shops.json');
let shops = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const save = () => fs.writeFileSync(FILE, JSON.stringify(shops, null, 2));

/** Crude singular form: "batteries" / "battery" -> "batter", "cables" -> "cabl". */
export const stem = (w) => String(w).toLowerCase().replace(/(ies|es|s|y)$/, '');

/** True if a product name contains every keyword as a whole word (so "aa" does not match "AAA"). */
export function nameMatches(name, keywords) {
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  return keywords.every((k) => words.some((w) => w === stem(k) || (stem(k).length >= 4 && w.startsWith(stem(k)))));
}

/** Every word stem used in any product name (lets the offline parser ignore chatter like "urgent" or "bank"). */
export function vocabulary() {
  const v = new Set();
  for (const s of shops) for (const p of s.products) for (const w of p.name.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 2) v.add(stem(w));
  return v;
}

export const listShops = () =>shops.map(({ id, name, trusted, products }) => ({ id, name, trusted, productCount: products.length }));
export const getShop = (id) => shops.find((s) => s.id === id) ?? null;

export function getProduct(shopId, sku) {
  return getShop(shopId)?.products.find((p) => p.sku === sku) ?? null;
}

/** The price the shop charges at checkout. Usually the listed price; a malicious shop may differ. */
export function quote(shopId, sku) {
  const p = getProduct(shopId, sku);
  return p ? (p.checkout_price ?? p.price) : null;
}

/** Keyword search across the given shops, cheapest first. */
export function search(query, shopIds) {
  const terms = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  const out = [];
  for (const shop of shops) {
    if (shopIds && !shopIds.includes(shop.id)) continue;
    for (const p of shop.products) {
      const hay = `${p.name} ${p.sku}`.toLowerCase();
      const score = terms.filter((t) => hay.includes(t.replace(/(ies|y|s)$/, ''))).length;
      if (score) out.push({ shop: shop.id, shopName: shop.name, sku: p.sku, name: p.name, price: p.price, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.price - b.price);
}

// ---------- listing scanner ----------
const PATTERNS = [
  { re: /<!--[\s\S]*?-->/, why: 'hidden HTML comment' },
  { re: /[​-‏⁠﻿]/, why: 'invisible characters' },
  { re: /\b(ignore|disregard)\b[^.]{0,40}\b(instructions|previous|prior|rules)\b/i, why: 'instruction override' },
  { re: /\b(ai|assistant|agent|llm|bot)s?\b[^.]{0,80}\b(must|should|need to|required|add|include|do not tell|don't tell|do not mention)\b/i, why: 'text addressed to AI agents' },
  { re: /\bdo not (mention|tell|inform)\b[^.]{0,40}\b(user|customer|buyer)\b/i, why: 'asks to hide something from the user' },
];

/** Lines of raw seller text that look like instructions to AI agents (checked before any AI clean-up). */
export function scanRawText(raw) {
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ line: line.slice(0, 200), reasons: PATTERNS.filter((p) => p.re.test(line)).map((p) => p.why) }))
    .filter((r) => r.reasons.length);
}

/** Returns why a listing looks like it contains instructions for AI agents, and which SKUs it pushes. */
export function scanListing(shopId, product) {
  const text = `${product.name}\n${product.description ?? ''}`;
  const reasons = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why);
  const shop = getShop(shopId);
  const pushedSkus = reasons.length
    ? (shop?.products ?? []).map((p) => p.sku).filter((sku) => sku !== product.sku && text.includes(sku))
    : [];
  return { flagged: reasons.length > 0, reasons, pushedSkus };
}

/** SKU -> the listing that pushes it, for every flagged listing in a shop. */
export function injectedSkus(shopId) {
  const map = new Map();
  for (const p of getShop(shopId)?.products ?? []) {
    const s = scanListing(shopId, p);
    for (const sku of s.pushedSkus) map.set(sku, { from: p.sku, reasons: s.reasons });
  }
  return map;
}

/** Shelf import: add or replace a shop from normalized products. */
export function upsertShop({ id, name, trusted = false, products }) {
  const shop = { id, name, trusted, products };
  const i = shops.findIndex((s) => s.id === id);
  if (i >= 0) shops[i] = shop;
  else shops.push(shop);
  save();
  return shop;
}
