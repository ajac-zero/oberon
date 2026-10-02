import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Webhook } from 'standardwebhooks'
import { z } from 'zod'
import type { ActiveThread, Amp, Target } from '../src/amp.ts'
import { createApp } from '../src/app.ts'
import { publishTurnEnded } from '../src/bridge.ts'
import { Subscriptions, TURN_ENDED, type SubscriptionState } from '../src/events.ts'
import { createAuthServer, emptyOAuthState, type OAuthState } from '../src/oauth.ts'
import { JsonFile } from '../src/store.ts'
import type { WebhookRequest } from '../src/webhook.ts'

const PASSPHRASE = 'correct horse battery staple'
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const THREAD = 'T-01a0f696-61fc-74da-a09c-6725b91a38f8'

const started: { prompt: string; target: Target; mode?: string }[] = []
const fakeAmp: Amp = {
	searchThreads: async (query) => [{ id: THREAD, title: `match for ${query}`, url: `https://ampcode.com/threads/${THREAD}`, updatedAt: '' }],
	threadMarkdown: async () => '# Thread\n\n## User\n\nFix it\n\n## Assistant\n\nFixed.',
	threadDetail: async (id) => ({ id, title: 'Fix the bug', url: `https://ampcode.com/threads/${id}`, agentState: 'idle', agentStateMessageId: 'M-1', lastAssistantText: 'Fixed the bug and pushed.', settled: true, updatedAt: '2026-10-01T00:00:00Z' }),
	listProjects: async () => [{ ref: 'ajac-zero/amp-mcp', name: 'amp-mcp', repositoryURL: 'https://github.com/ajac-zero/amp-mcp' }],
	startThread: async (input) => {
		started.push(input)
		return { id: THREAD, url: `https://ampcode.com/threads/${THREAD}` }
	},
	sendMessage: async (id) => ({ id, url: `https://ampcode.com/threads/${id}` }),
}
const active: ActiveThread[] = [{ id: THREAD, title: 'Fix the bug', url: `https://ampcode.com/threads/${THREAD}`, project: 'amp-mcp', status: 'working', working: true, executorConnected: true, updatedAt: '' }]

const deliveries: WebhookRequest[] = []
const subscriptions = new Subscriptions({
	store: new JsonFile<SubscriptionState>(undefined, { subscriptions: {}, verifiedCallbacks: {} }),
	send: async (req) => {
		deliveries.push(req)
		const body = JSON.parse(req.body)
		return body.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 202, body: '' }
	},
})

let server: Server
let base: string

before(async () => {
	server = createServer()
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	const auth = createAuthServer({ publicUrl: new URL(base), passphrase: PASSPHRASE, store: new JsonFile<OAuthState>(undefined, emptyOAuthState()) })
	server.on('request', createApp({ auth, amp: fakeAmp, activeThreads: () => active, subscriptions, log: () => {} }))
})
after(() => server.close())

const form = (values: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString(), redirect: 'manual' as const })

async function register(redirectUris = [REDIRECT]) {
	return fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: redirectUris }) })
}

function pkce() {
	const verifier = randomBytes(32).toString('base64url')
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function authorize(clientId: string, challenge: string, passphrase: string) {
	const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${base}/mcp`, scope: 'amp' })
	return fetch(`${base}/oauth/authorize`, form({ query: query.toString(), passphrase, decision: 'approve' }))
}

async function login() {
	const { client_id } = (await (await register()).json()) as { client_id: string }
	const { verifier, challenge } = pkce()
	const code = new URL((await authorize(client_id, challenge, PASSPHRASE)).headers.get('location')!).searchParams.get('code')!
	const res = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier, resource: `${base}/mcp` }))
	return { client_id, tokens: (await res.json()) as { access_token: string; refresh_token: string } }
}

test('discovery documents point ChatGPT at the Oberon authorization server', async () => {
	const unauthenticated = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
	assert.equal(unauthenticated.status, 401)
	const challenge = unauthenticated.headers.get('www-authenticate')!
	const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
	assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/mcp`)

	const prm = (await (await fetch(metadataUrl!)).json()) as { resource: string; authorization_servers: string[] }
	assert.equal(prm.resource, `${base}/mcp`)
	assert.deepEqual(prm.authorization_servers, [base])
	const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
	assert.equal(as.issuer, base)
	assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
	// Not advertised: Codex ≤ 0.146 drops `iss` and rejects servers that advertise it. `iss` is still sent (checked below).
	assert.equal(as.authorization_response_iss_parameter_supported, undefined)
})

