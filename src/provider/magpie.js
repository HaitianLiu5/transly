// Magpie's app integration contract: https://github.com/yetone/magpie/blob/main/docs/integrating.md
// GET /api/hello names the gateway, and a `magpie-<app>` key is how an app is
// counted under its own name in Magpie's Usage page. On loopback Magpie accepts
// any key, so this one identifies Transly without being a secret.
export const MAGPIE_API_URL = "http://127.0.0.1:3425/v1";
export const MAGPIE_CLIENT_KEY = "magpie-transly";

const MAGPIE_PORT = "3425";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

// Magpie keys account affinity by a caller's session header, so batches of one
// run stay with the account whose prompt cache already holds Transly's
// instructions. X-Magpie-Session only labels usage; this one also routes.
export const MAGPIE_SESSION_HEADER = "x-session-affinity";

export function magpieSessionHeaders(config, sessionId) {
  if (!sessionId || !isMagpieConnection(config)) return {};
  return { [MAGPIE_SESSION_HEADER]: `transly-${sessionId}` };
}

export function magpieHelloUrl(apiUrl) {
  return new URL("/api/hello", apiUrl).toString();
}

export function isMagpieHello(body) {
  return body?.name === "magpie";
}

export function isMagpieConnection(config) {
  let url;
  try {
    url = new URL(config.apiUrl);
  } catch {
    return false;
  }
  return url.protocol === "http:"
    && LOOPBACK_HOSTS.includes(url.hostname)
    && (url.port === MAGPIE_PORT || config.apiKey === MAGPIE_CLIENT_KEY);
}
