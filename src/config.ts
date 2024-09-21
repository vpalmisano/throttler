import convict, { addFormats } from 'convict'
import { ipaddress, url } from 'convict-format-with-validator'
import { existsSync } from 'fs'

import { logger } from './utils'
const log = logger('throttler:config')

const float = {
  name: 'float',
  coerce: (v: string) => parseFloat(v),
  validate: (v: number) => {
    if (!Number.isFinite(v)) throw new Error(`Invalid float: ${v}`)
  },
}

const index = {
  name: 'index',
  coerce: (v: unknown) => v,
  validate: (v: boolean | string | number) => {
    if (typeof v === 'string') {
      if (v === 'true' || v === 'false' || v === '') return
      if (v.indexOf('-') !== -1) {
        v.split('-').forEach(n => {
          if (isNaN(parseInt(n)) || !isFinite(parseInt(n)))
            throw new Error(`Invalid index: ${n}`)
        })
        return
      }
      if (v.indexOf(',') !== -1) {
        v.split(',').forEach(n => {
          if (isNaN(parseInt(n)) || !isFinite(parseInt(n)))
            throw new Error(`Invalid index: ${n}`)
        })
        return
      }
      if (isNaN(parseInt(v)) || !isFinite(parseInt(v)))
        throw new Error(`Invalid index: ${v}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      return
    }
    throw new Error(`Invalid index: ${v}`)
  },
}

addFormats({ ipaddress, url, float, index })

// config schema
const configSchema = convict({
  runDuration: {
    doc: `If greater than 0, the test will stop after the provided number of \
seconds.`,
    format: 'nat',
    default: 0,
    env: 'RUN_DURATION',
    arg: 'run-duration',
  },
  throttleConfig: {
    doc: `A JSON5 string with a valid network throttling configuration. \
Example: \

  \`\`\`javascript
  [{
    sessions: '0-1',
    device: 'eth0',
    protocol: 'udp',
    up: {
      rate: 1000,
      delay: 50,
      loss: 5,
      queue: 10,
    },
    down: [
      { rate: 2000, delay: 50, loss: 2, queue: 20 },
      { rate: 1000, delay: 50, loss: 2, queue: 20, at: 60 },
    ]
  }]
  \`\`\`
The sessions field represents the sessions IDs range that will be affected by \
the rule, e.g.: "0-10", "2,4" or simply "2". \
The device, protocol, up, down fields are optional. When device is not set, the \
default route device will be used. If protocol is specified ('udp' or 'tcp'), \
only the packets with the specified protocol will be affected by the shaping rules. \
When running as regular user, add the following sudo configuration:
  \`\`\`
%sudo ALL=(ALL) NOPASSWD: /usr/sbin/iptables,/usr/sbin/addgroup,/usr/sbin/adduser,/usr/sbin/tc,/usr/sbin/modprobe,/usr/sbin/ip,/usr/bin/dumpcap
  \`\`\`
\
`,
    format: String,
    nullable: true,
    default: '',
    env: 'THROTTLE_CONFIG',
    arg: 'throttle-config',
  },
  commandConfig: {
    doc: `The commands configuration.\
Example: \

  \`\`\`javascript
  [{
    session: 0,
    command: "firefox https://www.speedtest.net",
  }]
  \`\`\`
`,
    format: String,
    nullable: true,
    default: '',
    env: 'COMMAND_CONFIG',
    arg: 'command-config',
  },
})

type ConfigDocs = Record<
  string,
  { doc: string; format: string; default: string }
>

/**
 * Formats the schema documentation, calling the same function recursively.
 * @param docs the documentation object to extend
 * @param property the root property
 * @param schema the config schema fragment
 * @return the documentation object
 */
function formatDocs(
  docs: ConfigDocs,
  property: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
): ConfigDocs {
  if (schema._cvtProperties) {
    Object.entries(schema._cvtProperties).forEach(([name, value]) => {
      formatDocs(docs, `${property ? `${property}.` : ''}${name}`, value)
    })
    return docs
  }

  if (property) {
    docs[property] =
      // eslint-disable-line no-param-reassign
      {
        doc: schema.doc,
        format: JSON.stringify(schema.format, null, 2),
        default: JSON.stringify(schema.default, null, 2),
      }
  }
  return docs
}

/**
 * It returns the formatted configuration docs.
 */
export function getConfigDocs(): ConfigDocs {
  return formatDocs({}, null, configSchema.getSchema())
}

const schemaProperties = configSchema.getProperties()

/** [[include:config.md]] */
export type Config = typeof schemaProperties

/**
 * Loads the config object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadConfig(filePath?: string, values?: any): Config {
  if (filePath && existsSync(filePath)) {
    log.debug(`Loading config from ${filePath}`)
    configSchema.loadFile(filePath)
  } else if (values) {
    log.debug('Loading config from values.')
    configSchema.load(values)
  } else {
    log.debug('Using default values.')
    configSchema.load({})
  }

  configSchema.validate({ allowed: 'strict' })
  const config = configSchema.getProperties()

  log.debug('Using config:', config)
  return config
}
