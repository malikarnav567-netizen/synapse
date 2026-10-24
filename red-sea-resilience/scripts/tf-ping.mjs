import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(import.meta.dirname, '../.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
);
const key = env.TINYFISH_API_KEY;
if (!key) {
  console.error('no key');
  process.exit(1);
}
const r = await fetch('https://api.search.tinyfish.ai?query=' + encodeURIComponent('Red Sea shipping advisory') + '&domain_type=news', {
  headers: { 'X-API-Key': key },
});
const t = await r.text();
console.log('status', r.status);
console.log(t.slice(0, 900));
