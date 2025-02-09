import { spawn } from 'child_process'
import fs from 'fs'
import JSON5 from 'json5'
import os from 'os'

import {
  checkNetworkInterface,
  getDefaultNetworkInterface,
  logger,
  runShellCommand,
  toPrecision,
} from './utils'

const log = logger('throttler:throttle')

let throttleConfig: ThrottleConfig[] | null = null

const ruleTimeouts = new Set<NodeJS.Timeout>()

const captureStops = new Map<number, () => Promise<void>>()

const throttleCurrentValues = {
  up: new Map<
    number,
    {
      rate?: number
      delay?: number
      delayJitter?: number
      delayJitterCorrelation?: number
      loss?: number
      lossBurst?: number
      queue?: number
    }
  >(),
  down: new Map<
    number,
    {
      rate?: number
      delay?: number
      delayJitterCorrelation?: number
      loss?: number
      lossBurst?: number
      queue?: number
    }
  >(),
}

async function cleanup(): Promise<void> {
  await Promise.allSettled([...captureStops.values()].map(stop => stop()))
  captureStops.clear()
  ruleTimeouts.forEach(timeoutId => clearTimeout(timeoutId))
  ruleTimeouts.clear()
  throttleCurrentValues.up.clear()
  throttleCurrentValues.down.clear()
  let device = throttleConfig?.length ? throttleConfig[0].device : ''
  if (!device) {
    device = await getDefaultNetworkInterface()
  }
  await runShellCommand(`\
sudo -n tc qdisc del dev ${device} root || true;
sudo -n tc class del dev ${device} || true;
sudo -n tc filter del dev ${device} || true;
sudo -n tc qdisc del dev ${device} ingress || true;

sudo -n tc qdisc del dev ifb0 root || true;
sudo -n tc class del dev ifb0 root || true;
sudo -n tc filter del dev ifb0 root || true;
`)
  await cleanupRules()
}

function calculateBufferedPackets(
  rate: number,
  delay: number,
  mtu = 1500,
): number {
  // https://lists.linuxfoundation.org/pipermail/netem/2007-March/001094.html
  return Math.ceil((((1.5 * rate * 1000) / 8) * (delay / 1000)) / mtu)
}

/** The network throttle rules to be applied to uplink or downlink. */
export type ThrottleRule = {
  /** The available bandwidth (Kbps). */
  rate?: number
  /** The one-way delay (ms). */
  delay?: number
  /** The one-way delay jitter (ms). */
  delayJitter?: number
  /** The one-way delay jitter correlation. */
  delayJitterCorrelation?: number
  /** The delay distribution. */
  delayDistribution?: 'uniform' | 'normal' | 'pareto' | 'paretonormal'
  /** The packet reordering percentage. */
  reorder?: number
  /** The packet reordering correlation. */
  reorderCorrelation?: number
  /** The packet reordering gap. */
  reorderGap?: number
  /** The packet loss percentage. */
  loss?: number
  /** The packet loss burst. */
  lossBurst?: number
  /** The packet queue size. */
  queue?: number
  /** If set, the rule will be applied after the specified number of seconds. */
  at?: number
}

/**
 * The network throttling rules.
 * Specify multiple {@link ThrottleRule} with different `at` values to schedule
 * network bandwidth/delay fluctuations during the test run, e.g.:
 *
 * ```javascript
 * {
    device: "eth0",
    sessions: "0-1",
    protocol: "udp",
    down: [
      { rate: 1000000, delay: 50, loss: 0, queue: 5 },
      { rate: 200000, delay: 100, loss: 5, queue: 5, at: 60},
    ],
    up: { rate: 100000, delay: 50, queue: 5 },
    capture: 'capture.pcap',
  }
 * ```
 */
export type ThrottleConfig = {
  /** The network interface to throttle. If not specified, the default interface will be used. */
  device?: string
  /** The sessions to throttle. It could be a single index ("0"), a range ("0-2") or a comma-separated list ("0,3,4"). */
  sessions?: string
  /** The protocol to throttle. */
  protocol?: 'udp' | 'tcp'
  /** A comma-separated list of source ports that will not be throttled. */
  skipSourcePorts?: string
  /** A comma-separated list of destination ports that will not be throttled. */
  skipDestinationPorts?: string
  /** An additional IPTables packet filter rule. */
  filter?: string
  /** An additional TC match expression used to filter packets (https://man7.org/linux/man-pages/man8/tc-ematch.8.html). */
  match?: string
  /** If set, the packets matching the provided session and protocol will be captured at that file location. */
  capture?: string
  /** The uplink throttle rules. */
  up?: ThrottleRule | ThrottleRule[]
  /** The downlink throttle rules. */
  down?: ThrottleRule | ThrottleRule[]
}

