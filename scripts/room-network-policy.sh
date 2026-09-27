#!/usr/bin/env bash
# Network policy for Operating Rooms (idempotent; run as root after docker starts).
#   - rooms get outbound internet (model APIs, git, npm)
#   - rooms cannot reach each other (ICC disabled on the bridge)
#   - rooms cannot reach cloud metadata, the host, or private networks
set -euo pipefail
NET=${SAR_ROOM_NETWORK:-sar-rooms}
BRIDGE=sar0
SUBNET=${SAR_ROOM_SUBNET:-172.30.0.0/16}

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SUBNET" \
    -o com.docker.network.bridge.name=$BRIDGE \
    -o com.docker.network.bridge.enable_icc=false "$NET"
fi

# Forwarded traffic from rooms (DOCKER-USER is evaluated before docker's own rules).
iptables -N SAR-ROOMS 2>/dev/null || iptables -F SAR-ROOMS
iptables -A SAR-ROOMS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for dst in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  iptables -A SAR-ROOMS -d "$dst" -j REJECT
done
iptables -A SAR-ROOMS -j RETURN
iptables -C DOCKER-USER -i $BRIDGE -j SAR-ROOMS 2>/dev/null || iptables -I DOCKER-USER -i $BRIDGE -j SAR-ROOMS

# Traffic from rooms to the host itself (control API, sshd, ...). DNS to docker's
# embedded resolver does not traverse INPUT for user-defined networks.
iptables -C INPUT -i $BRIDGE -j REJECT 2>/dev/null || iptables -I INPUT -i $BRIDGE -j REJECT
echo "room network policy applied to $NET ($BRIDGE, $SUBNET)"
