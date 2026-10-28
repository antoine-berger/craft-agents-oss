#!/usr/bin/env python3
"""Fork release updater. check/stage never stop, restart, or modify a live release.

Install root-owned as /usr/local/sbin/craft-fork-update. apply is available only
through SSH and requires --authorize-restart; there is no agent-facing RPC.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

REPOSITORY = 'antoine-berger/craft-agents-oss'
MANIFEST_URL = f'https://github.com/{REPOSITORY}/releases/latest/download/fork-release.json'
CACHE = Path('/var/cache/craft-fork-update')
RELEASES = Path('/home/craft/releases')
DATA = Path('/home/craft/.craft-agent')
DROPIN = Path('/etc/systemd/system/craft-agents.service.d/zz-fork-updater.conf')
SERVICE = 'craft-agents'
BUN = '/home/craft/.bun/bin/bun'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Expected a stable x.y.z fork version')
    return tuple(map(int, value.split('.')))


def validate_manifest(obj, requested, expected_hash):
    if obj.get('schema') != 1 or obj.get('repository') != REPOSITORY or obj.get('version') != requested:
        raise ValueError('Fork release changed; check for updates again')
    version(requested)
    asset = obj['assets']['server-linux-x64']
    expected_url = f'https://github.com/{REPOSITORY}/releases/download/fork-v{requested}/craft-server-linux-x64.tar.gz'
    if asset.get('url') != expected_url or not re.fullmatch(r'[a-f0-9]{64}', asset.get('sha256', '')):
        raise ValueError('Invalid server asset')
    if asset['sha256'] != expected_hash or not isinstance(asset.get('size'), int) or asset['size'] <= 0:
        raise ValueError('Server asset checksum or size changed')
    return asset


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def current_release():
    return Path(run('systemctl', 'show', SERVICE, '--value', '-p', 'WorkingDirectory')).resolve(strict=True)


def current_version():
    root = current_release()
    marker = root / '.fork-release.json'
    if marker.exists():
        obj = json.loads(marker.read_text())
        if obj.get('repository') != REPOSITORY:
            raise ValueError('Running server belongs to another release channel')
        return obj['version']
    return json.loads((root / 'package.json').read_text())['version']


def verify_file(path, asset):
    if path.stat().st_size != asset['size']:
        raise ValueError('Server archive size mismatch')
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != asset['sha256']:
        raise ValueError('Server archive checksum mismatch')


def safe_extract(archive, destination):
    # Python's data filter rejects absolute paths, traversal, escaping links,
    # special devices and unsafe ownership. Do not use tar's permissive defaults.
    with tarfile.open(archive) as handle:
        handle.extractall(destination, filter='data')


def status(target, asset):
    old = current_version()
    staged = RELEASES / f'fork-{target}'
    marker = staged / '.fork-release.json'
    ready = marker.exists() and json.loads(marker.read_text()).get('sha256') == asset['sha256']
    return {'currentVersion': old, 'available': version(target) > version(old), 'staged': ready}


def stage(target, asset):
    result = status(target, asset)
    if not result['available'] or result['staged']:
        return result
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = CACHE / f'{target}.tar.gz'
    try:
        verify_file(archive, asset)
    except (OSError, ValueError):
        partial = archive.with_suffix('.partial')
        received = 0
        with urllib.request.urlopen(asset['url'], timeout=300) as source, partial.open('wb') as dest:
            while block := source.read(1024 * 1024):
                received += len(block)
                if received > asset['size']:
                    raise ValueError('Server archive exceeds expected size')
                dest.write(block)
        verify_file(partial, asset)
        partial.replace(archive)
    destination = RELEASES / f'fork-{target}'
    if destination.exists():
        raise ValueError('Unverified staging directory already exists; preserved for inspection')
    temporary = RELEASES / f'.fork-{target}.staging-{int(time.time())}'
    temporary.mkdir(mode=0o755)
    try:
        safe_extract(archive, temporary)
        for required in ['packages/server/src/index.ts', 'apps/webui/dist/index.html', 'apps/electron/resources', 'bun.lock']:
            if not (temporary / required).exists():
                raise ValueError(f'Incomplete server release: missing {required}')
        install_tmp = temporary / '.update-tmp'
        install_tmp.mkdir(mode=0o700)
        run('chown', '-R', 'craft:craft', str(temporary))
        # Installs are isolated in the new release on disk. No live node_modules,
        # environment, worktree, project or conversation is modified.
        run('runuser', '-u', 'craft', '--', 'env', 'HOME=/home/craft',
            'PATH=/home/craft/.bun/bin:/usr/local/bin:/usr/bin:/bin', 'HUSKY=0',
            'TMPDIR=' + str(install_tmp), 'BUN_INSTALL_CACHE_DIR=' + str(install_tmp / 'bun-cache'),
            BUN, 'install', '--frozen-lockfile', cwd=temporary, timeout=1200)
        run('runuser', '-u', 'craft', '--', BUN, '-e',
            "await import('@craft-agent/shared/protocol'); await import('@craft-agent/server-core/transport')",
            cwd=temporary, timeout=30)
        # The marker is written only after extraction and dependency installation.
        (temporary / '.fork-release.json').write_text(json.dumps({
            'repository': REPOSITORY, 'version': target, 'sha256': asset['sha256'],
        }) + '\n')
        temporary.rename(destination)
    except BaseException:
        # Preserve failed preparation and logs for diagnosis, never touch a live release.
        raise
    return status(target, asset)


def rpc_probe(require_idle=True):
    pid = run('systemctl', 'show', SERVICE, '--value', '-p', 'MainPID')
    if not pid.isdigit() or pid == '0':
        raise ValueError('Running server not found; restart refused')
    root = current_release()
    # Read the actual service environment without displaying or putting tokens on argv.
    env = {}
    for field in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
        key, sep, val = field.partition(b'=')
        if sep:
            env[key.decode()] = val.decode()
    env['FORK_CURRENT'] = str(root)
    env['FORK_REQUIRE_IDLE'] = '1' if require_idle else '0'
    script = """
