import express, { type Express } from 'express'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { TurnWait } from './activity.ts'
import type { ActiveThread, Amp } from './amp.ts'
import type { Subscriptions } from './events.ts'
import { createMcpServer } from './mcp.ts'
import type { AuthServer } from './oauth.ts'

/** Oberon's HTTP surface: OAuth discovery and endpoints, plus the bearer-protected MCP endpoint at /mcp. */
export function createApp(deps: { auth: AuthServer; amp: Amp; activeThreads: () => ActiveThread[]; subscriptions: Subscriptions; waitForTurnEnd?: (id: string, timeoutMs: number) => Promise<TurnWait>; log: (message: string) => void }): Express {
	const { auth } = deps
	const resourceUrl = new URL(auth.resource)
	const app = express()
	app.disable('x-powered-by')
	app.set('trust proxy', true)

	app.get('/healthz', (_req, res) => void res.json({ ok: true }))
	app.use(
		mcpAuthMetadataRouter({
			oauthMetadata: auth.metadata,
			resourceServerUrl: resourceUrl,
			scopesSupported: auth.metadata.scopes_supported,
			resourceName: 'Amp',
			dangerouslyAllowInsecureIssuerUrl: resourceUrl.protocol === 'http:',
		} as Parameters<typeof mcpAuthMetadataRouter>[0]),
	)
	app.use(auth.router)

	const mcp = createMcpHandler(
		(ctx) => {
			const principal = ctx.authInfo?.extra?.principal
			if (typeof principal !== 'string') throw new Error('Unauthenticated MCP request reached the server factory')
			return createMcpServer({ amp: deps.amp, activeThreads: deps.activeThreads, subscriptions: deps.subscriptions, principal, waitForTurnEnd: deps.waitForTurnEnd, log: deps.log })
		},
		{ onerror: (error) => deps.log(`mcp: ${error.message}`) },
	)
	const mcpNode = toNodeHandler(mcp, { onerror: (error) => deps.log(`mcp adapter: ${error.message}`) })
	app.all(
		'/mcp',
		(req, res, next) => {
			// One line per MCP HTTP request, so a client that connects but never calls tools (or keeps getting 401) is visible.
			res.on('finish', () => {
				const client = req.auth ? `client ${req.auth.clientId.slice(-6)}` : req.headers.authorization ? 'rejected token' : 'no token'
				const messages = (Array.isArray(req.body) ? req.body : [req.body]) as ({ method?: string; params?: { name?: string } } | undefined)[]
				const method =
					messages
						.filter((m) => m?.method)
						.map((m) => (m!.method === 'tools/call' ? `tools/call:${m!.params?.name}` : m!.method))
						.join(',') || '-'
				deps.log(`http: ${req.method} /mcp ${res.statusCode} ${method} ${client} ua="${String(req.headers['user-agent'] ?? '').slice(0, 60)}"`)
			})
			next()
		},
		requireBearerAuth({ verifier: auth.verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) }),
		// Parse the body here (and hand it to the adapter) so the request log can name the JSON-RPC method.
		express.json({ limit: '4mb' }),
		(req, res) => void mcpNode(req, res, req.body),
	)
	return app
}
