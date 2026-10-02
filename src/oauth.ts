import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import express, { type Response, type Router } from 'express'
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server'
import type { JsonFile } from './store.ts'

/**
 * A minimal single-user OAuth 2.1 authorization server for Oberon.
 *
 * Oberon has exactly one owner: whoever knows the passphrase. ChatGPT
 * registers itself with dynamic client registration, sends the owner to the
 * consent page, and exchanges the code with PKCE (S256). Only SHA-256 hashes
 * of codes and tokens are stored.
 */

export const SCOPE = 'amp'
const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TTL_MS = 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_CLIENTS = 100
const MAX_FAILED_ATTEMPTS = 10
const LOCKOUT_MS = 15 * 60 * 1000

type Grant = { clientId: string; scope: string; resource: string; expiresAt: number }
export type OAuthState = {
	clients: Record<string, { clientName: string; redirectUris: string[]; createdAt: number }>
	codes: Record<string, Grant & { redirectUri: string; codeChallenge: string }>
	accessTokens: Record<string, Grant>
	refreshTokens: Record<string, Grant>
}
export const emptyOAuthState = (): OAuthState => ({ clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} })

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

export type AuthServer = {
	issuer: string
	/** The resource identifier tokens are bound to: the public /mcp URL. */
	resource: string
	metadata: OAuthMetadata
	router: Router
	verifier: OAuthTokenVerifier
}

