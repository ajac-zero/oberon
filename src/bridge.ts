import { createHash } from 'node:crypto'
import type { OriginStore } from './origins.ts'
import type { TurnWait } from './activity.ts'
import { outcomeOfState, threadUrl, type ActiveThread, type Amp, type ThreadDetail } from './amp.ts'
import { TURN_ENDED, matchesOutcome, type Subscription, type Subscriptions, type TurnEndedPayload } from './events.ts'

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
	// 'ended': `amp top` is ahead of the export, so settle within what is left of the budget.
	// 'idle': usually one read, since a finished thread is already settled. But a thread started moments ago may not be
	// listed by `amp top` yet, so the watcher calls it idle while the export shows it running; settling covers that too.
	const detail = await settledThreadDetail(deps, id, timeoutMs - (Date.now() - startedAt))
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
	deps: { amp: Amp; subscriptions: Subscriptions; origins: OriginStore; now?: () => Date; sleep?: (ms: number) => Promise<void> },
	thread: ActiveThread,
	/** Catch-up delivery: only these subscriptions, stamped with when the turn actually ended. */
	only?: { subscriptionIds: ReadonlySet<string>; endedAt: Date },
): Promise<void> {
	const origin = deps.origins.originOf(thread.id)
	const candidates = deps.subscriptions
		.matching(TURN_ENDED, { thread_id: thread.id, project: thread.project, origin })
		.filter((s) => !only || only.subscriptionIds.has(s.id))
	if (candidates.length === 0) return

	const endedAt = (only?.endedAt ?? deps.now?.() ?? new Date()).toISOString()
	const detail = await settledThreadDetail(deps, thread.id)
	// Settling can time out in a state we don't recognize; report that as completed and keep the raw state in agent_state.
	const agentState = detail.agentState ?? 'idle'
	const outcome = outcomeOfState(agentState) ?? 'completed'
	const targets = candidates.filter((s) => matchesOutcome(s.arguments, outcome))
	if (targets.length === 0) return
	const message = truncateFinalMessage(detail.lastAssistantText)
	const data: TurnEndedPayload = {
		thread_id: thread.id,
		title: detail.title,
		url: detail.url,
		project: thread.project,
		origin,
		agent_state: agentState,
		outcome,
		final_message: message.text,
		final_message_truncated: message.truncated,
	}
	// One ID per agent turn, so a watcher restart that re-reports the same turn produces a duplicate ChatGPT can drop.
	const turnKey = detail.agentStateMessageId ?? detail.updatedAt
	const eventId = `evt_${createHash('sha256').update(`${thread.id} ${turnKey}`).digest('hex').slice(0, 32)}`
	await deps.subscriptions.deliver(targets, { eventId, name: TURN_ENDED, timestamp: endedAt, data })
}

/**
 * Turns that ended in the last few minutes. Events are not replayable, so a
 * `thread_id` subscription created right after `start_thread` (or while its
 * callback was still being verified) would otherwise miss a fast turn and wait forever.
 */
export class RecentTurns {
	readonly #turns = new Map<string, { thread: ActiveThread; endedAt: Date }>()
	readonly #windowMs: number
	readonly #now: () => Date

	constructor(options: { windowMs?: number; now?: () => Date } = {}) {
		this.#windowMs = options.windowMs ?? 2 * 60 * 1000
		this.#now = options.now ?? (() => new Date())
	}

	record(thread: ActiveThread): void {
		const now = this.#now()
		for (const [id, turn] of this.#turns) if (now.getTime() - turn.endedAt.getTime() > this.#windowMs) this.#turns.delete(id)
		this.#turns.set(thread.id, { thread, endedAt: now })
	}

	/** The thread's most recent turn end, if it was within the window. */
	recent(threadId: string): { thread: ActiveThread; endedAt: Date } | undefined {
		const turn = this.#turns.get(threadId)
		return turn && this.#now().getTime() - turn.endedAt.getTime() <= this.#windowMs ? turn : undefined
	}
}

/**
 * Delivers a just-missed turn to a new or refreshed subscription. Only `thread_id`
 * subscriptions catch up; a project- or origin-wide subscription would otherwise
 * receive unrelated turns that ended before it existed.
 */
export function catchUpSubscription(
	deps: Parameters<typeof publishTurnEnded>[0] & { recentTurns: RecentTurns },
	subscription: Subscription,
): Promise<void> {
	const threadId = subscription.arguments.thread_id
	const turn = threadId === undefined ? undefined : deps.recentTurns.recent(threadId)
	if (!turn) return Promise.resolve()
	return publishTurnEnded(deps, turn.thread, { subscriptionIds: new Set([subscription.id]), endedAt: turn.endedAt })
}
