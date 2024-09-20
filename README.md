![logo](media/logo.svg "Throttler")
# Throttler
[GitHub page](https://github.com/vpalmisano/throttler) | [Documentation](https://vpalmisano.github.io/throttler)
A Linux tool that allows to apply network constraints to a single or a group of processes.

Install:
```bash
echo '@vpalmisano:registry=https://npm.pkg.github.com' >> ~/.npmrc

npm install -g @vpalmisano/throttler
```

Basic usage:
```bash
throttler \
    --throttle-config '[{sessions:"0",up:[{delay:20,rate:5000}],down:[{delay:20,rate:5000}]}]' \
    --command-config '[{session:0,command:"firefox https://www.speedtest.net"}]'

# press q to stop the throttler
```
