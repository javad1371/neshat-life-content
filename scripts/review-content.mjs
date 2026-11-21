import fs from "node:fs/promises";
const projectUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const batchId = process.env.CONTENT_IMPORT_BATCH_ID || "461df03a-f37a-45f1-80f8-d68c064ef33d";
if (!projectUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY.");
const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };
const rows = [];
for (let offset = 0; ; offset += 500) {
  const u = new URL(projectUrl.replace(/\/+$/, "") + "/rest/v1/contents");
  u.searchParams.set("select", "id,title,body,category_id,subcategory_id,payload,content_hash,import_batch_id,is_published");
  u.searchParams.set("import_batch_id", "eq." + batchId);
  u.searchParams.set("order", "id.asc");
  const res = await fetch(u, { headers: { ...headers, Range: offset + "-" + (offset + 499), "Range-Unit": "items" } });
  if (!res.ok) throw new Error("Supabase read failed: " + res.status + " " + (await res.text()).slice(0, 300));
  const page = await res.json();
  rows.push(...page);
  if (page.length < 500) break;
}
const norm = v => String(v ?? "").normalize("NFKC").replace(/[ي]/g,"ی").replace(/[ك]/g,"ک").replace(/[\u200c\u200f]/g," ").replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim().toLowerCase();
const tokenSet = v => new Set(norm(v).split(" ").filter(x => x.length > 2));
function similarity(a,b) { const A=tokenSet(a), B=tokenSet(b); if(!A.size||!B.size)return 0; let n=0; for(const x of A)if(B.has(x))n++; return n/(A.size+B.size-n); }
const reportRows = rows.map(r => ({ id:r.id, title:r.title||"", subcategory_id:r.subcategory_id, published:!!r.is_published, issues:[] }));
const byId = new Map(reportRows.map(r => [r.id,r]));
const groups = new Map();
function issue(id, code, severity, message) { byId.get(id).issues.push({code,severity,message}); }
for (const r of rows) {
  const p = r.payload && typeof r.payload === "object" ? r.payload : {};
  const sid = Number(r.subcategory_id);
  if (!groups.has(sid)) groups.set(sid,[]);
  groups.get(sid).push(r);
  if (!String(r.title||"").trim()) issue(r.id,"empty_title","high","عنوان خالی است.");
  if (!String(r.body||"").trim()) issue(r.id,"empty_body","high","متن خالی است.");
  if (String(r.body||"").trim().length < 180) issue(r.id,"short_body","medium","متن کمتر از ۱۸۰ نویسه است.");
  if (/(TODO|Lorem ipsum|نمونه متن|متن آزمایشی|原创)/i.test((r.title||"")+" "+(r.body||""))) issue(r.id,"placeholder_or_foreign_text","high","عبارت جای‌نگهدار یا واژه نامتناسب پیدا شد.");
  if (r.is_published) issue(r.id,"already_published","info","رکورد از قبل منتشرشده است.");
  if (Number(r.category_id) === 1) {
    for (const field of ["stage1Motivation","stage2Intellectual","stage3Emotional","stage4Behavioral"]) if (!String(p[field]||"").trim()) issue(r.id,"missing_"+field,"high","فیلد "+field+" خالی است.");
    if (!String(p.referencesText||"").trim()) issue(r.id,"missing_reference","medium","منابع/مستندات خالی است.");
  }
  if ([6,9,10].includes(sid) && !String(p.referencesText||"").trim()) issue(r.id,"source_required","high","منبع محتوای معنوی ثبت نشده است.");
  if (sid===11 && !String(p.answer||"").trim()) issue(r.id,"riddle_missing_answer","high","پاسخ معما ثبت نشده است.");
  if (sid===11 && !String(p.explanation||"").trim()) issue(r.id,"riddle_missing_explanation","medium","توضیح پاسخ معما ثبت نشده است.");
  if (sid===15 && /(برداشت و تأمل تحریریه|نقل‌قول مستقیم نیست|原创)/i.test(r.body||"")) issue(r.id,"book_excerpt_not_verified","high","این متن نقل‌قول مستقیم کتاب نیست و نیازمند منبع/صفحه است.");
}
const stats=[], duplicates=[], nearDuplicates=[];
for (const [sid,items] of groups) {
  const bodies=new Map(), titles=new Map();
  for (const r of items) {
    const b=norm(r.body), t=norm(r.title);
    if(b)bodies.set(b,[...(bodies.get(b)||[]),r]);
    if(t)titles.set(t,[...(titles.get(t)||[]),r]);
  }
  for (const matches of bodies.values()) if(matches.length>1) {
    duplicates.push({subcategory_id:sid,ids:matches.map(x=>x.id),count:matches.length});
    for(const r of matches)issue(r.id,"exact_duplicate_body","high","متن دقیقاً تکراری است.");
  }
  for (const matches of titles.values()) if(matches.length>1) for(const r of matches)issue(r.id,"duplicate_title","medium","عنوان تکراری است.");
  const candidates=items.filter(x=>String(x.body||"").length>=180);
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const score=similarity(candidates[i].body,candidates[j].body);
    if(score>=0.82){nearDuplicates.push({subcategory_id:sid,id_a:candidates[i].id,id_b:candidates[j].id,similarity:Number(score.toFixed(3))});issue(candidates[i].id,"possible_near_duplicate","medium","شباهت واژگانی احتمالی با رکورد "+candidates[j].id);issue(candidates[j].id,"possible_near_duplicate","medium","شباهت واژگانی احتمالی با رکورد "+candidates[i].id);}
  }
  const family=items.filter(x=>Number(x.category_id)===1), payloads=family.map(x=>x.payload||{}), diversity={};
  for(const field of ["stage1Motivation","stage2Intellectual","stage3Emotional","stage4Behavioral","referencesText"]){
    diversity[field]=new Set(payloads.map(p=>norm(p[field])).filter(Boolean)).size;
    if(family.length && diversity[field]<=Math.max(1,Math.ceil(family.length*0.1))) for(const r of family)issue(r.id,"low_diversity_"+field,"high","تنوع این بخش پایین است: "+diversity[field]+" متن یکتا از "+family.length);
  }
  stats.push({subcategory_id:sid,total:items.length,unique_bodies:bodies.size,duplicate_groups:[...bodies.values()].filter(x=>x.length>1).length,duplicate_rows:[...bodies.values()].reduce((n,x)=>n+x.length-1,0),near_duplicate_pairs:nearDuplicates.filter(x=>x.subcategory_id===sid).length,family_stage_unique_counts:diversity});
}
const issueCounts={},severity={high:0,medium:0,low:0,info:0};
for(const r of reportRows)for(const i of r.issues){issueCounts[i.code]=(issueCounts[i.code]||0)+1;severity[i.severity]++;}
const report={generated_at:new Date().toISOString(),mode:"read-only; no Supabase writes",batch_id:batchId,total_records:rows.length,published_records:rows.filter(x=>x.is_published).length,unpublished_records:rows.filter(x=>!x.is_published).length,records_with_findings:reportRows.filter(x=>x.issues.length).length,severity,issue_counts:issueCounts,subcategories:stats,exact_duplicate_groups:duplicates,possible_near_duplicate_pairs:nearDuplicates,records:reportRows};
await fs.mkdir("review-report",{recursive:true});
await fs.writeFile("review-report/report.json",JSON.stringify(report,null,2));
const esc=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
const csv=[["id","subcategory_id","title","published","issue_codes","issue_details"],...reportRows.map(r=>[r.id,r.subcategory_id,r.title,r.published,r.issues.map(x=>x.code).join(";"),r.issues.map(x=>x.message).join(" | ")])].map(r=>r.map(esc).join(",")).join("\n");
await fs.writeFile("review-report/records.csv","\uFEFF"+csv);
const summary=["# گزارش بازبینی خودکار","", "بسته: "+batchId,"تعداد رکورد: "+rows.length,"دارای هشدار: "+report.records_with_findings,"شدید: "+severity.high+" | متوسط: "+severity.medium+" | کم: "+severity.low,"","این گزارش فقط‌خواندنی است؛ هیچ رکوردی تغییر یا منتشر نشده است.","","| زیرعنوان | تعداد | متن یکتا | گروه تکرار | شباهت احتمالی |","|---:|---:|---:|---:|---:|",...stats.map(s=>"| "+s.subcategory_id+" | "+s.total+" | "+s.unique_bodies+" | "+s.duplicate_groups+" | "+s.near_duplicate_pairs+" |")].join("\n");
await fs.writeFile("review-report/summary.md",summary);
console.log(JSON.stringify({total:rows.length,records_with_findings:report.records_with_findings,severity,issueCounts,stats},null,2));
