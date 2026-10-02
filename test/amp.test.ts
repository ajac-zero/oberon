import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseThreadId, toThreadDetail } from '../src/amp.ts'

const ID = 'T-01a0f696-61fc-74da-a09c-6725b91a38f8'
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (content: { type: string; text?: string }[], type = 'complete') => ({ role: 'assistant', state: { type }, content })

test('parseThreadId accepts IDs and URLs and rejects everything else', () => {
	assert.equal(parseThreadId(ID), ID)
	assert.equal(parseThreadId(` https://ampcode.com/threads/${ID}?x=1 `), ID)
	assert.throws(() => parseThreadId('T-123'))
	assert.throws(() => parseThreadId('--help'))
})

test('toThreadDetail is unsettled while the export lags behind a finished turn', () => {
	// Shape observed right after `amp top` flipped to idle: state still working, new reply missing.
	const lagging = toThreadDetail({ id: ID, meta: { lastKnownAgentState: { state: 'working', messageID: 'M-1' } }, messages: [user('a'), assistant([{ type: 'text', text: 'OK2' }]), user('b')] })
	assert.equal(lagging.settled, false)
	const idleButNoReply = toThreadDetail({ id: ID, meta: { lastKnownAgentState: { state: 'idle' } }, messages: [user('a'), assistant([{ type: 'text', text: 'OK2' }]), user('b')] })
	assert.equal(idleButNoReply.settled, false)
	const streaming = toThreadDetail({ id: ID, meta: { lastKnownAgentState: { state: 'idle' } }, messages: [user('b'), assistant([{ type: 'text', text: 'O' }], 'streaming')] })
	assert.equal(streaming.settled, false)

	const settled = toThreadDetail({
		id: ID,
		title: 'Probe',
		meta: { lastKnownAgentState: { state: 'idle', messageID: 'M-2' } },
		messages: [user('b'), assistant([{ type: 'text', text: 'Done.' }, { type: 'text', text: 'PR #4' }])],
	})
	assert.deepEqual([settled.settled, settled.lastAssistantText, settled.agentStateMessageId], [true, 'Done.\n\nPR #4', 'M-2'])
})

test('lastAssistantText skips trailing tool-only assistant messages', () => {
	const detail = toThreadDetail({ id: ID, meta: { lastKnownAgentState: { state: 'error' } }, messages: [user('a'), assistant([{ type: 'text', text: 'Trying.' }]), assistant([{ type: 'tool_use' }])] })
	assert.equal(detail.lastAssistantText, 'Trying.')
	assert.equal(detail.settled, true, 'an error ends the turn even without a final text reply')
})
