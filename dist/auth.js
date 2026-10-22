import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { userContext } from './context.js';
const ASYMMETRIC_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
function splitList(value) {
    const parts = value.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
}
function parseRoleMap(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    }
    catch { /* fall through */ }
    throw new Error('OIDC_ROLE_MAP must be a JSON object mapping IdP role/group names to K8sCortex roles.');
}
/**
 * Resolves the authentication mode from environment variables.
 * Throws when auth is enabled but no identity provider is configured, so the
 * server refuses to start rather than accepting tokens it cannot validate properly.
 */
export function loadAuthConfig(env = process.env) {
    if (env.DISABLE_AUTH === 'true')
        return { mode: 'disabled' };
    const rolesClaim = env.OIDC_ROLES_CLAIM || 'roles';
    const roleMap = parseRoleMap(env.OIDC_ROLE_MAP);
    // TEST_JWT_SECRET enables integration tests to sign tokens with a symmetric key
    // without requiring a live JWKS endpoint. Never set this in production.
    if (env.TEST_JWT_SECRET)
        return { mode: 'test-secret', secret: env.TEST_JWT_SECRET, rolesClaim, roleMap };
    if (env.OIDC_ISSUER) {
        if (!env.OIDC_AUDIENCE)
            throw new Error('OIDC_AUDIENCE must be set when OIDC_ISSUER is set.');
        return {
            mode: 'oidc',
            oidc: {
                issuer: splitList(env.OIDC_ISSUER),
                audience: splitList(env.OIDC_AUDIENCE),
                jwksUri: env.OIDC_JWKS_URI,
                rolesClaim,
                roleMap,
            },
        };
    }
    // Backwards-compatible Entra ID configuration
    if (env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID) {
        const tenant = env.ENTRA_TENANT_ID;
        return {
            mode: 'oidc',
            oidc: {
                issuer: [`https://login.microsoftonline.com/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`],
                audience: splitList(env.ENTRA_CLIENT_ID),
                jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
                rolesClaim,
                roleMap,
            },
        };
    }
    throw new Error('Authentication is enabled but not configured. Set OIDC_ISSUER and OIDC_AUDIENCE ' +
        '(or ENTRA_TENANT_ID and ENTRA_CLIENT_ID), or DISABLE_AUTH=true for local development.');
}
function readClaim(claims, path) {
    // Claims such as "cognito:groups" or "https://example.com/roles" are looked up verbatim first
    if (path in claims)
        return claims[path];
    return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), claims);
}
/**
 * Extracts K8sCortex roles from token claims, translating IdP group/role names via roleMap.
 */
export function extractRoles(claims, rolesClaim, roleMap) {
    const raw = readClaim(claims, rolesClaim);
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : [];
    return [...new Set(values.map(v => roleMap[v] ?? v))];
}
function toUser(claims, rolesClaim, roleMap) {
    return {
        oid: String(claims.oid || claims.sub || 'unknown'),
        roles: extractRoles(claims, rolesClaim, roleMap),
    };
}
async function discoverJwksUri(issuer) {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok)
        throw new Error(`OIDC discovery failed for ${issuer}: ${res.status}`);
    const { jwks_uri } = await res.json();
    if (!jwks_uri)
        throw new Error(`OIDC discovery document for ${issuer} has no jwks_uri`);
    return jwks_uri;
}
function bearerToken(req) {
    const [scheme, token] = (req.headers['authorization'] || '').split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
export function createAuthMiddleware(config) {
    if (config.mode === 'disabled') {
        return (req, _res, next) => {
            req.user = { oid: 'local-dev', roles: ['platform-engineer'] };
            userContext.run(req.user, () => next());
        };
    }
    let verify;
    let rolesClaim;
    let roleMap;
    if (config.mode === 'test-secret') {
        ({ rolesClaim, roleMap } = config);
        verify = (token) => new Promise((resolve, reject) => {
            jwt.verify(token, config.secret, { algorithms: ['HS256'] }, (err, claims) => err ? reject(err) : resolve(claims));
        });
    }
    else {
        const { oidc } = config;
        ({ rolesClaim, roleMap } = oidc);
        let clientPromise;
        const getClient = () => {
            clientPromise ??= (oidc.jwksUri
                ? Promise.resolve(oidc.jwksUri)
                : discoverJwksUri(Array.isArray(oidc.issuer) ? oidc.issuer[0] : oidc.issuer)).then(jwksUri => jwksClient({ jwksUri, cache: true, rateLimit: true }));
            // Retry discovery on the next request if it failed
            clientPromise.catch(() => { clientPromise = undefined; });
            return clientPromise;
        };
        const getKey = (header, callback) => {
            getClient()
                .then(client => client.getSigningKey(header.kid))
                .then(key => callback(null, key.getPublicKey()), err => callback(err));
        };
        const issuer = oidc.issuer;
        const audience = oidc.audience;
        verify = (token) => new Promise((resolve, reject) => {
            jwt.verify(token, getKey, { algorithms: ASYMMETRIC_ALGORITHMS, issuer, audience }, (err, claims) => err ? reject(err) : resolve(claims));
        });
    }
    return (req, res, next) => {
        const token = bearerToken(req);
        if (!token) {
            res.status(401).send('Authentication token missing');
            return;
        }
        verify(token).then((claims) => {
            req.user = toUser(claims, rolesClaim, roleMap);
            userContext.run(req.user, () => next());
        }, () => { res.status(403).send('Invalid or expired token'); });
    };
}
let defaultMiddleware;
export const authenticateToken = (req, res, next) => {
    defaultMiddleware ??= createAuthMiddleware(loadAuthConfig());
    return defaultMiddleware(req, res, next);
};
