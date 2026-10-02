import express, { type Express } from 'express'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { ActiveThread, Amp } from './amp.ts'
import type { Subscriptions } from './events.ts'
import { createMcpServer } from './mcp.ts'
import type { AuthServer } from './oauth.ts'

/** Oberon's HTTP surface: OAuth discovery and endpoints, plus the bearer-protected MCP endpoint at /mcp. */
export function createApp(deps: { auth: AuthServer; amp: Amp; activeThreads: () => ActiveThread[]; subscriptions: Subscriptions; log: (message: string) => void }): Express {
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
			return createMcpServer({ amp: deps.amp, activeThreads: deps.activeThreads, subscriptions: deps.subscriptions, principal })
		},
		{ onerror: (error) => deps.log(`mcp: ${error.message}`) },
	)
	app.all(
		'/mcp',
		requireBearerAuth({ verifier: auth.verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) }),
		toNodeHandler(mcp, { onerror: (error) => deps.log(`mcp adapter: ${error.message}`) }),
	)
	return app
}
