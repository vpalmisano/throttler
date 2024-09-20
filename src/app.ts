import { paramCase } from 'change-case'
import { spawn } from 'child_process'
import fs from 'fs'
import json5 from 'json5'
import wrap from 'word-wrap'

import { getConfigDocs, loadConfig } from './config'
import {
  getSessionThrottleIndex,
  startThrottle,
  stopThrottle,
  throttleLauncher,
} from './throttle'
import { logger, registerExitHandler, resolvePackagePath } from './utils'

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

async function main(): Promise<void> {
  showHelpOrVersion()

  const config = loadConfig(process.argv[2])

  const commands = json5.parse(config.commandConfig) as Command[]

  await startThrottle(config.throttleConfig)

  const stop = async (): Promise<void> => {
    console.log('Exiting...')
    await stopThrottle()
    process.exit(0)
  }
  registerExitHandler(() => stop())

  for (const command of commands) {
    const launcher = await throttleLauncher(
      command.command,
      getSessionThrottleIndex(command.session || 0),
    )
    try {
      const proc = spawn(launcher, {
        shell: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      proc.on('error', err => {
        log.error(`Error running command "${command.command}": ${err}`)
      })
      proc.once('exit', code => {
        log.info(`Command "${command.command}" exited with code ${code}`)
      })
    } catch (err: unknown) {
      log.error(
        `Error running command "${command.command}": ${(err as Error).stack}`,
      )
    }
  }

  // Stop after a configured duration.
  if (config.runDuration > 0) {
    setTimeout(stop, config.runDuration * 1000)
  }

  // Command line interface.
  if (process.stdin && process.stdin.setRawMode) {
    console.log('Press [q] to stop the throttler')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', async data => {
      log.debug('[stdin]', data[0])
      if (data[0] === 'q'.charCodeAt(0)) {
        try {
          await stop()
        } catch (err: unknown) {
          log.error(`stop error: ${(err as Error).stack}`)
          process.exit(1)
        }
      } else {
        console.log('Press [q] to stop the throttler')
      }
    })
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(-1)
  })
}