export function createAuthServer(options: { publicUrl: URL; passphrase: string; store: JsonFile<OAuthState>; now?: () => number; log?: (message: string) => void }): AuthServer {
	const { store } = options
	const log = options.log ?? (() => {})
	const clientLabel = (clientId: string) => `${store.value.clients[clientId]?.clientName ?? 'unknown'} (${clientId.slice(-6)})`
	const now = options.now ?? Date.now
	const issuer = options.publicUrl.origin
	const resource = new URL('/mcp', issuer).href
	const passphraseHash = Buffer.from(sha256(options.passphrase), 'hex')
	const failures: number[] = []

	const metadata: OAuthMetadata = {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		registration_endpoint: `${issuer}/oauth/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [SCOPE],
		// Every redirect carries RFC 9207 `iss`, but we don't advertise
		// `authorization_response_iss_parameter_supported`: when it is advertised, rmcp
		// requires `iss`, and Codex ≤ 0.146 drops it before validation, so sign-in fails.
	} as OAuthMetadata

	const sameResource = (requested: string | undefined) => requested === undefined || requested.replace(/\/$/, '') === resource.replace(/\/$/, '')

	const purgeExpired = (state: OAuthState) => {
		const t = now()
		for (const table of [state.codes, state.accessTokens, state.refreshTokens]) {
			for (const [key, grant] of Object.entries(table)) if (grant.expiresAt <= t) delete table[key]
		}
	}

	const issueTokens = (grant: Omit<Grant, 'expiresAt'>, state: OAuthState) => {
		const access = token('amb_at')
		const refresh = token('amb_rt')
		state.accessTokens[sha256(access)] = { ...grant, expiresAt: now() + ACCESS_TTL_MS }
		state.refreshTokens[sha256(refresh)] = { ...grant, expiresAt: now() + REFRESH_TTL_MS }
		return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: grant.scope }
	}

	const router = express.Router()

	// ── Dynamic client registration (RFC 7591) ──
	router.post('/oauth/register', express.json({ limit: '32kb' }), (req, res) => {
		const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown }
		const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
		if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
			return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs (or http://localhost)' })
		}
		if (Object.keys(store.value.clients).length >= MAX_CLIENTS) {
			return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Too many registered clients' })
		}
		const clientId = `amb_client_${randomBytes(16).toString('hex')}`
		const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Unnamed client'
		store.update((state) => void (state.clients[clientId] = { clientName, redirectUris, createdAt: now() }))
		log(`oauth: registered client ${clientLabel(clientId)} redirecting to ${redirectUris.map((u) => new URL(u).host).join(', ')}`)
		res.status(201).json({
			client_id: clientId,
			client_id_issued_at: Math.floor(now() / 1000),
			client_name: clientName,
			redirect_uris: redirectUris,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		})
	})

	// ── Authorization endpoint ──
	const readAuthorizeParams = (source: Record<string, unknown>) => {
		const get = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : undefined)
		const clientId = get('client_id')
		const redirectUri = get('redirect_uri')
		const client = clientId ? store.value.clients[clientId] : undefined
		// Without a trusted redirect URI we must not redirect, so these errors render instead.
		if (!client || !clientId) return { fatal: 'Unknown client. Reconnect the app from ChatGPT.' } as const
		if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { fatal: 'The redirect URI is not registered for this client.' } as const
		const params = {
			clientId,
			clientName: client.clientName,
			redirectUri,
			state: get('state'),
			codeChallenge: get('code_challenge') ?? '',
			resource: get('resource'),
		}
		if (get('response_type') !== 'code') return { params, error: 'unsupported_response_type' } as const
		if (get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
			return { params, error: 'invalid_request', description: 'PKCE with S256 is required' } as const
		}
		if (!sameResource(params.resource)) return { params, error: 'invalid_target', description: `resource must be ${resource}` } as const
		return { params } as const
	}

	const redirectWith = (res: Response, redirectUri: string, values: Record<string, string | undefined>) => {
		const url = new URL(redirectUri)
		for (const [key, value] of Object.entries({ ...values, iss: issuer })) if (value !== undefined) url.searchParams.set(key, value)
		res.redirect(302, url.href)
	}

	router.get('/oauth/authorize', (req, res) => {
		const parsed = readAuthorizeParams(req.query as Record<string, unknown>)
		if (parsed.fatal !== undefined) return renderPage(res, 400, errorPage(parsed.fatal))
		if (parsed.error) return redirectWith(res, parsed.params.redirectUri, { error: parsed.error, error_description: parsed.description, state: parsed.params.state })
		renderPage(res, 200, consentPage({ query: new URLSearchParams(req.query as Record<string, string>).toString(), clientName: parsed.params.clientName, redirectHost: new URL(parsed.params.redirectUri).host }), parsed.params.redirectUri)
	})

	router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
		const query = new URLSearchParams(typeof req.body?.query === 'string' ? req.body.query : '')
		const parsed = readAuthorizeParams(Object.fromEntries(query))
		if (parsed.fatal !== undefined) return renderPage(res, 400, errorPage(parsed.fatal))
		const { params } = parsed
		if (parsed.error) return redirectWith(res, params.redirectUri, { error: parsed.error, error_description: parsed.description, state: params.state })
		if (req.body?.decision !== 'approve') {
			log(`oauth: consent denied for ${clientLabel(params.clientId)}`)
			return redirectWith(res, params.redirectUri, { error: 'access_denied', state: params.state })
		}

		while (failures.length && failures[0]! < now() - LOCKOUT_MS) failures.shift()
		if (failures.length >= MAX_FAILED_ATTEMPTS) {
			log(`oauth: consent locked out after ${failures.length} wrong passphrases`)
			return renderPage(res, 429, consentPage({ query: query.toString(), clientName: params.clientName, redirectHost: new URL(params.redirectUri).host, error: 'Too many failed attempts. Try again in 15 minutes.' }), params.redirectUri)
		}
		const given = Buffer.from(sha256(typeof req.body?.passphrase === 'string' ? req.body.passphrase : ''), 'hex')
		if (!timingSafeEqual(given, passphraseHash)) {
			failures.push(now())
			log(`oauth: wrong passphrase for ${clientLabel(params.clientId)}`)
			return renderPage(res, 401, consentPage({ query: query.toString(), clientName: params.clientName, redirectHost: new URL(params.redirectUri).host, error: 'Wrong passphrase.' }), params.redirectUri)
		}

		const code = token('amb_code')
		store.update((state) => {
			purgeExpired(state)
			state.codes[sha256(code)] = {
				clientId: params.clientId,
				redirectUri: params.redirectUri,
				codeChallenge: params.codeChallenge,
				scope: SCOPE,
				resource,
				expiresAt: now() + CODE_TTL_MS,
			}
		})
		log(`oauth: consent approved for ${clientLabel(params.clientId)}`)
		redirectWith(res, params.redirectUri, { code, state: params.state })
	})

	// ── Token endpoint ──
	router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
		res.setHeader('cache-control', 'no-store')
		const body = (req.body ?? {}) as Record<string, string | undefined>
		const fail = (status: number, error: string, description: string) => {
			log(`oauth: token ${body.grant_type ?? '?'} rejected for ${body.client_id ? clientLabel(body.client_id) : 'no client'}: ${error} (${description})`)
			return res.status(status).json({ error, error_description: description })
		}
		if (!body.client_id || !store.value.clients[body.client_id]) return fail(401, 'invalid_client', 'Unknown client_id')
		if (!sameResource(body.resource)) return fail(400, 'invalid_target', `resource must be ${resource}`)

		if (body.grant_type === 'authorization_code') {
			const key = sha256(body.code ?? '')
			const grant = store.value.codes[key]
			// Codes are single use: delete before checking anything else.
			if (grant) store.update((state) => void delete state.codes[key])
			if (!grant || grant.expiresAt <= now() || grant.clientId !== body.client_id) return fail(400, 'invalid_grant', 'Invalid or expired code')
			if (grant.redirectUri !== body.redirect_uri) return fail(400, 'invalid_grant', 'redirect_uri does not match')
			const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
			if (!body.code_verifier || challenge !== grant.codeChallenge) return fail(400, 'invalid_grant', 'PKCE verification failed')
			let tokens
			store.update((state) => void (tokens = issueTokens({ clientId: grant.clientId, scope: grant.scope, resource: grant.resource }, state)))
			log(`oauth: issued tokens to ${clientLabel(body.client_id)} via ${body.grant_type}`)
			return res.json(tokens)
		}

		if (body.grant_type === 'refresh_token') {
			const key = sha256(body.refresh_token ?? '')
			const grant = store.value.refreshTokens[key]
			if (!grant || grant.expiresAt <= now() || grant.clientId !== body.client_id) return fail(400, 'invalid_grant', 'Invalid or expired refresh token')
			let tokens
			store.update((state) => {
				delete state.refreshTokens[key] // rotate
				purgeExpired(state)
				tokens = issueTokens({ clientId: grant.clientId, scope: grant.scope, resource: grant.resource }, state)
			})
			log(`oauth: issued tokens to ${clientLabel(body.client_id)} via ${body.grant_type}`)
			return res.json(tokens)
		}

		return fail(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
	})

	const verifier: OAuthTokenVerifier = {
		async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
			const grant = store.value.accessTokens[sha256(accessToken)]
			if (!grant || grant.expiresAt <= now()) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or expired access token')
			return {
				token: accessToken,
				clientId: grant.clientId,
				scopes: grant.scope.split(' '),
				expiresAt: Math.floor(grant.expiresAt / 1000),
				resource: new URL(grant.resource),
				extra: { principal: 'owner' },
			}
		},
	}

	return { issuer, resource, metadata, router, verifier }
}

function isAllowedRedirectUri(raw: string): boolean {
	try {
		const url = new URL(raw)
		if (url.hash) return false
		return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
	} catch {
		return false
	}
}

// ── Pages ────────────────────────────────────────────────────────────────────

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * `redirectUri` is the client's registered redirect. Browsers apply `form-action`
 * to the redirect that follows a form POST, so the consent form must allow it,
 * including Codex's loopback `http://127.0.0.1:<port>` callback.
 */
function renderPage(res: Response, status: number, html: string, redirectUri?: string) {
	const formAction = ["'self'", ...(redirectUri ? [new URL(redirectUri).origin] : [])].join(' ')
	res
		.status(status)
		.setHeader('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`)
		.setHeader('x-frame-options', 'DENY')
		.setHeader('cache-control', 'no-store')
		.type('html')
		.send(html)
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1b1b1a; --muted:#6b6b66; --line:#e3e3df; --accent:#1b1b1a; --accent-fg:#fff; --danger:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#111110; --card:#1b1b1a; --fg:#ededea; --muted:#a1a19b; --line:#45453f; --accent:#ededea; --accent-fg:#111110; --danger:#f97066; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
h1 { font-size:20px; line-height:1.3; margin:0 0 8px; text-wrap:balance; }
p { margin:0 0 16px; color:var(--muted); }
ul { margin:0 0 20px; padding-left:20px; color:var(--muted); }
li { margin:4px 0; }
strong { color:var(--fg); font-weight:600; }
label { display:block; font-weight:600; margin-bottom:6px; }
input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
input[type=password]:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.error { color:var(--danger); margin:8px 0 0; font-size:14px; }
.actions { display:flex; gap:8px; margin-top:20px; }
button { flex:1; padding:10px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; font-weight:600; cursor:pointer; }
button.primary { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
button.secondary { order:-1; }
.meta { font-size:13px; margin:16px 0 0; }
`

function consentPage(input: { query: string; clientName: string; redirectHost: string; error?: string }): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Amp</title><style>${STYLE}</style></head>
<body><main>
<h1>Connect ${escapeHtml(input.clientName)} to Amp</h1>
<p>This lets it act as you in Amp through Oberon:</p>
<ul>
<li>Read and search your Amp threads</li>
<li>Start agents in orbs and on your runners</li>
<li>Send messages to running threads</li>
<li>Get notified when an agent finishes</li>
</ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="query" value="${escapeHtml(input.query)}">
<label for="passphrase">Oberon passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''}
<div class="actions">
<!-- Allow comes first so pressing Enter (which submits the first button) approves; CSS shows Deny on the left. -->
<button type="submit" name="decision" value="approve" class="primary">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate class="secondary">Deny</button>
</div>
</form>
<p class="meta">You'll return to <strong>${escapeHtml(input.redirectHost)}</strong>. Served by Oberon.</p>
</main></body></html>`
}

function errorPage(message: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Amp</title><style>${STYLE}</style></head>
<body><main><h1>Can't connect</h1><p>${escapeHtml(message)}</p></main></body></html>`
}
