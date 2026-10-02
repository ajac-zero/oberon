import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { Webhook } from 'standardwebhooks'
import { OUTCOMES } from '../src/amp.ts'
import { CALLBACK_ENDPOINT_ERROR, canonicalJson, DEFAULT_TTL_MS, EVENT_DEFINITIONS, matchesOutcome, MAX_TTL_MS, MIN_TTL_MS, Subscriptions, TURN_ENDED, type SubscriptionState } from '../src/events.ts'
import { JsonFile } from '../src/store.ts'
import type { WebhookRequest, WebhookResponse } from '../src/webhook.ts'

/** Checks a delivery's signature header contains a valid signature for `secret`, independent of wall-clock tolerance. */
const signedWith = (s: string, req: WebhookRequest) => {
	const expected = new Webhook(s).sign(req.headers['webhook-id']!, new Date(Number(req.headers['webhook-timestamp']) * 1000), req.body)
	return req.headers['webhook-signature']!.split(' ').includes(expected)
}
const secret = (fill: number, bytes = 32) => `whsec_${Buffer.alloc(bytes, fill).toString('base64')}`
const URL_A = 'https://receiver.example.com/mcp-events/cb_1'

/** A callback receiver that answers verification challenges and scripts event responses. */
function receiver(eventResponses: (WebhookResponse | Error)[] = []) {
	const requests: WebhookRequest[] = []
	const send = async (req: WebhookRequest): Promise<WebhookResponse> => {
		requests.push(req)
		const body = JSON.parse(req.body)
		if (body.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
		const next = eventResponses.shift() ?? { status: 200, body: '' }
		if (next instanceof Error) throw next
		return next
	}
	return { requests, send, events: () => requests.filter((r) => !JSON.parse(r.body).type) }
}

function setup(send: (req: WebhookRequest) => Promise<WebhookResponse>) {
	let now = Date.parse('2026-10-01T12:00:00Z')
	const sleeps: number[] = []
	const store = new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} })
	const subs = new Subscriptions({ store, send, now: () => now, sleep: async (ms) => void sleeps.push(ms) })
	return { subs, store, sleeps, advance: (ms: number) => void (now += ms), now: () => now }
}

const subscribeParams = (args: Record<string, unknown>, s = secret(1), extra: Record<string, unknown> = {}) => ({
	name: TURN_ENDED,
	arguments: args,
	delivery: { mode: 'webhook', url: URL_A, secret: s },
	cursor: null,
	...extra,
})

test('rejects bad secrets, unknown events, unknown filters, and non-https callbacks', async () => {
	const { subs } = setup(receiver().send)
	await assert.rejects(subs.subscribe('owner', subscribeParams({}, secret(1, 16))), /24–64 bytes/)
	await assert.rejects(subs.subscribe('owner', subscribeParams({}, Buffer.alloc(32).toString('base64'))), /whsec_/)
	await assert.rejects(subs.subscribe('owner', { ...subscribeParams({}), name: 'thread.created' }), /Unknown event/)
	await assert.rejects(subs.subscribe('owner', subscribeParams({ channel_id: 'x' })), /Invalid arguments/)
	await assert.rejects(subs.subscribe('owner', { ...subscribeParams({}), delivery: { mode: 'webhook', url: 'http://receiver.example.com/cb', secret: secret(1) } }), (e: { code?: number }) => e.code === CALLBACK_ENDPOINT_ERROR)
})

test('callback verification failures map to CallbackEndpointError reasons', async () => {
	const cases: [(req: WebhookRequest) => Promise<WebhookResponse>, string][] = [
		[async () => ({ status: 200, body: JSON.stringify({ challenge: 'wrong' }) }), 'challenge_failed'],
		[async () => ({ status: 200, body: 'not json' }), 'challenge_failed'],
		[async () => ({ status: 500, body: '' }), 'http_error'],
		[async () => Promise.reject(new Error('Callback timed out')), 'timeout'],
	]
	for (const [send, reason] of cases) {
		const { subs, store } = setup(send)
		await assert.rejects(subs.subscribe('owner', subscribeParams({})), (e: { code?: number; data?: { reason?: string } }) => e.code === CALLBACK_ENDPOINT_ERROR && e.data?.reason === reason)
		assert.deepEqual(store.value.subscriptions, {}, 'nothing stored after failed verification')
	}
})

