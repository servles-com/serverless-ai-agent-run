// Long-horizon dogfood: agents grow github.com/servles-com/universe-timeline.
// One tick = one backlog issue → one run with a host-side PR → project CI decides:
// green → merge, red → close with the reason. Every outcome is a metric.
//
//   node scripts/dogfood-timeline.ts     (SAR_URL, SAR_API_TOKEN, GH_TOKEN)
// Output: $SAR_DATA_DIR/reports/timeline-history.jsonl
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAndWait, QueueTimeoutError } from '../tests/lib/client.ts';

const REPO = process.env.SAR_TIMELINE_REPO ?? 'servles-com/universe-timeline';
const MODEL = process.env.SAR_TIMELINE_MODEL ?? 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
const TIMEOUT_S = Number(process.env.SAR_TIMELINE_TIMEOUT_S ?? 900);
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
const outDir = join(resolve(process.env.SAR_DATA_DIR ?? 'runtime-data'), 'reports');
const history = join(outDir, 'timeline-history.jsonl');
mkdirSync(outDir, { recursive: true });

interface Issue { number: number; title: string; body?: string | null; pull_request?: unknown }
interface CheckRun { name: string; status: string; conclusion: string | null }
interface RunResult {
  id: string; state: string;
  diagnosis?: { category: string; summary: string };
  result?: { steps?: number; tool_calls?: number;
    pull_request?: { url: string; number: number; commit: string; files_changed: number } };
}

const gh = async <T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' } });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Pick the least-attempted open agent-task issue (ties → random) so the backlog rotates.
const issues = (await gh<Issue[]>('/issues?state=open&labels=agent-task&per_page=100')).body.filter(i => !i.pull_request);
if (!issues.length) { console.log('no open agent-task issues'); process.exit(0); }
const attempts = new Map<number, number>();
if (existsSync(history)) for (const l of readFileSync(history, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l); attempts.set(r.issue, (attempts.get(r.issue) ?? 0) + 1);
}
issues.sort((a, b) => (attempts.get(a.number) ?? 0) - (attempts.get(b.number) ?? 0) || Math.random() - 0.5);
const issue = issues[0];

const task = `You are contributing to the open-source project in /workspace (a zoomable timeline of the universe).
First read /workspace/README.md completely — especially "Data" and "Rules for agents".

Your task is GitHub issue #${issue.number}: "${issue.title}"
${issue.body ?? ''}

How to work:
- Make a small, high-quality change that addresses the task. Edit files in /workspace only.
- Never invent facts, dates or URLs. Open every source you cite (you have web access). If unsure, widen time.uncertainty and say so.
- Run \`node scripts/validate.mjs\` in /workspace and fix every error until it passes.
- Do NOT git commit or push — the platform opens the pull request for you.
- Finish with a short summary: what you changed, which sources you used, what you were unsure about.`;

const started = Date.now();
let run: RunResult;
try {
  run = await runAndWait({
    agent: 'opencode', model: MODEL, task,
    repo: { url: `https://github.com/${REPO}`, ref: 'main',
      pull_request: { title: `[agent] ${issue.title}`.slice(0, 120), branch: `agent/issue-${issue.number}-${Date.now().toString(36)}`,
        body: `Refs #${issue.number}. Opened by the serverless-ai-agent-run dogfood loop.` } },
    limits: { timeout_s: TIMEOUT_S, idle_timeout_s: 300 },
    metadata: { track: 'timeline', issue: issue.number },
  }, TIMEOUT_S + 200) as RunResult;
} catch (e) {
  const cat = e instanceof QueueTimeoutError ? 'QUEUE_TIMEOUT' : 'HARNESS_ERROR';
  run = { id: '-', state: cat, diagnosis: { category: cat, summary: (e as Error).message } };
}

const pr = run.result?.pull_request;
let ci = 'none', merged = false;
if (pr) {
  // Wait for the project's CI (the quality gate), then merge or close.
  for (let i = 0; i < 40; i++) {
    const checks = (await gh<{ check_runs?: CheckRun[] }>(`/commits/${pr.commit}/check-runs`)).body?.check_runs ?? [];
    const v = checks.find(c => c.name === 'validate');
    if (v?.status === 'completed') { ci = v.conclusion ?? 'unknown'; break; }
    await sleep(15_000);
  }
  if (ci === 'success') {
    const m = await gh(`/pulls/${pr.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) });
    merged = m.status === 200;
  } else {
    await gh(`/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Closing: project CI \`validate\` = ${ci}. Run ${run.id}.` }) });
    await gh(`/pulls/${pr.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
}
await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body:
  `Agent attempt: run \`${run.id}\` → **${run.state}**${run.diagnosis ? ` (${run.diagnosis.category}: ${run.diagnosis.summary})` : ''}` +
  (pr ? `\nPR ${pr.url} · CI ${ci} · ${merged ? 'merged ✅' : 'not merged'}` : '') }) });

const row = {
  ts: new Date().toISOString(), issue: issue.number, title: issue.title, run_id: run.id, state: run.state,
  category: run.diagnosis?.category ?? 'OK', summary: run.diagnosis?.summary, seconds: Math.round((Date.now() - started) / 1000),
  steps: run.result?.steps, tool_calls: run.result?.tool_calls, pr: pr?.url, files_changed: pr?.files_changed, ci, merged, model: MODEL,
};
appendFileSync(history, JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
