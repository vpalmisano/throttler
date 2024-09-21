
The configuration properties are applied in the following order (from higher to
lower precedence):

- arguments passed to the executable in kebab case (e.g. `--run-duration`);
- environment variables in uppercase snake format (e.g. `RUN_DURATION`);
- `config.json` configuration file;
- default values.

## runDuration
If greater than 0, the test will stop after the provided number of seconds.

*Type*: `positive int`

*Default*: `0`

## throttleConfig
A JSON5 string with a valid network throttling configuration. Example: 
  ```javascript
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
  ```
The sessions field represents the sessions IDs range that will be affected by the rule, e.g.: "0-10", "2,4" or simply "2". The device, protocol, up, down fields are optional. When device is not set, the default route device will be used. If protocol is specified ('udp' or 'tcp'), only the packets with the specified protocol will be affected by the shaping rules. When running as regular user, add the following sudo configuration:
  ```
%sudo ALL=(ALL) NOPASSWD: /usr/sbin/iptables,/usr/sbin/addgroup,/usr/sbin/adduser,/usr/sbin/tc,/usr/sbin/modprobe,/usr/sbin/ip,/usr/bin/dumpcap
  ```


*Type*: `string`

*Default*: `""`

## commandConfig
The commands configuration.Example: 
  ```javascript
  [{
    session: 0,
    command: "firefox https://www.speedtest.net",
  }]
  ```


*Type*: `string`

*Default*: `""`



---