async function applyRules(
  config: ThrottleConfig,
  direction: 'up' | 'down',
  device: string,
  index: number,
  protocol?: 'udp' | 'tcp',
  match?: string,
): Promise<void> {
  let rules = config[direction]
  if (!rules) return
  log.info(
    `applyRules device=${device} index=${index} protocol=${protocol} match=${match} ${JSON.stringify(
      rules,
    )}`,
  )
  if (!Array.isArray(rules)) {
    rules = [rules]
  }
  rules.sort((a, b) => {
    return (a.at || 0) - (b.at || 0)
  })

  for (const [i, rule] of rules.entries()) {
    const {
      rate,
      delay,
      delayJitter,
      delayJitterCorrelation,
      delayDistribution,
      reorder,
      reorderCorrelation,
      reorderGap,
      loss,
      lossBurst,
      queue,
      at,
    } = rule
    const limit = queue ?? calculateBufferedPackets(rate || 0, delay || 0)
    const mark = index + 1
    const handle = index + 2

    if (i === 0) {
      const matches = [`'meta(nf_mark eq ${mark})'`]
      if (protocol === 'udp') {
        matches.push("'cmp(u8 at 9 layer network eq 0x11)'")
      } else if (protocol === 'tcp') {
        matches.push("'cmp(u8 at 9 layer network eq 0x6)'")
      }
      if (match) {
        matches.push(match)
      }
      const cmd = `\
set -e;

sudo -n tc class add dev ${device} parent 1: classid 1:${handle} htb rate 1Gbit ceil 1Gbit;

sudo -n tc qdisc add dev ${device} \
  parent 1:${handle} \
  handle ${handle}: \
  netem; \

sudo -n tc filter add dev ${device} \
  parent 1: \
  protocol ip \
  basic match ${matches.join(' and ')} \
  flowid 1:${handle};
`
      try {
        await runShellCommand(cmd, true)
      } catch (err) {
        log.error(`error running "${cmd}": ${(err as Error).stack}`)
        throw err
      }
    }

    const timeoutId = setTimeout(
      async () => {
        let desc = ''

        if (rate && rate > 0) {
          desc += ` rate ${rate}kbit`
        }

        if (limit && limit > 0) {
          desc += ` limit ${limit}`
        }

        if (delay && delay > 0) {
          desc += ` delay ${delay}ms`
          if (delayJitter && delayJitter > 0) {
            desc += ` ${delayJitter}ms`
            if (delayJitterCorrelation && delayJitterCorrelation > 0) {
              desc += ` ${delayJitterCorrelation}`
            }
          }
          if (delayDistribution) {
            desc += ` distribution ${delayDistribution}`
          }
        }

        if (loss && loss > 0) {
          if (lossBurst && lossBurst > 0) {
            const p = (100 * loss) / (lossBurst * (100 - loss))
            const r = 100 / lossBurst
            desc += ` loss gemodel ${toPrecision(p, 2)} ${toPrecision(r, 2)}`
          } else {
            desc += ` loss ${toPrecision(loss, 2)}%`
          }
        }

        if (reorder && reorder > 0) {
          desc += ` reorder ${toPrecision(reorder, 2)}%`
          if (reorderCorrelation && reorderCorrelation > 0) {
            desc += ` ${toPrecision(reorderCorrelation, 2)}`
          }
          if (reorderGap && reorderGap > 0) {
            desc += ` gap ${reorderGap}`
          }
        }

        log.info(`applying rules on ${device} (${mark}): ${desc}`)
        const cmd = `\
sudo -n tc qdisc change dev ${device} \
  parent 1:${handle} \
  handle ${handle}: \
  netem ${desc}`
        try {
          ruleTimeouts.delete(timeoutId)

          await runShellCommand(cmd)

          throttleCurrentValues[direction].set(index, {
            rate: rate ? 1000 * rate : undefined,
            delay: delay || undefined,
            loss: loss || undefined,
            queue: limit || undefined,
          })
        } catch (err) {
          log.error(`error running "${cmd}": ${(err as Error).stack}`)
        }
      },
      (at || 0) * 1000,
    )

    ruleTimeouts.add(timeoutId)
  }
}

