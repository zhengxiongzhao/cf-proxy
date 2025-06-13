// Constants
const DOCKER_HUB_URL = 'https://registry-1.docker.io';

// Default headers to forward
const DEFAULT_HEADERS = ['accept', 'content-type', 'authorization', 'user-agent'];

// API configurations
const apiConfigs = {
  '/registry/docker/elastic': { baseUrl: 'https://docker.elastic.co' },
  '/registry/docker/hub': { baseUrl: DOCKER_HUB_URL },
  '/registry/google': { baseUrl: 'https://gcr.io' },
  '/registry/github': { baseUrl: 'https://ghcr.io' },
  '/registry/k8s': { baseUrl: 'https://registry.k8s.io' },
  '/registry/microsoft': { baseUrl: 'https://mcr.microsoft.com' },
  '/registry/nvidia': { baseUrl: 'https://nvcr.io' },
  '/registry/quay': { baseUrl: 'https://quay.io' },
  '/registry/ollama': { baseUrl: 'https://registry.ollama.ai' },
  '/ai/discord': { baseUrl: 'https://discord.com/api' },
  '/ai/telegram': { baseUrl: 'https://api.telegram.org' },
  '/ai/openai': { baseUrl: 'https://api.openai.com' },
  '/ai/claude': { baseUrl: 'https://api.anthropic.com', allowedHeaders: ['anthropic-version'] },
  '/ai/gemini': { baseUrl: 'https://generativelanguage.googleapis.com', allowedHeaders: ['x-goog-api-key'] },
  '/ai/meta': { baseUrl: 'https://www.meta.ai/api' },
  '/ai/groq': { baseUrl: 'https://api.groq.com/openai' },
  '/ai/xai': { baseUrl: 'https://api.x.ai', allowedHeaders: ['x-api-key'] },
  '/ai/cohere': { baseUrl: 'https://api.cohere.ai' },
  '/ai/huggingface': { baseUrl: 'https://api.huggingface.co' },
  '/ai/together': { baseUrl: 'https://api.together.ai' },
  '/ai/novita': { baseUrl: 'https://api.novita.ai' },
  '/ai/portkey': { baseUrl: 'https://api.portkey.ai' },
  '/ai/fireworks': { baseUrl: 'https://api.fireworks.ai' },
  '/ai/openrouter': { baseUrl: 'https://openrouter.ai/api' }
};

// Event listener for fetch events
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

/**
 * Main request handler
 * @param {Request} request - The incoming request
 * @returns {Promise<Response>} - The response
 */
