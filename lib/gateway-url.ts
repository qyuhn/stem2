export function buildGatewayUrl(port: number, path: string, params?: Record<string, string>, host?: string): string {
  const url = new URL(`http://localhost:${port}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined) url.searchParams.set(k, v);
    });
  }
  if (host) url.host = host;
  return url.toString();
}