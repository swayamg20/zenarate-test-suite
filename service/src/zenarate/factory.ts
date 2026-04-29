import { ZenLabsClient } from "zenlabs-web-typescript";

export interface ClientConfig {
  baseUrl?: string;
  tenantId?: string;
  token?: string;
  username?: string;
  password?: string;
}

export async function createClient(cfg?: ClientConfig): Promise<ZenLabsClient> {
  const baseUrl =
    cfg?.baseUrl ?? process.env.ZENARATE_API_BASE ?? "https://zenarate-web-prod.fly.dev";
  const tenantId = cfg?.tenantId ?? process.env.ZENARATE_TENANT_ID;
  if (!tenantId) throw new Error("ZENARATE_TENANT_ID is required (numeric, NOT slug)");

  // Option B: direct token
  let token = cfg?.token ?? process.env.ZENARATE_TOKEN;

  // Option A: programmatic loin via BasicAuth
  if (!token) {
    const username = cfg?.username ?? process.env.ZENARATE_USERNAME;
    const password = cfg?.password ?? process.env.ZENARATE_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "Either ZENARATE_TOKEN or ZENARATE_USERNAME + ZENARATE_PASSWORD required",
      );
    }
    const tempClient = new ZenLabsClient({ baseUrl });
    const basic = Buffer.from(`${username}:${password}`).toString("base64");
    const login = await tempClient.auth.tokenAuthLoginCreate({
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!login.token) throw new Error("Login succeeded but no token returned");
    token = login.token;
    console.log(
      JSON.stringify({ step: "auth", method: "basic_auth", user: login.user?.username }),
    );
  }

  return new ZenLabsClient({ token, baseUrl, tenantId });
}

export function clientFromEnv(): Promise<ZenLabsClient> {
  return createClient();
}
