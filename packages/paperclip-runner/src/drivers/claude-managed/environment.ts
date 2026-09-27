/**
 * Builds the complete environment visible to runnerd for Claude Managed
 * execution. Remote providers receive governed inline tool definitions in the
 * durable descriptor, never a Paperclip MCP URL or capability token.
 */
export function createSanitizedClaudeManagedEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "RUST_BACKTRACE",
    "ANTHROPIC_API_KEY",
  ] as const) {
    const value = source[key];
    if (typeof value !== "string") continue;
    // A Claude.ai credential (`sk-ant-oat…` access token, `sk-ant-ort…`
    // refresh token, `sk-ant-sid…` session key) is never an API key and never
    // reaches runnerd, whatever allowlisted key carries it.
    if (/^sk-ant-(oat|ort|sid)/.test(value.trim().toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

/**
 * AgentCore uses workload identity from a private runner home. Long-lived AWS
 * access keys, shared profiles, executable credential configuration, and
 * Paperclip capability credentials are excluded.
 */
export function createSanitizedAwsAgentCoreEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  isolatedHome: string,
): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const result: NodeJS.ProcessEnv = { HOME: isolatedHome };
  for (const key of [
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "RUST_BACKTRACE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  ] as const) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}
