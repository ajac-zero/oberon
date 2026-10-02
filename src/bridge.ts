import { createHash } from 'node:crypto'
import type { ActiveThread, Amp, ThreadDetail } from './amp.ts'
import type { TurnWait } from './activity.ts'
import { threadUrl } from './amp.ts'
import { TURN_ENDED, type Subscriptions, type TurnEndedPayload } from './events.ts'

const FINAL_MESSAGE_MAX = 16_000
/** `amp top` reports idle a moment before `amp threads export` reflects the finished turn. */
const SETTLE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Same truncation for every final message Oberon returns. */
export function truncateFinalMessage(text: string): { text: string; truncated: boolean } {
	const truncated = text.length > FINAL_MESSAGE_MAX
	return { text: truncated ? `${text.slice(0, FINAL_MESSAGE_MAX)}…` : text, truncated }
}

/**
 * Reads the thread, retrying with backoff until the export reflects a finished
 * turn. Stops early when the next delay would exceed `budgetMs`; the last read
 * is returned either way, so check `settled`.
 */
export async function settledThreadDetail(
	deps: { amp: Amp; sleep?: (ms: number) => Promise<void> },
	id: string,
	budgetMs = Infinity,
): Promise<ThreadDetail> {
	const sleep = deps.sleep ?? defaultSleep
	let detail = await deps.amp.threadDetail(id)
	let spent = 0
	for (const delay of SETTLE_DELAYS_MS) {
		if (detail.settled || spent + delay > budgetMs) break
		await sleep(delay)
		spent += delay
		detail = await deps.amp.threadDetail(id)
	}
	return detail
}

export type WaitResult = {
	thread_id: string
	url: string
	finished: boolean
	agent_state: string
	final_message: string
	final_message_truncated: boolean
	/** Present when not finished. */
	hint?: string
}

/**
 * Waits up to `timeoutMs` for the thread's current turn to end and reports where it
 * stands. A thread that is not working now is reported as it is, without waiting.
 */
export async function waitForThread(
	deps: { amp: Amp; waitForTurnEnd: (id: string, timeoutMs: number) => Promise<TurnWait>; sleep?: (ms: number) => Promise<void> },
	id: string,
	timeoutMs: number,
): Promise<WaitResult> {
	const startedAt = Date.now()
	const outcome = await deps.waitForTurnEnd(id, timeoutMs)
	const url = threadUrl(id)
	if (outcome === 'timeout') {
		return { thread_id: id, url, finished: false, agent_state: 'working', final_message: '', final_message_truncated: false, hint: 'Still working. Call wait_for_thread again to keep waiting.' }
	}
	// 'ended': `amp top` is ahead of the export, so settle within what is left of the budget. 'idle': one read.
	const detail = outcome === 'ended' ? await settledThreadDetail(deps, id, timeoutMs - (Date.now() - startedAt)) : await deps.amp.threadDetail(id)
	const message = truncateFinalMessage(detail.lastAssistantText)
	return {
		thread_id: id,
		url,
		finished: detail.settled,
		agent_state: detail.agentState ?? 'unknown',
		final_message: message.text,
		final_message_truncated: message.truncated,
		...(detail.settled ? {} : { hint: 'The thread has not finished yet. Call wait_for_thread again to keep waiting.' }),
	}
}

/**
 * Turns an ended agent turn into a `thread.turn_ended` event for every
 * matching subscription. Reads the thread only when someone is subscribed.
 */
export async function publishTurnEnded(
	deps: { amp: Amp; subscriptions: Subscriptions; now?: () => Date; sleep?: (ms: number) => Promise<void> },
	thread: ActiveThread,
): Promise<void> {
	const targets = deps.subscriptions.matching(TURN_ENDED, { thread_id: thread.id, project: thread.project })
	if (targets.length === 0) return

	const endedAt = (deps.now?.() ?? new Date()).toISOString()
	const detail = await settledThreadDetail(deps, thread.id)
	const message = truncateFinalMessage(detail.lastAssistantText)
	const data: TurnEndedPayload = {
		thread_id: thread.id,
		title: detail.title,
		url: detail.url,
		project: thread.project,
		agent_state: detail.agentState ?? 'idle',
		final_message: message.text,
		final_message_truncated: message.truncated,
	}
	// One ID per agent turn, so a watcher restart that re-reports the same turn produces a duplicate ChatGPT can drop.
	const turnKey = detail.agentStateMessageId ?? detail.updatedAt
	const eventId = `evt_${createHash('sha256').update(`${thread.id} ${turnKey}`).digest('hex').slice(0, 32)}`
	await deps.subscriptions.deliver(targets, { eventId, name: TURN_ENDED, timestamp: endedAt, data })
}
