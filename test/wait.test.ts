import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { ActivityTracker, type TopSnapshot } from '../src/activity.ts'
import type { ActiveThread, Amp, ThreadDetail } from '../src/amp.ts'
import { loadConfig } from '../src/config.ts'
import { Subscriptions, type SubscriptionState } from '../src/events.ts'
import { createMcpServer } from '../src/mcp.ts'
import { JsonFile } from '../src/store.ts'

const A = 'T-01a0f696-61fc-74da-a09c-6725b91a38f8'
const B = 'T-01a0f696-61fc-74da-a09c-6725b91a38f9'

const thread = (id: string, working: boolean): ActiveThread => ({ id, title: id, url: `https://ampcode.com/threads/${id}`, project: 'p', status: working ? 'working' : '1m', working, executorConnected: true, updatedAt: '' })
const snap = (...threads: ActiveThread[]): TopSnapshot => ({ updatedAt: '', threads, reconnecting: false })
const env = { OBERON_PUBLIC_URL: 'https://o.example.com', OBERON_PASSPHRASE: 'a long enough passphrase' }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const finishedDetail = (over: Partial<ThreadDetail> = {}): ThreadDetail => ({ id: A, title: 't', url: '', agentState: 'idle', agentStateMessageId: 'M', lastAssistantText: 'All done', settled: true, updatedAt: '', ...over })

/** An MCP client connected in memory to a server wired to a real ActivityTracker and a fake Amp. */
async function connect(options: { enabled: boolean; details?: () => ThreadDetail; sleep?: (ms: number) => Promise<void> }) {
	const tracker = new ActivityTracker()
	let reads = 0
	const amp = { threadDetail: async () => (reads++, (options.details ?? finishedDetail)()) } as unknown as Amp
	const subscriptions = new Subscriptions({ store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }), send: async () => ({ status: 200, body: '' }) })
	const server = createMcpServer({ amp, activeThreads: tracker.current, subscriptions, principal: 'owner', waitForTurnEnd: options.enabled ? tracker.waitForTurnEnd : undefined, sleep: options.sleep })
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const client = new Client({ name: 'test', version: '1' })
	await client.connect(clientSide)
	const wait = (args: Record<string, unknown>) => client.callTool({ name: 'wait_for_thread', arguments: args })
	return { client, tracker, wait, reads: () => reads }
}

test('OBERON_ENABLE_WAIT_TOOL parses 1/true only and defaults off', () => {
	assert.equal(loadConfig(env).enableWaitTool, false)
	for (const on of ['1', 'true', 'TRUE']) assert.equal(loadConfig({ ...env, OBERON_ENABLE_WAIT_TOOL: on }).enableWaitTool, true, on)
	for (const off of ['0', 'false', '', 'yes']) assert.equal(loadConfig({ ...env, OBERON_ENABLE_WAIT_TOOL: off }).enableWaitTool, false, off)
})

test('wait_for_thread is listed only when enabled, and the rest of the list is unchanged', async () => {
	const off = await connect({ enabled: false })
	const on = await connect({ enabled: true })
	const offNames = (await off.client.listTools()).tools.map((t) => t.name).sort()
	const onTools = (await on.client.listTools()).tools
	assert.ok(!offNames.includes('wait_for_thread'))
	assert.deepEqual(onTools.map((t) => t.name).sort(), [...offNames, 'wait_for_thread'].sort())
	assert.equal(onTools.find((t) => t.name === 'wait_for_thread')!.annotations?.readOnlyHint, true)
})

test('resolves when the watched thread turn ends, not when another thread does', async () => {
	const { tracker, wait } = await connect({ enabled: true })
	tracker.ingest(snap(thread(A, true), thread(B, true)))
	let settled = false
	const pending = wait({ thread_id: A, timeout_seconds: 30 }).then((r) => ((settled = true), r))

	tracker.ingest(snap(thread(A, true), thread(B, false)))
	await tick(50)
	assert.equal(settled, false, "another thread's turn ending must not release the wait")

	tracker.ingest(snap(thread(A, false), thread(B, false)))
	const result = (await pending).structuredContent as Record<string, unknown>
	assert.equal(result.finished, true)
	assert.equal(result.thread_id, A)
	assert.equal(result.final_message, 'All done')
	assert.equal(result.hint, undefined)
})

