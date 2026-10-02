import { createHash } from 'node:crypto'
import type { OriginStore } from './origins.ts'
import { outcomeOfState, type ActiveThread, type Amp } from './amp.ts'
import { TURN_ENDED, matchesOutcome, type Subscriptions, type TurnEndedPayload } from './events.ts'

const FINAL_MESSAGE_MAX = 16_000
/** `amp top` reports idle a moment before `amp threads export` reflects the finished turn. */
const SETTLE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

/**
 * Turns an ended agent turn into a `thread.turn_ended` event for every
 * matching subscription. Reads the thread only when someone is subscribed.
 */
export async function publishTurnEnded(
	deps: { amp: Amp; subscriptions: Subscriptions; origins: OriginStore; now?: () => Date; sleep?: (ms: number) => Promise<void> },
	thread: ActiveThread,
): Promise<void> {
	const origin = deps.origins.originOf(thread.id)
	const candidates = deps.subscriptions.matching(TURN_ENDED, { thread_id: thread.id, project: thread.project, origin })
	if (candidates.length === 0) return

	const endedAt = (deps.now?.() ?? new Date()).toISOString()
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	let detail = await deps.amp.threadDetail(thread.id)
	for (const delay of SETTLE_DELAYS_MS) {
		if (detail.settled) break
		await sleep(delay)
		detail = await deps.amp.threadDetail(thread.id)
	}
	// Settling can time out in a state we don't recognize; report that as completed and keep the raw state in agent_state.
	const agentState = detail.agentState ?? 'idle'
	const outcome = outcomeOfState(agentState) ?? 'completed'
	const targets = candidates.filter((s) => matchesOutcome(s.arguments, outcome))
	if (targets.length === 0) return
	const truncated = detail.lastAssistantText.length > FINAL_MESSAGE_MAX
	const data: TurnEndedPayload = {
		thread_id: thread.id,
		title: detail.title,
		url: detail.url,
		project: thread.project,
		origin,
		agent_state: agentState,
		outcome,
		final_message: truncated ? `${detail.lastAssistantText.slice(0, FINAL_MESSAGE_MAX)}…` : detail.lastAssistantText,
		final_message_truncated: truncated,
	}
	// One ID per agent turn, so a watcher restart that re-reports the same turn produces a duplicate ChatGPT can drop.
	const turnKey = detail.agentStateMessageId ?? detail.updatedAt
	const eventId = `evt_${createHash('sha256').update(`${thread.id} ${turnKey}`).digest('hex').slice(0, 32)}`
	await deps.subscriptions.deliver(targets, { eventId, name: TURN_ENDED, timestamp: endedAt, data })
}
