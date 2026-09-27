// Dogfood loop: push a fixed task set through the API on free models and
// record how runs fail. Free models fail a lot — that is the point: every
// failure must land in a known diagnosis category. Growth of UNKNOWN /
// RUNTIME_BUG / SILENT_FAILURE is the signal to improve the runtime.
//
//   node scripts/dogfood-free-models.ts            (uses SAR_URL, SAR_API_TOKEN)
//   SAR_DOGFOOD_MODELS=a,b SAR_DOGFOOD_TASKS=write-file,fix-bug node scripts/...
//   SAR_DOGFOOD_SAMPLE=2 SAR_DOGFOOD_TIMEOUT_S=240   2 random (model, task) pairs — for
//                                                    frequent ticks (no .md report, history only)
//
// Output: $SAR_DATA_DIR/reports/dogfood-<ts>.md + history.jsonl
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAndWait } from '../tests/lib/client.ts';
import { dogfoodCategory, harnessErrorRun } from './dogfood-lib.ts';

const models = (process.env.SAR_DOGFOOD_MODELS ?? [
  // The owner's ladder (Go first). Direct OpenRouter :free models only via
  // SAR_DOGFOOD_MODELS for comparisons — one account's daily free quota is tiny.
  'ladder/free',
].join(',')).split(',');
const only = process.env.SAR_DOGFOOD_TASKS?.split(',');
const tasks = JSON.parse(readFileSync(new URL('../tests/dogfood/tasks.json', import.meta.url), 'utf8'))
  .filter((t: any) => !only || only.includes(t.name));
const outDir = join(resolve(process.env.SAR_DATA_DIR ?? 'runtime-data'), 'reports');
mkdirSync(outDir, { recursive: true });

const sample = Number(process.env.SAR_DOGFOOD_SAMPLE ?? 0);
const timeoutS = Number(process.env.SAR_DOGFOOD_TIMEOUT_S ?? 600);
let pairs: [string, any][] = models.flatMap(m => tasks.map((t: any) => [m, t] as [string, any]));
if (sample > 0) pairs = pairs.sort(() => Math.random() - 0.5).slice(0, sample);

const rows: any[] = [];
for (const [model, t] of pairs) {
  {
    const started = Date.now();
    let run: any;
    try {
      run = await runAndWait({ agent: 'opencode', model, task: t.task, files: t.files, repo: t.repo, expect: t.expect,
        limits: { timeout_s: timeoutS, idle_timeout_s: Math.min(240, timeoutS) }, metadata: { dogfood: t.name } }, timeoutS + 100);
    } catch (e: any) {
      run = harnessErrorRun(e);
    }
    // An agent that says "done" but produced nothing is the most dangerous failure.
    const category = dogfoodCategory(run);
    const row = {
      ts: new Date().toISOString(), model, task: t.name, run_id: run.id, state: run.state, category,
      seconds: Math.round((Date.now() - started) / 1000), steps: run.result?.steps, tool_calls: run.result?.tool_calls,
      tool_errors: run.result?.tool_errors, artifacts: run.result?.artifacts?.length ?? 0,
      summary: run.diagnosis?.summary, warnings: run.warnings,
    };
    rows.push(row);
    appendFileSync(join(outDir, 'history.jsonl'), JSON.stringify(row) + '\n');
    console.log(`${row.state.padEnd(10)} ${category.padEnd(22)} ${String(row.seconds).padStart(4)}s  ${model}  ${t.name}  ${run.id}`);
  }
}

if (sample > 0) process.exit(0);

const byCat = rows.reduce<Record<string, number>>((a, r) => (a[r.category] = (a[r.category] ?? 0) + 1, a), {});
const md = [
  `# Dogfood ${new Date().toISOString()}`,
  '', `Runs: ${rows.length} · OK: ${byCat.OK ?? 0}`, '',
  '## Categories', '', ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${c}: ${n}`),
  '', '## Runs', '', '| model | task | state | category | s | steps | tools (err) | artifacts | run |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.model.replace('openrouter/', '')} | ${r.task} | ${r.state} | ${r.category} | ${r.seconds} | ${r.steps ?? ''} | ${r.tool_calls ?? ''} (${r.tool_errors ?? ''}) | ${r.artifacts} | ${r.run_id} |`),
].join('\n');
const file = join(outDir, `dogfood-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(file, md + '\n');
console.log(`\nreport: ${file}`);
console.log(JSON.stringify(byCat));
