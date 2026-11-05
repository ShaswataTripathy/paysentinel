// Guardian mode profiles.
import fs from 'node:fs';
import { dataFile } from './paths.js';

const FILE = dataFile('profiles.json');
let profiles = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const save = () => {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(profiles, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
};

export const CATEGORIES = ['groceries', 'pharmacy', 'household', 'electronics', 'services', 'gift_cards'];

export const listProfiles = () => profiles;
export const getProfile = (id) => profiles.find((p) => p.id === id) ?? null;

const invalid = (message) => Object.assign(new Error(message), { status: 400, expose: true });

const MAX_LIMIT = 10_000; // USD

export function updateRules(id, input) {
  const p = getProfile(id);
  if (!p?.guardian) throw invalid('This profile has no guardian.');
  const r = p.guardian.rules;
  const cats = (v, field) => {
    if (v === undefined) return r[field];
    if (!Array.isArray(v) || v.some((c) => !CATEGORIES.includes(c))) throw invalid(`${field} must be a list of: ${CATEGORIES.join(', ')}.`);
    return [...new Set(v)];
  };
  const limit = (v, field) => {
    if (v === undefined) return r[field];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_LIMIT) throw invalid(`${field.replace('_', ' ')} must be a number from 0 to ${MAX_LIMIT}.`);
    return Math.round(n * 100) / 100;
  };
  const next = {
    allowed_categories: cats(input.allowed_categories, 'allowed_categories'),
    blocked_categories: cats(input.blocked_categories, 'blocked_categories'),
    per_order_limit: limit(input.per_order_limit, 'per_order_limit'),
    weekly_limit: limit(input.weekly_limit, 'weekly_limit'),
    verified_shops_only: input.verified_shops_only === undefined ? r.verified_shops_only : input.verified_shops_only,
  };
  if (typeof next.verified_shops_only !== 'boolean') throw invalid('verified_shops_only must be true or false.');
  const both = next.allowed_categories.filter((c) => next.blocked_categories.includes(c));
  if (both.length) throw invalid(`A category cannot be both allowed and blocked: ${both.join(', ')}.`);
  if (next.per_order_limit > next.weekly_limit) throw invalid('The per-order limit cannot be higher than the weekly budget.');
  p.guardian.rules = next;
  save();
  return p;
}
