![logo](media/logo.svg "Throttler")
# Throttler
[GitHub page](https://github.com/vpalmisano/throttler) | [Documentation](https://vpalmisano.github.io/throttler)

A Linux tool that allows to apply network constraints to a single or a group of processes.

## Install
```bash
echo '@vpalmisano:registry=https://npm.pkg.github.com' >> ~/.npmrc

npm install -g @vpalmisano/throttler
```

System configuration:
```bash
# Allow to run the required comamnds without password:
echo "$(whoami) ALL=(ALL) NOPASSWD: $(which iptables),$(which addgroup),$(which adduser),$(which tc),$(which modprobe),$(which ip)" | sudo tee /etc/sudoers.d/throttler

# Install wireshark and allow regular user to capture packets:
sudo apt install -y wireshark
sudo dpkg-reconfigure wireshark-common
sudo usermod -a -G wireshark $(whoami)
# Logout and login again
```

## Examples
Throttle all the traffic of a single process (e.g. firefox):
```bash
throttler \
    --throttle-config '[{sessions:"0",up:[{delay:20,rate:5000}],down:[{delay:20,rate:5000}]}]' \
    --command-config '[{session:0,command:"firefox https://www.speedtest.net"}]'
# press q to stop the throttler
```

Throttle the udp traffic of a single process (e.g. firefox) and capture the packets:
```bash
throttler \
    --throttle-config '[{sessions:"0",protocol:"udp",capture:"capture.pcap",up:[{delay:50,loss:1,rate:2000}],down:[{delay:20,loss:1,rate:2000}]}]' \
    --command-config '[{session:0,command:"firefox https://meet.jit.si/"}]'
```
