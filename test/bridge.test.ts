import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { toThreadDetail, type ActiveThread, type Amp, type ThreadDetail } from '../src/amp.ts'
import { catchUpSubscription, publishTurnEnded, RecentTurns } from '../src/bridge.ts'
import { Subscriptions, TURN_ENDED, type SubscriptionState } from '../src/events.ts'
import { emptyOriginState, OriginStore, type OriginState } from '../src/origins.ts'
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
	await publishTurnEnded({ amp, subscriptions, origins: new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState())), sleep: async (ms) => void sleeps.push(ms) }, thread)
	assert.deepEqual(sleeps, [1_000, 2_000])
	assert.equal(events().length, 1)
	assert.equal(events()[0].data.final_message, 'OK3')
	assert.equal(events()[0].data.agent_state, 'idle')
})

test('event IDs are stable per turn and differ across turns', async () => {
	const { subscriptions, events } = await subscribed()
	const turns = [detail({ agentStateMessageId: 'M-2' }), detail({ agentStateMessageId: 'M-2' }), detail({ agentStateMessageId: 'M-3' })]
	const amp = { threadDetail: async () => turns.shift()! } as unknown as Amp
	for (let i = 0; i < 3; i++) await publishTurnEnded({ amp, subscriptions, origins: new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState())), sleep: async () => {} }, thread)
	const [a, b, c] = events().map((e) => e.eventId)
	assert.equal(a, b, 'a re-reported turn keeps its event ID')
	assert.notEqual(a, c)
})

test('does not read the thread when nobody is subscribed', async () => {
	const subscriptions = new Subscriptions({ store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }), send: async () => ({ status: 200, body: '' }) })
	const amp = { threadDetail: async () => assert.fail('should not export the thread') } as unknown as Amp
	await publishTurnEnded({ amp, subscriptions, origins: new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState())) }, thread)
})

// ── origin and outcome ───────────────────────────────────────────────────────

const OTHER = 'T-01a0f696-0000-7000-8000-000000000001'
const subscribe = async (subscriptions: Subscriptions, args: Record<string, unknown>) =>
	subscriptions.subscribe('owner', { name: TURN_ENDED, arguments: args, delivery: { mode: 'webhook', url: 'https://r.example.com/cb', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` } })
function harness(origins: OriginStore, states: Partial<ThreadDetail> = {}) {
	const sent: WebhookRequest[] = []
	const subscriptions = new Subscriptions({
		store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }),
		send: async (req) => {
			sent.push(req)
			const body = JSON.parse(req.body)
			return { status: 200, body: body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '' }
		},
	})
	const amp = { threadDetail: async (id: string) => detail({ id, ...states }) } as unknown as Amp
	const publish = (t: ActiveThread) => publishTurnEnded({ amp, subscriptions, origins, sleep: async () => {} }, t)
	return { subscriptions, publish, events: () => sent.filter((r) => !JSON.parse(r.body).type).map((r) => JSON.parse(r.body)) }
}

test('an origin-filtered subscription fires for Oberon-started threads only, including after a restart', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'oberon-origins-'))
	try {
		const file = join(dir, 'origins.json')
		new OriginStore(new JsonFile<OriginState>(file, emptyOriginState())).record(ID)
		// A new process reads the same file.
		const restarted = new OriginStore(new JsonFile<OriginState>(file, emptyOriginState()))
		const h = harness(restarted)
		await subscribe(h.subscriptions, { origin: 'oberon' })

		await h.publish({ ...thread, id: OTHER })
		assert.deepEqual(h.events(), [], 'a thread Oberon did not start does not fire')
		await h.publish(thread)
		assert.equal(h.events().length, 1)
		assert.equal(h.events()[0].data.origin, 'oberon')
	} finally {
		rmSync(dir, { recursive: true })
	}
})

test('subscriptions without origin still receive every thread, labelled by origin', async () => {
	const origins = new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState()))
	origins.record(ID)
	const h = harness(origins)
	await subscribe(h.subscriptions, {})
	await h.publish(thread)
	await h.publish({ ...thread, id: OTHER })
	assert.deepEqual(h.events().map((e) => [e.data.thread_id, e.data.origin]), [[ID, 'oberon'], [OTHER, 'other']])
})

test('outcome follows the settled agent state and the outcomes filter drops the rest', async () => {
	const cases: [string, string][] = [
		['idle', 'completed'],
		['error', 'error'],
		['cancelled', 'cancelled'],
		['awaiting_approval', 'needs_approval'],
		['awaiting_user_input', 'needs_approval'],
		['some_future_state', 'completed'],
	]
	for (const [state, outcome] of cases) {
		const origins = new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState()))
		const h = harness(origins, { agentState: state })
		await subscribe(h.subscriptions, {})
		await h.publish(thread)
		assert.equal(h.events()[0].data.outcome, outcome, state)
		assert.equal(h.events()[0].data.agent_state, state, 'raw state stays available')
	}

	const origins = new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState()))
	let state = 'idle'
	const subscriptions = new Subscriptions({
		store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }),
		send: async (req) => {
			const body = JSON.parse(req.body)
			if (body.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
			delivered.push(body)
			return { status: 200, body: '' }
		},
	})
	const delivered: { data: { outcome: string } }[] = []
	const amp = { threadDetail: async () => detail({ agentState: state }) } as unknown as Amp
	await subscribe(subscriptions, { outcomes: ['error', 'needs_approval'] })
	for (state of ['idle', 'error', 'cancelled', 'awaiting_approval']) await publishTurnEnded({ amp, subscriptions, origins, sleep: async () => {} }, thread)
	assert.deepEqual(delivered.map((e) => e.data.outcome), ['error', 'needs_approval'])
})

test('threads stopped in error, cancelled, or awaiting states settle without a completed assistant message', async () => {
	const last = (role: string, type?: string) => ({ role, state: type ? { type } : undefined, content: [{ type: 'text', text: 'x' }] })
	const toDetail = (state: string, message: ReturnType<typeof last>) => toThreadDetail({ id: ID, meta: { lastKnownAgentState: { state } }, messages: [last('user'), message] })
	for (const state of ['error', 'cancelled', 'awaiting_approval']) {
		assert.equal(toDetail(state, last('assistant', 'streaming')).settled, true, state)
		assert.equal(toDetail(state, last('user')).settled, true, state)
	}
	assert.equal(toDetail('idle', last('assistant', 'complete')).settled, true)
	assert.equal(toDetail('idle', last('user')).settled, false, 'idle still needs the finished assistant message')
	// Mid-turn states observed in real exports must not look settled, even with a completed assistant message.
	for (const state of ['tool_use', 'running_tools', 'working', 'streaming', 'some_future_state']) assert.equal(toDetail(state, last('assistant', 'complete')).settled, false, state)
})

// ── Catch-up: a turn that ends before (or while) ChatGPT subscribes ─────────────

/** Subscriptions wired like main.ts: onSubscribed runs the catch-up; the test awaits it. */
function catchUpHarness(windowMs = 120_000) {
	let clock = Date.parse('2026-10-05T19:18:58Z')
	const now = () => new Date(clock)
	const sent: WebhookRequest[] = []
	const recentTurns = new RecentTurns({ windowMs, now })
	const origins = new OriginStore(new JsonFile<OriginState>(undefined, emptyOriginState()))
	const amp = { threadDetail: async () => detail({ lastAssistantText: 'Soft rain taps the leaves' }) } as unknown as Amp
	const pending: Promise<void>[] = []
	const subscriptions: Subscriptions = new Subscriptions({
		store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }),
		now: () => clock,
		send: async (req) => {
			sent.push(req)
			const body = JSON.parse(req.body)
			return { status: 200, body: body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '' }
		},
		onSubscribed: (s) => void pending.push(catchUpSubscription({ amp, subscriptions, origins, recentTurns, now }, s)),
	})
	const subscribe = async (args: Record<string, unknown>, url = 'https://connectors.example.com/cb') => {
		const result = await subscriptions.subscribe('owner', { name: TURN_ENDED, arguments: args, delivery: { mode: 'webhook', url, secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` } })
		await Promise.all(pending)
		return result
	}
	return {
		subscriptions,
		origins,
		recentTurns,
		subscribe,
		advance: (ms: number) => void (clock += ms),
		events: () => sent.filter((r) => !JSON.parse(r.body).type).map((r) => ({ to: r.headers['x-mcp-subscription-id'], ...JSON.parse(r.body) })),
		publish: (t: ActiveThread) => publishTurnEnded({ amp, subscriptions, origins, now }, t),
	}
}

