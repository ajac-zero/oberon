import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Webhook } from 'standardwebhooks'
import { isPublicAddress, sendWebhook, signedHeaders } from '../src/webhook.ts'

test('isPublicAddress blocks private, local, reserved, and mapped addresses', () => {
	for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
		assert.equal(isPublicAddress(ip), false, ip)
	}
	for (const ip of ['8.8.8.8', '172.32.0.1', '104.18.0.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
})

test('sendWebhook refuses non-https and private literal callback URLs before connecting', async () => {
	await assert.rejects(sendWebhook({ url: 'http://example.com/cb', headers: {}, body: '{}' }), /https/)
	await assert.rejects(sendWebhook({ url: 'https://127.0.0.1/cb', headers: {}, body: '{}' }), /non-public/)
	await assert.rejects(sendWebhook({ url: 'https://[::1]/cb', headers: {}, body: '{}' }), /non-public/)
})

test('signedHeaders produce Standard Webhooks signatures valid for every rotation secret', () => {
	const oldSecret = `whsec_${Buffer.alloc(32, 1).toString('base64')}`
	const newSecret = `whsec_${Buffer.alloc(32, 2).toString('base64')}`
	const body = JSON.stringify({ eventId: 'evt_1', data: { x: 'ü' } })
	const headers = signedHeaders({ secrets: [newSecret, oldSecret], messageId: 'evt_1', body, subscriptionId: 'sub_1', now: new Date() })
	assert.equal(headers['webhook-id'], 'evt_1')
	assert.equal(headers['x-mcp-subscription-id'], 'sub_1')
	assert.equal(headers['webhook-signature']!.split(' ').length, 2)
	for (const secret of [oldSecret, newSecret]) assert.doesNotThrow(() => new Webhook(secret).verify(body, headers))
	const stranger = `whsec_${Buffer.alloc(32, 3).toString('base64')}`
	assert.throws(() => new Webhook(stranger).verify(body, headers))
	assert.throws(() => new Webhook(newSecret).verify(`${body} `, headers), 'signature must cover the exact body bytes')
})
