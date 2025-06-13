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
 * Handles all API requests except the token endpoint
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
          // For a generic /v2/ ping, no specific image path is available for scope inference
          return responseUnauthorized(new URL(request.url), pingResponse.headers.get('Www-Authenticate'), null);
        }
        return pingResponse;
      }

      // Extract registry prefix from the v2Path
      const [registryPrefix, imagePath] = extractPrefixAndRest(v2Path, Object.keys(registryConfigs));

      let targetBaseUrl;
      let finalImagePath;

      if (registryPrefix) {
        const config = registryConfigs[registryPrefix];
        targetBaseUrl = config.baseUrl;
        finalImagePath = imagePath; // This is the part after our proxy prefix, e.g., "/hello-world"
      } else {
        // No specific registry prefix found, default to Docker Hub
        targetBaseUrl = DOCKER_HUB_URL;
        finalImagePath = v2Path; // This is the full path after /v2/, e.g., "hello-world" or "library/ubuntu"
      }

      // Special handling for Docker Hub official images (e.g., "hello-world" -> "library/hello-world")
      if (targetBaseUrl === DOCKER_HUB_URL) {
          let repoName = finalImagePath.split('/manifests/')[0].split('/blobs/')[0];
          // Only add 'library/' if it's a single-segment name and not already a multi-segment path or a digest
          if (repoName && !repoName.includes('/') && !repoName.includes(':')) {
              finalImagePath = `library/${finalImagePath}`;
          }
      }
      
      // Ensure finalImagePath does not start with a leading slash if it's being appended directly to /v2/
      const cleanedFinalImagePath = finalImagePath.startsWith('/') ? finalImagePath.slice(1) : finalImagePath;

      return handleRegistryRequest(request, targetBaseUrl, cleanedFinalImagePath, search, cleanedFinalImagePath);
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
  // Ensure imagePath does not start with a leading slash if it's being appended directly to /v2/
  const cleanedImagePath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  const targetUrl = `${baseUrl}/v2/${cleanedImagePath}${search}`;
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
    // Pass the cleanedImagePath (which is the part after our proxy prefix, without leading slash) for scope inference
    return responseUnauthorized(new URL(request.url), response.headers.get('Www-Authenticate'), cleanedImagePath);
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
 * @param {string|null} authHeader - The original WWW-Authenticate header from the upstream.
 * @returns {Response} - The 401 response.
 */
/**
 * Creates a 401 Unauthorized response with a WWW-Authenticate header.
 * @param {URL} url - The original request URL.
 * @param {string|null} authHeader - The original WWW-Authenticate header from the upstream.
 * @param {string|null} requestedImagePath - The image path requested by the client (e.g., "hello-world/manifests/latest").
 * @returns {Response} - The 401 response.
 */
/**
 * Creates a 401 Unauthorized response with a WWW-Authenticate header.
 * @param {URL} url - The original request URL.
 * @param {string|null} authHeader - The original WWW-Authenticate header from the upstream.
 * @param {string|null} requestedImagePath - The image path requested by the client (e.g., "hello-world/manifests/latest").
 * @returns {Response} - The 401 response.
 */
function responseUnauthorized(url, authHeader, requestedImagePath = null) {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');

    const newRealm = `https://${url.hostname}/v2/token`;
    let service = 'registry.docker.io';
    let scope = 'repository:*:pull'; // Default generic scope
    const otherParams = [];

    if (authHeader) {
        // Parse the existing WWW-Authenticate header
        const parts = authHeader.split(',');
        for (const part of parts) {
            const trimmedPart = part.trim();
            if (trimmedPart.startsWith('realm="')) {
                // Ignore original realm, we'll use newRealm
            } else if (trimmedPart.startsWith('service="')) {
                service = trimmedPart.substring('service="'.length, trimmedPart.length - 1);
            } else if (trimmedPart.startsWith('scope="')) {
                scope = trimmedPart.substring('scope="'.length, trimmedPart.length - 1);
            } else {
                // Collect other parameters
                otherParams.push(trimmedPart);
            }
        }
    }

    // If scope was not provided by upstream or is generic, but we have image path, try to infer
    if ((!authHeader || !authHeader.includes('scope=') || scope === 'repository:*:pull') && requestedImagePath) {
        let repoName = requestedImagePath.split('/manifests/')[0].split('/blobs/')[0];
        // For Docker Hub, if it's a single-segment name, it implies 'library/'
        if (service === 'registry.docker.io' && repoName && !repoName.includes('/') && !repoName.includes(':')) {
            repoName = `library/${repoName}`;
        }
        if (repoName) {
            scope = `repository:${repoName}:pull`;
        }
    }
    
    let newAuthHeader = `Bearer realm="${newRealm}",service="${service}",scope="${scope}"`;
    if (otherParams.length > 0) {
        newAuthHeader += `,${otherParams.join(',')}`;
    }
    headers.set('WWW-Authenticate', newAuthHeader);

    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: headers
    });
}

// Special handler for the /v2/token endpoint
async function handleTokenRequest(request) {
    const url = new URL(request.url);
    const searchParams = url.searchParams;
    const service = searchParams.get('service');
    const scope = searchParams.get('scope');

    // The actual token server is at auth.docker.io
    // The actual token server is at auth.docker.io
    // URL-encode service and scope parameters
    const encodedService = encodeURIComponent(service);
    const encodedScope = encodeURIComponent(scope);
    const tokenUrl = `https://auth.docker.io/token?service=${encodedService}&scope=${encodedScope}`;
    
    console.log(`Requesting token from: ${tokenUrl}`);

    // Forward all original request headers to the token server
    const headers = new Headers(request.headers);
    // Remove host header as it will be set by fetch to auth.docker.io
    headers.delete('host'); 

    const tokenResponse = await fetch(tokenUrl, { headers });
    
    return tokenResponse;
}

/**
 * Main request handler, acts as a router.
 * @param {Request} request - The incoming request
 * @returns {Promise<Response>} - The response
 */
async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/v2/token') {
      return handleTokenRequest(request);
    }
    // All other requests go to the main API handler
    return handleApiRequest(request);
  } catch (error) {
    console.error(`Critical error in router handleRequest:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
