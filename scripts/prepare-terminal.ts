import { chmodSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// node-pty 1.1's published Darwin helper can arrive without its executable bit.
// Repair the installed dependency as well as the separately staged app bundle.
const root = resolve(import.meta.dir, '../node_modules/node-pty')
for (const arch of ['arm64', 'x64']) {
  const helper = resolve(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
