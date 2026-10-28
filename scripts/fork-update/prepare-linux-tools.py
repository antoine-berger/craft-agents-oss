#!/usr/bin/env python3
"""Expose the existing Node runtime and install tsx for unchanged Linux repo hooks.

Run explicitly as root from a verified release. Never restarts services or edits
repositories, hook sources, credentials, or conversations.
"""
import json
import os
from pathlib import Path
import subprocess
import time


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def main():
    if os.geteuid() != 0:
        raise ValueError('Run as root on the Craft Linux host')
    node_bin = Path('/home/craft/.local/share/mise/installs/node/24.22.1/bin')
    if run(str(node_bin / 'node'), '--version') != 'v24.22.1':
        raise ValueError('Expected the already installed Node 24.22.1 runtime')
    # mise's npm shell wrapper locates npm relative to BASH_SOURCE and cannot be
    # symlinked elsewhere. Link the actual npm CLI, just as npx/corepack do.
    executables = {name: (node_bin / name).resolve() for name in ['node', 'npx', 'corepack']}
    executables['npm'] = node_bin.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    links = {Path('/usr/local/bin') / name: source for name, source in executables.items()}
    for target, source in links.items():
        if not source.exists():
            raise ValueError(f'Missing runtime executable: {source}')
        previous_link = node_bin / target.name
        managed_link = target.is_symlink() and os.readlink(target) == str(previous_link)
        if (target.exists() or target.is_symlink()) and target.resolve() != source.resolve() and not managed_link:
            raise ValueError(f'Existing executable preserved; inspect first: {target}')
    tsx = Path('/usr/local/bin/tsx')
    if tsx.exists() and not Path('/usr/local/lib/node_modules/tsx/package.json').exists():
        raise ValueError('Existing unrelated tsx executable preserved')
    backup = Path('/var/backups') / f'craft-linux-tools-{time.time_ns()}'
    backup.mkdir(mode=0o700)
    before = {str(p): os.readlink(p) if p.is_symlink() else None for p in links}
    (backup / 'links-before.json').write_text(json.dumps(before, indent=2) + '\n')
    for target, source in links.items():
        if target.is_symlink() and target.resolve() != source.resolve():
            target.unlink()
        if not target.exists():
            target.symlink_to(source)
    cache = Path('/var/cache/craft-linux-tools')
    cache.mkdir(mode=0o700, exist_ok=True)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root',
           'NPM_CONFIG_CACHE': str(cache), 'NPM_CONFIG_USERCONFIG': '/dev/null',
           'TMPDIR': str(cache)}
    package = Path('/usr/local/lib/node_modules/tsx/package.json')
    if not package.exists() or json.loads(package.read_text())['version'] != '4.21.0':
        if package.exists():
            raise ValueError('Existing tsx version preserved; inspect before replacing')
        subprocess.run(['/usr/local/bin/npm', 'install', '--global', '--prefix', '/usr/local',
                        '--ignore-scripts', '--no-audit', '--no-fund', 'tsx@4.21.0'],
                       env=env, check=True, timeout=180)
    # npm exec checks this runtime's global-bin before PATH. Point it at the same
    # installed tsx so npx can run hooks offline in a new checkout without deps.
    launcher = node_bin / 'tsx'
    if launcher.exists() or launcher.is_symlink():
        if launcher.resolve() != tsx.resolve():
            raise ValueError('Existing runtime tsx launcher preserved')
    else:
        (backup / 'npx-launcher-before.json').write_text(json.dumps({'path': str(launcher), 'before': None}) + '\n')
        launcher.symlink_to(tsx)
    versions = {name: run('/usr/local/bin/' + name, '--version', env=env)
                for name in ['node', 'npm', 'npx', 'tsx']}
    (backup / 'installed.json').write_text(json.dumps(versions, indent=2) + '\n')
    print(json.dumps({'backup': str(backup), 'versions': versions, 'serverRestarted': False}))


if __name__ == '__main__':
    main()
