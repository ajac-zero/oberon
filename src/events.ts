import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ProtocolError } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { OUTCOMES, type Outcome } from './amp.ts'
import type { JsonFile } from './store.ts'
import { MAX_EVENT_BYTES, signedHeaders, type SendWebhook } from './webhook.ts'

// ── Event catalog ────────────────────────────────────────────────────────────

export const TURN_ENDED = 'thread.turn_ended'

export const TurnEndedArguments = z.strictObject({
	thread_id: z.string().describe('Only notify for this Amp thread ID (T-…). Omit to watch every thread.').optional(),
	project: z.string().describe('Only notify for threads in this project, by the name list_active_threads shows. Omit for all projects.').optional(),
	origin: z
		.enum(['oberon', 'any'])
		.describe('"oberon": only threads started through this server\'s start_thread tool (the default recommendation when following up on work you started). "any" (default): every thread, including ones the user chats with directly in Amp.')
		.optional(),
	outcomes: z
		.array(z.enum(OUTCOMES))
		.min(1)
		.describe('Only notify for these outcomes: completed (agent idle), error, cancelled, needs_approval (agent waiting for approval). Omit for all outcomes.')
		.optional(),
})
export type TurnEndedArguments = z.infer<typeof TurnEndedArguments>

export const TurnEndedPayload = z.strictObject({
	thread_id: z.string(),
	title: z.string(),
	url: z.string(),
	project: z.string(),
	origin: z.enum(['oberon', 'other']).describe('"oberon" if the thread was started through start_thread, otherwise "other".'),
	agent_state: z.string().describe('Raw Amp agent state after the turn, e.g. idle or error. Prefer outcome.'),
	outcome: z.enum(OUTCOMES).describe('How the turn ended: completed, error, cancelled, or needs_approval. Unrecognized agent states are reported as completed.'),
	final_message: z.string().describe("The agent's last text message, possibly truncated. Call fetch for the full thread."),
	final_message_truncated: z.boolean(),
})
export type TurnEndedPayload = z.infer<typeof TurnEndedPayload>

const jsonSchema = (schema: z.ZodType) => {
	const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
	return rest
}

export const EVENT_DEFINITIONS = [
	{
		name: TURN_ENDED,
		description:
			'An Amp agent finished its turn in a thread: it completed the task, stopped to ask for input, or hit an error. Use this to follow up when Amp work started with start_thread or send_message is done.',
		delivery: ['webhook'],
		inputSchema: jsonSchema(TurnEndedArguments),
		payloadSchema: jsonSchema(TurnEndedPayload),
	},
]

/** What a turn-ended event is matched against before the bridge fetches its payload. */
export type TurnEndedFacts = { thread_id: string; project: string; origin: 'oberon' | 'other' }

export function matchesTurnEnded(args: TurnEndedArguments, facts: TurnEndedFacts): boolean {
	return (
		(args.thread_id === undefined || args.thread_id === facts.thread_id) &&
		(args.project === undefined || args.project === facts.project) &&
		(args.origin !== 'oberon' || facts.origin === 'oberon')
	)
}

/** The outcome is only known after the thread export settles, so it is matched separately from the other filters. */
export function matchesOutcome(args: TurnEndedArguments, outcome: Outcome): boolean {
	return args.outcomes === undefined || args.outcomes.includes(outcome)
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export const SubscribeParams = z.looseObject({
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).default({}),
	delivery: z.looseObject({ mode: z.string(), url: z.string(), secret: z.string() }),
	cursor: z.string().nullable().optional(),
	ttlMs: z.number().int().positive().nullable().optional(),
})
export const UnsubscribeParams = z.looseObject({
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).default({}),
	delivery: z.looseObject({ mode: z.string(), url: z.string() }),
})
export const ListEventsParams = z.looseObject({ cursor: z.string().optional() })

export type Subscription = {
	id: string
	principal: string
	name: string
	arguments: TurnEndedArguments
	url: string
	/** Signing secrets, newest first. Older ones are kept only until `rotationEndsAt`. */
	secrets: string[]
	rotationEndsAt: number | null
	expiresAt: number
}

export type SubscriptionState = {
	subscriptions: Record<string, Subscription>
	/** `${principal} ${url}` → ms timestamp of the last successful callback verification. */
	verifiedCallbacks: Record<string, number>
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MIN_TTL_MS = 60 * 60 * 1000
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const VERIFICATION_CACHE_MS = 24 * 60 * 60 * 1000
const ROTATION_WINDOW_MS = 60 * 60 * 1000
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000]

