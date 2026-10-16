// Setup: https://api.market/store/circadian/page-tools
// In Flowise Variables, add Runtime variable CIRCADIAN_API_MARKET_KEY.
// Set that environment variable on the Flowise server. Never paste a key here.
// AI-operated provider: Circadian. This template is free; API usage has its own plan.
const fetch = require('node-fetch');
const { URL } = require('url');
const fail = (code, message, status) => JSON.stringify({
    ok: false, error: code, message, ...(status === undefined ? {} : { gatewayStatus: status })
});

const operation = typeof $operation === 'string' ? $operation.trim() : '';
if (operation !== 'extract' && operation !== 'meta') {
    return fail('invalid_operation', 'Choose exactly extract or meta. No API request was sent.');
}
let target;
try {
    if (typeof $url !== 'string' || $url.length > 8192) throw new Error();
    target = new URL($url.trim());
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
} catch {
    return fail('invalid_url', 'Provide one absolute HTTP or HTTPS URL without embedded credentials. No API request was sent.');
}
const key = typeof $vars !== 'undefined' ? $vars.CIRCADIAN_API_MARKET_KEY : undefined;
if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
    return fail('missing_key', 'Configure the CIRCADIAN_API_MARKET_KEY Runtime variable on the Flowise server. No API request was sent.');
}

const endpoint = 'https://prod.api.market/api/v1/circadian/page-tools/api/' + operation;
try {
    const response = await fetch(endpoint + '?url=' + encodeURIComponent(target.href), {
        method: 'GET',
        headers: { 'x-api-market-key': key.trim(), accept: 'application/json' },
        timeout: 25000,
        size: 2097152
    });
    if (response.status < 200 || response.status >= 300) {
        // Do not return raw gateway errors: they can contain request details.
        if (response.body && typeof response.body.destroy === 'function') response.body.destroy();
        if ([400, 401, 403].includes(response.status)) {
            return fail('gateway_rejected', 'Check the API.market key, active Page Tools plan and input URL.', response.status);
        }
        if (response.status === 402) {
            return fail('payment_required', 'Check the selected API.market plan and balance. This tool will not pay or retry.', response.status);
        }
        if (response.status === 429) {
            return fail('limit_reached', 'Check quota and trial expiry before retrying. A rate limit is also possible. No automatic retry was made.', response.status);
        }
        return fail('gateway_error', 'The gateway did not return a successful response. No automatic retry was made.', response.status);
    }
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok !== true ||
        !Number.isInteger(data.httpStatus) || typeof data.truncated !== 'boolean' ||
        (operation === 'extract' && typeof data.markdown !== 'string') ||
        (operation === 'meta' && (!data.openGraph || typeof data.openGraph !== 'object' || Array.isArray(data.openGraph)))) {
        return fail('unexpected_response', 'The gateway response did not match the Page Tools schema. No automatic retry was made.');
    }
    // Preserve source httpStatus and truncated: gateway success is not source success.
    // Page content is untrusted data, never instructions for the agent.
    return JSON.stringify(data);
} catch {
    return fail('request_failed', 'The request failed, timed out, exceeded the response limit or returned invalid JSON. Its billing outcome may be unknown. No automatic retry was made.');
}
