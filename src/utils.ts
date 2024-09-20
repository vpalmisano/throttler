import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const { Log } = require('debug-level')

type Logger = {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

export function logger(name: string, options = {}): Logger {
  return new Log(name, { splitLine: false, ...options })
}

export class LoggerInterface {
  name?: string

  private logInit(args: unknown[]): void {
    if (this.name) {
      args.unshift(`[${this.name}]`)
    }
  }

  debug(...args: unknown[]): void {
    this.logInit(args)
    log.debug(...args)
  }

  info(...args: unknown[]): void {
    this.logInit(args)
    log.info(...args)
  }

  warn(...args: unknown[]): void {
    this.logInit(args)
    log.warn(...args)
  }

  error(...args: unknown[]): void {
    this.logInit(args)
    log.error(...args)
  }

  log(...args: unknown[]): void {
    this.logInit(args)
    log.log(...args)
  }
}

const log = logger('webrtcperf:utils')

/**
 * Resolves the absolute path from the package installation directory.
 * @param relativePath The relative path.
 * @returns The absolute path.
 */
export function resolvePackagePath(relativePath: string): string {
  if ('__nexe' in process) {
    return relativePath
  }
  if (process.env.WEBPACK) {
    return path.join(path.dirname(__filename), relativePath)
  }
  for (const d of ['..', '../..']) {
    const p = path.join(__dirname, d, relativePath)
    if (fs.existsSync(p)) {
      return require.resolve(p)
    }
  }
  throw new Error(`resolvePackagePath: ${relativePath} not found`)
}

/**
 * Format number to the specified precision.
 * @param value value to format
 * @param precision precision
 */
export function toPrecision(value: number, precision = 3): string {
  return (Math.round(value * 10 ** precision) / 10 ** precision).toFixed(
    precision,
  )
}

export async function getDefaultNetworkInterface(): Promise<string> {
  const { stdout } = await runShellCommand(
    `ip route | awk '/default/ {print $5; exit}' | tr -d ''`,
  )
  return stdout.trim()
}

export async function checkNetworkInterface(device: string): Promise<void> {
  await runShellCommand(`ip route | grep -q "dev ${device}"`)
}

/** Runs the shell command asynchronously. */
export async function runShellCommand(
  cmd: string,
  verbose = false,
): Promise<{ stdout: string; stderr: string }> {
  if (verbose) log.debug(`runShellCommand cmd: ${cmd}`)
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', data => {
      if (stdout.length > 512 * 1024) {
        stdout = stdout.slice(data.length)
      }
      stdout += data
    })
    p.stderr.on('data', data => {
      if (stderr.length > 512 * 1024) {
        stderr = stderr.slice(data.length)
      }
      stderr += data
    })
    p.once('error', err => reject(err))
    p.once('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            `runShellCommand cmd: ${cmd} failed with code ${code}: ${stderr}`,
          ),
        )
      } else {
        if (verbose)
          log.debug(`runShellCommand cmd: ${cmd} done`, { stdout, stderr })
        resolve({ stdout, stderr })
      }
    })
  })
}

/** Exit handler callback. */
export type ExitHandler = (signal?: string) => Promise<void>

const exitHandlers = new Set<ExitHandler>()

/**
 * Register an {@link ExitHandler} callback that will be executed at the
 * nodejs process exit.
 * @param exitHandler
 */
export function registerExitHandler(exitHandler: ExitHandler): void {
  exitHandlers.add(exitHandler)
}

/**
 * Un-registers the {@link ExitHandler} callback.
 * @param exitHandler
 */
export function unregisterExitHandler(exitHandler: ExitHandler): void {
  exitHandlers.delete(exitHandler)
}

const runExitHandlers = async (signal?: string): Promise<void> => {
  let i = 0
  for (const exitHandler of exitHandlers.values()) {
    const id = `${i + 1}/${exitHandlers.size}`
    log.debug(`running exitHandler ${id}`)
    try {
      await exitHandler(signal)
      log.debug(`  exitHandler ${id} done`)
    } catch (err) {
      log.error(`exitHandler ${id} error: ${err}`)
    }
    i++
  }
  exitHandlers.clear()
}

let runExitHandlersPromise: Promise<void> | null = null

/**
 * Runs the registered exit handlers immediately.
 * @param signal The process exit signal.
 */
export async function runExitHandlersNow(signal?: string): Promise<void> {
  if (!runExitHandlersPromise) {
    runExitHandlersPromise = runExitHandlers(signal)
  }
  await runExitHandlersPromise
}

const SIGNALS = [
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGTERM',
]
process.setMaxListeners(process.getMaxListeners() + SIGNALS.length)
SIGNALS.forEach(event =>
  process.once(event, async signal => {
    if (signal instanceof Error) {
      log.error(`Exit on error: ${signal.stack || signal.message}`)
    } else {
      log.debug(`Exit on signal: ${signal}`)
    }
    await runExitHandlersNow(signal)
    process.exit(0)
  }),
)