/** JSON-RPC error codes from the MCP Events draft. */
export const CALLBACK_ENDPOINT_ERROR = -32015
const INVALID_PARAMS = -32602

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` identify the same subscription. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
		return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

export function subscriptionId(principal: string, url: string, name: string, args: unknown): string {
	const digest = createHash('sha256').update(canonicalJson([principal, url, name, args])).digest('hex')
	return `sub_${digest.slice(0, 32)}`
}

function validateSecret(secret: string): void {
	const decoded = secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.alloc(0)
	if (decoded.length < 24 || decoded.length > 64) {
		throw new ProtocolError(INVALID_PARAMS, 'delivery.secret must be a whsec_ secret whose base64 value decodes to 24–64 bytes')
	}
}

function parseEventArguments(name: string, args: unknown): TurnEndedArguments {
	if (name !== TURN_ENDED) throw new ProtocolError(INVALID_PARAMS, `Unknown event: ${name}`)
	const parsed = TurnEndedArguments.safeParse(args)
	if (!parsed.success) throw new ProtocolError(INVALID_PARAMS, `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`)
	// Normalize so equivalent filters share one subscription ID: "any" is the default, and outcome order is irrelevant.
	const { origin, outcomes, ...rest } = parsed.data
	return {
		...rest,
		...(origin === 'oberon' ? { origin } : {}),
		...(outcomes ? { outcomes: OUTCOMES.filter((o) => outcomes.includes(o)) } : {}),
	}
}

function grantedTtl(requested: number | null | undefined): number {
	if (requested === undefined || requested === null) return requested === null ? MAX_TTL_MS : DEFAULT_TTL_MS
	return Math.min(Math.max(requested, MIN_TTL_MS), MAX_TTL_MS)
}

export class Subscriptions {
	readonly #store: JsonFile<SubscriptionState>
	readonly #send: SendWebhook
	readonly #now: () => number
	readonly #sleep: (ms: number) => Promise<void>
	readonly #log: (message: string) => void
	readonly #onSubscribed: (subscription: Subscription) => void

	constructor(options: {
		store: JsonFile<SubscriptionState>
		send: SendWebhook
		now?: () => number
		sleep?: (ms: number) => Promise<void>
		log?: (message: string) => void
		/** Called after a subscription is created or refreshed, e.g. to deliver a turn that ended moments before. */
		onSubscribed?: (subscription: Subscription) => void
	}) {
		this.#store = options.store
		this.#send = options.send
		this.#now = options.now ?? Date.now
		this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
		this.#log = options.log ?? (() => {})
		this.#onSubscribed = options.onSubscribed ?? (() => {})
	}

	async subscribe(principal: string, raw: unknown) {
		const params = SubscribeParams.parse(raw)
		const args = parseEventArguments(params.name, params.arguments)
		if (params.delivery.mode !== 'webhook') throw new ProtocolError(INVALID_PARAMS, 'Only webhook delivery is supported')
		validateSecret(params.delivery.secret)
		let url: URL
		try {
			url = new URL(params.delivery.url)
		} catch {
			throw new ProtocolError(INVALID_PARAMS, 'delivery.url is not a valid URL')
		}
		if (url.protocol !== 'https:') throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'Callback URL must use https', { reason: 'invalid_url' })

		const id = subscriptionId(principal, url.href, params.name, args)
		await this.#verifyCallback(principal, url.href, id, params.delivery.secret)

		const now = this.#now()
		const existing = this.#store.value.subscriptions[id]
		const rotating = existing && existing.secrets[0] !== params.delivery.secret
		const expiresAt = now + grantedTtl(params.ttlMs)
		this.#store.update((state) => {
			state.subscriptions[id] = {
				id,
				principal,
				name: params.name,
				arguments: args,
				url: url.href,
				secrets: rotating ? [params.delivery.secret, existing.secrets[0]!] : existing ? existing.secrets : [params.delivery.secret],
				rotationEndsAt: rotating ? now + ROTATION_WINDOW_MS : (existing?.rotationEndsAt ?? null),
				expiresAt,
			}
		})
		this.#onSubscribed(this.#store.value.subscriptions[id]!)
		return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false }
	}

	unsubscribe(principal: string, raw: unknown) {
		const params = UnsubscribeParams.parse(raw)
		const args = parseEventArguments(params.name, params.arguments)
		const id = subscriptionId(principal, new URL(params.delivery.url).href, params.name, args)
		if (this.#store.value.subscriptions[id]) this.#store.update((state) => void delete state.subscriptions[id])
		return {}
	}

	/** Active subscriptions to `name` whose filters accept `facts`. */
	matching(name: string, facts: TurnEndedFacts): Subscription[] {
		const now = this.#now()
		return Object.values(this.#store.value.subscriptions).filter((s) => s.name === name && s.expiresAt > now && matchesTurnEnded(s.arguments, facts))
	}

	/** Delivers one event to each subscription, retrying transient failures. Resolves when every delivery settles. */
	async deliver(subscriptions: Subscription[], event: { eventId: string; name: string; timestamp: string; data: unknown }): Promise<void> {
		const body = JSON.stringify({ ...event, cursor: null })
		if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw new Error(`Event ${event.eventId} exceeds 256 KiB`)
		await Promise.all(subscriptions.map((s) => this.#deliverOne(s.id, event.eventId, body)))
	}

	async #deliverOne(subscriptionId: string, eventId: string, body: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			// Re-read each attempt: the subscription may have been refreshed, rotated, or removed meanwhile.
			const sub = this.#store.value.subscriptions[subscriptionId]
			if (!sub || sub.expiresAt <= this.#now()) return
			let outcome: string
			try {
				const res = await this.#send({ url: sub.url, body, headers: signedHeaders({ secrets: this.#activeSecrets(sub), messageId: eventId, body, subscriptionId, now: new Date(this.#now()) }) })
				if (res.status >= 200 && res.status < 300) {
					this.#log(`subscription ${subscriptionId}: delivered event ${eventId} (HTTP ${res.status}, attempt ${attempt + 1})`)
					return
				}
				if (res.status === 410) {
					this.#log(`subscription ${subscriptionId}: callback returned 410, removing`)
					this.#store.update((state) => void delete state.subscriptions[subscriptionId])
					return
				}
				if (res.status === 413 || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
					this.#log(`subscription ${subscriptionId}: event ${eventId} rejected with ${res.status}, not retrying`)
					return
				}
				outcome = `HTTP ${res.status}`
			} catch (error) {
				outcome = (error as Error).message
			}
			if (attempt >= RETRY_DELAYS_MS.length) {
				this.#log(`subscription ${subscriptionId}: giving up on event ${eventId} after ${attempt + 1} attempts (${outcome})`)
				return
			}
			await this.#sleep(RETRY_DELAYS_MS[attempt]!)
		}
	}

	#activeSecrets(sub: Subscription): string[] {
		return sub.rotationEndsAt !== null && sub.rotationEndsAt > this.#now() ? sub.secrets : sub.secrets.slice(0, 1)
	}

	async #verifyCallback(principal: string, url: string, subscriptionId: string, secret: string): Promise<void> {
		const cacheKey = `${principal} ${url}`
		const verifiedAt = this.#store.value.verifiedCallbacks[cacheKey]
		if (verifiedAt !== undefined && this.#now() - verifiedAt < VERIFICATION_CACHE_MS) return

		const challenge = randomBytes(24).toString('base64url')
		const body = JSON.stringify({ type: 'verification', challenge })
		const messageId = `msg_verification_${randomBytes(12).toString('hex')}`
		let res
		try {
			res = await this.#send({ url, body, headers: signedHeaders({ secrets: [secret], messageId, body, subscriptionId, now: new Date(this.#now()) }) })
		} catch (error) {
			const reason = /timed out/i.test((error as Error).message) ? 'timeout' : 'unreachable'
			throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, `Callback verification failed: ${(error as Error).message}`, { reason })
		}
		if (res.status < 200 || res.status >= 300) {
			throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, `Callback verification returned HTTP ${res.status}`, { reason: 'http_error' })
		}
		let echoed: unknown
		try {
			echoed = (JSON.parse(res.body) as { challenge?: unknown }).challenge
		} catch {
			echoed = undefined
		}
		const expected = Buffer.from(challenge)
		const actual = Buffer.from(typeof echoed === 'string' ? echoed : '')
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'Callback did not echo the verification challenge', { reason: 'challenge_failed' })
		}
		this.#store.update((state) => void (state.verifiedCallbacks[cacheKey] = this.#now()))
	}
}