test('a thread_id subscription created just after its turn ended still gets that turn', async () => {
	const h = catchUpHarness()
	// The turn ends while nobody is subscribed: the normal path delivers nothing.
	h.recentTurns.record(thread)
	await h.publish(thread)
	assert.equal(h.events().length, 0)
	h.advance(500)
	const sub = await h.subscribe({ thread_id: ID })
	assert.equal(h.events().length, 1)
	assert.equal(h.events()[0].to, sub.id)
	assert.equal(h.events()[0].data.final_message, 'Soft rain taps the leaves')
	assert.equal(h.events()[0].timestamp, '2026-10-05T19:18:58.000Z', 'stamped with when the turn ended, not when it was caught up')
})

test('catch-up honours the subscription filters', async () => {
	const h = catchUpHarness()
	h.recentTurns.record(thread)
	await h.subscribe({ thread_id: ID, origin: 'oberon' })
	assert.equal(h.events().length, 0, 'thread was not started through Oberon')
	h.origins.record(ID)
	await h.subscribe({ thread_id: ID, origin: 'oberon' }, 'https://connectors.example.com/cb2')
	assert.equal(h.events().length, 1)
})

test('no catch-up for old turns, other threads, or subscriptions without thread_id', async () => {
	const h = catchUpHarness(120_000)
	h.recentTurns.record(thread)
	h.advance(121_000)
	await h.subscribe({ thread_id: ID })
	await h.subscribe({ thread_id: 'T-00000000-0000-0000-0000-000000000000' }, 'https://connectors.example.com/other')
	h.advance(-121_000)
	await h.subscribe({ project: 'amp-mcp' }, 'https://connectors.example.com/project')
	await h.subscribe({}, 'https://connectors.example.com/all')
	assert.equal(h.events().length, 0)
})

test('catch-up goes only to the new subscription, not to existing ones that already had their chance', async () => {
	const h = catchUpHarness()
	const early = await h.subscribe({ project: 'amp-mcp' }, 'https://connectors.example.com/early')
	h.recentTurns.record(thread)
	await h.publish(thread)
	assert.deepEqual(h.events().map((e) => e.to), [early.id])
	const late = await h.subscribe({ thread_id: ID }, 'https://connectors.example.com/late')
	assert.deepEqual(h.events().map((e) => e.to), [early.id, late.id])
	assert.equal(h.events()[0].eventId, h.events()[1].eventId, 'same turn, same event ID')
})
