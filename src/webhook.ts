import { lookup } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Webhook } from 'standardwebhooks'

export type WebhookRequest = { url: string; headers: Record<string, string>; body: string }
export type WebhookResponse = { status: number; body: string }
/** Sends one POST. Rejects on network errors and timeouts; resolves with any HTTP status. */
export type SendWebhook = (request: WebhookRequest) => Promise<WebhookResponse>

export const MAX_EVENT_BYTES = 256 * 1024

/** Standard Webhooks headers for one delivery attempt. Sign with every active secret during rotation. */
export function signedHeaders(input: { secrets: string[]; messageId: string; body: string; subscriptionId: string; now: Date }): Record<string, string> {
	const signatures = input.secrets.map((secret) => new Webhook(secret).sign(input.messageId, input.now, input.body))
	return {
		'content-type': 'application/json',
		'webhook-id': input.messageId,
		'webhook-timestamp': String(Math.floor(input.now.getTime() / 1000)),
		'webhook-signature': signatures.join(' '),
		'x-mcp-subscription-id': input.subscriptionId,
	}
}

const blocked = new BlockList()
for (const [net, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
	['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
	['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
	['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6')

/** True for addresses on the public internet; false for private, local, reserved, and mapped addresses. */
export function isPublicAddress(address: string): boolean {
	// IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. A ::ffff:0:0/96 rule
	// cannot express this: BlockList also applies mapped rules to plain IPv4 addresses.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
	if (mapped) return isPublicAddress(mapped)
	const family = isIP(address)
	if (family === 0) return false
	if (family === 6 && /^::ffff:/i.test(address)) return false
	return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Validates the resolved address at connection time, so DNS rebinding between
 * a check and the connect cannot reach an internal host. TLS still verifies
 * the original hostname because only the socket address is substituted.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error, '', 0)
		const list = addresses as { address: string; family: number }[]
		const rejected = list.find((a) => !isPublicAddress(a.address))
		if (rejected || list.length === 0) {
			return callback(Object.assign(new Error(`Callback host ${hostname} resolves to a non-public address`), { code: 'EBLOCKED' }), '', 0)
		}
		if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
		callback(null, list[0]!.address, list[0]!.family)
	})
}

/** Production sender: HTTPS only, public addresses only, no redirects, 10 s timeout. */
export const sendWebhook: SendWebhook = ({ url, headers, body }) =>
	new Promise((resolve, reject) => {
		const target = new URL(url)
		if (target.protocol !== 'https:') return reject(new Error('Callback URL must use https'))
		if (isIP(target.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(target.hostname.replace(/^\[|\]$/g, ''))) {
			return reject(new Error('Callback URL points to a non-public address'))
		}
		const req = request(target, { method: 'POST', headers, lookup: publicOnlyLookup, timeout: 10_000 }, (res) => {
			const chunks: Buffer[] = []
			let size = 0
			res.on('data', (chunk: Buffer) => {
				size += chunk.length
				if (size <= 64 * 1024) chunks.push(chunk)
			})
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
		})
		req.on('timeout', () => req.destroy(new Error('Callback timed out')))
		req.on('error', reject)
		req.end(body)
	})
