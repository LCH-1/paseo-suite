import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { MAX_BYTES, snapshotSchema, type Snapshot } from "../shared/model";

const derive = promisify(pbkdf2);
const iterations = 600_000;
const aad = Buffer.from("paseo-settings-sync:v1");
const localMaxBytes = MAX_BYTES * 3;
const envelopeSchema = z.strictObject({
  version: z.literal(1), cipher: z.literal("aes-256-gcm"), kdf: z.literal("pbkdf2-sha256"),
  iterations: z.literal(iterations), salt: z.string(), iv: z.string(), tag: z.string(), data: z.string(),
});

function decode(value: string, length?: number) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("암호화 데이터 형식이 올바르지 않습니다.");
  const buffer = Buffer.from(value, "base64");
  if (length !== undefined && buffer.length !== length) throw new Error("암호화 데이터 길이가 올바르지 않습니다.");
  return buffer;
}

async function seal(value: unknown, password: string, context: Buffer, limit = MAX_BYTES) {
  if (password.length < 12) throw new Error("복구 암호를 12자 이상 입력하세요.");
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > limit) throw new Error(limit === MAX_BYTES ? "백업 크기는 5 MiB를 넘을 수 없습니다." : "암호화할 로컬 동기화 상태의 크기 제한을 초과했습니다.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derive(password, salt, iterations, 32, "sha256");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(context);
    const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, cipher: "aes-256-gcm", kdf: "pbkdf2-sha256", iterations,
      salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  } finally { key.fill(0); }
}

async function open(raw: string, password: string, context: Buffer, limit = MAX_BYTES): Promise<unknown> {
  if (Buffer.byteLength(raw) > limit * 1.5) throw new Error("백업 크기 제한을 초과했습니다.");
  const envelope = envelopeSchema.parse(JSON.parse(raw));
  const key = await derive(password, decode(envelope.salt, 16), iterations, 32, "sha256");
  let plain: string;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12));
    cipher.setAAD(context);
    cipher.setAuthTag(decode(envelope.tag, 16));
    plain = Buffer.concat([cipher.update(decode(envelope.data)), cipher.final()]).toString("utf8");
  } catch {
    throw new Error("복구 암호가 다르거나 백업이 손상되었습니다.");
  } finally { key.fill(0); }
  if (Buffer.byteLength(plain) > limit) throw new Error("복호화한 데이터의 크기 제한을 초과했습니다.");
  try { return JSON.parse(plain); } catch { throw new Error("복호화한 백업 형식이 올바르지 않습니다."); }
}

export async function encrypt(snapshot: Snapshot, password: string) {
  const version = snapshot.version === 3 || snapshot.client.hostSettings || snapshot.client.preferenceCoverage ? 3 : snapshot.credentials?.records.length ? 2 : snapshot.version;
  const { localHostIds: _localHostIds, ...client } = snapshot.client;
  return seal(snapshotSchema.parse({ ...snapshot, client, version }), password, aad);
}
export async function decrypt(raw: string, password: string): Promise<Snapshot> {
  const parsed = snapshotSchema.safeParse(await open(raw, password, aad));
  if (!parsed.success) throw new Error("백업 형식을 지원하지 않거나 프로바이더 연결이 올바르지 않습니다. 연결한 PC의 Settings Sync를 최신 버전으로 업데이트하세요.");
  return parsed.data;
}
const localStateContext = Buffer.from("paseo-settings-sync:local-state:v1");
export async function encryptLocal(value: unknown, password: string) { return seal(value, password, localStateContext, localMaxBytes); }
export async function decryptLocal(raw: string, password: string) { return open(raw, password, localStateContext, localMaxBytes); }
