# Automated content review

This workflow audits one Supabase contents import batch in read-only mode. It never updates, deletes, or publishes rows.

## GitHub configuration

Open Settings > Secrets and variables > Actions:

- Add repository variable SUPABASE_URL with the Supabase project URL.
- Add repository secret SUPABASE_SERVICE_ROLE_KEY with the service-role key. Never commit this key.
- Optional variable CONTENT_IMPORT_BATCH_ID overrides the default batch UUID.

The service-role key is used only for GET requests.

## Runs

- Manually from Actions > Content quality review > Run workflow.
- On pushes to content-bank JSON files on main.
- Weekly on Monday at 03:17 UTC.

Each run uploads summary.md, records.csv, and report.json as an artifact for 30 days.

## Checks

Empty fields, short text, exact normalized duplicate bodies and titles, possible lexical near-duplicates (Jaccard >= 0.82), family four-stage field presence and diversity, riddle answers/explanations, source warnings, and placeholder/foreign-text markers.

## Limitations

This deterministic audit is not an AI fact-checker. Medical claims, Quran quotations, hadith attribution, poetry authorship, and book page references require authoritative source verification and human review. No record is automatically approved for publication.
