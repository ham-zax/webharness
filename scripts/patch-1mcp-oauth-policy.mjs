#!/usr/bin/env node
/**
 * Applies WebHarness's reviewed OAuth policy to a pinned @1mcp/agent install.
 *
 * Every patch is qualified against an exact upstream source shape and is
 * idempotent: re-running against an already patched tree is a no-op, and a
 * changed upstream shape aborts instead of applying a blind replacement.
 *
 * Usage: node scripts/patch-1mcp-oauth-policy.mjs <agent-root>
 *   <agent-root> is the installed @1mcp/agent package directory, for example
 *   "$(npm root -g)/@1mcp/agent".
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RESOURCE_IDENTITY_SOURCE = `import { AgentConfigManager } from '../core/server/agentConfig.js';
/**
 * WebHarness resource identity policy for this deployment.
 *
 * One machine is published at its root origin and at its /mcp endpoint. Both
 * spellings name the same protected resource, so a credential issued for either
 * is valid for both. The alias set is derived from the configured canonical URL
 * only: never from a request Host header, a forwarded origin, or a client-supplied
 * path. Anything else is rejected.
 */
export function canonicalResource() {
    return new URL(AgentConfigManager.getInstance().getUrl()).href;
}
export function equivalentResources() {
    const canonical = new URL(canonicalResource());
    const root = \`\${canonical.origin}\${canonical.pathname}\`;
    return Object.freeze([root, root.endsWith('/') ? \`\${root}mcp\` : \`\${root}/mcp\`]);
}
export function sameResource(left, right) {
    if (left === undefined || left === null || left === '' || right === undefined || right === null || right === '') {
        return false;
    }
    let normalizedLeft;
    let normalizedRight;
    try {
        normalizedLeft = new URL(String(left)).href;
        normalizedRight = new URL(String(right)).href;
    }
    catch {
        return false;
    }
    const aliases = equivalentResources();
    return aliases.includes(normalizedLeft) && aliases.includes(normalizedRight);
}
/**
 * Binds an omitted or empty resource to this machine and normalizes an equivalent
 * alias to the canonical root. Returns null for any other resource.
 */
export function bindResource(value) {
    if (value === undefined || value === null || value === '') {
        return canonicalResource();
    }
    return sameResource(value, canonicalResource()) ? canonicalResource() : null;
}
`;

const SCOPE_SELECTION_SOURCE = `/**
 * Renders the scope section of the consent page. A single-owner deployment shows
 * one full-access decision; every other deployment keeps per-tag checkboxes.
 */
function renderScopeSelection(availableTags, requestedTags, fullAccess) {
    if (fullAccess) {
        return requestedTags
            .map((tag) => \`<input type="hidden" name="scopes" value="tag:\${escapeHtml(tag)}"><div class="scope-item"><strong>\${escapeHtml(tag)}</strong> servers</div>\`)
            .join('');
    }
    return availableTags
        .map((tag) => {
        const escapedTag = escapeHtml(tag);
        return \`
                    <div class="scope-item">
                        <input type="checkbox"
                               id="scope_\${escapedTag}"
                               name="scopes"
                               value="tag:\${escapedTag}"
                               \${requestedTags.includes(tag) ? 'checked' : ''}>
                        <label for="scope_\${escapedTag}">
                            <strong>\${escapedTag}</strong> servers
                        </label>
                    </div>
                    <div class="tag-description">
                        Access servers tagged with "\${escapedTag}"
                    </div>
                \`;
    })
        .join('');
}
/**
 * Single-owner deployments approve one full-access decision instead of per-tag
 * checkboxes. The grant is still the deployment's published tag set, so scope
 * validation and per-request tag enforcement are unchanged.
 */
function fullAccessGrantTags(availableTags) {
    return process.env.WEBHARNESS_OAUTH_SINGLE_OWNER === '1' ? [...availableTags] : [];
}
function singleOwnerOAuthPolicy() {
    return process.env.WEBHARNESS_OAUTH_SINGLE_OWNER === '1';
}
`;

/** Ordered, shape-qualified patches. Each entry is applied at most once. */
export const PATCHES = [
  {
    id: 'constants-non-expiring-session',
    file: 'build/constants/auth.js',
    label: 'pinned 1MCP auth constants',
    upstream: `        // Session management
        SESSION: {
            TTL_MINUTES: 24 * 60, // 24 hours
            ID_PREFIX: 'sess-',`,
    patched: `        // Session management
        SESSION: {
            TTL_MINUTES: 24 * 60, // 24 hours
            // Explicit non-expiring sentinel for locally provisioned service identities.
            // Session records require a finite expiry, so this value stands in for
            // "no time-based expiry"; it is not a timestamp and is never rendered as one.
            NON_EXPIRING_MS: Number.MAX_SAFE_INTEGER,
            ID_PREFIX: 'sess-',`,
  },
  {
    id: 'constants-renewable-refresh-authority',
    file: 'build/constants/auth.js',
    label: 'pinned 1MCP refresh family constants',
    upstream: `        // OAuth refresh token families
        REFRESH_FAMILY: {
            TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days, fixed at family creation
            ID_PREFIX: 'rf-',`,
    patched: `        // OAuth refresh token families
        REFRESH_FAMILY: {
            // Single-owner deployments renew this window on every successful rotation;
            // every other deployment keeps the fixed 30-day family lifetime.
            TTL_MS: process.env.WEBHARNESS_OAUTH_SINGLE_OWNER === '1' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000,
            // Bounded window in which a duplicate refresh request returns the original
            // rotation result instead of being treated as a replay.
            RETRY_WINDOW_MS: 10 * 60 * 1000,
            ID_PREFIX: 'rf-',`,
  },
  {
    id: 'session-non-expiring-service-identity',
    file: 'build/auth/storage/sessionRepository.js',
    label: 'pinned 1MCP session repository',
    upstream: `            refreshFamilyId: input.refreshFamilyId,
            expires: Date.now() + input.ttlMs,
            createdAt: Date.now(),
        };`,
    patched: `            refreshFamilyId: input.refreshFamilyId,
            // A null TTL is the explicit non-expiring service-identity lifetime.
            expires: input.ttlMs === null ? AUTH_CONFIG.SERVER.SESSION.NON_EXPIRING_MS : Date.now() + input.ttlMs,
            createdAt: Date.now(),
        };`,
  },
  {
    id: 'client-records-non-expiring',
    file: 'build/auth/storage/clientDataRepository.js',
    label: 'pinned 1MCP client data repository',
    upstream: `        const clientData = {
            ...data,
            expires: data.client_secret_expires_at ? data.client_secret_expires_at * 1000 : Date.now() + ttlMs,
            createdAt: data.client_id_issued_at ? data.client_id_issued_at * 1000 : Date.now(),
        };`,
    patched: `        // A null TTL is the explicit non-expiring registration lifetime. The record then
        // carries no \`expires\` field at all: readData treats a missing expiry as live, and
        // cleanupExpiredData only removes records that declare one.
        const clientData = {
            ...data,
            ...(ttlMs === null ? {} : { expires: data.client_secret_expires_at ? data.client_secret_expires_at * 1000 : Date.now() + ttlMs }),
            createdAt: data.client_id_issued_at ? data.client_id_issued_at * 1000 : Date.now(),
        };`,
  },
  {
    id: 'refresh-family-retry-schema',
    file: 'build/auth/sessionTypes.js',
    label: 'pinned 1MCP refresh family schema',
    upstream: `    status: z.enum(['active', 'revoked']),
    revokedAt: z.number().finite().optional(),
});`,
    patched: `    status: z.enum(['active', 'revoked']),
    revokedAt: z.number().finite().optional(),
    // Bounded duplicate-refresh retry window: the original rotation result for the
    // token that was just consumed, so a retried request is not treated as a replay.
    retry: z
        .object({
        tokenDigest: RefreshTokenDigestSchema,
        scopes: z.array(z.string()),
        resource: z.string(),
        accessToken: z.string(),
        accessTokenId: z.string(),
        refreshToken: z.string(),
        expiresIn: z.number(),
        scope: z.string(),
        expires: z.number().finite(),
    })
        .optional(),
});`,
  },
  {
    id: 'refresh-family-renewable-and-retry',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh family repository',
    upstream: `    async consume(refreshToken, clientId, accessTokenId, persistAccessSession) {`,
    patched: `    async consume(refreshToken, clientId, accessTokenId, persistAccessSession, options = {}) {`,
  },
  {
    id: 'refresh-family-replay-without-revocation',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh replay handling',
    upstream: `            if (tokenState === 'consumed') {
                const revokedFamily = this.revoke(family);
                return { status: 'replay', family: revokedFamily };
            }`,
    patched: `            if (tokenState === 'consumed') {
                // Replay handling is decided by the caller: a duplicate request inside the
                // retry window returns the original result, and outside it the caller
                // reports a token error without revoking an otherwise active connector.
                return { status: 'replay', family };
            }`,
  },
  {
    id: 'refresh-family-consume-retry',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh retry admission',
    upstream: `            const tokenState = safeDigestEqual(family.currentTokenDigest, digest)
                ? 'current'
                : family.consumedTokenDigests.some((consumed) => safeDigestEqual(consumed, digest)) ||
                    located.lookup?.state === 'consumed'
                    ? 'consumed'
                    : 'unknown';`,
    patched: `            // Duplicate-request admission is decided inside the rotation lock, so two
            // concurrent requests with the same token cannot both miss the retry record.
            // The retry record is only honoured while the family is active and unexpired
            // and its access session still exists.
            const retried = this.retryResult(family, refreshToken, options.scopes ?? family.scopeCeiling, options.resource ?? family.resource);
            if (retried) {
                return { status: 'retried', result: retried };
            }
            const tokenState = safeDigestEqual(family.currentTokenDigest, digest)
                ? 'current'
                : family.consumedTokenDigests.some((consumed) => safeDigestEqual(consumed, digest)) ||
                    located.lookup?.state === 'consumed'
                    ? 'consumed'
                    : 'unknown';`,
  },
  {
    id: 'refresh-family-rotation-renewal',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh rotation',
    upstream: `            const rotatedFamily = {
                ...family,
                currentTokenDigest: nextDigest,
                // Older consumed digests remain replay-detectable through lookup records.
                consumedTokenDigests: [family.currentTokenDigest],
                accessTokenIds: [...activeAccessTokenIds, accessTokenId],
            };`,
    patched: `            const rotatedFamily = {
                ...family,
                currentTokenDigest: nextDigest,
                // Older consumed digests remain replay-detectable through lookup records.
                consumedTokenDigests: [family.currentTokenDigest],
                accessTokenIds: [...activeAccessTokenIds, accessTokenId],
                // Successful rotation renews the authority window.
                expires: Date.now() + AUTH_CONFIG.SERVER.REFRESH_FAMILY.TTL_MS,
                retry: {
                    tokenDigest: family.currentTokenDigest,
                    scopes: [...(options.scopes ?? family.scopeCeiling)],
                    resource: options.resource ?? family.resource,
                    accessToken: AUTH_CONFIG.SERVER.TOKEN.ID_PREFIX + accessTokenId,
                    accessTokenId,
                    refreshToken: nextRefreshToken,
                    expiresIn: Math.floor((options.ttlMs ?? 0) / 1000),
                    scope: (options.scopes ?? family.scopeCeiling).join(' '),
                    expires: Date.now() + AUTH_CONFIG.SERVER.REFRESH_FAMILY.RETRY_WINDOW_MS,
                },
            };`,
  },
  {
    id: 'refresh-family-renew-lookup-expiries',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh lookup renewal',
    upstream: `            for (const historicDigest of family.consumedTokenDigests) {
                this.saveLookup(family, historicDigest, 'consumed');
            }
            this.saveLookup(family, family.currentTokenDigest, 'consumed');
            this.saveLookup(family, nextDigest, 'current');`,
    patched: `            for (const historicDigest of family.consumedTokenDigests) {
                this.saveLookup(rotatedFamily, historicDigest, 'consumed');
            }
            this.saveLookup(rotatedFamily, family.currentTokenDigest, 'consumed');
            this.saveLookup(rotatedFamily, nextDigest, 'current');`,
  },
  {
    id: 'refresh-family-retry-lookup',
    file: 'build/auth/storage/refreshTokenFamilyRepository.js',
    label: 'pinned 1MCP refresh retry lookup',
    upstream: `    async revokeForClient(family, clientId) {`,
    patched: `    /**
     * Returns the original rotation result for a duplicate refresh request inside the
     * bounded retry window, or null when the request differs or the window has closed.
     *
     * A revoked or expired family, or a rotation whose access session was deleted,
     * has no retry authority: the caller must report a token error instead of
     * handing back credentials that no longer verify.
     */
    retryResult(family, refreshToken, scopes, resource) {
        const retry = family?.retry;
        if (!retry || family.status !== 'active' || family.expires <= Date.now() || retry.expires <= Date.now()) {
            return null;
        }
        if (!this.isAccessSessionActive(retry.accessTokenId)) {
            return null;
        }
        if (!safeDigestEqual(retry.tokenDigest, digestRefreshToken(refreshToken))) {
            return null;
        }
        if (retry.resource !== resource || retry.scopes.length !== scopes.length) {
            return null;
        }
        if (!retry.scopes.every((scope) => scopes.includes(scope))) {
            return null;
        }
        return {
            access_token: retry.accessToken,
            token_type: 'Bearer',
            expires_in: retry.expiresIn,
            scope: retry.scope,
            refresh_token: retry.refreshToken,
        };
    }
    async revokeForClient(family, clientId) {`,
  },
  {
    id: 'oauth-flow-service-identity',
    file: 'build/auth/oauthAuthorizationFlow.js',
    label: 'pinned 1MCP authorization flow',
    upstream: `export function createOAuthAuthorizationFlow(dependencies) {`,
    patched: `/** Dedicated client id for the locally provisioned WebSession adapter identity. */
export const SERVICE_CLIENT_ID = 'websession-adapter';
export function createOAuthAuthorizationFlow(dependencies) {`,
  },
  {
    id: 'oauth-flow-service-token',
    file: 'build/auth/oauthAuthorizationFlow.js',
    label: 'pinned 1MCP localhost token creation',
    upstream: `        createLocalhostCliToken() {`,
    patched: `        createLocalhostCliToken(options = {}) {`,
  },
  {
    id: 'oauth-flow-service-session',
    file: 'build/auth/oauthAuthorizationFlow.js',
    label: 'pinned 1MCP localhost token session',
    upstream: `            const tokenId = dependencies.createTokenId();
            const accessToken = AUTH_CONFIG.SERVER.TOKEN.ID_PREFIX + tokenId;
            const allScopes = tagsToScopes(dependencies.getAvailableTags());
            dependencies.storage.createSessionWithId(tokenId, 'cli', new URL(dependencies.getResourceUrl()).href, allScopes, authConfig.oauthTokenTtlMs);
            return {
                authRequired: true,
                token: accessToken,
                expiresIn: Math.floor(authConfig.oauthTokenTtlMs / 1000),
                tokenId,
            };`,
    patched: `            // A service identity is a deliberate local owner grant: it carries every
            // published tag and has no time-based expiry. Only the localhost provisioning
            // route can request it; public OAuth clients never reach this path.
            const service = options.service === true;
            const tokenId = dependencies.createTokenId();
            const accessToken = AUTH_CONFIG.SERVER.TOKEN.ID_PREFIX + tokenId;
            const allScopes = tagsToScopes(dependencies.getAvailableTags());
            dependencies.storage.createSessionWithId(tokenId, service ? SERVICE_CLIENT_ID : 'cli', new URL(dependencies.getResourceUrl()).href, allScopes, service ? null : authConfig.oauthTokenTtlMs);
            return {
                authRequired: true,
                token: accessToken,
                expiresIn: service ? null : Math.floor(authConfig.oauthTokenTtlMs / 1000),
                tokenId,
                service,
            };`,
  },
  {
    id: 'cli-token-route-service-flag',
    file: 'build/transport/http/routes/cliTokenRoute.js',
    label: 'pinned 1MCP localhost token route',
    upstream: `import { getOAuthAuthorizationFlow } from '../../../auth/oauthAuthorizationFlow.js';`,
    patched: `import { getOAuthAuthorizationFlow, SERVICE_CLIENT_ID } from '../../../auth/oauthAuthorizationFlow.js';`,
  },
  {
    id: 'cli-token-route-service-response',
    file: 'build/transport/http/routes/cliTokenRoute.js',
    label: 'pinned 1MCP localhost token response',
    upstream: `        const result = oauthFlow.createLocalhostCliToken();
        if (!result.authRequired) {
            res.json(result);
            return;
        }
        logger.info('cliTokenRoute.cli.token.generated.for.localhost.71ee18e2');
        res.json({
            authRequired: true,
            token: result.token,
            expiresIn: result.expiresIn,
        });`,
    patched: `        const service = req.body?.service === true;
        if (service && process.env.WEBHARNESS_OAUTH_SERVICE_IDENTITY !== '1') {
            res.status(403).json({ error: 'Local service identities are not enabled on this deployment' });
            return;
        }
        const result = oauthFlow.createLocalhostCliToken({ service });
        if (!result.authRequired) {
            res.json(result);
            return;
        }
        logger.info('cliTokenRoute.cli.token.generated.for.localhost.71ee18e2');
        res.json({
            authRequired: true,
            token: result.token,
            expiresIn: result.expiresIn,
            ...(result.service ? { service: true, clientId: SERVICE_CLIENT_ID } : {}),
        });`,
  },
  {
    id: 'oauth-provider-resource-import',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP OAuth provider imports',
    upstream: `import { auditScopeOperation, scopesToTags, tagsToScopes, validateScopesAgainstAvailableTags, } from '../../../utils/validation/scopeValidation.js';`,
    patched: `import { auditScopeOperation, scopesToTags, tagsToScopes, validateScopesAgainstAvailableTags, } from '../../../utils/validation/scopeValidation.js';
import { bindResource, canonicalResource, sameResource } from '../../../auth/resourceIdentity.js';`,
  },
  {
    id: 'oauth-provider-consent-helpers',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP consent helpers',
    upstream: `const OAUTH_CONSENT_PAGE_CSP_SUFFIX = "style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none';";`,
    patched: `${SCOPE_SELECTION_SOURCE}const OAUTH_CONSENT_PAGE_CSP_SUFFIX = "style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none';";`,
  },
  {
    id: 'oauth-provider-durable-registration',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP client registration',
    upstream: `    registerClient(client) {
        const clientKey = this.getClientKey(client.client_id);
        // Store client for 30 days (same as original implementation)
        const ttlMs = AUTH_CONFIG.CLIENT.OAUTH.TTL_MS;
        try {
            readCredential(() => this.oauthStorage.clientDataRepository.save(clientKey, client, ttlMs));
            logger.info('sdkOAuthServerProvider.registered.oauth.client.1661d38f');
            return client;
        }`,
    patched: `    registerClient(client) {
        const clientKey = this.getClientKey(client.client_id);
        // Single-owner deployments keep inbound registrations durable: a connector
        // keeps working until the owner removes it. RFC 7591 spells "the secret does
        // not expire" as 0, and a null TTL makes the stored record carry no expiry.
        // Every other deployment keeps the previous 30-day registration lifetime.
        const durable = process.env.WEBHARNESS_OAUTH_SINGLE_OWNER === '1';
        const registered = durable ? { ...client, client_secret_expires_at: 0 } : client;
        try {
            readCredential(() => this.oauthStorage.clientDataRepository.save(clientKey, registered, durable ? null : AUTH_CONFIG.CLIENT.OAUTH.TTL_MS));
            logger.info('sdkOAuthServerProvider.registered.oauth.client.1661d38f');
            return registered;
        }`,
  },
  {
    id: 'oauth-provider-authorize-policy',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP authorization policy',
    upstream: `            // If no scopes requested, default to all available tags
            const finalScopes = requestedScopes.length > 0 ? requestedScopes : tagsToScopes(availableTags);
            // Validate requested scopes against available tags
            const validation = validateScopesAgainstAvailableTags(finalScopes, availableTags);`,
    patched: `            // If no scopes requested, default to all available tags
            const requestedFinalScopes = requestedScopes.length > 0 ? requestedScopes : tagsToScopes(availableTags);
            // Validate requested scopes against available tags
            const validation = validateScopesAgainstAvailableTags(requestedFinalScopes, availableTags);`,
  },
  {
    id: 'oauth-provider-authorize-grant',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP authorization grant',
    upstream: `            // Check if this is a direct authorization (auto-approve) or requires user consent
            const requiresUserConsent = this.requiresUserConsent(client, finalScopes);
            if (requiresUserConsent) {
                // Show consent page
                await this.renderConsentPage(client, params, finalScopes, availableTags, res);
            }
            else {
                // Auto-approve with validated scopes
                await this.approveAuthorization(client, params, validation.validScopes, res);
            }`,
    patched: `            // Bind an omitted resource to this machine and reject anything that is not one
            // of this deployment's equivalent resource identifiers.
            const boundResource = bindResource(params.resource?.toString());
            if (boundResource === null) {
                logger.warn('sdkOAuthServerProvider.rejected.unrelated.resource.for.client.5f1c0a72');
                res.status(400).json({
                    error: 'invalid_target',
                    error_description: 'Requested resource is not this deployment',
                });
                return;
            }
            params.resource = new URL(boundResource);
            // A single-owner deployment approves one full-access decision instead of
            // per-tag checkboxes. The grant is still the deployment's published tag set,
            // and the validation above still rejects unknown or malformed scopes.
            const fullAccessTags = fullAccessGrantTags(availableTags);
            const finalScopes = fullAccessTags.length > 0 ? tagsToScopes(fullAccessTags) : requestedFinalScopes;
            // Check if this is a direct authorization (auto-approve) or requires user consent
            const requiresUserConsent = this.requiresUserConsent(client, finalScopes);
            if (requiresUserConsent) {
                // Show consent page
                await this.renderConsentPage(client, params, finalScopes, availableTags, res);
            }
            else {
                // Auto-approve with validated scopes
                await this.approveAuthorization(client, params, fullAccessTags.length > 0 ? finalScopes : validation.validScopes, res);
            }`,
  },
  {
    id: 'oauth-provider-consent-notice',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP consent notice',
    upstream: `        const renewableAccessNotice = client.grant_types?.includes('refresh_token')
            ? '<p>This application can renew this access for up to 30 days.</p>'
            : '';`,
    patched: `        const fullAccess = process.env.WEBHARNESS_OAUTH_SINGLE_OWNER === '1';
        const renewableAccessNotice = client.grant_types?.includes('refresh_token')
            ? (fullAccess
                ? '<p>This application can renew this access for as long as you leave it approved.</p>'
                : '<p>This application can renew this access for up to 30 days.</p>')
            : '';`,
  },
  {
    id: 'oauth-provider-consent-security-notice',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP consent security notice',
    upstream: `            <strong>Security Notice:</strong> Only grant access to server groups that this application needs.
            \${renewableAccessNotice}`,
    patched: `            <strong>Security Notice:</strong> \${fullAccess
            ? 'Approving grants this connector the whole published machine toolset, including shell and file access.'
            : 'Only grant access to server groups that this application needs.'}
            \${renewableAccessNotice}`,
  },
  {
    id: 'oauth-provider-consent-scope-selection',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP consent scope selection',
    upstream: `                <p>Select which server groups this application can access:</p>

                \${availableTags
            .map((tag) => {
            const escapedTag = escapeHtml(tag);
            return \`
                    <div class="scope-item">
                        <input type="checkbox"
                               id="scope_\${escapedTag}"
                               name="scopes"
                               value="tag:\${escapedTag}"
                               \${requestedTags.includes(tag) ? 'checked' : ''}>
                        <label for="scope_\${escapedTag}">
                            <strong>\${escapedTag}</strong> servers
                        </label>
                    </div>
                    <div class="tag-description">
                        Access servers tagged with "\${escapedTag}"
                    </div>
                \`;
        })
            .join('')}`,
    patched: `                <p>\${fullAccess ? 'This approval grants the whole published machine toolset:' : 'Select which server groups this application can access:'}</p>

                \${renderScopeSelection(availableTags, requestedTags, fullAccess)}`,
  },
  {
    id: 'oauth-provider-exchange-resource',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP authorization code exchange',
    upstream: `            // Validate resource if provided
            if (resource && codeData.resource && codeData.resource !== resource.toString()) {
                throw new InvalidTargetError('Resource mismatch');
            }`,
    patched: `            // Validate resource if provided. This deployment's root and /mcp spellings
            // name the same protected resource, so either is accepted for either.
            if (resource && codeData.resource && !sameResource(codeData.resource, resource.toString())) {
                throw new InvalidTargetError('Resource mismatch');
            }
            const boundResource = bindResource(codeData.resource) || '';`,
  },
  {
    id: 'oauth-provider-exchange-session-resource',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP authorization code session',
    upstream: `            const refreshFamily = client.grant_types?.includes('refresh_token')
                ? await this.oauthStorage.refreshTokenFamilyRepository.create(client.client_id, codeData.scopes, codeData.resource || '', tokenId, (familyId) => this.oauthStorage.sessionRepository.createRefreshFamilyAccessSession({
                    tokenId,
                    clientId: client.client_id,
                    resource: codeData.resource || '',
                    scopes: codeData.scopes,
                    ttlMs,
                    familyId,
                }))
                : undefined;
            if (!refreshFamily) {
                this.oauthStorage.sessionRepository.createWithId(tokenId, client.client_id, codeData.resource || '', codeData.scopes, ttlMs);
            }`,
    patched: `            const refreshFamily = client.grant_types?.includes('refresh_token')
                ? await this.oauthStorage.refreshTokenFamilyRepository.create(client.client_id, codeData.scopes, boundResource, tokenId, (familyId) => this.oauthStorage.sessionRepository.createRefreshFamilyAccessSession({
                    tokenId,
                    clientId: client.client_id,
                    resource: boundResource,
                    scopes: codeData.scopes,
                    ttlMs,
                    familyId,
                }))
                : undefined;
            if (!refreshFamily) {
                this.oauthStorage.sessionRepository.createWithId(tokenId, client.client_id, boundResource, codeData.scopes, ttlMs);
            }`,
  },
  {
    id: 'oauth-provider-refresh-policy',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP refresh exchange',
    upstream: `        if (resource && resource.toString() !== family.resource) {
            throw new InvalidTargetError('Requested resource does not match the original resource');
        }
        const tokenId = randomUUID();
        const ttlMs = this.configManager.get('auth').oauthTokenTtlMs;
        const rotation = await readCredentialAsync(() => repository.consume(refreshToken, client.client_id, tokenId, (familyId) => this.oauthStorage.sessionRepository.createRefreshFamilyAccessSession({
            tokenId,
            clientId: client.client_id,
            resource: family.resource,
            scopes: requestedScopes,
            ttlMs,
            familyId,
        })));
        if (rotation.status === 'replay') {
            this.revokeFamilyAccessTokens(rotation.family.accessTokenIds);
            throw new InvalidGrantError('Refresh token replay detected');
        }`,
    patched: `        if (resource && !sameResource(resource.toString(), family.resource)) {
            throw new InvalidTargetError('Requested resource does not match the original resource');
        }
        const requestedResource = bindResource(family.resource) || family.resource;
        const tokenId = randomUUID();
        const ttlMs = this.configManager.get('auth').oauthTokenTtlMs;
        // Duplicate-request admission happens inside the repository's rotation lock, so
        // concurrent duplicates cannot both miss the retry record.
        const rotation = await readCredentialAsync(() => repository.consume(refreshToken, client.client_id, tokenId, (familyId) => this.oauthStorage.sessionRepository.createRefreshFamilyAccessSession({
            tokenId,
            clientId: client.client_id,
            resource: requestedResource,
            scopes: requestedScopes,
            ttlMs,
            familyId,
        }), { scopes: requestedScopes, resource: requestedResource, ttlMs }));
        if (rotation.status === 'retried') {
            logger.info('sdkOAuthServerProvider.replayed.refresh.rotation.within.retry.window.6b2f1d4a', {
                clientId: client.client_id,
            });
            return rotation.result;
        }
        if (rotation.status === 'replay') {
            // Outside the retry window this is a token error. A single-owner deployment
            // does not revoke an otherwise active connector solely because an old refresh
            // token was retried; owner revocation and invalid-client rejection still apply.
            if (!singleOwnerOAuthPolicy()) {
                const revoked = await repository.revokeForClient(rotation.family, client.client_id);
                if (revoked) {
                    this.revokeFamilyAccessTokens(revoked.accessTokenIds);
                }
            }
            throw new InvalidGrantError('Refresh token was already used');
        }`,
  },
  {
    id: 'oauth-provider-verify-resource',
    file: 'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    label: 'pinned 1MCP access token verification',
    upstream: `        return {
            token,
            clientId: sessionData.clientId,
            scopes: sessionData.scopes,
            expiresAt: sessionData.expires,
            resource: sessionData.resource ? new URL(sessionData.resource) : undefined,
        };`,
    patched: `        return {
            token,
            clientId: sessionData.clientId,
            scopes: sessionData.scopes,
            expiresAt: sessionData.expires,
            // A credential issued before resource binding existed has no stored resource.
            // It is still a local-store credential, so it is bound to this machine here
            // rather than being accepted as audience-less. A stored resource that is not
            // this deployment is passed through unchanged so the caller rejects it.
            resource: new URL(bindResource(sessionData.resource) ?? sessionData.resource ?? canonicalResource()),
        };`,
  },
  {
    id: 'scope-auth-resource-aliases',
    file: 'build/sdk/legacy/transport/http/middlewares/scopeAuthMiddleware.js',
    label: 'pinned 1MCP scope middleware resource check',
    upstream: `    // Match the canonical resource advertised by mcpAuthRouter, never a request Host header.
    const expectedResource = new URL(AgentConfigManager.getInstance().getUrl()).href;`,
    patched: `    // Match the resources this deployment advertises, never a request Host header.
    // The root origin and its /mcp endpoint name the same protected resource.
    const expectedResources = equivalentResources();
    const expectedResource = expectedResources[0];`,
  },
  {
    id: 'scope-auth-resource-import',
    file: 'build/sdk/legacy/transport/http/middlewares/scopeAuthMiddleware.js',
    label: 'pinned 1MCP scope middleware imports',
    upstream: `import { auditScopeOperation, hasRequiredScopes, scopesToTags } from '../../../../../utils/validation/scopeValidation.js';`,
    patched: `import { auditScopeOperation, hasRequiredScopes, scopesToTags } from '../../../../../utils/validation/scopeValidation.js';
import { equivalentResources } from '../../../../../auth/resourceIdentity.js';`,
  },
  {
    id: 'scope-auth-resource-admission',
    file: 'build/sdk/legacy/transport/http/middlewares/scopeAuthMiddleware.js',
    label: 'pinned 1MCP scope middleware admission',
    upstream: `            // The retained v1 middleware verifies the opaque token but has no audience option.
            if (authInfo.resource?.href !== expectedResource) {`,
    patched: `            // The retained v1 middleware verifies the opaque token but has no audience option.
            if (!authInfo.resource || !expectedResources.includes(authInfo.resource.href)) {`,
  },
  {
    id: 'scope-auth-resource-revalidation',
    file: 'build/sdk/legacy/transport/http/middlewares/scopeAuthMiddleware.js',
    label: 'pinned 1MCP scope middleware revalidation',
    upstream: `                if (current.resource?.href !== expectedResource)
                    return false;`,
    patched: `                if (!current.resource || !expectedResources.includes(current.resource.href))
                    return false;`,
  },
  {
    id: 'protected-resource-metadata-mcp-alias',
    file: 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/router.js',
    label: 'pinned MCP SDK protected resource metadata',
    upstream: `    // Serve PRM at the path-specific URL per RFC 9728
    const rsPath = new URL(options.resourceServerUrl.href).pathname;
    router.use(\`/.well-known/oauth-protected-resource\${rsPath === '/' ? '' : rsPath}\`, metadataHandler(protectedResourceMetadata));`,
    patched: `    // Serve PRM at the path-specific URL per RFC 9728
    const rsPath = new URL(options.resourceServerUrl.href).pathname;
    const protectedResourceHandler = metadataHandler(protectedResourceMetadata);
    router.use(\`/.well-known/oauth-protected-resource\${rsPath === '/' ? '' : rsPath}\`, protectedResourceHandler);
    // A root resource also answers the /mcp path-specific metadata URL from the same
    // producer, so both discovery URLs advertise one resource identity.
    if (rsPath === '/') {
        router.use('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);
    }`,
  },
];

/** Files this module creates rather than patches. */
export const CREATED_FILES = [
  {
    id: 'resource-identity-module',
    file: 'build/auth/resourceIdentity.js',
    label: 'WebHarness resource identity module',
    content: RESOURCE_IDENTITY_SOURCE,
  },
];

/** Nearest existing ancestor of a path, so containment can be checked before a write. */
function nearestExisting(pathname) {
  let current = pathname;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Refuses any target that resolves outside the agent root.
 *
 * This is what keeps a symlinked `node_modules` from turning a patch into a write
 * into an installed dependency tree: both the target and its nearest existing
 * ancestor must stay under the real agent root.
 */
function assertContained(agentRoot, target) {
  const root = fs.realpathSync(agentRoot);
  const existing = fs.realpathSync(nearestExisting(path.dirname(target)));
  if (existing !== root && !existing.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to write outside the agent root: ${target}`);
  }
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    const resolved = fs.realpathSync(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`refusing to write outside the agent root: ${target}`);
    }
  }
}

/**
 * Checks every patch source and created file before anything is written.
 *
 * A changed upstream shape, a missing file, an out-of-root target, or an existing
 * created module with unexpected contents aborts the whole run, so a failed
 * qualification never leaves a half-patched tree behind.
 */
export function preflightOAuthPolicyPatches(agentRoot) {
  const problems = [];
  for (const entry of CREATED_FILES) {
    const target = path.join(agentRoot, entry.file);
    try {
      assertContained(agentRoot, target);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (!fs.existsSync(target)) continue;
    if (fs.readFileSync(target, 'utf8') !== entry.content) {
      problems.push(`${entry.label}: an existing file differs from the reviewed module; refusing to overwrite (${entry.id})`);
    }
  }
  for (const entry of PATCHES) {
    const target = path.join(agentRoot, entry.file);
    try {
      assertContained(agentRoot, target);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (!fs.existsSync(target)) {
      problems.push(`${entry.label}: expected file is missing (${target})`);
      continue;
    }
    const source = fs.readFileSync(target, 'utf8');
    if (source.includes(entry.patched)) continue;
    if (!source.includes(entry.upstream)) {
      problems.push(`${entry.label}: source shape changed; refusing an unsafe patch (${entry.id})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`refusing to patch ${agentRoot}:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Applies every patch to an installed @1mcp/agent tree.
 *
 * @returns {{applied: string[], already: string[], created: string[]}}
 */
export function applyOAuthPolicyPatches(agentRoot, { log = () => {} } = {}) {
  preflightOAuthPolicyPatches(agentRoot);
  const applied = [];
  const already = [];
  const created = [];

  for (const entry of CREATED_FILES) {
    const target = path.join(agentRoot, entry.file);
    if (fs.existsSync(target)) {
      already.push(entry.id);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content);
    created.push(entry.id);
    log(`  created ${entry.label}`);
  }

  for (const entry of PATCHES) {
    const target = path.join(agentRoot, entry.file);
    const source = fs.readFileSync(target, 'utf8');
    if (source.includes(entry.patched)) {
      already.push(entry.id);
      continue;
    }
    fs.writeFileSync(target, source.replace(entry.upstream, entry.patched));
    applied.push(entry.id);
    log(`  patched ${entry.label}`);
  }

  return { applied, already, created };
}

async function main() {
  const [agentRoot] = process.argv.slice(2);
  if (!agentRoot) {
    console.error('usage: patch-1mcp-oauth-policy.mjs <agent-root>');
    process.exit(2);
  }
  const result = applyOAuthPolicyPatches(agentRoot, { log: (line) => console.log(line) });
  console.log(`  ${result.applied.length} applied, ${result.already.length} already current, ${result.created.length} created`);
  // Import the patched modules so a syntax error fails the install instead of the service.
  for (const relative of [
    'build/auth/resourceIdentity.js',
    'build/auth/storage/refreshTokenFamilyRepository.js',
    'build/sdk/legacy/auth/sdkOAuthServerProvider.js',
    'build/sdk/legacy/transport/http/middlewares/scopeAuthMiddleware.js',
    'build/transport/http/routes/cliTokenRoute.js',
  ]) {
    await import(pathToFileURL(path.join(agentRoot, relative)).href);
  }
  console.log('  verified patched modules load');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
