import { resolve } from 'node:path'
import { downloadBun, downloadUv, copySDK, copyRipgrep, copyInterceptor, copyPiAgentServer, type BuildConfig } from '../build/common'
const rootDir = resolve(import.meta.dir, '../..')
const config: BuildConfig = { rootDir, electronDir: resolve(rootDir, 'apps/electron'), platform: 'darwin', arch: 'arm64', upload: false, uploadLatest: false, uploadScript: false }
await downloadBun(config)
await downloadUv(config)
copySDK(config)
copyRipgrep(config)
copyInterceptor(config)
copyPiAgentServer(config)
