import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActiveThread, Amp, ThreadDetail } from '../src/amp.ts'
import { publishTurnEnded } from '../src/bridge.ts'
import { Subscriptions, TURN_ENDED, type SubscriptionState } from '../src/events.ts'
import { JsonFile } from '../src/store.ts'
import type { WebhookRequest } from '../src/webhook.ts'

const ID = 'T-01a0f696-61fc-74da-a09c-6725b91a38f8'
const thread: ActiveThread = { id: ID, title: 'Probe', url: `https://ampcode.com/threads/${ID}`, project: 'amp-mcp', status: '1m', working: false, executorConnected: true, updatedAt: '' }
const detail = (over: Partial<ThreadDetail>): ThreadDetail => ({ id: ID, title: 'Probe', url: thread.url, agentState: 'idle', agentStateMessageId: 'M-2', lastAssistantText: 'OK3', settled: true, updatedAt: '', ...over })

async function subscribed() {
	const sent: WebhookRequest[] = []
	const subscriptions = new Subscriptions({
		store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }),
		send: async (req) => {
			sent.push(req)
			const body = JSON.parse(req.body)
			return { status: 200, body: body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '' }
		},
	})
	await subscriptions.subscribe('owner', { name: TURN_ENDED, arguments: { thread_id: ID }, delivery: { mode: 'webhook', url: 'https://r.example.com/cb', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` } })
	return { subscriptions, events: () => sent.filter((r) => !JSON.parse(r.body).type).map((r) => JSON.parse(r.body)) }
}

test('waits for the thread export to settle before publishing', async () => {
	const { subscriptions, events } = await subscribed()
	const reads = [detail({ agentState: 'working', agentStateMessageId: 'M-1', lastAssistantText: 'OK2', settled: false }), detail({ settled: false }), detail({})]
	const amp = { threadDetail: async () => reads.shift()! } as unknown as Amp
	const sleeps: number[] = []
	await publishTurnEnded({ amp, subscriptions, sleep: async (ms) => void sleeps.push(ms) }, thread)
	assert.deepEqual(sleeps, [1_000, 2_000])
	assert.equal(events().length, 1)
	assert.equal(events()[0].data.final_message, 'OK3')
	assert.equal(events()[0].data.agent_state, 'idle')
})

test('event IDs are stable per turn and differ across turns', async () => {
	const { subscriptions, events } = await subscribed()
	const turns = [detail({ agentStateMessageId: 'M-2' }), detail({ agentStateMessageId: 'M-2' }), detail({ agentStateMessageId: 'M-3' })]
	const amp = { threadDetail: async () => turns.shift()! } as unknown as Amp
	for (let i = 0; i < 3; i++) await publishTurnEnded({ amp, subscriptions, sleep: async () => {} }, thread)
	const [a, b, c] = events().map((e) => e.eventId)
	assert.equal(a, b, 'a re-reported turn keeps its event ID')
	assert.notEqual(a, c)
})

test('does not read the thread when nobody is subscribed', async () => {
	const subscriptions = new Subscriptions({ store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }), send: async () => ({ status: 200, body: '' }) })
	const amp = { threadDetail: async () => assert.fail('should not export the thread') } as unknown as Amp
	await publishTurnEnded({ amp, subscriptions }, thread)
})
