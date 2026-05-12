function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  return String(baseUrl).replace(/\/+$/, "");
}

function normalizeApiPrefix(apiPathPrefix) {
  if (!apiPathPrefix) return "/api/v1";
  const trimmed = String(apiPathPrefix).trim();
  if (!trimmed) return "/api/v1";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

export async function resolveNoasBunkerUrl(noasConfig) {
  if (!noasConfig?.enabled) return null;
  if (!noasConfig.baseUrl || !noasConfig.username) {
    throw new Error("NOAS enabled but base_url or username is missing.");
  }

  const baseUrl = normalizeBaseUrl(noasConfig.baseUrl);
  const apiPrefix = normalizeApiPrefix(noasConfig.apiPathPrefix);
  const username = encodeURIComponent(String(noasConfig.username).trim().toLowerCase());
  const timeoutMs = Number(noasConfig.timeoutMs) || 10000;
  const url = `${baseUrl}${apiPrefix}/nip46/connect/${username}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NOAS connect failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const bunkerUrl = payload?.bunker_url;
    if (!bunkerUrl || !String(bunkerUrl).startsWith("bunker://")) {
      throw new Error("NOAS response did not include a valid bunker_url.");
    }
    return bunkerUrl;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`NOAS connect timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
