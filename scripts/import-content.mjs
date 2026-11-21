import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('content-bank');
const REPO = 'javad1371/neshat-life-content';
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const GITHUB_SHA = process.env.GITHUB_SHA ?? 'manual';
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY.');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files.sort();
}

async function api(resource, options = {}) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + resource, {
    ...options,
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error('Supabase ' + (options.method ?? 'GET') + ' ' + resource + ' failed (' + response.status + '): ' + body);
  return body ? JSON.parse(body) : null;
}

const [categories, subcategories] = await Promise.all([api('categories?select=id,title'), api('subcategories?select=id,category_id,title')]);
const categoryIds = new Set(categories.map(x => String(x.id)));
const subcategoryMap = new Map(subcategories.map(x => [String(x.id), String(x.category_id)]));
const files = await walk(ROOT);
const records = [];
const seenKeys = new Set();
for (const file of files) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  const doc = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(doc.items)) throw new Error(relative + ': items must be an array');
  for (const item of doc.items) {
    const categoryId = String(item.category_id ?? doc.category_id ?? '');
    const subcategoryId = String(item.subcategory_id ?? doc.subcategory_id ?? '');
    if (!item.id || !item.title?.trim() || !item.body?.trim() || !item.content_type) throw new Error(relative + ': item missing id/title/body/content_type');
    if (!categoryIds.has(categoryId)) throw new Error(relative + '/' + item.id + ': unknown category_id ' + categoryId);
    if (!subcategoryMap.has(subcategoryId)) throw new Error(relative + '/' + item.id + ': unknown subcategory_id ' + subcategoryId);
    if (subcategoryMap.get(subcategoryId) !== categoryId) throw new Error(relative + '/' + item.id + ': category/subcategory mismatch');
    if (subcategoryId === '13') throw new Error(relative + '/' + item.id + ': games banner must not be imported as text');
    const uniqueKey = relative + ':' + item.id;
    if (seenKeys.has(uniqueKey)) throw new Error('Duplicate item id in bank: ' + uniqueKey);
    seenKeys.add(uniqueKey);
    const contentHash = createHash('md5').update(REPO + ':' + uniqueKey).digest('hex');
    records.push({
      title: item.title, body: item.body, category_id: Number(categoryId), subcategory_id: Number(subcategoryId),
      content_type: item.content_type, payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
      content_hash: contentHash, source_type: 'file', source_name: item.source_name ?? doc.source_name ?? 'بانک محتوای نشاط زندگی',
      source_url: 'https://github.com/' + REPO + '/blob/main/' + relative, is_published: false,
    });
  }
}
if (!records.length) { console.log('No JSON content records found.'); process.exit(0); }

const hashes = records.map(x => x.content_hash);
const existing = new Set();
for (let i = 0; i < hashes.length; i += 80) {
  const chunk = hashes.slice(i, i + 80);
  const rows = await api('contents?select=content_hash&content_hash=in.(' + chunk.join(',') + ')');
  for (const row of rows) existing.add(row.content_hash);
}
const pending = records.filter(x => !existing.has(x.content_hash));
const duplicateCount = records.length - pending.length;
if (!pending.length) { console.log(JSON.stringify({ total: records.length, inserted: 0, alreadyPresent: duplicateCount })); process.exit(0); }

const batchRows = await api('content_import_batches?select=id', {
  method: 'POST', headers: { Prefer: 'return=representation' },
  body: JSON.stringify([{ source_type: 'file', file_name: 'GitHub ' + GITHUB_SHA, status: 'processing', total_items: records.length, imported_items: 0, duplicate_items: duplicateCount, rejected_items: 0, started_at: new Date().toISOString() }]),
});
const batchId = batchRows?.[0]?.id;
if (!batchId) throw new Error('Supabase did not return content_import_batches.id');
let inserted = 0;
const errors = [];
try {
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100).map(row => ({ ...row, import_batch_id: batchId }));
    try {
      await api('contents', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
      inserted += chunk.length;
      console.log('Inserted ' + inserted + '/' + pending.length);
    } catch (error) { errors.push(String(error)); throw error; }
  }
  await api('content_import_batches?id=eq.' + batchId, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'completed', imported_items: inserted, completed_at: new Date().toISOString(), error_details: [] }) });
} catch (error) {
  await api('content_import_batches?id=eq.' + batchId, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: inserted > 0 ? 'partial' : 'failed', imported_items: inserted, completed_at: new Date().toISOString(), error_details: errors }) }).catch(() => {});
  throw error;
}
console.log(JSON.stringify({ total: records.length, inserted, alreadyPresent: duplicateCount, unpublished: inserted, importBatchId: batchId }, null, 2));