test('concurrent waiters on one thread all resolve', async () => {
	const { tracker, wait } = await connect({ enabled: true })
	tracker.ingest(snap(thread(A, true)))
	const waits = [wait({ thread_id: A }), wait({ thread_id: `https://ampcode.com/threads/${A}` }), wait({ thread_id: A })]
	await tick()
	tracker.ingest(snap(thread(A, false)))
	const results = await Promise.all(waits)
	assert.deepEqual(results.map((r) => (r.structuredContent as { finished: boolean }).finished), [true, true, true])
})

test('timeout returns finished: false with a hint and does not throw', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const { tracker, wait } = await connect({ enabled: true })
	tracker.ingest(snap(thread(A, true)))
	const pending = wait({ thread_id: A, timeout_seconds: 1 })
	await new Promise<void>((r) => setImmediate(r))
	t.mock.timers.tick(5_000) // 1 s requested; the minimum is 5 s
	const res = await pending
	assert.notEqual(res.isError, true)
	const result = res.structuredContent as { finished: boolean; agent_state: string; hint?: string; url: string }
	assert.equal(result.finished, false)
	assert.equal(result.agent_state, 'working')
	assert.match(result.hint ?? '', /again/)
	assert.equal(result.url, `https://ampcode.com/threads/${A}`)
})

test('timeout is clamped to at most 55 s', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const { tracker, wait } = await connect({ enabled: true })
	tracker.ingest(snap(thread(A, true)))
	let done = false
	const pending = wait({ thread_id: A, timeout_seconds: 600 }).then((r) => ((done = true), r))
	await new Promise<void>((r) => setImmediate(r))
	t.mock.timers.tick(54_000)
	await new Promise<void>((r) => setImmediate(r))
	assert.equal(done, false)
	t.mock.timers.tick(1_000)
	assert.equal(((await pending).structuredContent as { finished: boolean }).finished, false)
})

test('an already idle thread returns its state at once without waiting or settling', async () => {
	const sleeps: number[] = []
	const { tracker, wait, reads } = await connect({ enabled: true, sleep: async (ms) => void sleeps.push(ms) })
	tracker.ingest(snap(thread(A, false)))
	const result = (await wait({ thread_id: A })).structuredContent as { finished: boolean; final_message: string }
	assert.equal(result.finished, true)
	assert.equal(result.final_message, 'All done')
	assert.equal(reads(), 1)
	assert.deepEqual(sleeps, [])
})

test('after a turn ends it waits for the export to settle, and long messages are truncated', async () => {
	const details = [finishedDetail({ settled: false, agentState: 'working', lastAssistantText: 'stale' }), finishedDetail({ lastAssistantText: 'x'.repeat(20_000) })]
	const sleeps: number[] = []
	const { tracker, wait } = await connect({ enabled: true, details: () => details.shift()!, sleep: async (ms) => void sleeps.push(ms) })
	tracker.ingest(snap(thread(A, true)))
	const pending = wait({ thread_id: A })
	await tick(10)
	tracker.ingest(snap(thread(A, false)))
	const result = (await pending).structuredContent as { finished: boolean; final_message: string; final_message_truncated: boolean }
	assert.equal(sleeps.length, 1)
	assert.equal(result.finished, true)
	assert.equal(result.final_message_truncated, true)
	assert.ok(result.final_message.length < 20_000)
})

test('a bad thread_id is a tool error, not a crash', async () => {
	const { wait } = await connect({ enabled: true })
	assert.equal((await wait({ thread_id: 'nope' })).isError, true)
})
