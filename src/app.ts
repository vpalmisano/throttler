import { paramCase } from 'change-case'
import { spawn } from 'child_process'
import fs from 'fs'
import json5 from 'json5'
import readline from 'readline'
import wrap from 'word-wrap'

import { getConfigDocs, loadConfig } from './config'
import {
  applyThrottleRule,
  getSessionThrottleIndex,
  getSessionThrottleValues,
  getStats,
  startThrottle,
  stopThrottle,
  throttleLauncher,
} from './throttle'
import {
  handleExitSignals,
  logger,
  registerExitHandler,
  resolvePackagePath,
  runShellCommandIfLinux,
} from './utils'

const log = logger('throttler')

function showHelpOrVersion(): void {
  if (process.argv.findIndex(a => a.localeCompare('--help') === 0) !== -1) {
    const docs = getConfigDocs()
    let out = `Params:\n  --version\n        It shows the package version.\n`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.entries(docs).forEach(([name, value]: [string, any]) => {
      out += `  --${paramCase(name)}
${wrap(value.doc, { width: 72, indent: '        ' })}
        Default: ${value.default}\n`
    })
    console.log(out)
    process.exit(0)
  } else if (
    process.argv.findIndex(a => a.localeCompare('--version') === 0) !== -1
  ) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const version = json5.parse(
      fs.readFileSync(resolvePackagePath('package.json')).toString(),
    ).version
    console.log(version)
    process.exit(0)
  }
}

type Command = {
  command: string
  session?: number
}

function showCliHelp(): void {
  console.log(`Commands:
  help              Show this help
  quit, q, exit     Stop the throttler
  status, s [session]  Show throttle values for a session (default: 0)
  stats             Show network throttle statistics`)
}

async function handleCliCommand(line: string): Promise<boolean> {
  const trimmed = line.trim()
  if (!trimmed) return false

  const [cmd, ...args] = trimmed.split(/\s+/)
  switch (cmd.toLowerCase()) {
    case 'q':
    case 'quit':
    case 'exit':
      return true
    case 'help':
      showCliHelp()
      break
    case 'stats': {
      console.log(await getStats())
      break
    }
    case 's':
    case 'status': {
      const session = args[0] !== undefined ? parseInt(args[0], 10) : 0
      if (!Number.isFinite(session)) {
        console.log('Usage: status [session]')
        break
      }
      const index = getSessionThrottleIndex(session)
      if (index < 0) {
        console.log(`No throttle rules for session ${session}`)
        break
      }
      const up = getSessionThrottleValues(index, 'up')
      const down = getSessionThrottleValues(index, 'down')
      console.log(`Session ${session} (rule ${index}):`)
      console.log('  up:', up)
      console.log('  down:', down)
      break
    }
    case 'apply': {
      const index = args[0] !== undefined ? parseInt(args[0], 10) : 0
      if (!Number.isFinite(index)) {
        console.log('Usage: apply <index> <direction> <rule>')
        break
      }
      const direction = args[1] !== undefined ? args[1].toLowerCase() : 'up'
      if (direction !== 'up' && direction !== 'down') {
        console.log('Usage: apply <index> <direction> <rule>')
        break
      }
      const rule = args[2] !== undefined ? json5.parse(args[2]) : null
      if (!rule) {
        console.log('Usage: apply <index> <direction> <rule>')
        break
      }
      try {
        await applyThrottleRule(rule, index, direction as 'up' | 'down')
      } catch (err: unknown) {
        console.error(
          `Error applying rule "${trimmed}": ${(err as Error).stack}`,
        )
        break
      }
      break
    }
    default:
      console.log(
        `Unknown command: ${cmd}. Type "help" for available commands.`,
      )
  }
  return false
}

async function main(): Promise<void> {
  showHelpOrVersion()
  handleExitSignals()

  const config = loadConfig(process.argv[2])
  const pids = new Set<number>()

  await startThrottle(config.throttleConfig)

  let cli: readline.Interface | undefined

  const stop = async (): Promise<void> => {
    log.info('Stopping...')
    cli?.close()
    cli = undefined
    for (const c of commands) {
      const index = getSessionThrottleIndex(c.session || 0)
      try {
        await runShellCommandIfLinux(`pkill -2 -G throttler${index}`)
      } catch (err: unknown) {
        log.error(`Error stopping throttler ${index}: ${(err as Error).stack}`)
      }
    }
    await stopThrottle()
    process.exit(0)
  }
  registerExitHandler(() => stop())

  const commands = config.commandConfig
    ? (json5.parse(config.commandConfig) as Command[])
    : []
  for (const c of commands) {
    const { session, command } = c
    const shortName = command.split(' ')[0]
    const index = getSessionThrottleIndex(session || 0)
    const launcher = await throttleLauncher(command, index)
    try {
      const proc = spawn(launcher, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      if (proc.pid) pids.add(proc.pid)
      proc.stdout.on('data', data => {
        log.info(`[${shortName}][stdout]`, data.toString().trim())
      })
      proc.stderr.on('data', data => {
        log.info(`[${shortName}][stderr]`, data.toString().trim())
      })
      proc.on('error', err => {
        if (err.message.startsWith('The operation was aborted')) return
        log.error(`Error running command "${command}": ${(err as Error).stack}`)
      })
      proc.once('exit', code => {
        log.info(`Command "${command}" exited with code: ${code || 0}`)
        if (proc.pid) pids.delete(proc.pid)
      })
    } catch (err: unknown) {
      log.error(`Error running command "${command}": ${(err as Error).stack}`)
    }
  }

  // Stop after a configured duration.
  if (config.runDuration > 0) {
    setTimeout(stop, config.runDuration * 1000)
  }

  // Command line interface.
  cli = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'throttler> ',
  })
  showCliHelp()
  cli.prompt()
  cli.on('line', line => {
    void (async () => {
      cli?.pause()
      try {
        const shouldStop = await handleCliCommand(line)
        if (shouldStop) {
          await stop()
        } else {
          cli?.prompt()
        }
      } catch (err: unknown) {
        log.error(`command error: ${(err as Error).stack}`)
        cli?.prompt()
      } finally {
        cli?.resume()
      }
    })()
  })
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(-1)
  })
}