async function start(): Promise<void> {
  if (!throttleConfig || !throttleConfig.length) return

  let device = throttleConfig[0].device
  if (device) {
    try {
      await checkNetworkInterface(device)
    } catch (_err) {
      log.warn(`Network interface ${device} not found, using default.`)
      device = ''
    }
  }
  if (!device) {
    device = await getDefaultNetworkInterface()
  }

  await runShellCommand(
    `\
set -e;

sudo -n modprobe ifb || true;
sudo -n ip link add ifb0 type ifb || true;
sudo -n ip link set dev ifb0 up;

sudo -n tc qdisc add dev ${device} root handle 1: htb default 1;
sudo -n tc class add dev ${device} parent 1: classid 1:1 htb rate 1Gbit ceil 1Gbit;

sudo -n tc qdisc add dev ifb0 root handle 1: htb default 1;
sudo -n tc class add dev ifb0 parent 1: classid 1:1 htb rate 1Gbit ceil 1Gbit;

sudo -n tc qdisc add dev ${device} ingress handle ffff: || true;
sudo -n tc filter add dev ${device} \
  parent ffff: \
  protocol ip \
  u32 \
  match u32 0 0 \
  action connmark \
  action mirred egress \
  redirect dev ifb0 \
  flowid 1:1;
`,
    true,
  )

  let index = 0
  for (const config of throttleConfig) {
    if (config.up) {
      await applyRules(
        config,
        'up',
        device,
        index,
        config.protocol,
        config.match,
      )
    }
    if (config.down) {
      await applyRules(
        config,
        'down',
        'ifb0',
        index,
        config.protocol,
        config.match,
      )
    }
    if (config.capture) {
      captureStops.set(
        index,
        capturePackets(index, config.capture, config.protocol),
      )
    }
    index++
  }
}

/**
 * Starts a network throttle configuration
 * @param config A JSON5 configuration parsed as {@link ThrottleConfig}.
 */
export async function startThrottle(config: string): Promise<void> {
  if (os.platform() !== 'linux') {
    throw new Error('Throttle option is only supported on Linux')
  }
  try {
    throttleConfig = JSON5.parse(config) as ThrottleConfig[]
    log.debug('Starting throttle with config:', throttleConfig)
    await cleanup()
    await start()
  } catch (err) {
    log.error(`startThrottle "${config}" error: ${(err as Error).stack}`)
    await stopThrottle()
    throw err
  }
}

/**
 * Stops the network throttle.
 */
export async function stopThrottle(): Promise<void> {
  if (os.platform() !== 'linux') {
    throw new Error('Throttle option is only supported on Linux')
  }
  try {
    log.debug('Stopping throttle')
    await cleanup()
    log.debug('Stopping throttle done')
    throttleConfig = null
  } catch (err) {
    log.error(`Stop throttle error: ${(err as Error).stack}`)
  }
}

export function getSessionThrottleIndex(sessionId: number): number {
  if (!throttleConfig) return -1

  for (const [index, config] of throttleConfig.entries()) {
    if (config.sessions === undefined || config.sessions === '') {
      continue
    }
    try {
      if (config.sessions.includes('-')) {
        const [start, end] = config.sessions.split('-').map(Number)
        if (sessionId >= start && sessionId <= end) {
          return index
        }
      } else if (config.sessions.includes(',')) {
        const sessions = config.sessions.split(',').map(Number)
        if (sessions.includes(sessionId)) {
          return index
        }
      } else if (sessionId === Number(config.sessions)) {
        return index
      }
    } catch (err) {
      log.error(
        `getSessionThrottleId sessionId=${sessionId} error: ${(err as Error).stack}`,
      )
    }
  }

  return -1
}

export function getSessionThrottleValues(
  index: number,
  direction: 'up' | 'down',
): {
  rate?: number
  delay?: number
  loss?: number
  queue?: number
} {
  if (index < 0) {
    return {}
  }
  return throttleCurrentValues[direction].get(index) || {}
}

