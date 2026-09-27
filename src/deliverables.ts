// What a finished run hands back: the artifact index, the host-side PR and the
// `expect` contract check. Both checks run only for a run that otherwise succeeded
// and can turn it into a FAILED verdict.
import { readFileSync, lstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles, openInside } from './safe-files.ts';
import { config } from './config.ts';
import type { AgentStats } from './adapters/index.ts';
import { checkDeliverable, type Verdict } from './failures.ts';
import { emit, runDir, type RunRecord, type RunRequest } from './store.ts';
import { openPullRequest, PullRequestError } from './pullrequest.ts';

export { listFiles };

export async function settleDeliverables(o: {
  id: string; result: NonNullable<RunRecord['result']>; req: RunRequest; model: string;
  stats: AgentStats; artifacts: string[]; verdict: Verdict;
}): Promise<void> {
  const { id, result, req, model, stats: agentStats, artifacts, verdict } = o;
  const dir = runDir(id);
  // Host-side PR, only for a run that otherwise succeeded. "Nothing changed" is a
  // failure, not a quiet success — the user's worst case is an agent that did nothing.
  if (verdict.state === 'SUCCEEDED' && req.repo?.pull_request) {
    const spec = req.repo.pull_request;
    const title = spec.title ?? `[agent] ${req.task.split('\n')[0].slice(0, 80)}`;
    const body = [spec.body ?? '', '', '---', `Run \`${id}\` · model \`${model}\` · ${agentStats.steps} steps, ${agentStats.toolCalls} tool calls`, '',
      '<details><summary>Agent summary</summary>', '', (agentStats.finalText ?? '(none)').slice(0, 6000), '', '</details>'].join('\n');
    try {
      result.pull_request = await openPullRequest({ runId: id, repoUrl: req.repo.url, hostRepo: join(dir, 'host-repo'),
        workspace: join(dir, 'workspace'), spec, defaultBase: req.repo.ref, token: config.githubPushToken, title, body });
      emit(id, 'run.pull_request', { ...result.pull_request });
    } catch (e) {
      const err = e as { message?: unknown; stderr?: unknown } | undefined;
      const pe = e instanceof PullRequestError ? e : new PullRequestError('PR_FAILED', String(err?.message ?? e), true);
      verdict.state = 'FAILED';
      verdict.diagnosis = { category: pe.category, summary: pe.message, evidence: [String(err?.stderr ?? '').slice(0, 500)].filter(Boolean),
        retryable: pe.retryable, hints: pe.category === 'NO_CHANGES'
          ? ['The agent reported success but did not modify the repository — see its final text in result.text']
          : ['See run.log events and host-repo/ in the run dir'] };
    }
  }
  if (verdict.state === 'SUCCEEDED') {
    const artDir = join(dir, 'artifacts');
    const failed = checkDeliverable(req.expect, {
      agent: req.agent ?? 'opencode', text: agentStats.finalText, pullRequest: !!result.pull_request,
      artifacts: artifacts.map(p => ({ path: p, size: lstatSync(join(artDir, p)).size })),
      parsesAsJson: p => {
        const fd = openInside(artDir, p);
        if (fd === undefined) return false;
        try { JSON.parse(readFileSync(fd, 'utf8')); return true; } catch { return false; } finally { closeSync(fd); }
      },
    }, verdict.warnings);
    if (failed) Object.assign(verdict, failed);
  }
}