test('subscription identity ignores argument key order; refresh is idempotent and skips re-verification', async () => {
	const r = receiver()
	const { subs, store } = setup(r.send)
	const first = await subs.subscribe('owner', subscribeParams({ thread_id: 'T-1', project: 'p' }))
	const again = await subs.subscribe('owner', subscribeParams({ project: 'p', thread_id: 'T-1' }))
	assert.equal(again.id, first.id)
	assert.equal(Object.keys(store.value.subscriptions).length, 1)
	assert.equal(r.requests.length, 1, 'verified once per principal + callback URL')
	assert.deepEqual({ cursor: first.cursor, truncated: first.truncated }, { cursor: null, truncated: false })

	const other = await subs.subscribe('owner', subscribeParams({ thread_id: 'T-2' }))
	assert.notEqual(other.id, first.id)
	const otherPrincipal = await subs.subscribe('someone-else', subscribeParams({ thread_id: 'T-1', project: 'p' }))
	assert.notEqual(otherPrincipal.id, first.id)
})

test('canonicalJson sorts keys at every depth and drops undefined', () => {
	assert.equal(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[{"x":2,"y":1}]},"b":1}')
})

test('grants a bounded TTL', async () => {
	const { subs, now } = setup(receiver().send)
	const granted = async (ttlMs: unknown) => Date.parse((await subs.subscribe('owner', subscribeParams({}, secret(1), ttlMs === 'omit' ? {} : { ttlMs }))).refreshBefore) - now()
	assert.equal(await granted('omit'), DEFAULT_TTL_MS)
	assert.equal(await granted(1_000), MIN_TTL_MS)
	assert.equal(await granted(2 * 60 * 60 * 1000), 2 * 60 * 60 * 1000)
	assert.equal(await granted(30 * 24 * 60 * 60 * 1000), MAX_TTL_MS)
	assert.equal(await granted(null), MAX_TTL_MS, 'no-expiry requests get a finite grant')
})

test('matching applies filters and expiry; unsubscribe is idempotent', async () => {
	const { subs, advance } = setup(receiver().send)
	await subs.subscribe('owner', subscribeParams({ thread_id: 'T-1' }))
	await subs.subscribe('owner', subscribeParams({ project: 'web' }))
	const ids = (facts: { thread_id: string; project: string; origin?: 'oberon' | 'other' }) => subs.matching(TURN_ENDED, { origin: 'other', ...facts }).map((s) => JSON.stringify(s.arguments)).sort()
	assert.deepEqual(ids({ thread_id: 'T-1', project: 'api' }), ['{"thread_id":"T-1"}'])
	assert.deepEqual(ids({ thread_id: 'T-9', project: 'web' }), ['{"project":"web"}'])
	assert.deepEqual(ids({ thread_id: 'T-1', project: 'web' }), ['{"project":"web"}', '{"thread_id":"T-1"}'])
	assert.deepEqual(ids({ thread_id: 'T-9', project: 'api' }), [])

	assert.deepEqual(subs.unsubscribe('owner', { name: TURN_ENDED, arguments: { thread_id: 'T-1' }, delivery: { mode: 'webhook', url: URL_A } }), {})
	assert.deepEqual(subs.unsubscribe('owner', { name: TURN_ENDED, arguments: { thread_id: 'T-1' }, delivery: { mode: 'webhook', url: URL_A } }), {})
	assert.deepEqual(ids({ thread_id: 'T-1', project: 'api' }), [])

	advance(DEFAULT_TTL_MS + 1)
	assert.deepEqual(ids({ thread_id: 'T-9', project: 'web' }), [], 'expired subscriptions do not match')
})

test('delivery retries transient failures with the same event ID and stops on 410', async () => {
	const r = receiver([{ status: 503, body: '' }, new Error('ECONNRESET'), { status: 200, body: '' }])
	const { subs, sleeps, store } = setup(r.send)
	await subs.subscribe('owner', subscribeParams({}))
	const event = { eventId: 'evt_1', name: TURN_ENDED, timestamp: '2026-10-01T12:00:00.000Z', data: { thread_id: 'T-1' } }
	await subs.deliver(subs.matching(TURN_ENDED, { thread_id: 'T-1', project: 'p', origin: 'other' }), event)
	const attempts = r.events()
	assert.equal(attempts.length, 3)
	assert.deepEqual(new Set(attempts.map((a) => a.headers['webhook-id'])), new Set(['evt_1']))
	assert.deepEqual(sleeps, [1_000, 5_000])
	assert.deepEqual(JSON.parse(attempts[2]!.body), { ...event, cursor: null })
	for (const a of attempts) assert.ok(signedWith(secret(1), a))

	const gone = receiver([{ status: 410, body: '' }])
	const g = setup(gone.send)
	await g.subs.subscribe('owner', subscribeParams({}))
	await g.subs.deliver(g.subs.matching(TURN_ENDED, { thread_id: 'T-1', project: 'p', origin: 'other' }), event)
	assert.equal(gone.events().length, 1)
	assert.deepEqual(g.store.value.subscriptions, {}, '410 removes the subscription')

	const rejected = receiver([{ status: 400, body: '' }])
	const b = setup(rejected.send)
	await b.subs.subscribe('owner', subscribeParams({}))
	await b.subs.deliver(b.subs.matching(TURN_ENDED, { thread_id: 'T-1', project: 'p', origin: 'other' }), event)
	assert.equal(rejected.events().length, 1, 'permanent 4xx is not retried')
	assert.equal(Object.keys(b.store.value.subscriptions).length + Object.keys(store.value.subscriptions).length, 2)
})

