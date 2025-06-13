// Constants
const DOCKER_HUB_URL = 'https://registry-1.docker.io';

// Default headers to forward
const DEFAULT_HEADERS = ['accept', 'content-type', 'authorization', 'user-agent'];

// Registry API configurations (keys are path segments after /v2/)
const registryConfigs = {
  'register/docker/elastic': { baseUrl: 'https://docker.elastic.co' },
  'register/docker/hub': { baseUrl: DOCKER_HUB_URL },
  'register/google': { baseUrl: 'https://gcr.io' },
  'register/github': { baseUrl: 'https://ghcr.io' },
  'register/k8s': { baseUrl: 'https://registry.k8s.io' },
  'register/microsoft': { baseUrl: 'https://mcr.microsoft.com' },
  'register/nvidia': { baseUrl: 'https://nvcr.io' },
  'register/quay': { baseUrl: 'https://quay.io' },
  'register/ollama': { baseUrl: 'https://registry.ollama.ai' }
};

// AI API configurations (keys include leading slash)
const aiConfigs = {
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
 * Handles all API requests except the auth endpoint
 * @param {Request} request - The incoming request
 * @returns {Promise<Response>} - The response
 */
async function handleApiRequest(request) {
  try {
    const url = new URL(request.url);
    const { pathname, search } = url;

    console.log(`Received API request: ${request.method} ${pathname}${search}`);

    // Handle static assets and root path
    if (pathname === '/' || pathname === '/index.html') {
      return new Response('Service is running!', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Check if it's a Docker V2 API request
    if (pathname.startsWith('/v2/')) {
      const v2Path = pathname.substring(4); // Remove '/v2/'
      
      // Handle the Docker V2 API "ping"
      if (v2Path === '' || v2Path === '/') {
        const targetUrl = `${DOCKER_HUB_URL}/v2/`;
        const pingResponse = await fetch(targetUrl, { method: request.method, headers: request.headers, redirect: 'manual' });
        if (pingResponse.status === 401) {
          return responseUnauthorized(new URL(request.url)); // No imagePath needed for generic /v2/ ping
        }
        return pingResponse;
      }

      // Extract registry prefix from the v2Path
      const [registryPrefix, imagePath] = extractPrefixAndRest(v2Path, Object.keys(registryConfigs));

      let targetBaseUrl;
      let finalImagePath;
      let isDockerHub = false;

      if (registryPrefix) {
        const config = registryConfigs[registryPrefix];
        targetBaseUrl = config.baseUrl;
        finalImagePath = imagePath; // This is the part after our proxy prefix, e.g., "/hello-world"
        if (targetBaseUrl === DOCKER_HUB_URL) {
            isDockerHub = true;
        }
      } else {
        // No specific registry prefix found, default to Docker Hub
        targetBaseUrl = DOCKER_HUB_URL;
        finalImagePath = v2Path; // This is the full path after /v2/, e.g., "hello-world" or "library/ubuntu"
        isDockerHub = true;
      }

      // Special handling for Docker Hub official images (e.g., "hello-world" -> "library/hello-world")
      // This is now handled by a 301 redirect if it's a direct image pull
      if (isDockerHub) {
        const pathParts = finalImagePath.split('/');
        // Check if it's a simple image name (e.g., "hello-world/manifests/latest")
        // and not already "library/hello-world" or a multi-segment path
        if (pathParts.length >= 2 && !pathParts[0].includes('.') && !pathParts[0].includes(':') && pathParts[0] !== 'library') {
            const redirectUrl = new URL(url);
            // Reconstruct the path to include 'library/'
            const newPathParts = pathname.split('/');
            newPathParts.splice(2, 0, 'library'); // Insert 'library' after '/v2/'
            redirectUrl.pathname = newPathParts.join('/');
            console.log(`Redirecting Docker Hub official image: ${url.pathname} -> ${redirectUrl.pathname}`);
            return Response.redirect(redirectUrl, 301);
        }
      }
      
      // Ensure finalImagePath does not start with a leading slash if it's being appended directly to /v2/
      const cleanedFinalImagePath = finalImagePath.startsWith('/') ? finalImagePath.slice(1) : finalImagePath;

      return handleRegistryRequest(request, targetBaseUrl, cleanedFinalImagePath, search);
    }

    // Handle other API requests (e.g., AI APIs)
    const [aiPrefix, restPath] = extractPrefixAndRest(pathname, Object.keys(aiConfigs));
    if (aiPrefix) {
      const config = aiConfigs[aiPrefix];
      return handleGenericApiRequest(request, config.baseUrl, restPath, search, config.allowedHeaders);
    } else {
      // No matching API or /v2/ path
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

  } catch (error) {
    console.error(`Critical error in handleApiRequest:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Handles Docker Registry API requests
 * @param {Request} request - The incoming request
 * @param {string} baseUrl - The base URL of the target registry.
 * @param {string} imagePath - The path segment representing the image name.
 * @param {string} search - The request search query.
 * @returns {Promise<Response>} - The response
 */
async function handleRegistryRequest(request, baseUrl, imagePath, search) {
  const targetUrl = `${baseUrl}/v2/${imagePath}${search}`;
  const isDockerHub = (baseUrl === DOCKER_HUB_URL);
  console.log(`Proxying registry request to: ${targetUrl}`);

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
    return responseUnauthorized(new URL(request.url)); // No imagePath needed here, auth endpoint handles scope
  }

  // Handle blob redirects (e.g., 307 Temporary Redirect)
  if (isDockerHub && (response.status === 307 || response.status === 302)) {
    const location = new URL(response.headers.get('Location'));
    if (location) {
      console.log(`Following redirect to: ${location}`);
      // The redirected location is a pre-signed URL, fetch it directly
      return fetch(location.toString(), { method: 'GET', redirect: 'follow' });
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
 * @param {string} baseUrl - The base URL of the target API.
 * @param {string} restPath - The remaining path after the proxy prefix.
 * @param {string} search - The request search query.
 * @param {string[]} [allowedHeaders=[]] - Additional headers allowed for this API.
 * @returns {Promise<Response>} - The response
 */
async function handleGenericApiRequest(request, baseUrl, restPath, search, allowedHeaders = []) {
  const headers = new Headers();
  const combinedAllowedHeaders = [...DEFAULT_HEADERS, ...allowedHeaders];

  for (const [key, value] of request.headers.entries()) {
    if (combinedAllowedHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  const targetUrl = `${baseUrl}${restPath.startsWith('/') ? restPath : `/${restPath}`}${search}`;
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
 * Assumes pathSegment is already correctly formatted relative to prefixes.
 * @param {string} pathSegment - The path segment to parse.
 * @param {string[]} prefixes - The list of prefixes to check.
 * @returns {[string|null, string|null]} - The matching prefix and the rest of the path.
 */
function extractPrefixAndRest(pathSegment, prefixes) {
  let bestMatch = null;
  for (const prefix of prefixes) {
    // Ensure we match a full segment, e.g., "docker/hub/foo" should match "docker/hub"
    if (pathSegment.startsWith(prefix + '/') || pathSegment === prefix) {
        if (!bestMatch || prefix.length > bestMatch.length) {
            bestMatch = prefix;
        }
    }
  }

  if (bestMatch) {
      const rest = pathSegment.slice(bestMatch.length);
      return [bestMatch, rest];
  }

  return [null, pathSegment]; // Return the original path if no prefix matches
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
 * @returns {Response} - The 401 response.
 */
function responseUnauthorized(url) {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    // Hardcode service to cloudflare-docker-proxy as per src/docker.js
    headers.set('WWW-Authenticate', `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`);

    return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
        status: 401,
        headers: headers
    });
}

/**
 * Parses the WWW-Authenticate header.
 * @param {string} authenticateStr - The WWW-Authenticate header string.
 * @returns {{realm: string, service: string}} - Parsed realm and service.
 */
function parseAuthenticate(authenticateStr) {
    // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
    // match strings after =" and before "
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (matches == null || matches.length < 2) {
      throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
    }
    return {
      realm: matches[0],
      service: matches[1],
    };
}

/**
 * Fetches a token from the authentication server.
 * @param {{realm: string, service: string}} wwwAuthenticate - Parsed WWW-Authenticate info.
 * @param {string} scope - The requested scope.
 * @param {string|null} authorization - The original Authorization header from the client.
 * @returns {Promise<Response>} - The token response.
 */
async function fetchToken(wwwAuthenticate, scope, authorization) {
    const url = new URL(wwwAuthenticate.realm);
    if (wwwAuthenticate.service.length) {
      url.searchParams.set("service", wwwAuthenticate.service);
    }
    if (scope) {
      url.searchParams.set("scope", scope);
    }
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    return await fetch(url, { method: "GET", headers: headers });
}

/**
 * Special handler for the /v2/auth endpoint to get Docker tokens.
 * @param {Request} request - The incoming request.
 * @returns {Promise<Response>} - The token response.
 */
async function handleAuthRequest(request) {
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    let service = searchParams.get('service');
    let scope = searchParams.get('scope');
    const authorization = request.headers.get('Authorization');

    // If service is our proxy's service, we need to map it back to Docker Hub's service
    if (service === 'cloudflare-docker-proxy') {
        service = 'registry.docker.io';
    }

    // Autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope && service === 'registry.docker.io') {
        let scopeParts = scope.split(":");
        if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
            scopeParts[1] = "library/" + scopeParts[1];
            scope = scopeParts.join(":");
        }
    }

    // We need to get the WWW-Authenticate header from the actual upstream registry
    // This is a simplified approach, assuming we know the upstream is Docker Hub for this service
    const upstreamPingUrl = `${DOCKER_HUB_URL}/v2/`;
    const pingResp = await fetch(upstreamPingUrl, { method: 'GET', redirect: 'manual' });
    const authenticateStr = pingResp.headers.get('WWW-Authenticate');

    if (!authenticateStr) {
        console.error('Upstream did not provide WWW-Authenticate header for token request.');
        return new Response(JSON.stringify({ error: 'Failed to get upstream authentication challenge' }), { status: 500 });
    }

    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    
    return await fetchToken(wwwAuthenticate, scope, authorization);
}

/**
 * Main request handler, acts as a router.
 * @param {Request} request - The incoming request
 * @returns {Promise<Response>} - The response
 */
async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/v2/auth') {
      return handleAuthRequest(request);
    }
    // All other requests go to the main API handler
    return handleApiRequest(request);
  } catch (error) {
    console.error(`Critical error in router handleRequest:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
