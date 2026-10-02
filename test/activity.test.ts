import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySnapshot } from '../src/activity.ts'
import type { ActiveThread } from '../src/amp.ts'

const thread = (id: string, working: boolean): ActiveThread => ({
	id,
	title: id,
	url: `https://ampcode.com/threads/${id}`,
	project: 'p',
	status: working ? 'working' : '1m',
	working,
	executorConnected: true,
	updatedAt: '2026-10-01T00:00:00Z',
})
const snap = (threads: ActiveThread[], reconnecting = false) => ({ updatedAt: '', threads, reconnecting })

test('reports a turn only on a working → idle transition', () => {
	const known = new Map<string, ActiveThread>()
	// First sight of an idle thread is not an ended turn (it may have finished hours ago).
	assert.deepEqual(applySnapshot(known, snap([thread('A', false), thread('B', true)])).map((t) => t.id), [])
	assert.deepEqual(applySnapshot(known, snap([thread('A', false), thread('B', true)])).map((t) => t.id), [])
	assert.deepEqual(applySnapshot(known, snap([thread('A', true), thread('B', false)])).map((t) => t.id), ['B'])
	assert.deepEqual(applySnapshot(known, snap([thread('A', false), thread('B', false)])).map((t) => t.id), ['A'])
})

test('an empty or reconnecting snapshot does not forget working threads', () => {
	const known = new Map<string, ActiveThread>()
	applySnapshot(known, snap([thread('A', true)]))
	// `amp top` restarts with an empty list, and reconnecting snapshots may be stale.
	assert.deepEqual(applySnapshot(known, snap([])), [])
	assert.deepEqual(applySnapshot(known, snap([thread('A', false)], true)), [])
	assert.deepEqual(applySnapshot(known, snap([thread('A', false)])).map((t) => t.id), ['A'])
})
