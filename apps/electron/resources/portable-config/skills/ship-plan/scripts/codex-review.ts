#!/usr/bin/env bun
// One local reviewer, using Conductor's frozen role contract and the existing proxy account pool.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const here = import.meta.dir;
const roles = JSON.parse(readFileSync(join(here, 'roles.json'), 'utf8'));
const args = process.argv.slice(2);
function option(name: string) { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; }
if (args.includes('--help')) {
  console.log('bun codex-review.ts --role factcheck|omissions|bugs|comments|light --round N --key ROLE-BATCH --input FILE [--fresh]\nRun from the existing worktree. Input contains neutral artifact paths, IDs, base/HEAD and prior own counters. Reports and reviewer thread IDs stay in .context/ship/reviewers/.');
  process.exit(0);
}
const role = option('role') ?? '';
const spec = roles[role];
const round = Number(option('round'));
const key = option('key') ?? role;
if (!spec || !Number.isInteger(round) || round < 1 || !/^[a-zA-Z0-9_-]+$/.test(key) || !option('input')) throw Error('Invalid arguments; use --help');
const cwd = process.cwd();
function git(...argv: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('Current directory must be an existing Git worktree');
  return result.stdout.trim();
}
const head = git('rev-parse', 'HEAD');
const root = git('rev-parse', '--show-toplevel');
if (resolve(root) !== resolve(cwd)) throw Error('Run from the worktree root');
const input = readFileSync(resolve(option('input')!), 'utf8');
const outputDir = join(cwd, '.context/ship/reviewers', key);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const lock = join(outputDir, 'running.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) throw Error('This reviewer is already running');
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
let child: ReturnType<typeof spawn> | undefined;
function stop() { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
function clean() { stop(); try { unlinkSync(lock); } catch {} }
process.on('exit', clean);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(130));

try {
  const metaPath = join(outputDir, 'last.json');
  const previous = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined;
  const fresh = args.includes('--fresh');
  if (previous && previous.role !== role) throw Error('Reviewer key belongs to another role');
  if (!fresh && previous && round <= previous.round) throw Error('Round already completed; reuse its report');
  if (!fresh && round > 1 && !previous?.thread) throw Error('Previous reviewer thread missing; disclose this before explicitly using --fresh');
  const thread = !fresh && round > 1 ? previous.thread : undefined;

  const home = '/home/craft/.craft-agent/cli-proxy';
  const config = JSON.parse(readFileSync(join(home, 'config.yaml'), 'utf8'));
  const port = config.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Proxy port unavailable');
  const runtime = spawnSync('systemctl', ['show', 'craft-agents', '--property=WorkingDirectory', '--value'], { encoding: 'utf8' }).stdout.trim();
  if (!runtime.startsWith('/home/craft/')) throw Error('Craft runtime unavailable');
  const { getCredentialManager } = await import(pathToFileURL(join(runtime, 'packages/shared/src/credentials/index.ts')).href);
  const token = await getCredentialManager().getLlmApiKey('cli-proxy-internal-client');
  if (!token) throw Error('Existing CLIProxyAPI client credential unavailable; no direct-provider fallback');
  const Ajv = createRequire(join(runtime, 'package.json'))('ajv');
  const schemaPath = join(here, 'schemas', `${spec.schema}.json`);
  const validate = new Ajv({ strict: false }).compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  const codex = join(home, 'reviewers/codex-cli/vendor/x86_64-unknown-linux-musl/bin/codex');
  const reviewerHome = join(home, 'reviewers/home');
    mkdirSync(join(reviewerHome, '.codex'), { recursive: true, mode: 0o700 });
  const promptName = thread ? (role === 'bugs' ? 'astra-recheck' : 'recheck') : spec.prompt;
  const prompt = readFileSync(join(here, 'prompts', `${promptName}.md`), 'utf8') +
    `\n\n## Inputs\ngate: ${spec.gate}\nactor: ${spec.actor}\nround: ${round}\nworkspace: ${cwd}\nhead: ${head}\nprevious_head: ${previous?.head ?? 'none'}\nprevious_report: ${previous?.report ?? 'none'}\n${input}\n`;
  const common = [
    '--ignore-user-config', '--ignore-rules', '--json', '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="read-only"', '-c', 'model_provider="craft_proxy"',
    '-c', 'model_providers.craft_proxy.name="CLIProxyAPI"',
    '-c', `model_providers.craft_proxy.base_url="http://127.0.0.1:${port}/v1"`,
    '-c', 'model_providers.craft_proxy.env_key="CRAFT_REVIEW_PROXY_KEY"',
    '-c', 'model_providers.craft_proxy.wire_api="responses"',
    '-c', 'model_providers.craft_proxy.requires_openai_auth=false',
    '-c', 'model_providers.craft_proxy.supports_websockets=false',
    '-c', 'model_providers.craft_proxy.request_max_retries=0',
    '-c', 'model_providers.craft_proxy.stream_max_retries=0',
    '-c', `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`,
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.set={PATH="/usr/local/bin:/usr/bin:/bin"}',
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.memories=false',
    '-c', 'features.multi_agent=false', '-c', 'skills.bundled.enabled=false',
    '-c', 'web_search="disabled"', '-c', `model_reasoning_effort="${spec.effort}"`,
    '--output-schema', schemaPath,
  ];
  const deadline = Date.now() + 540_000;
  const models = thread ? [previous.model] : spec.models;
  for (const model of models) {
    const prefix = join(outputDir, `r${round}-${Date.now()}-${model}`);
    const reportPath = prefix + '.json';
    writeFileSync(prefix + '.prompt.md', prompt, { mode: 0o600 });
    const command = ['exec', ...(thread ? ['resume'] : []), ...common, '-m', model, '-o', reportPath, ...(thread ? [thread] : []), '-'];
    child = spawn(codex, command, {
      cwd, detached: true, env: {
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: reviewerHome, CODEX_HOME: join(reviewerHome, '.codex'),
        LANG: 'C.UTF-8', CRAFT_REVIEW_PROXY_KEY: token,
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; });
    child.stderr!.on('data', data => { stderr += data; });
    child.stdin!.end(prompt);
    const timeout = setTimeout(stop, Math.max(1, deadline - Date.now()));
    const status = await new Promise<number | null>((res, rej) => { child!.on('error', rej); child!.on('close', res); }).finally(() => clearTimeout(timeout));
    child = undefined;
    stdout = stdout.replaceAll(token, '[redacted]'); stderr = stderr.replaceAll(token, '[redacted]');
    writeFileSync(prefix + '.events.jsonl', stdout, { mode: 0o600 });
    writeFileSync(prefix + '.stderr', stderr, { mode: 0o600 });
    if (status !== 0) {
      const modelDenied = /model.{0,100}(not supported|not found|does not exist|not available|not have access)|unsupported_model|model_not_found/i.test(stdout + stderr);
      if (!thread && modelDenied && model !== models.at(-1) && Date.now() < deadline) continue;
      throw Error(`Reviewer failed (${model}, exit ${status}); inspect ${prefix}.stderr and .events.jsonl. No verdict, quota retry or Claude substitution.`);
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!validate(report) || report.actor !== spec.actor || report.gate !== spec.gate || report.round !== round) throw Error(`Invalid reviewer report: ${reportPath}`);
    if (git('rev-parse', 'HEAD') !== head) throw Error(`HEAD changed during review; report is stale: ${reportPath}`);
    const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const id = events.find(e => e.type === 'thread.started')?.thread_id ?? thread;
    if (!id) throw Error('Reviewer thread ID missing');
    const meta = { role, actor: spec.actor, model, effort: spec.effort, round, head, thread: id, report: reportPath, provider: 'CLIProxyAPI', resumed: !!thread };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...meta, result: report }));
    break;
  }
} finally { clean(); }
