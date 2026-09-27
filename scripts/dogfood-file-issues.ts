// Turns dogfood failures into GitHub issues — the input of the self-fix loop.
// Only categories that point at *our* runtime (not at a weak free model) are filed,
// one open issue per category (deduplicated by title).
//
//   node scripts/dogfood-file-issues.ts          needs `gh` authenticated (GH_TOKEN) on the host
//   SAR_ISSUES_DRY_RUN=1 node scripts/...         print what would be filed
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { api } from '../tests/lib/client.ts';

const REPO = process.env.SAR_ISSUES_REPO ?? 'servles-com/serverless-ai-agent-run';
const WATCH = (process.env.SAR_ISSUES_CATEGORIES ?? 'RUNTIME_BUG,SILENT_FAILURE,AGENT_NO_OUTPUT,ROOM_START_FAILED,HYDRATE_FAILED,HARNESS_ERROR,UNKNOWN').split(',');
const SINCE_H = Number(process.env.SAR_ISSUES_SINCE_H ?? 24);
const dry = process.env.SAR_ISSUES_DRY_RUN === '1';

const history = join(resolve(process.env.SAR_DATA_DIR ?? 'runtime-data'), 'reports', 'history.jsonl');
if (!existsSync(history)) { console.log('no dogfood history yet'); process.exit(0); }
const cutoff = Date.now() - SINCE_H * 3600_000;
const rows = readFileSync(history, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(r => Date.parse(r.ts) > cutoff && WATCH.includes(r.category));

const byCat = new Map<string, any[]>();
for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);

if (!dry && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log(`skip: ${rows.length} watched failures, but no GITHUB_TOKEN in /etc/sar/secrets.env to file issues`);
  process.exit(0);
}
const open = dry ? [] : JSON.parse(execFileSync('gh', ['issue', 'list', '-R', REPO, '--state', 'open', '--label', 'dogfood',
  '--json', 'title', '--limit', '200']).toString()).map((i: any) => i.title);

for (const [cat, list] of byCat) {
  const title = `[dogfood] ${cat}: ${list.length} run(s) in the last ${SINCE_H}h`;
  if (open.some((t: string) => t.startsWith(`[dogfood] ${cat}:`))) { console.log(`skip ${cat}: open issue exists`); continue; }
  const sample = list[list.length - 1];
  const debug = sample.run_id !== '-' ? (await api('GET', `/runs/${sample.run_id}/debug`)).body : null;
  const body = [
    `Dogfood detected **${cat}** ${list.length}× in the last ${SINCE_H}h.`, '',
    '| model | task | run | summary |', '|---|---|---|---|',
    ...list.slice(-10).map(r => `| ${r.model} | ${r.task} | ${r.run_id} | ${r.summary ?? ''} |`), '',
    '## Latest debug bundle', '', '```json', JSON.stringify(debug, null, 2)?.slice(0, 50_000) ?? 'n/a', '```', '',
    'Fix path: add/adjust a category in `src/failures.ts` + unit test; if the runtime is at fault, fix it and add an e2e case.',
  ].join('\n');
  if (dry) { console.log(`would file: ${title}`); continue; }
  execFileSync('gh', ['issue', 'create', '-R', REPO, '--title', title, '--label', 'dogfood', '--body', body]);
  console.log(`filed: ${title}`);
}
