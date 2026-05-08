import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { userContext } from './context.js';
// Configure this with actual Entra ID tenant details via environment variables
const TENANT_ID = process.env.ENTRA_TENANT_ID || 'common';
const CLIENT_ID = process.env.ENTRA_CLIENT_ID || 'your-client-id';
const client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
    cache: true,
    rateLimit: true,
});
function getKey(header, callback) {
    client.getSigningKey(header.kid, (err, key) => {
        if (err || !key) {
            return callback(err);
        }
        const signingKey = key.getPublicKey();
        callback(null, signingKey);
    });
}
export const authenticateToken = (req, res, next) => {
    // Allow bypassing auth if testing locally (for Phase 1 & local dev)
    if (process.env.DISABLE_AUTH === 'true') {
        req.user = { oid: 'local-dev', roles: ['platform-engineer'] };
        return userContext.run(req.user, () => next());
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).send('Authentication token missing');
    }
    // TEST_JWT_SECRET enables integration tests to sign tokens with a symmetric key
    // without requiring a live JWKS endpoint. Never set this in production.
    const testSecret = process.env.TEST_JWT_SECRET;
    if (testSecret) {
        jwt.verify(token, testSecret, (err, user) => {
            if (err) {
                return res.status(403).send('Invalid or expired token');
            }
            req.user = user;
            userContext.run(user, () => next());
        });
        return;
    }
    jwt.verify(token, getKey, { audience: CLIENT_ID }, (err, user) => {
        if (err) {
            return res.status(403).send('Invalid or expired token');
        }
        req.user = user;
        userContext.run(user, () => next());
    });
};