export async function throttleLauncher(
  executablePath: string,
  index: number,
): Promise<string> {
  log.debug(`throttleLauncher executablePath=${executablePath} index=${index}`)
  if (!throttleConfig || index < 0) {
    return executablePath
  }
  const config = throttleConfig[index]
  const mark = index + 1
  const launcherPath = `/tmp/throttler-launcher-${index}`
  const group = `throttler${index}`
  const filters = `${config.protocol ? `-p ${config.protocol}` : ''}\
${config.skipSourcePorts ? ` -m multiport ! --sports ${config.skipSourcePorts}` : ''}\
${config.skipDestinationPorts ? ` -m multiport ! --dports ${config.skipDestinationPorts}` : ''}\
${config.filter ? ` ${config.filter}` : ''}`
  await fs.promises.writeFile(
    launcherPath,
    `#!/bin/bash
getent group ${group} >/dev/null || sudo -n addgroup --system ${group}
sudo -n adduser $USER ${group} --quiet

rule=$(sudo -n iptables -t mangle -L OUTPUT --line-numbers | grep "owner GID match ${group}" | awk '{print $1}')
if [ -n "$rule" ]; then
  sudo -n iptables -t mangle -R OUTPUT \${rule} ${filters} -m owner --gid-owner ${group} -j MARK --set-mark ${mark}  
else
  sudo -n iptables -t mangle -I OUTPUT 1 ${filters} -m owner --gid-owner ${group} -j MARK --set-mark ${mark}
fi

sudo -n iptables -t mangle -L PREROUTING | grep -q "CONNMARK restore" || sudo -n iptables -t mangle -I PREROUTING 1 -j CONNMARK --restore-mark
sudo -n iptables -t mangle -L POSTROUTING | grep -q "CONNMARK save" || sudo -n iptables -t mangle -I POSTROUTING 1 -j CONNMARK --save-mark

function stop() {
  echo "Stopping throttler"
}
trap stop SIGINT SIGTERM

echo "running: ${executablePath} $@"
exec newgrp ${group} <<EOF
${executablePath} $@
EOF`,
  )
  await fs.promises.chmod(launcherPath, 0o755)
  return launcherPath
}

async function cleanupRules(): Promise<void> {
  if (!throttleConfig?.length) return
  log.debug(`cleanupRules (${throttleConfig.length})`)
  try {
    await runShellCommand(`\
for i in $(seq 0 ${throttleConfig.length}); do
  rule=$(sudo -n iptables -t mangle -L OUTPUT --line-numbers | grep "owner GID match throttler\${i}" | awk '{print $1}');
  if [ -n "$rule" ]; then
    sudo -n iptables -t mangle -D OUTPUT \${rule};
  fi;
done;`)
  } catch (err) {
    log.error(`cleanupRules error: ${(err as Error).stack}`)
  }
}

function capturePackets(
  index: number,
  filePath: string,
  protocol?: string,
): () => Promise<void> {
  const mark = index + 1
  log.info(`Starting capture ${filePath}`)
  const cmd = `#!/bin/bash
sudo -n iptables -L INPUT | grep -q "nflog-group ${mark}" || sudo -n iptables -A INPUT ${protocol ? `-p ${protocol}` : ''} -m connmark --mark ${mark} -j NFLOG --nflog-group ${mark}
sudo -n iptables -L OUTPUT | grep -q "nflog-group ${mark}" || sudo -n iptables -A OUTPUT ${protocol ? `-p ${protocol}` : ''} -m connmark --mark ${mark} -j NFLOG --nflog-group ${mark}
exec dumpcap -q -i nflog:${mark} -w ${filePath}
`
  const proc = spawn(cmd, {
    shell: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  let stderr = ''
  proc.stderr.on('data', data => {
    stderr += data
  })
  proc.on('error', err => {
    log.error(`Error running command capturePackets ${err}: ${stderr}`)
  })
  proc.once('exit', code => {
    if (code) {
      log.error(`capturePackets exited with code ${code}: ${stderr}`)
    } else {
      log.info(`capturePackets exited`)
    }
  })

  const stop = async () => {
    log.info(`Stopping capture ${filePath}`)
    proc.kill('SIGINT')
    await runShellCommand(`#!/bin/bash
sudo -n iptables -D INPUT ${protocol ? `-p ${protocol}` : ''} -m connmark --mark ${mark} -j NFLOG --nflog-group ${mark}
sudo -n iptables -D OUTPUT ${protocol ? `-p ${protocol}` : ''} -m connmark --mark ${mark} -j NFLOG --nflog-group ${mark}
`)
  }

  return stop
}
