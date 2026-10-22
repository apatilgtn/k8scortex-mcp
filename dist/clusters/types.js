/** Builds a single-context KubeConfig from an API endpoint, CA bundle and bearer token. */
export function kubeConfigFromToken(KubeConfigCtor, name, server, caData, token) {
    const kc = new KubeConfigCtor();
    kc.loadFromOptions({
        clusters: [{ name, server, caData, skipTLSVerify: false }],
        users: [{ name, token }],
        contexts: [{ name, cluster: name, user: name }],
        currentContext: name,
    });
    return kc;
}
/** Imports an optional cloud SDK, explaining how to install it when missing. */
export async function importOptional(specifier, provider) {
    try {
        return await import(specifier);
    }
    catch (err) {
        if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
            throw new Error(`The '${provider}' cluster provider requires the optional package '${specifier}'. Install it with: npm install ${specifier}`);
        }
        throw err;
    }
}
