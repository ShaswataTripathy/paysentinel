// Guardian mode: people whose AI assistant shops for them, and the family member who sets their rules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'profiles.json');
let profiles = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const save = () => fs.writeFileSync(FILE, JSON.stringify(profiles, null, 2));

export const CATEGORIES = ['groceries', 'pharmacy', 'household', 'electronics', 'services', 'gift_cards'];

export const listProfiles = () => profiles;
export const getProfile = (id) => profiles.find((p) => p.id === id) ?? null;

/** Validate and store a guardian's rules. Returns the updated profile. */
export function updateRules(id, input) {
  const p = getProfile(id);
  if (!p?.guardian) throw new Error('This profile has no guardian.');
  const cats = (v) => (Array.isArray(v) ? v.filter((c) => CATEGORIES.includes(c)) : []);
  const limit = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : d);
  const r = p.guardian.rules;
  p.guardian.rules = {
    allowed_categories: cats(input.allowed_categories ?? r.allowed_categories),
    blocked_categories: cats(input.blocked_categories ?? r.blocked_categories),
    per_order_limit: limit(input.per_order_limit, r.per_order_limit),
    weekly_limit: limit(input.weekly_limit, r.weekly_limit),
    verified_shops_only: input.verified_shops_only ?? r.verified_shops_only,
  };
  save();
  return p;
}
