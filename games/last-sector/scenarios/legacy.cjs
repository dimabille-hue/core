'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cache = new Map();
function loadScenario(id) {
  if (!id) return null;
  const key = String(id);
  if (cache.has(key)) return cache.get(key);
  const file = path.join(__dirname, `${key}.json`);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`scenario-not-found:${key}`), { code:'scenario-not-found' });
  const value = JSON.parse(fs.readFileSync(file,'utf8'));
  cache.set(key, Object.freeze(value));
  return value;
}
module.exports = { loadScenario };
