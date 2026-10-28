import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('release_guard', Path(__file__).with_name('verify-release-base.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class ReleaseBaseTests(unittest.TestCase):
    path = 'apps/electron/src/renderer/hooks/usePrWatch.ts'

    def fixtures(self, content):
        return {
            'index.html': b'<script type="module" src="./assets/main.js"></script>',
            'assets/main.js': b'console.log("app")',
            'assets/main.js.map': json.dumps({'sources': ['../../apps/electron/src/renderer/hooks/usePrWatch.ts'], 'sourcesContent': [content]}).encode(),
        }

    def test_reachable_compiled_fix_passes(self):
        expected = {self.path: hashlib.sha256(b'fixed').hexdigest()}
        errors = []
        guard.verify_renderer(self.fixtures('fixed').get, expected, errors)
        self.assertEqual(errors, [])

    def test_old_active_renderer_cannot_be_hidden_by_new_source_or_unused_assets(self):
        files = self.fixtures('old')
        files['src/renderer/hooks/usePrWatch.ts'] = b'fixed'
        files['assets/unused.js.map'] = files['assets/main.js.map'].replace(b'old', b'fixed')
        errors = []
        guard.verify_renderer(files.get, {self.path: hashlib.sha256(b'fixed').hexdigest()}, errors)
        self.assertEqual(errors, ['compiled renderer: ' + self.path])

    def test_missing_or_replaced_server_fix_blocks_publication(self):
        expected = {'query.ts': hashlib.sha256(b'valid query').hexdigest()}
        for files in [{}, {'query.ts': b'old query'}]:
            errors = []
            guard.verify_sources(files.get, expected, errors)
            self.assertEqual(errors, ['source: query.ts'])

if __name__ == '__main__':
    unittest.main()