const {CliRpcClient} = await import(process.env.FORK_CURRENT + '/apps/cli/src/client.ts');
const host = process.env.CRAFT_RPC_HOST || '127.0.0.1';
const c = new CliRpcClient('ws://' + host + ':' + (process.env.CRAFT_RPC_PORT || '9100'), {token:process.env.CRAFT_SERVER_TOKEN});
try {await c.connect(); const active = await c.invoke('server:getActiveSessions');
if (!Array.isArray(active) || (process.env.FORK_REQUIRE_IDLE === '1' && active.length)) process.exitCode = 2;
else console.log('IDLE');} finally {c.destroy()}
"""
    try:
        if run(BUN, '-e', script, env=env, cwd=root, timeout=25) != 'IDLE':
            raise ValueError('Cannot verify that all sessions are idle')
    except subprocess.CalledProcessError:
        raise ValueError('A session is active or the idle check failed; restart refused') from None
    return pid


def assert_idle():
    pid = rpc_probe()
    group = run('systemctl', 'show', SERVICE, '--value', '-p', 'ControlGroup')
    # Reject even idle Claude runtimes and untracked shells/builds. CLIProxyAPI is
    # the only persistent child allowed; it has no per-session commands.
    for proc_file in (Path('/sys/fs/cgroup') / group.lstrip('/')).rglob('cgroup.procs'):
        for child in proc_file.read_text().split():
            if child == pid:
                continue
            try:
                exe = Path(f'/proc/{child}/exe').resolve(strict=True).name
            except FileNotFoundError:
                continue
            if exe not in ('cli-proxy-api', 'CLIProxyAPI', 'cliproxyapi'):
                raise ValueError('An agent or command still has a process in Craft; restart refused')
    return pid


def apply(target, asset, authorized):
    if not authorized:
        raise ValueError('Explicit --authorize-restart is required; nothing restarted')
    result = status(target, asset)
    if not result['available']:
        return result
    if not result['staged']:
        raise ValueError('Prepare this exact release before applying it')
    verify_file(CACHE / f'{target}.tar.gz', asset)
    assert_idle()
    destination = RELEASES / f'fork-{target}'
    backup = Path('/var/backups') / f'craft-fork-{target}-{time.time_ns()}'
    backup.mkdir(mode=0o700)
    shutil.copytree('/etc/systemd/system/craft-agents.service.d', backup / 'service.d')
    shutil.copy2('/etc/systemd/system/craft-agents.service', backup / 'craft-agents.service')
    shutil.copy2('/etc/craft-agents.env', backup / 'craft-agents.env')
    run('rsync', '-aHAX', '--numeric-ids', str(DATA) + '/', str(backup / 'craft-agent') + '/')
    previous = DROPIN.read_text() if DROPIN.exists() else None
    assert_idle()  # Recheck after the potentially slow live backup.
    stopped = False
    try:
        run('systemctl', 'stop', SERVICE)
        stopped = True
        # Final consistent data backup after the process has flushed its history.
        run('rsync', '-aHAX', '--numeric-ids', '--delete', str(DATA) + '/', str(backup / 'craft-agent') + '/')
        DROPIN.write_text('[Service]\n' + f'WorkingDirectory={destination}\n' +
            f'Environment="CRAFT_WEBUI_DIR={destination}/apps/webui/dist"\n' +
            f'Environment="CRAFT_BUNDLED_ASSETS_ROOT={destination}/apps/electron"\n' +
            'Environment="ENABLE_TOOL_SEARCH=true"\n')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', SERVICE)
        for _ in range(30):
            time.sleep(2)
            try:
                if run('systemctl', 'is-active', SERVICE) == 'active':
                    # Healthy is not the same as idle: resumed work must not trigger rollback.
                    rpc_probe(require_idle=False)
                    return {'currentVersion': target, 'available': False, 'staged': True, 'backup': str(backup)}
            except (ValueError, subprocess.CalledProcessError):
                pass
        raise ValueError('Updated server failed its RPC health check')
    except BaseException:
        if stopped:
            if previous is None:
                DROPIN.unlink(missing_ok=True)
            else:
                DROPIN.write_text(previous)
            run('systemctl', 'daemon-reload')
            run('systemctl', 'restart', SERVICE)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'stage', 'apply'])
    parser.add_argument('version')
    parser.add_argument('sha256')
    parser.add_argument('--authorize-restart', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run this administrator helper over SSH as root')
    # Refuse before any network or system operation when apply lacks consent.
    if args.action == 'apply' and not args.authorize_restart:
        raise ValueError('Explicit --authorize-restart is required; nothing restarted')
    version(args.version)
    asset = validate_manifest(fetch_json(MANIFEST_URL), args.version, args.sha256)
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (CACHE / 'update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'check':
            result = status(args.version, asset)
        elif args.action == 'stage':
            result = stage(args.version, asset)
        else:
            result = apply(args.version, asset, args.authorize_restart)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Don't forward subprocess output: it can contain provider credentials.
        print(json.dumps({'error': str(error) if not isinstance(error, subprocess.CalledProcessError) else 'Update command failed; inspect the staged release on disk'}), file=sys.stderr)
        sys.exit(1)