test('OAuth: registration, passphrase consent, PKCE, single-use codes, refresh rotation', async () => {
	assert.equal((await register(['http://evil.example.com/cb'])).status, 400)
	const { client_id } = (await (await register()).json()) as { client_id: string }

	// Missing PKCE is reported back to the client, with the issuer.
	const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' })
	const noPkceLocation = new URL(noPkce.headers.get('location')!)
	assert.equal(noPkceLocation.searchParams.get('error'), 'invalid_request')
	assert.equal(noPkceLocation.searchParams.get('iss'), base)

	// An unregistered redirect URI is never redirected to.
	const badRedirect = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://attacker.example/cb' })}`, { redirect: 'manual' })
	assert.equal(badRedirect.status, 400)
	assert.equal(badRedirect.headers.get('location'), null)

	const { verifier, challenge } = pkce()
	const consent = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })}`)
	assert.equal(consent.status, 200)
	assert.match(await consent.text(), /Oberon passphrase/)

	const wrong = await authorize(client_id, challenge, 'not the passphrase')
	assert.equal(wrong.status, 401)
	assert.equal(wrong.headers.get('location'), null)

	const approved = new URL((await authorize(client_id, challenge, PASSPHRASE)).headers.get('location')!)
	assert.equal(approved.origin + approved.pathname, REDIRECT)
	assert.equal(approved.searchParams.get('state'), 'st8')
	assert.equal(approved.searchParams.get('iss'), base)
	const code = approved.searchParams.get('code')!

	const exchange = (c: string, v: string) => fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code: c, redirect_uri: REDIRECT, client_id, code_verifier: v }))
	assert.equal((await exchange(code, pkce().verifier)).status, 400, 'wrong verifier')
	assert.equal((await exchange(code, verifier)).status, 400, 'code was consumed by the failed attempt')

	const second = pkce()
	const code2 = new URL((await authorize(client_id, second.challenge, PASSPHRASE)).headers.get('location')!).searchParams.get('code')!
	const tokens = (await (await exchange(code2, second.verifier)).json()) as { access_token: string; refresh_token: string; token_type: string }
	assert.equal(tokens.token_type, 'Bearer')

	const refresh = (rt: string) => fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: rt, client_id }))
	const rotated = await refresh(tokens.refresh_token)
	assert.equal(rotated.status, 200)
	assert.equal((await refresh(tokens.refresh_token)).status, 400, 'refresh tokens rotate')
})

test('MCP 2026-07-28: discover advertises events; tools and event subscription work end to end', async () => {
	const { tokens } = await login()
	const headers = { authorization: `Bearer ${tokens.access_token}` }

	// Raw discover, as ChatGPT sends it: the client SDK's schema strips unknown capabilities.
	const raw = await fetch(`${base}/mcp`, {
		method: 'POST',
		headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: '1' } } } }),
	})
	const discovered = (await raw.json()) as { result: { capabilities: Record<string, unknown>; supportedVersions: string[]; instructions: string } }
	assert.deepEqual(discovered.result.supportedVersions, ['2026-07-28'])
	assert.deepEqual(discovered.result.capabilities.events, {})
	assert.match(discovered.result.instructions, /thread\.turn_ended/)

	const client = new Client({ name: 'test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never)
	await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }))

	const { tools } = await client.listTools()
	assert.deepEqual(tools.map((t) => t.name).sort(), ['fetch', 'list_active_threads', 'list_projects', 'search', 'send_message', 'start_thread'])
	assert.equal(tools.find((t) => t.name === 'start_thread')!.annotations?.readOnlyHint, false)
	assert.equal(tools.find((t) => t.name === 'search')!.annotations?.readOnlyHint, true)

	const fetched = await client.callTool({ name: 'fetch', arguments: { id: `https://ampcode.com/threads/${THREAD}` } })
	assert.equal((fetched.structuredContent as { id: string }).id, THREAD)
	assert.equal((fetched.structuredContent as { metadata: { agent_state: string; project: string } }).metadata.agent_state, 'working')

	const ambiguous = await client.callTool({ name: 'start_thread', arguments: { prompt: 'x', project: 'a/b', runner_id: 'r' } })
	assert.equal(ambiguous.isError, true)
	assert.equal(started.length, 0)
	const ok = await client.callTool({ name: 'start_thread', arguments: { prompt: 'Fix the flaky test', runner_id: 'villahermosa', runner_dir: '/home/coder/amp-mcp', mode: 'low' } })
	assert.deepEqual(started.at(-1), { prompt: 'Fix the flaky test', target: { kind: 'runner', runnerId: 'villahermosa', runnerDir: '/home/coder/amp-mcp' }, mode: 'low', title: undefined })
	assert.equal((ok.structuredContent as { thread_id: string }).thread_id, THREAD)

	const { events } = await client.request({ method: 'events/list', params: {} } as never, z.object({ events: z.array(z.object({ name: z.string(), payloadSchema: z.unknown() })) }))
	assert.deepEqual(events.map((e) => e.name), [TURN_ENDED])

	const secret = `whsec_${randomBytes(32).toString('base64')}`
	const sub = await client.request(
		{ method: 'events/subscribe', params: { name: TURN_ENDED, arguments: { thread_id: THREAD }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/cb_1', secret }, cursor: null } } as never,
		z.object({ id: z.string(), refreshBefore: z.string(), cursor: z.null(), truncated: z.boolean() }),
	)
	assert.match(sub.id, /^sub_/)
	const badSecret = client.request({ method: 'events/subscribe', params: { name: TURN_ENDED, arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example.com/cb_1', secret: 'whsec_c2hvcnQ=' } } } as never, z.unknown())
	await assert.rejects(badSecret, /24–64 bytes/)

	// A turn ends in a thread that does not match the filter: nothing is delivered.
	const before = deliveries.length
	await publishTurnEnded({ amp: fakeAmp, subscriptions }, { ...active[0]!, id: 'T-00000000-0000-0000-0000-000000000000', working: false })
	assert.equal(deliveries.length, before)

	await publishTurnEnded({ amp: fakeAmp, subscriptions, now: () => new Date('2026-10-01T12:05:00Z') }, { ...active[0]!, working: false })
	const delivered = deliveries.at(-1)!
	assert.equal(delivered.headers['x-mcp-subscription-id'], sub.id)
	assert.doesNotThrow(() => new Webhook(secret).verify(delivered.body, delivered.headers))
	const event = JSON.parse(delivered.body)
	assert.equal(event.name, TURN_ENDED)
	assert.equal(event.eventId, delivered.headers['webhook-id'])
	assert.equal(event.timestamp, '2026-10-01T12:05:00.000Z')
	assert.deepEqual(event.data, { thread_id: THREAD, title: 'Fix the bug', url: `https://ampcode.com/threads/${THREAD}`, project: 'amp-mcp', agent_state: 'idle', final_message: 'Fixed the bug and pushed.', final_message_truncated: false })

	await client.request({ method: 'events/unsubscribe', params: { name: TURN_ENDED, arguments: { thread_id: THREAD }, delivery: { mode: 'webhook', url: 'https://receiver.example.com/cb_1' } } } as never, z.object({}))
	assert.deepEqual(subscriptions.matching(TURN_ENDED, { thread_id: THREAD, project: 'amp-mcp' }), [])
	await client.close()
})
