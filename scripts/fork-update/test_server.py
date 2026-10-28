import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fork_server', Path(__file__).with_name('server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class ForkServerTests(unittest.TestCase):
    def test_apply_cannot_touch_anything_without_explicit_consent(self):
        with patch.object(server, 'run', side_effect=AssertionError('must not run commands')), patch.object(server, 'status', side_effect=AssertionError('must not inspect or mutate')):
            with self.assertRaisesRegex(ValueError, 'authorize-restart'):
                server.apply('0.15.7', {}, False)
            with self.assertRaisesRegex(ValueError, 'authorize-restart'):
                server.apply('0.15.7', {}, False, force=True)

    def test_only_exact_fork_asset_and_checksum_can_be_staged(self):
        asset = {'url': f'https://github.com/{server.REPOSITORY}/releases/download/fork-v0.15.7/craft-server-linux-x64.tar.gz', 'sha256': 'a' * 64, 'size': 1024}
        manifest = {'schema': 1, 'repository': server.REPOSITORY, 'version': '0.15.7', 'assets': {'server-linux-x64': asset}}
        self.assertEqual(server.validate_manifest(manifest, '0.15.7', 'a' * 64), asset)
        with self.assertRaises(ValueError): server.validate_manifest(manifest, '0.15.7', 'b' * 64)
        asset['url'] = 'https://thecraftagents.com/server.tar.gz'
        with self.assertRaises(ValueError): server.validate_manifest(manifest, '0.15.7', 'a' * 64)

    def test_check_is_read_only_and_never_stops_or_prepares(self):
        with tempfile.TemporaryDirectory() as root, patch.object(server, 'RELEASES', Path(root)), patch.object(server, 'current_version', return_value='0.15.6'), patch.object(server, 'run', side_effect=AssertionError('must not invoke commands')):
            self.assertEqual(server.status('0.15.7', {'sha256': 'a' * 64}), {'currentVersion': '0.15.6', 'available': True, 'staged': False})
            self.assertEqual(list(Path(root).iterdir()), [])

    def test_apply_refuses_before_backup_when_runtime_is_busy(self):
        with patch.object(server, 'status', return_value={'available': True, 'staged': True}), patch.object(server, 'verify_file'), patch.object(server, 'assert_idle', side_effect=ValueError('command still active')), patch.object(server, 'run', side_effect=AssertionError('must not stop')):
            with self.assertRaisesRegex(ValueError, 'command still active'): server.apply('0.15.7', {}, True)

    def test_force_keeps_backup_and_health_checks_but_bypasses_activity(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); dropin = root / 'update.conf'; commands = []
            def command(*args, **kwargs):
                commands.append(args)
                return 'active' if args == ('systemctl', 'is-active', server.SERVICE) else ''
            def path(value):
                return root if value == '/var/backups' else Path(value)
            with patch.object(server, 'status', return_value={'available': True, 'staged': True}), patch.object(server, 'verify_file'), patch.object(server, 'Path', side_effect=path), patch.object(server, 'DROPIN', dropin), patch.object(server, 'assert_idle', side_effect=AssertionError('force must bypass activity check')), patch.object(server, 'rpc_probe', return_value='123') as health, patch.object(server.shutil, 'copytree'), patch.object(server.shutil, 'copy2'), patch.object(server.time, 'sleep'), patch.object(server, 'run', side_effect=command):
                result = server.apply('0.15.7', {}, True, force=True)
            self.assertEqual(result['currentVersion'], '0.15.7')
            self.assertTrue(Path(result['backup']).is_dir())
            self.assertEqual(health.call_count, 3)
            self.assertTrue(all(call.kwargs == {'require_idle': False} for call in health.call_args_list))
            stop = commands.index(('systemctl', 'stop', server.SERVICE))
            self.assertTrue(any(args[0] == 'rsync' for args in commands[:stop]))
            self.assertEqual(commands[stop + 1][0], 'rsync')
            self.assertIn('--delete', commands[stop + 1])
            self.assertIn(('systemctl', 'start', server.SERVICE), commands)

    def test_preparation_uses_its_own_writable_disk_cache(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); releases = root / 'releases'; releases.mkdir()
            cache = root / 'downloads'; cache.mkdir()
            commands = []
            def extract(_archive, dest):
                for name in ['packages/server/src/index.ts', 'apps/webui/dist/index.html', 'bun.lock']:
                    path = dest / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('fixture')
                (dest / 'apps/electron/resources').mkdir(parents=True)
            with patch.object(server, 'RELEASES', releases), patch.object(server, 'CACHE', cache), patch.object(server, 'verify_file'), patch.object(server, 'safe_extract', side_effect=extract), patch.object(server, 'run', side_effect=lambda *args, **kwargs: commands.append(args)), patch.object(server, 'status', side_effect=[{'available': True, 'staged': False}, {'available': True, 'staged': True}]):
                server.stage('0.15.7', {'sha256': 'a' * 64})
            install = next(args for args in commands if 'install' in args)
            self.assertTrue(any(str(arg).startswith('TMPDIR=' + str(releases)) for arg in install))
            self.assertTrue(any(str(arg).startswith('BUN_INSTALL_CACHE_DIR=' + str(releases)) for arg in install))
            self.assertTrue((releases / 'fork-0.15.7/.update-tmp').is_dir())

    def test_corrupted_cached_download_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'download'; file.write_bytes(b'good')
            asset = {'size': 4, 'sha256': hashlib.sha256(b'good').hexdigest()}
            server.verify_file(file, asset)
            file.write_bytes(b'evil')
            with self.assertRaisesRegex(ValueError, 'checksum'): server.verify_file(file, asset)

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'requires Python tar data filter')
    def test_archive_cannot_escape_destination(self):
        for kind in ['path', 'symlink']:
            with tempfile.TemporaryDirectory() as root:
                root = Path(root); archive = root / 'update.tar.gz'; dest = root / 'unpack'; dest.mkdir()
                with tarfile.open(archive, 'w:gz') as tar:
                    item = tarfile.TarInfo('../outside' if kind == 'path' else 'link')
                    if kind == 'symlink': item.type = tarfile.SYMTYPE; item.linkname = '../../outside'
                    tar.addfile(item)
                with self.assertRaises(tarfile.FilterError): server.safe_extract(archive, dest)
                self.assertFalse((root / 'outside').exists())

if __name__ == '__main__': unittest.main()
