import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import Constants from "expo-constants";

export const API_URL_KEY = "hi_api_url";
export const ACCESS_TOKEN_KEY = "hi_access_token";
export const REFRESH_TOKEN_KEY = "hi_refresh_token";

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.setItem(key, value); } catch {}
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.removeItem(key); } catch {}
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export function cleanUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    u = `http://${u}`;
  }
  return u.replace(/\/+$/, "");
}

export async function getApiUrl(): Promise<string> {
  const stored = await getItem(API_URL_KEY);
  if (stored) return cleanUrl(stored);
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri && Platform.OS !== "web") {
    const ip = hostUri.split(":")[0];
    if (ip && ip !== "localhost" && ip !== "127.0.0.1") {
      return `http://${ip}:8787`;
    }
  }
  return "http://localhost:8787";
}

export async function setApiUrl(url: string): Promise<void> {
  await setItem(API_URL_KEY, cleanUrl(url));
}

export async function getAccessToken(): Promise<string | null> {
  return getItem(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return getItem(REFRESH_TOKEN_KEY);
}

export async function setTokens(access: string, refresh: string): Promise<void> {
  await setItem(ACCESS_TOKEN_KEY, access.trim());
  await setItem(REFRESH_TOKEN_KEY, refresh.trim());
}

export async function clearTokens(): Promise<void> {
  await deleteItem(ACCESS_TOKEN_KEY);
  await deleteItem(REFRESH_TOKEN_KEY);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await getApiUrl();
  const token = await getAccessToken();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${base}${normalizedPath}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    const refresh = await getRefreshToken();
    if (refresh) {
      const r = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (r.ok) {
        const data = await r.json();
        await setTokens(data.accessToken, data.refreshToken);
        return apiFetch(path, init);
      }
    }
  }
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}