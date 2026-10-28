#!/usr/bin/env python3
"""Reject release candidates that lose verified server or compiled-client fixes."""
from pathlib import Path
from contextlib import ExitStack
import argparse, hashlib, json, posixpath, re, sys, tarfile, zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_sources(read, expected, errors, label='source'):
    for path, sha in expected.items():
        data = read(path)
        if data is None or digest(data) != sha:
            errors.append(label + ': ' + path)


def verify_renderer(read, expected, errors):
    queue, visited, found = ['index.html'], set(), {}
    while queue:
        path = queue.pop()
        if path in visited:
            continue
        visited.add(path)
        raw = read(path)
        if raw is None:
            if path == 'index.html':
                errors.append('renderer: missing index.html')
            continue
        text = raw.decode('utf-8')
        for ref in re.findall(r'''["']([^"'\n]+\.js(?:\?[^"'\n]*)?)["']''', text):
            ref = ref.split('?', 1)[0]
            for target in [posixpath.normpath(posixpath.join(posixpath.dirname(path), ref)), ref.lstrip('/')]:
                if not target.startswith('../') and read(target) is not None:
                    queue.append(target)
        if path.endswith('.js'):
            raw_map = read(path + '.map')
            if raw_map is None:
                continue
            mapping = json.loads(raw_map)
            for source, content in zip(mapping.get('sources', []), mapping.get('sourcesContent', [])):
                if content is None:
                    continue
                for target in expected:
                    suffix = target.removeprefix('apps/electron/')
                    if source.replace('\\', '/').endswith('/' + suffix):
                        found.setdefault(target, set()).add(digest(content.encode()))
    for path, sha in expected.items():
        if found.get(path) != {sha}:
            errors.append('compiled renderer: ' + path)


def directory(root):
    root = Path(root)
    def read(path):
        p = root / path
        return p.read_bytes() if p.is_file() else None
    return read


def verify_native(read, expected, errors):
    for path, markers in expected.items():
        raw = read(path)
        if raw is None or any(marker not in raw.decode('utf-8') for marker in markers):
            errors.append('compiled native: ' + path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=Path(__file__).with_name('release-base.lock.json'))
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--renderer-dir', type=Path)
    parser.add_argument('--native-dir', type=Path)
    parser.add_argument('--server-archive', type=Path)
    parser.add_argument('--mac-archive', type=Path)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    errors = []
    with ExitStack() as stack:
        if args.source_root:
            verify_sources(directory(args.source_root), lock['sourceFiles'], errors)
        if args.renderer_dir:
            verify_renderer(directory(args.renderer_dir), lock['compiledClientFiles'], errors)
        if args.native_dir:
            verify_native(directory(args.native_dir), lock['compiledNativeFeatures'], errors)
        if args.server_archive:
            archive = stack.enter_context(tarfile.open(args.server_archive, mode='r|gz'))
            contents = {}
            for member in archive:
                name = posixpath.normpath(member.name)
                if member.isfile() and (name in lock['sourceFiles'] or (
                    name.startswith('apps/webui/dist/') and name.endswith(('.html', '.js', '.js.map'))
                )):
                    contents[name] = archive.extractfile(member).read()
            def read_server(path):
                return contents.get(path)
            verify_sources(read_server, lock['sourceFiles'], errors)
            verify_renderer(lambda p: read_server('apps/webui/dist/' + p), lock['compiledClientFiles'], errors)
        if args.mac_archive:
            archive_mac = stack.enter_context(zipfile.ZipFile(args.mac_archive))
            names = set(archive_mac.namelist())
            prefix = 'Craft Agents.app/Contents/Resources/app/dist/renderer/'
            verify_renderer(lambda p: archive_mac.read(prefix + p) if prefix + p in names else None, lock['compiledClientFiles'], errors)
            prefix = 'Craft Agents.app/Contents/Resources/app/dist/'
            verify_native(lambda p: archive_mac.read(prefix + p) if prefix + p in names else None,
                          lock['compiledNativeFeatures'], errors)
    if not any([args.source_root, args.renderer_dir, args.native_dir, args.server_archive, args.mac_archive]):
        parser.error('Select a source, renderer or archive to verify')
    if errors:
        print('Release blocked: verified fixes are missing or changed. Review and test before updating the lock.', file=sys.stderr)
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print('Verified release base: server fixes and reachable compiled-client sources match the lock.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
