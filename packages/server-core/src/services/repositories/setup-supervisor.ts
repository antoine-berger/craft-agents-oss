import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// The lock is held by the worker and inherited by the setup shell. A dead server closes stdin;
// the worker kills its own process group before releasing it. Kernel locks need no stale-PID kill.
const WORKER = String.raw`
import base64, fcntl, json, os, select, signal, subprocess, sys, time

lease = None
child = None
stopping = False

def send(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

def control_ready():
    return bool(select.select([sys.stdin], [], [], 0)[0])

def read_control():
    line = sys.stdin.readline()
    return json.loads(line) if line else {"type": "stop"}

def stop_child():
    global child
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
    child = None

def stop_signal(_signal, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop_signal)
signal.signal(signal.SIGINT, stop_signal)

def execute(request):
    global child, stopping
    shell = os.environ.get("SHELL") or "/bin/sh"
    environment = dict(os.environ, **request["environment"])
    # Keep the leased shell alive; do not let a last-command exec optimization drop its lock FD.
    child = subprocess.Popen([shell, "-c", "set -e\n" + request["command"] + "\n:"],
        cwd=request["checkout"], env=environment, start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        pass_fds=(lease.fileno(),))
    deadline = time.monotonic() + request["timeoutSeconds"]
    output_open = True
    while output_open or child.poll() is None:
        if stopping or time.monotonic() >= deadline:
            stopped = stopping
            stop_child()
            return {"type": "result", "ok": False, "cancelled": stopped,
                "message": "Repository setup stopped." if stopped else "Repository setup timed out."}
        readers = [sys.stdin]
        if output_open:
            readers.append(child.stdout)
        ready, _, _ = select.select(readers, [], [], 0.1)
        if sys.stdin in ready and read_control().get("type") in ("stop", "finish"):
            stopping = True
        if output_open and child.stdout in ready:
            data = os.read(child.stdout.fileno(), 8192)
            if data:
                send({"type": "data", "data": base64.b64encode(data).decode("ascii")})
            else:
                output_open = False
    code = child.wait()
    child = None
    return {"type": "result", "ok": code == 0, "message": "Repository setup exited " + str(code) + "."}

try:
    descriptor = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
    lease = os.fdopen(descriptor, "a+b", buffering=0)
    deadline = time.monotonic() + 10
    while True:
        if stopping or (control_ready() and read_control().get("type") in ("stop", "finish")):
            raise RuntimeError("Repository setup stopped before acquiring its checkout.")
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Another setup is still running in this checkout. Retry after it finishes.")
            time.sleep(0.05)
    send({"type": "ready"})
    while not stopping:
        if not select.select([sys.stdin], [], [], 0.1)[0]:
            continue
        request = read_control()
        if request.get("type") in ("stop", "finish"):
            break
        if request.get("type") == "run":
            send(execute(request))
except BaseException as error:
    try:
        send({"type": "error", "message": str(error)})
    except (BrokenPipeError, OSError):
        pass
finally:
    stop_child()
    if lease is not None:
        lease.close()
`

export interface SetupSupervisor {
  run(command: string, timeoutSeconds: number): Promise<void>
  close(): Promise<void>
}

/** Acquiring the OS lock precedes status/log replacement and every command or environment copy. */
export async function startSetupSupervisor(input: {
  leasePath: string
  checkout: string
  repositoryPath: string
  signal?: AbortSignal
  onData(data: Buffer): void
}): Promise<SetupSupervisor> {
  await mkdir(dirname(input.leasePath), { recursive: true, mode: 0o700 })
  const child: ChildProcessWithoutNullStreams = spawn(process.env.CRAFT_SETUP_PYTHON || 'python3', ['-u', '-c', WORKER, input.leasePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  let stderr = ''
  let ready = false
  let closed = false
  let pending: { resolve(): void; reject(error: Error): void } | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveClosed!: () => void
  const acquired = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const finished = new Promise<void>(resolve => { resolveClosed = resolve })
  const send = (value: object) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n') }
  const abort = () => send({ type: 'stop' })
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  child.stdin.on('error', () => {}) // EOF after cancellation can race a late close message.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2048) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'ready') { ready = true; resolveReady() }
        else if (event.type === 'data') input.onData(Buffer.from(event.data, 'base64'))
        else if (event.type === 'result') {
          const current = pending; pending = undefined
          if (event.ok) current?.resolve()
          else current?.reject(event.cancelled ? new DOMException('Repository setup stopped. Send a message to retry.', 'AbortError') : new Error(event.message))
        } else if (event.type === 'error') {
          const error = new Error(event.message); rejectReady(error); pending?.reject(error); pending = undefined
        }
      } catch { rejectReady(new Error('Repository setup supervisor returned invalid output.')); send({ type: 'stop' }) }
    }
  })
  child.on('error', error => {
    const unavailable = new Error(`Repository setup requires Python 3 on the server (or CRAFT_SETUP_PYTHON): ${error.message}`)
    rejectReady(unavailable); pending?.reject(unavailable); pending = undefined
  })
  child.on('close', () => {
    closed = true
    input.signal?.removeEventListener('abort', abort)
    const error = input.signal?.aborted ? new DOMException('Repository setup stopped. Send a message to retry.', 'AbortError')
      : new Error(`Repository setup supervisor stopped unexpectedly.${stderr ? ` ${stderr}` : ''}`)
    if (!ready) rejectReady(error)
    pending?.reject(error); pending = undefined
    resolveClosed()
  })
  try { await acquired } catch (error) {
    send({ type: 'stop' }); await finished
    if (input.signal?.aborted) throw new DOMException('Repository setup stopped. Send a message to retry.', 'AbortError')
    throw error
  }
  return {
    run(command, timeoutSeconds) {
      if (closed || input.signal?.aborted) return Promise.reject(new DOMException('Repository setup stopped. Send a message to retry.', 'AbortError'))
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject }
        send({ type: 'run', command, timeoutSeconds, checkout: input.checkout,
          environment: { CRAFT_WORKTREE_PATH: input.checkout, CRAFT_REPOSITORY_PATH: input.repositoryPath, CONDUCTOR_ROOT_PATH: input.repositoryPath, CONDUCTOR_WORKSPACE_PATH: input.checkout } })
      })
    },
    async close() { send({ type: 'finish' }); child.stdin.end(); await finished },
  }
}
