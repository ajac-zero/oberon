import { createHash } from 'node:crypto'
import type { ActiveThread, Amp } from './amp.ts'
import { TURN_ENDED, type Subscriptions, type TurnEndedPayload } from './events.ts'

const FINAL_MESSAGE_MAX = 16_000
/** `amp top` reports idle a moment before `amp threads export` reflects the finished turn. */
const SETTLE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

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
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	let detail = await deps.amp.threadDetail(thread.id)
	for (const delay of SETTLE_DELAYS_MS) {
		if (detail.settled) break
		await sleep(delay)
		detail = await deps.amp.threadDetail(thread.id)
	}
	const truncated = detail.lastAssistantText.length > FINAL_MESSAGE_MAX
	const data: TurnEndedPayload = {
		thread_id: thread.id,
		title: detail.title,
		url: detail.url,
		project: thread.project,
		agent_state: detail.agentState ?? 'idle',
		final_message: truncated ? `${detail.lastAssistantText.slice(0, FINAL_MESSAGE_MAX)}…` : detail.lastAssistantText,
		final_message_truncated: truncated,
	}
	// One ID per agent turn, so a watcher restart that re-reports the same turn produces a duplicate ChatGPT can drop.
	const turnKey = detail.agentStateMessageId ?? detail.updatedAt
	const eventId = `evt_${createHash('sha256').update(`${thread.id} ${turnKey}`).digest('hex').slice(0, 32)}`
	await deps.subscriptions.deliver(targets, { eventId, name: TURN_ENDED, timestamp: endedAt, data })
}
