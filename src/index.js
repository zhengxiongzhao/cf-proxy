// 配置
const DEFAULT_HEADERS = ['accept', 'content-type', 'authorization'];

// API 配置类型定义
/**
 * @typedef {Object} ApiConfig
 * @property {string} baseUrl - API 的基础 URL
 * @property {string[]} [allowedHeaders] - 允许转发的请求头
 */

/**
 * @typedef {Object} ApiGroup
 * @property {string} prefix - API 组的前缀
 * @property {ApiConfig} config - API 配置对象
 */

// AI API 配置
const aiApis = {
  prefix: '/ai',
  config: {
    discord: {
      baseUrl: 'https://discord.com/api'
    },
    telegram: {
      baseUrl: 'https://api.telegram.org'
    },
    openai: {
      baseUrl: 'https://api.openai.com'
    },
    claude: {
      baseUrl: 'https://api.anthropic.com',
      allowedHeaders: ['anthropic-version']
    },
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com',
      allowedHeaders: ['x-goog-api-key']
    },
    meta: {
      baseUrl: 'https://www.meta.ai/api'
    },
    groq: {
      baseUrl: 'https://api.groq.com/openai'
    },
    xai: {
      baseUrl: 'https://api.x.ai',
      allowedHeaders: ['x-api-key']
    },
    cohere: {
      baseUrl: 'https://api.cohere.ai'
    },
    huggingface: {
      baseUrl: 'https://api.huggingface.co'
    },
    together: {
      baseUrl: 'https://api.together.ai'
    },
    novita: {
      baseUrl: 'https://api.novita.ai'
    },
    portkey: {
      baseUrl: 'https://api.portkey.ai'
    },
    fireworks: {
      baseUrl: 'https://api.fireworks.ai'
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api'
    }
  }
};

// Docker/K8s Registry 配置
const registryApis = {
  prefix: '/registry',
  config: {
    'docker/elastic': {
      baseUrl: 'https://docker.elastic.co'
    },
    'docker/hub': {
      baseUrl: 'https://docker.io'
    },
    google: {
      baseUrl: 'https://gcr.io'
    },
    github: {
      baseUrl: 'https://ghcr.io'
    },
    k8s: {
      baseUrl: 'https://registry.k8s.io'
    },
    microsoft: {
      baseUrl: 'https://mcr.microsoft.com'
    },
    nvidia: {
      baseUrl: 'https://nvcr.io'
    },
    quay: {
      baseUrl: 'https://quay.io'
    },
    ollama: {
      baseUrl: 'https://registry.ollama.ai'
    }
  }
};

// 合并所有配置
const mergeConfigs = (apiGroups) => {
  const config = {};
  for (const group of apiGroups) {
    for (const [key, configItem] of Object.entries(group.config)) {
      config[`${group.prefix}/${key}`] = configItem;
    }
  }
  return config;
};

// 生成最终配置
const allConfig = mergeConfigs([aiApis, registryApis]);

// 使用 allConfig 作为 apiMapping
const apiMapping = allConfig;

// 在处理请求时，将默认头和特定头合并
function getHeadersForApi(prefix) {
  const config = apiMapping[prefix];
  if (!config.allowedHeaders) {
    return DEFAULT_HEADERS;
  }
  return [...DEFAULT_HEADERS, ...config.allowedHeaders];
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;

  console.log(`Received request: ${request.method} ${pathname}${search}`);

  // 处理根路径和 index.html
  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Service is running!', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // 处理 robots.txt
  if (pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // 提取 API 前缀和剩余路径
  const [prefix, rest] = extractPrefixAndRest(pathname, Object.keys(apiMapping));
  console.log(`Extracted prefix: ${prefix}, rest: ${rest}`);

  // 如果找不到匹配的前缀，返回 404
  if (!prefix) {
    console.log(`No matching prefix found for path: ${pathname}`);
    console.log('Available prefixes:', Object.keys(apiMapping));
    return new Response('Not Found', { status: 404 });
  }

  try {
    // 创建请求头
    const headers = new Headers();
    
    // 转发必要的头
    ['accept', 'content-type', 'authorization', 'user-agent'].forEach(key => {
      if (request.headers.has(key.toLowerCase())) {
        headers.set(key, request.headers.get(key.toLowerCase()));
      }
    });

    // 如果是 registry 请求，特殊处理
    if (prefix.startsWith('/registry/')) {
      // 获取 registry 类型
      const registryType = prefix.split('/')[2];
      console.log(`Handling registry request: ${registryType}`);

      // 构建目标 URL
      const targetUrl = `${apiMapping[prefix].baseUrl}${rest.startsWith('/') ? rest : `/${rest}`}${search}`;
      console.log(`Target URL: ${targetUrl}`);

      // 特殊处理 Docker Hub
      if (registryType === 'docker/hub') {
        // Docker Hub 需要特殊处理
        const dockerHubUrl = `https://registry-1.docker.io${rest.startsWith('/') ? rest : `/${rest}`}${search}`;
        console.log(`Docker Hub request: ${dockerHubUrl}`);
        
        // 发起请求
        const response = await fetch(dockerHubUrl, {
          method: request.method,
          headers: headers,
          body: request.body
        });

        // 创建响应
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('X-Content-Type-Options', 'nosniff');
        responseHeaders.set('X-Frame-Options', 'DENY');
        responseHeaders.set('Referrer-Policy', 'no-referrer');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }

      // 其他 registry 直接转发
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.body
      });

      // 创建响应
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      responseHeaders.set('X-Frame-Options', 'DENY');
      responseHeaders.set('Referrer-Policy', 'no-referrer');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    // 非 registry 请求，使用通用处理逻辑
    const targetUrl = `${apiMapping[prefix].baseUrl}${rest.startsWith('/') ? rest : `/${rest}`}${search}`;
    console.log(`Target URL: ${targetUrl}`);

    // 获取当前 API 的允许头配置
    const config = apiMapping[prefix];
    const allowedHeaders = config.allowedHeaders || [];

    // 遍历原始请求头，只复制允许的头
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (allowedHeaders.includes(lowerKey)) {
        headers.set(key, value);
        console.log(`Forwarding header: ${key}: ${value.startsWith('sk-') || value.startsWith('AIza') ? '***' : value}`);
      }
    }

    console.log(`Forwarding request to: ${targetUrl}`);

    // 发起实际的 fetch 请求到目标 API
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body
    });

    // 创建响应
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    responseHeaders.set('X-Frame-Options', 'DENY');
    responseHeaders.set('Referrer-Policy', 'no-referrer');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    console.error(`Failed to fetch ${targetUrl}:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

function extractPrefixAndRest(pathname, prefixes) {
  // 添加斜杠前缀以确保正确匹配
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  
  for (const prefix of prefixes) {
    if (normalizedPath.startsWith(prefix)) {
      const rest = normalizedPath.slice(prefix.length);
      return [prefix, rest];
    }
  }
  return [null, null];
}