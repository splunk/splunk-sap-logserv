/**
 * Linux kernel firewall chains (session 146, build 374).
 *
 * LogServ's /var/log/firewall lines (sourcetype linux_secure) carry the LOG
 * prefix of the host's packet filter:
 *   - IN_DROP:  a packet addressed to the host itself was dropped (INPUT chain;
 *               the line's OUT= is empty).
 *   - FWD_DROP: a packet the host was asked to route onward was dropped
 *               (FORWARD chain; OUT= names the exit interface). Only hosts that
 *               forward traffic, such as VPN or IPsec gateways, log these.
 * On real data the two never describe the same packet, so they add up without
 * double counting. Environment Health counts only IN_DROP as an error; Linux
 * and Network Perimeter show both chains side by side.
 *
 * KERNEL_REX is the UI's single copy of the kernel-tag extraction. It must stay
 * byte-identical to the rex in [logserv_linux_aggregate] and
 * [logserv_linux_backfill] (check-diagnostics 3t), whose `kernel` metric stores
 * kernel_event per hour and cloud_provider (no host).
 */
export const KERNEL_REX = 'rex field=_raw "kernel:.*?\\]\\s+(?<kernel_event>[A-Z]{2}[A-Z0-9_]*)(?=[\\s:\\-/(\\[,.#]|$)"';

/** KPI labels and their one-line chain captions. */
export const FW_AT_HOST = 'Firewall Drops at Host';
export const FW_IN_TRANSIT = 'Firewall Drops in Transit';
export const FW_AT_HOST_SUB = 'INPUT chain · IN_DROP';
export const FW_IN_TRANSIT_SUB = 'FORWARD chain · FWD_DROP';

/** Series names for charts that split drops by chain. */
export const FW_SERIES_AT_HOST = 'At host (INPUT)';
export const FW_SERIES_IN_TRANSIT = 'In transit (FORWARD)';
