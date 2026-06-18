export interface IdentityKeys {
  publicKey: string;
  privateKey: string;
  signature: string;
}

function base64urlFromBinary(binary: string): string {
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function binaryFromBase64url(input: string): string {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  return atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function utf8ToBase64url(text: string): string {
  return base64urlFromBinary(unescape(encodeURIComponent(text)));
}

function base64urlToUtf8(input: string): string {
  return decodeURIComponent(escape(binaryFromBase64url(input)));
}

function bytesToBase64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return base64urlFromBinary(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64urlToBytes(input: string): ArrayBuffer {
  const binary = binaryFromBase64url(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return toArrayBuffer(out);
}

export function identityPayload(uid: string, publicKey: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(`obsidian-collab-identity-v1\n${uid}\n${publicKey}`));
}

async function verifyIdentity(uid: string, publicKey: string, signature: string): Promise<boolean> {
  try {
    const jwk = JSON.parse(base64urlToUtf8(publicKey));
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlToBytes(signature),
      identityPayload(uid, publicKey)
    );
  } catch {
    return false;
  }
}

async function signIdentity(uid: string, publicKey: string, privateKey: string): Promise<string> {
  const jwk = JSON.parse(base64urlToUtf8(privateKey));
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, identityPayload(uid, publicKey));
  return bytesToBase64url(sig);
}

export async function ensureIdentityKeys(existing: Partial<IdentityKeys>, uid: string): Promise<IdentityKeys> {
  if (existing.publicKey && existing.privateKey) {
    if (existing.signature && await verifyIdentity(uid, existing.publicKey, existing.signature)) {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey, signature: existing.signature };
    }
    try {
      const signature = await signIdentity(uid, existing.publicKey, existing.privateKey);
      return { publicKey: existing.publicKey, privateKey: existing.privateKey, signature };
    } catch {
      // Fall through and replace a corrupt local keypair.
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = utf8ToBase64url(JSON.stringify(publicJwk));
  const privateKey = utf8ToBase64url(JSON.stringify(privateJwk));
  const signature = await signIdentity(uid, publicKey, privateKey);
  return { publicKey, privateKey, signature };
}

export async function verifyIdentityForTest(uid: string, publicKey: string, signature: string): Promise<boolean> {
  return verifyIdentity(uid, publicKey, signature);
}
