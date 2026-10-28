#!/usr/bin/env python3
"""Read Craft histories and local Git; feed the unchanged /heures renderer."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from zoneinfo import ZoneInfo

GEN_SHA256 = '3129df6bacf2bc01570aacd1250ad0d76f1a95c9d2cc2bce087d317f05a8c8b3'
WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']


def window(value, timezone, now=None):
    zone = ZoneInfo(timezone)
    now = now or dt.datetime.now(zone)
    now = now.astimezone(zone)
    if not value:
        date = now.date() - dt.timedelta(days=now.hour < 5)
    elif value.lower() in WEEKDAYS:
        days = (now.weekday() - WEEKDAYS.index(value.lower())) % 7 or 7
        date = now.date() - dt.timedelta(days=days)
    else:
        date = dt.date.fromisoformat(value)
    # Match gen.mjs exactly: noon's offset, 96 fixed 15-minute buckets.
    offset = dt.datetime.combine(date, dt.time(12), zone).utcoffset().total_seconds()
    start = int(dt.datetime.combine(date, dt.time(4), dt.timezone.utc).timestamp() - offset)
    return date.isoformat(), start, start + 86400


def epoch(value):
    if isinstance(value, (int, float)):
        return int(value / 1000 if value > 100_000_000_000 else value)
    if isinstance(value, str):
        try:
            return epoch(float(value))
        except ValueError:
            try:
                return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
            except ValueError:
                pass
    return None


def clean(value):
    return re.sub(r'[\t\r\n]+', ' ', str(value or '')).strip()


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def unpack_result(value, depth=0):
    if depth > 4:
        return {}
    if isinstance(value, str):
        try:
            return unpack_result(json.loads(value), depth + 1)
        except (ValueError, TypeError):
            return {}
    if isinstance(value, list):
        for item in value:
            found = unpack_result(item, depth + 1)
            if found.get('sessionId'):
                return found
    if isinstance(value, dict):
        if value.get('sessionId'):
            return value
        return unpack_result(value.get('text'), depth + 1)
    return {}


def collect_chats(root, start, end):
    root = Path(root)
    if not root.is_dir():
        raise RuntimeError('Craft sessions directory is unavailable; refusing an empty report')
    rows, automated, seen = [], [], set()
    stats = collections.Counter()
    for folder in sorted(root.iterdir()):
        if folder.is_symlink() or not folder.is_dir():
            continue
        files = [folder / 'session.jsonl']
        # Hidden/archived subchats retained during consolidation still contain real activity.
        files += sorted((folder / 'data/conductor-chats').glob('*/session.jsonl'))
        for path in files:
            if not path.is_file() or path.is_symlink():
                continue
            with path.open() as stream:
                try:
                    header = json.loads(next(stream))
                except (StopIteration, ValueError) as error:
                    raise RuntimeError(f'Unreadable session header: {path}') from error
                stats['filesRead'] += 1
                sid = header.get('id', folder.name)
                label = clean(header.get('name') or header.get('importedFrom', {}).get('repository') or sid)
                for number, line in enumerate(stream, 2):
                    try:
                        message = json.loads(line)
                    except ValueError:
                        # A concurrent append may leave only the final line incomplete.
                        if not line.endswith('\n'):
                            stats['incompleteTrailingLines'] += 1
                            continue
                        raise RuntimeError(f'Invalid history at {path}:{number}')
                    stamp = epoch(message.get('timestamp'))
                    if stamp is None or not start <= stamp < end:
                        continue
                    mid = message.get('conductorSourceMessageId') or message.get('id')
                    if mid and mid in seen:
                        stats['duplicatesExcluded'] += 1
                        continue
                    if mid:
                        seen.add(mid)
                    if message.get('hidden'):
                        stats['hiddenSystemMessagesExcluded'] += 1
                        continue
                    kind = message.get('type') or message.get('role')
                    if kind not in ('user', 'assistant', 'tool', 'plan'):
                        continue
                    imported = message.get('conductorSourceChatId') or str(mid).startswith('conductor-') or path != folder / 'session.jsonl'
                    stats['importedMessages' if imported else 'nativeMessages'] += 1
                    content = message.get('content', '')
                    content_key = digest(content if isinstance(content, str) else json.dumps(content, sort_keys=True))
                    rows.append({'role': 'user' if kind == 'user' else 'assistant', 'epoch': stamp,
                                 'label': label, 'session': sid, 'contentKey': content_key})
                    name = message.get('toolName', '')
                    args = message.get('toolInput') or {}
                    if not isinstance(args, dict) or message.get('isError'):
                        continue
                    if name.endswith('spawn_session') and isinstance(args.get('prompt'), str):
                        target = unpack_result(message.get('toolResult')).get('sessionId')
                        if target:
                            automated.append((target, digest(args['prompt']), stamp))
                    elif name.endswith('send_agent_message') and isinstance(args.get('message'), str):
                        target = args.get('sessionId') or args.get('session_id')
                        if target and message.get('toolResult'):
                            automated.append((target, digest(args['message']), stamp))
    # Old Craft versions persisted agent deliveries as ordinary user bubbles. Match the sender's
    # actual tool call, target and exact text rather than guessing from words such as "Continue".
    candidates = collections.defaultdict(list)
    for index, row in enumerate(rows):
        if row['role'] == 'user':
            candidates[(row['session'], row['contentKey'])].append(index)
    matched = set()
    for target, text_hash, stamp in sorted(automated, key=lambda value: value[2]):
        choices = [i for i in candidates[(target, text_hash)] if i not in matched and abs(rows[i]['epoch'] - stamp) <= 180]
        if choices:
            index = min(choices, key=lambda i: abs(rows[i]['epoch'] - stamp))
            rows[index]['role'] = 'assistant'
            matched.add(index)
    stats['automatedPromptsExcludedFromHumanTime'] = len(matched)
    stats['humanMessages'] = sum(row['role'] == 'user' for row in rows)
    stats['agentActivityMessages'] = len(rows) - stats['humanMessages']
    result = sorted({(row['role'], row['epoch'], row['label']) for row in rows}, key=lambda row: (row[1], row[0], row[2]))
    return result, dict(stats)


def collect_git(roots, author, start, end):
    common_dirs, commits = set(), set()
    for parent in roots:
        parent = Path(parent)
        if not parent.is_dir():
            continue
        candidates = [parent] if (parent / '.git').exists() or (parent / 'HEAD').is_file() else sorted(parent.iterdir())
        for repo in candidates:
            if not repo.is_dir() or not ((repo / '.git').exists() or ((repo / 'HEAD').is_file() and (repo / 'objects').is_dir())):
                continue
            gitdir = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--git-common-dir'], text=True, capture_output=True, timeout=20)
            if gitdir.returncode:
                raise RuntimeError(f'Cannot read local Git metadata: {repo}')
            common = (repo / gitdir.stdout.strip()).resolve()
            if common in common_dirs:
                continue
            common_dirs.add(common)
            result = subprocess.run(['git', '-C', str(repo), 'log', '--all', '--no-show-signature', f'--author={author}',
                                     f'--since=@{start}', f'--until=@{end}', '--format=%H%x00%at%x00%s%x00%B%x00%x1e'],
                                    text=True, capture_output=True, timeout=60)
            if result.returncode:
                raise RuntimeError(f'Cannot read local commits: {repo}')
            for record in result.stdout.split('\x1e'):
                fields = record.strip('\n').split('\x00')
                if len(fields) < 4:
                    continue
                sha, stamp, subject, body = fields[:4]
                if not start <= int(stamp) < end or re.search(r'Co-Authored-By:.*(?:Claude|Codex|GPT|OpenAI|Anthropic)', body, re.I):
                    continue
                ticket = re.search(r'\b((?:SAP|AGENT|POL|DOPS)-\d+)\b', subject, re.I)
                branch = re.search(r' from [^/]+/(.+)$', subject)
                label = ticket.group(1).upper() if ticket else branch.group(1) if branch else subject
                commits.add((sha, int(stamp), clean(label)))
    return sorted({(stamp, label) for _, stamp, label in commits}), len(common_dirs)


def backup(path, root):
    if path.is_file():
        content = path.read_bytes()
        target = root / '.history' / path.parent.name / f'{path.name}-{hashlib.sha256(content).hexdigest()}'
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not target.exists():
            target.write_bytes(content)
            target.chmod(0o600)


def save(path, text, root):
    if path.exists() and path.read_text() == text:
        return
    backup(path, root)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.new')
    temporary.write_text(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def display_text(text):
    # Keep gen.mjs immutable. Only source labels change; all calculation, CSS and SVG stay intact.
    return text.replace('Conductor + Slack + Calendar + Git', 'Craft + Slack + Calendar + Git').replace('message Conductor', 'message Craft').replace('conductor ✓', 'craft ✓').replace('conductor ✗', 'craft ✗')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['window', 'collect', 'render'])
    parser.add_argument('date', nargs='?', default='')
    parser.add_argument('--config', type=Path, default=Path.home() / '.claude/heures/config.json')
    parser.add_argument('--skip-source', action='append', choices=['slack', 'calendar'], default=[])
    parser.add_argument('--output', type=Path, help='Copy the HTML to this session data file')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    date, start, end = window(args.date.strip(), config['timezone'])
    metadata = {'date': date, 'timezone': config['timezone'], 'startEpoch': start, 'endEpoch': end,
                'startISO': dt.datetime.fromtimestamp(start, dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
                'endISO': dt.datetime.fromtimestamp(end, dt.timezone.utc).isoformat().replace('+00:00', 'Z')}
    if args.phase == 'window':
        print(json.dumps(metadata, ensure_ascii=False))
        return
    root = Path.home() / '.claude/heures'
    folder = root / date
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.phase == 'collect':
        rows, stats = collect_chats(config['sessionsRoot'], start, end)
        git_rows, repositories = collect_git(config['repositoryRoots'], config['gitAuthor'], start, end)
        save(folder / 'conductor.csv', ''.join(f'{role}\t{stamp}\t{label}\n' for role, stamp, label in rows), root)
        if repositories:
            save(folder / 'git.csv', ''.join(f'{stamp}\t{label}\n' for stamp, label in git_rows), root)
        elif (folder / 'git.csv').exists():
            backup(folder / 'git.csv', root)
            (folder / 'git.csv').unlink()
        for source in args.skip_source:
            path = folder / f'{source}.csv'
            backup(path, root)
            path.unlink(missing_ok=True)
        names = {}
        names_path = root / 'names.tsv'
        if names_path.is_file():
            names = dict(line.split('\t', 1) for line in names_path.read_text().splitlines() if '\t' in line)
        labels = {row[2] for row in rows} | {row[1] for row in git_rows}
        save(folder / 'missing-labels.txt', ''.join(label + '\n' for label in sorted(labels - names.keys())), root)
        metadata.update(stats, localRepositories=repositories, manualGitEvents=len(git_rows), directory=str(folder))
        save(folder / 'collection.json', json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', root)
        print(json.dumps(metadata, ensure_ascii=False))
        return
    generator = root / 'gen.mjs'
    if not generator.is_file() or hashlib.sha256(generator.read_bytes()).hexdigest() != GEN_SHA256:
        raise RuntimeError('Original frozen gen.mjs is missing or changed; do not regenerate it')
    if not (folder / 'conductor.csv').is_file():
        raise RuntimeError('Collect Craft histories first')
    html = folder / 'heures.html'
    backup(html, root)
    html.unlink(missing_ok=True)
    env = dict(os.environ, TZ=config['timezone'])
    result = subprocess.run([config['javascriptRuntime'], str(generator), date], env=env, text=True, capture_output=True, timeout=60, check=True)
    summary = display_text(result.stdout)
    if html.is_file():
        save(html, display_text(html.read_text()), root)
        if args.output:
            output = args.output.expanduser().resolve()
            save(output, html.read_text(), root)
            summary = summary.replace(str(html), str(output))
    save(folder / 'summary.txt', summary, root)
    print(summary, end='')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'/heures: {error}', file=sys.stderr)
        sys.exit(1)
