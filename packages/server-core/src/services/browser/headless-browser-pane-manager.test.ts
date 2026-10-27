import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { HeadlessBrowserPaneManager } from './headless-browser-pane-manager'

const executable = process.env.CRAFT_BROWSER_EXECUTABLE_PATH
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath())
const available = await access(executable).then(() => true, () => false)
const browserSuite = available ? describe : describe.skip

const fixture = `<!doctype html><html><head><title>Browser fixture</title></head><body>
<h1>Browser fixture</h1>
<label>Name <input aria-label="Name" id="name"></label>
<label>Password <input aria-label="Password" type="password" value="never-expose-this"></label>
<label>Color <select aria-label="Color" id="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<label>Upload <input aria-label="Upload" type="file" id="file"></label>
<button id="click" onclick="document.querySelector('#result').textContent=event.isTrusted?'Trusted click':'Untrusted click'">Click me</button>
<button disabled>Disabled button</button>
<a href="/other">Other page</a><a target="_blank" href="/popup">Open popup</a><a href="/download" download>Download file</a>
<div id="result"></div><div style="height:1600px"></div><button id="bottom">Bottom</button>
<script>console.info('fixture console');fetch('/api');</script></body></html>`

browserSuite('server Chromium integration (disposable profiles and loopback only)', () => {
  let directory: string
  let manager: HeadlessBrowserPaneManager
  let server: ReturnType<typeof Bun.serve>
  let origin: string
  let id: string
  let sessionRoot: string
  let allowed: string
  const managers: HeadlessBrowserPaneManager[] = []
  function createManager() {
    const next = new HeadlessBrowserPaneManager({
      dataDir: join(directory, 'profiles'), executablePath: executable,
      resolveUploadDirectories: () => [allowed],
    })
    next.setSessionPathResolver(session => join(directory, 'sessions', session))
    managers.push(next)
    return next
  }
  async function ref(name: string, role?: string) {
    const snapshot = await manager.getAccessibilitySnapshot(id)
    const node = snapshot.nodes.find(node => node.name === name && (!role || node.role === role))
    if (!node) throw new Error(`No AX ref for ${name}: ${JSON.stringify(snapshot.nodes)}`)
    return node.ref
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'craft-headless-browser-'))
    sessionRoot = join(directory, 'sessions', 'first')
    allowed = join(directory, 'repo')
    await mkdir(sessionRoot, { recursive: true })
    await mkdir(allowed)
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/download') return new Response('fixture download\n', { headers: { 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Type': 'text/plain' } })
      if (pathname === '/api') return Response.json({ ok: true })
      if (pathname === '/challenge') return new Response('<title>Just a moment...</title><div id="challenge-stage">Verify you are human by completing the action below</div>', { headers: { 'Content-Type': 'text/html' } })
      if (pathname === '/transient') return new Response('<title>Just a moment...</title><script>setTimeout(()=>{document.title="Done"},100)</script>', { headers: { 'Content-Type': 'text/html' } })
      return new Response(pathname === '/' ? fixture : `<title>Other page</title><h1>${pathname}</h1>`, { headers: { 'Content-Type': 'text/html' } })
    } })
    origin = `http://127.0.0.1:${server.port}`
    manager = createManager()
    id = await manager.createForSessionAsync('first', { workspaceId: 'test-workspace' })
  }, 30_000)
  afterAll(async () => {
    for (const item of managers) await item.close()
    await server?.stop(true)
    if (directory) await rm(directory, { recursive: true, force: true })
  }, 30_000)

  test('launches with private persistent profile, navigates, and reads real AX refs', async () => {
    expect(manager.getOrCreateForSession('first', { workspaceId: 'test-workspace' })).toBe(id)
    expect(await manager.navigate(id, origin)).toEqual({ url: `${origin}/`, title: 'Browser fixture' })
    expect(await manager.createForSessionAsync('first', { workspaceId: 'test-workspace' })).toBe(id)
    expect((await manager.getInstanceAsync(id))?.currentUrl).toBe(`${origin}/`)
    const snapshot = await manager.getAccessibilitySnapshot(id)
    expect(snapshot.nodes.some(node => node.name === 'Name' && node.role === 'textbox')).toBe(true)
    expect(snapshot.nodes.some(node => node.name === 'Disabled button' && node.disabled)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('never-expose-this')
    expect(manager.listInstances()[0]?.isVisible).toBe(false)
    expect((await stat(join(directory, 'profiles'))).mode & 0o777).toBe(0o700)
    await expect(manager.navigate(id, 'file:///etc/passwd')).rejects.toThrow('http')
    await expect(manager.navigate(id, 'https://user:pass@example.invalid')).rejects.toThrow('Credentials')
    expect(await manager.detectSecurityChallenge(id)).toMatchObject({ detected: false })
  })

  test('fills, types, selects, uses isolated clipboard and sends trusted mouse input', async () => {
    await manager.fillElement(id, await ref('Name', 'textbox'), 'Antoine')
    await manager.typeText(id, ' Berger')
    expect(await manager.evaluate(id, 'document.querySelector("#name").value')).toBe('Antoine Berger')
    await manager.selectOption(id, await ref('Color', 'combobox'), 'Blue')
    expect(await manager.evaluate(id, 'document.querySelector("#color").value')).toBe('blue')
    await manager.setClipboard(id, 'server clipboard')
    await manager.fillElement(id, await ref('Name', 'textbox'), '')
    await manager.sendKey(id, { key: 'v', modifiers: ['control'] })
    await manager.sendKey(id, { key: 'a', modifiers: ['control'] })
    // Explicit selection works on both Linux Control and macOS Meta keyboard conventions.
    await manager.evaluate(id, 'document.querySelector("#name").select()')
    await manager.sendKey(id, { key: 'c', modifiers: ['control'] })
    expect(await manager.getClipboard(id)).toBe('server clipboard')
    expect(await manager.clickElement(id, await ref('Click me', 'button'))).toEqual({ via: 'mouse' })
    await manager.waitFor(id, { kind: 'text', value: 'Trusted click' })
    await expect(manager.clickElement(id, await ref('Disabled button', 'button'))).rejects.toThrow('disabled')
    await expect(manager.clickAtCoordinates(id, -1, 20)).rejects.toThrow('viewport')
    await manager.drag(id, 10, 10, 30, 30)
    await manager.sendKey(id, { key: 'Escape' })
  }, 30_000)

  test('takes real images and bounded regions after viewport resizing', async () => {
    expect(manager.windowResize(id, 900, 700)).toEqual({ width: 900, height: 700 })
    const clicked = await ref('Click me', 'button')
    const png = await manager.screenshot(id, { format: 'png', refs: [clicked], annotate: true, includeMetadata: true })
    expect(png.imageFormat).toBe('png')
    expect(png.metadata?.headless).toBe(true)
    expect((png.metadata?.targets as unknown[])?.length).toBeGreaterThan(0)
    const scrollBefore = await manager.evaluate(id, 'scrollY')
    await manager.screenshot(id, { annotate: true })
    expect(await manager.evaluate(id, 'scrollY')).toBe(scrollBefore)
    expect(await sharp(png.imageBuffer).metadata()).toMatchObject({ format: 'png', width: 900, height: 700 })
    const jpeg = await manager.screenshot(id, { mode: 'agent', includeLastAction: true, annotate: true })
    expect(await sharp(jpeg.imageBuffer).metadata()).toMatchObject({ format: 'jpeg' })
    const region = await manager.screenshotRegion(id, { x: 10, y: 20, width: 100, height: 80 })
    expect(await sharp(region.imageBuffer).metadata()).toMatchObject({ width: 100, height: 80 })
    const target = await manager.screenshotRegion(id, { selector: '#click', padding: 5, format: 'jpeg' })
    expect(target.imageFormat).toBe('jpeg')
    await expect(manager.screenshotRegion(id, { x: -100, y: -100, width: 1, height: 1 })).rejects.toThrow('outside')
    await manager.scroll(id, 'down', 700)
    await manager.waitFor(id, { kind: 'selector', value: '#bottom' })
    await manager.scroll(id, 'up', 700)
  })

  test('uploads server files only from authorized real directories', async () => {
    const permitted = join(allowed, 'fixture.txt'), outside = join(directory, 'outside.txt'), secret = join(allowed, '.env')
    await writeFile(permitted, 'upload fixture')
    await writeFile(outside, 'outside')
    await writeFile(secret, 'not-a-real-secret')
    await symlink(outside, join(allowed, 'escape.txt'))
    const input = await ref('Upload', 'button')
    expect(await manager.uploadFile(id, input, [permitted])).toEqual({ ref: input, files: 1 })
    expect(await manager.evaluate(id, 'document.querySelector("#file").files[0].name')).toBe('fixture.txt')
    await expect(manager.uploadFile(id, input, [outside])).rejects.toThrow('outside')
    await expect(manager.uploadFile(id, input, [join(allowed, 'escape.txt')])).rejects.toThrow('outside')
    await expect(manager.uploadFile(id, input, [secret])).rejects.toThrow('Sensitive')
    await expect(manager.uploadFile(id, input, ['relative.txt'])).rejects.toThrow('absolute')
  })

  test('collects console/network evidence, waits, and persists downloads in session storage', async () => {
    expect(manager.getConsoleLogs(id, { level: 'info' }).some(entry => entry.message === 'fixture console')).toBe(true)
    expect(manager.getNetworkLogs(id, { status: '2xx', method: 'get' }).some(entry => entry.url.endsWith('/api'))).toBe(true)
    await manager.waitFor(id, { kind: 'network-idle', idleMs: 100, timeoutMs: 2000 })
    await expect(manager.waitFor(id, { kind: 'selector', value: '#missing', timeoutMs: 100 })).rejects.toThrow('timed out')
    await manager.clickElement(id, await ref('Download file', 'link'))
    const downloads = await manager.getDownloads(id, { action: 'wait', timeoutMs: 5000 })
    expect(downloads[0]?.state).toBe('completed')
    expect(downloads[0]?.savePath?.startsWith(join(sessionRoot, 'downloads', 'browser'))).toBe(true)
    expect(await readFile(downloads[0]!.savePath!, 'utf8')).toBe('fixture download\n')
  })

  test('owns popups and history, and rejects refs after navigation', async () => {
    const popup = await manager.clickElement(id, await ref('Open popup', 'link'))
    expect(popup.popup).toBeDefined()
    expect(manager.listInstances().find(item => item.id === popup.popup)?.ownerSessionId).toBe('first')
    expect(await manager.createForSessionAsync('first', { workspaceId: 'test-workspace' })).toBe(popup.popup!)
    await manager.waitFor(popup.popup!, { kind: 'text', value: '/popup' })
    manager.focus(id)
    expect(await manager.createForSessionAsync('first', { workspaceId: 'test-workspace' })).toBe(id)
    manager.destroyInstance(popup.popup!)
    const old = await ref('Name', 'textbox')
    await manager.clickElement(id, await ref('Other page', 'link'), { waitFor: 'navigation' })
    await manager.waitFor(id, { kind: 'url', value: '/other' })
    await expect(manager.fillElement(id, old, 'stale')).rejects.toThrow('snapshot')
    expect((await manager.listInstancesAsync()).find(item => item.id === id)?.canGoBack).toBe(true)
    await manager.goBack(id)
    expect((await manager.getInstanceAsync(id))?.currentUrl).toBe(`${origin}/`)
    await manager.goForward(id)
    expect((await manager.getInstanceAsync(id))?.currentUrl).toBe(`${origin}/other`)
  })

  test('isolates session cookies and clipboard, prevents profile rebinding, and persists after restart', async () => {
    await manager.evaluate(id, 'document.cookie="isolated=first;path=/;max-age=3600";localStorage.setItem("persist","first")')
    const second = await manager.createForSessionAsync('second', { workspaceId: 'test-workspace' })
    await manager.navigate(second, origin)
    expect(await manager.evaluate(second, 'document.cookie')).toBe('')
    expect(await manager.evaluate(second, 'localStorage.getItem("persist")')).toBeNull()
    expect(await manager.getClipboard(second)).toBe('')
    expect(() => manager.bindSession(second, 'first')).toThrow('another session')
    manager.setAgentControl('second', { intent: 'test' })
    expect(manager.listInstances().find(item => item.id === second)?.agentControlActive).toBe(true)
    expect(manager.clearAgentControlForInstance(second, 'first').released).toBe(false)
    await manager.clearVisualsForSession('second')
    manager.unbindAllForSession('second')
    expect(manager.getInstance(second)?.ownerType).toBe('manual')
    expect(manager.getInstance(second)?.ownerSessionId).toBe('second')
    manager.destroyForSession('second')
    expect(manager.getInstance(second)).toBeUndefined()
    await manager.close()
    manager = createManager()
    id = await manager.getOrCreateForSessionAsync('first', { workspaceId: 'test-workspace' })
    await manager.navigate(id, origin)
    expect(await manager.evaluate(id, 'localStorage.getItem("persist")')).toBe('first')
    expect(await manager.evaluate(id, 'document.cookie')).toContain('isolated=first')
  }, 30_000)

  test('detects sustained human security challenges without solving them, ignores transient ones', async () => {
    await manager.navigate(id, `${origin}/challenge`)
    const detected = await manager.detectSecurityChallenge(id)
    expect(detected).toMatchObject({ detected: true, provider: 'cloudflare' })
    expect(await manager.evaluate(id, 'document.querySelector("#challenge-stage").textContent')).toContain('Verify you are human')
    await manager.navigate(id, `${origin}/transient`)
    expect((await manager.detectSecurityChallenge(id)).detected).toBe(false)
  })

  test('releases browser capacity on final tab close and safely reopens the same profile immediately', async () => {
    const limited = new HeadlessBrowserPaneManager({ dataDir: join(directory, 'limited-profiles'), executablePath: executable, maxContexts: 1 })
    managers.push(limited)
    const first = await limited.createForSessionAsync('limited-first')
    await limited.navigate(first, origin)
    await limited.evaluate(first, 'localStorage.setItem("closed","retained")')
    expect(() => limited.createForSession('limited-second')).toThrow('limit')
    limited.destroyInstance(first)
    expect(limited.getInstance(first)).toBeUndefined()
    const reopened = await limited.createForSessionAsync('limited-first')
    await limited.navigate(reopened, origin)
    expect(await limited.evaluate(reopened, 'localStorage.getItem("closed")')).toBe('retained')
    limited.destroyInstance(reopened)
    const next = await limited.createForSessionAsync('limited-second')
    await limited.navigate(next, origin)
    expect(await limited.evaluate(next, 'localStorage.getItem("closed")')).toBeNull()
    await limited.close()
    expect(limited.listInstances()).toEqual([])
  }, 30_000)
})

test('missing Chromium has an actionable error and needs no connected Mac', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-headless-missing-'))
  const manager = new HeadlessBrowserPaneManager({ dataDir: directory, executablePath: join(directory, 'missing-chromium') })
  try { await expect(manager.createForSessionAsync('missing')).rejects.toThrow('CRAFT_BROWSER_EXECUTABLE_PATH') }
  finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
})