async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const { pathname, search } = url;

    console.log(`Received request: ${request.method} ${pathname}${search}`);

    // Handle static assets and root path
    if (pathname === '/' || pathname === '/index.html') {
      return new Response('Service is running!', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Check if it's a Docker V2 API request
    if (pathname.startsWith('/v2/')) {
      return handleRegistryRequest(request, pathname, search);
    }

    // Handle other API requests (e.g., AI APIs)
    return handleGenericApiRequest(request, pathname, search);

  } catch (error) {
    console.error(`Critical error in handleRequest:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Handles Docker Registry API requests
 * @param {Request} request - The incoming request
 * @param {string} pathname - The request pathname
 * @param {string} search - The request search query
 * @returns {Promise<Response>} - The response
 */
async function handleRegistryRequest(request, pathname, search) {
  // The path inside the v2 API
  const v2Path = pathname.substring(4); // Remove '/v2/'

  // Handle the Docker V2 API "ping"
  if (v2Path === '' || v2Path === '/') {
    // A GET to /v2/ should be proxied to a default registry to check for auth
    // We default to Docker Hub
    const targetUrl = `${DOCKER_HUB_URL}/v2/`;
    const pingResponse = await fetch(targetUrl, { method: request.method, headers: request.headers, redirect: 'manual' });
    if (pingResponse.status === 401) {
      return responseUnauthorized(new URL(request.url));
    }
    return pingResponse;
  }

  // Extract prefix and the rest of the image path
  const [prefix, imagePath] = extractPrefixAndRest(v2Path, Object.keys(apiConfigs));
  
  let targetUrl;
  let isDockerHub = false;

  if (prefix && prefix.startsWith('/registry/')) {
    // A known registry is specified
    const config = apiConfigs[prefix];
    targetUrl = `${config.baseUrl}/v2${imagePath.startsWith('/') ? imagePath : `/${imagePath}`}${search}`;
    if (config.baseUrl === DOCKER_HUB_URL) {
      isDockerHub = true;
    }
    console.log(`Proxying to configured registry: ${prefix} -> ${targetUrl}`);
  } else {
    // No specific registry prefix found, default to Docker Hub
    // This handles `docker pull myproxy.com/hello-world`
    isDockerHub = true;
    targetUrl = `${DOCKER_HUB_URL}/v2/${v2Path}${search}`;
    console.log(`Defaulting to Docker Hub: ${targetUrl}`);
  }

  // Forward the request
  const newReq = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual' // Important for handling registry redirects
  });

  const response = await fetch(newReq);

  // Handle Docker Hub's 401 Unauthorized with a challenge
  if (response.status === 401) {
    return responseUnauthorized(new URL(request.url), response.headers.get('Www-Authenticate'));
  }

  // Handle blob redirects (e.g., 307 Temporary Redirect)
  if (isDockerHub && (response.status === 307 || response.status === 302)) {
    const location = response.headers.get('Location');
    if (location) {
      console.log(`Following redirect to: ${location}`);
      // The redirected location is a pre-signed URL, fetch it directly
      return fetch(location, { method: 'GET', redirect: 'follow' });
    }
  }

  // Return the response with security headers
  const responseHeaders = new Headers(response.headers);
  addSecurityHeaders(responseHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

/**
 * Handles generic API requests (non-registry)
 * @param {Request} request - The incoming request
 * @param {string} pathname - The request pathname
 * @param {string} search - The request search query
 * @returns {Promise<Response>} - The response
 */
async function handleGenericApiRequest(request, pathname, search) {
  const [prefix, rest] = extractPrefixAndRest(pathname, Object.keys(apiConfigs));

  if (!prefix) {
    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const config = apiConfigs[prefix];
  const allowedHeaders = [...DEFAULT_HEADERS, ...(config.allowedHeaders || [])];

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (allowedHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  const targetUrl = `${config.baseUrl}${rest.startsWith('/') ? rest : `/${rest}`}${search}`;
  console.log(`Proxying generic API request to: ${targetUrl}`);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: headers,
    body: request.body
  });

  const responseHeaders = new Headers(response.headers);
  addSecurityHeaders(responseHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

/**
 * Extracts the matching prefix and the rest of the path.
 * @param {string} pathname - The URL pathname.
 * @param {string[]} prefixes - The list of prefixes to check.
 * @returns {[string|null, string|null]} - The matching prefix and the rest of the path.
 */
function extractPrefixAndRest(pathname, prefixes) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  
  // Find the longest matching prefix
  let bestMatch = null;
  for (const prefix of prefixes) {
    if (normalizedPath.startsWith(prefix + '/')) {
        if (!bestMatch || prefix.length > bestMatch.length) {
            bestMatch = prefix;
        }
    }
  }

  if (bestMatch) {
      const rest = normalizedPath.slice(bestMatch.length);
      return [bestMatch, rest];
  }

  return [null, pathname]; // Return the original path if no prefix matches
}

/**
 * Adds security headers to a response.
 * @param {Headers} headers - The headers object to modify.
 */
function addSecurityHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
}

/**
 * Creates a 401 Unauthorized response with a WWW-Authenticate header.
 * @param {URL} url - The original request URL.
 * @param {string|null} authHeader - The original WWW-Authenticate header from the upstream.
 * @returns {Response} - The 401 response.
 */
function responseUnauthorized(url, authHeader) {
    // If the upstream provided a WWW-Authenticate header, use it.
    if (authHeader) {
        // We need to rewrite the 'realm' to point back to our proxy.
        const realmRegex = /realm="([^"]+)"/;
        const serviceRegex = /service="([^"]+)"/;
        
        const realmMatch = authHeader.match(realmRegex);
        const serviceMatch = authHeader.match(serviceRegex);

        if (realmMatch && serviceMatch) {
            const service = serviceMatch[1];
            // The realm for token authentication should be the token endpoint.
            const newRealm = `https://${url.hostname}/v2/token`;
            const newAuthHeader = `Bearer realm="${newRealm}",service="${service}"`;
            
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: {
                    'Www-Authenticate': newAuthHeader,
                    'Content-Type': 'application/json'
                }
            });
        }
    }

    // Fallback for basic ping 401
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
            'Www-Authenticate': `Bearer realm="https://${url.hostname}/v2/token",service="registry.docker.io"`,
            'Content-Type': 'application/json'
        }
    });
}

// Special handler for the /v2/token endpoint
async function handleTokenRequest(request) {
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    const service = searchParams.get('service');
    const scope = searchParams.get('scope');

    // The actual token server is at auth.docker.io
    const tokenUrl = `https://auth.docker.io/token?service=${service}&scope=${scope}`;
    
    console.log(`Requesting token from: ${tokenUrl}`);

    // If the client sends basic auth, we need to forward it.
    const headers = {};
    if (request.headers.has('authorization')) {
        headers['authorization'] = request.headers.get('authorization');
    }

    const tokenResponse = await fetch(tokenUrl, { headers });
    
    return tokenResponse;
}

// We need to modify the main handler to include the token endpoint
const originalHandler = handleRequest;
async function handleRequest(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v2/token') {
        return handleTokenRequest(request);
    }
    return originalHandler(request);
}