test('secret rotation signs with both secrets during the window, then only the new one', async () => {
	const r = receiver()
	const { subs, advance } = setup(r.send)
	await subs.subscribe('owner', subscribeParams({}, secret(1)))
	await subs.subscribe('owner', subscribeParams({}, secret(2)))
	const deliver = async (id: string) => {
		await subs.deliver(subs.matching(TURN_ENDED, { thread_id: 'T-1', project: 'p', origin: 'other' }), { eventId: id, name: TURN_ENDED, timestamp: '', data: {} })
		return r.events().at(-1)!
	}
	const during = await deliver('evt_a')
	assert.ok(signedWith(secret(1), during))
	assert.ok(signedWith(secret(2), during))
	advance(61 * 60 * 1000)
	const after = await deliver('evt_b')
	assert.ok(!signedWith(secret(1), after))
	assert.ok(signedWith(secret(2), after))
})

// ── origin and outcomes filters ──────────────────────────────────────────────

test('a subscription without the new arguments keeps the ID it had before they existed', async () => {
	const { subs, store } = setup(receiver().send)
	const legacy = async (args: Record<string, unknown>) => (await subs.subscribe('owner', subscribeParams(args))).id
	// Hand-built from the original derivation: sha256 over canonical JSON of [principal, url, name, args].
	const before = (args: string) => `sub_${createHash('sha256').update(`["owner","${URL_A}","thread.turn_ended",${args}]`).digest('hex').slice(0, 32)}`
	assert.equal(await legacy({}), before('{}'))
	assert.equal(await legacy({ thread_id: 'T-1', project: 'p' }), before('{"project":"p","thread_id":"T-1"}'))
	assert.deepEqual(store.value.subscriptions[before('{}')]!.arguments, {}, 'no defaults are written into stored arguments')
	// Spelling out the default is the same subscription, not a second one that would double-deliver.
	assert.equal(await legacy({ origin: 'any' }), before('{}'))
	assert.notEqual(await legacy({ origin: 'oberon' }), before('{}'))
})

test('outcomes are validated and their order does not change the subscription', async () => {
	const { subs } = setup(receiver().send)
	const a = await subs.subscribe('owner', subscribeParams({ outcomes: ['error', 'needs_approval'] }))
	const b = await subs.subscribe('owner', subscribeParams({ outcomes: ['needs_approval', 'error', 'error'] }))
	assert.equal(a.id, b.id)
	await assert.rejects(subs.subscribe('owner', subscribeParams({ outcomes: ['idle'] })), /Invalid arguments/)
	await assert.rejects(subs.subscribe('owner', subscribeParams({ outcomes: [] })), /Invalid arguments/)
	await assert.rejects(subs.subscribe('owner', subscribeParams({ origin: 'mine' })), /Invalid arguments/)
})

test('origin "oberon" matches only threads Oberon started; no origin argument matches both', async () => {
	const { subs } = setup(receiver().send)
	await subs.subscribe('owner', subscribeParams({ origin: 'oberon' }))
	await subs.subscribe('owner', subscribeParams({}, secret(1), {}))
	const count = (origin: 'oberon' | 'other') => subs.matching(TURN_ENDED, { thread_id: 'T-1', project: 'p', origin }).length
	assert.equal(count('oberon'), 2)
	assert.equal(count('other'), 1)
})

test('matchesOutcome applies the outcomes filter only when present', () => {
	assert.equal(matchesOutcome({}, 'error'), true)
	assert.equal(matchesOutcome({ outcomes: ['completed'] }, 'error'), false)
	assert.equal(matchesOutcome({ outcomes: ['completed', 'error'] }, 'error'), true)
})

test('the schemas advertised to clients describe the new argument and payload fields', () => {
	const def = EVENT_DEFINITIONS.find((e) => e.name === TURN_ENDED)!
	const input = def.inputSchema as { properties: Record<string, { enum?: string[]; items?: { enum: string[] } }> }
	assert.deepEqual(input.properties.origin!.enum, ['oberon', 'any'])
	assert.deepEqual(input.properties.outcomes!.items!.enum, [...OUTCOMES])
	const payload = def.payloadSchema as { required: string[]; properties: Record<string, { enum?: string[] }> }
	assert.ok(payload.required.includes('origin') && payload.required.includes('outcome'))
	assert.deepEqual(payload.properties.origin!.enum, ['oberon', 'other'])
})
