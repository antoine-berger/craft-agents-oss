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
