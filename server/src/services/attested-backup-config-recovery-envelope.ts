import { createHmac, timingSafeEqual } from "node:crypto";

export interface AttestedBackupEnvelope {
  version: 1;
  operationId: string;
  companyId: string;
  agentId: string;
  backupCheckpointId: string;
  verifiedBackupSha256: string;
  backupCreatedAt: string;
  latestRevisionId: string;
  latestRevisionCreatedAt: string;
  gateLatestRevisionId: string;
  activityAnchor: { id: string; createdAt: string } | null;
  agent: unknown;
  gateAgent: unknown;
}

type SignedBackupEnvelope = {
  version: 1;
  mac: string;
  payloadBase64: string;
};

const PRIVATE_PIPE_DOMAIN = "paperclip-attested-backup-recovery/private-pipe/v1|";

/**
 * A caller cannot turn the root-only pipe into a config restore input: the
 * payload must be authenticated with the server's existing private key before
 * it is parsed as a backup row.
 */
export function verifySignedAttestedBackupEnvelope(raw: Buffer, signingSecret: string): AttestedBackupEnvelope {
  if (raw.length === 0 || raw.length > 24 * 1024 * 1024 || !signingSecret) throw new Error("invalid backup input");
  const signed = JSON.parse(raw.toString("utf8")) as Partial<SignedBackupEnvelope>;
  if (
    signed.version !== 1 ||
    typeof signed.mac !== "string" ||
    !/^[0-9a-f]{64}$/i.test(signed.mac) ||
    typeof signed.payloadBase64 !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.payloadBase64)
  ) {
    throw new Error("invalid signed backup envelope");
  }
  const payload = Buffer.from(signed.payloadBase64, "base64");
  if (payload.length === 0 || payload.length > 16 * 1024 * 1024) throw new Error("invalid backup payload");
  const expectedMac = createHmac("sha256", signingSecret).update(PRIVATE_PIPE_DOMAIN).update(payload).digest();
  const suppliedMac = Buffer.from(signed.mac, "hex");
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    throw new Error("private backup envelope authentication failed");
  }
  const value = JSON.parse(payload.toString("utf8")) as Partial<AttestedBackupEnvelope>;
  if (
    value.version !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.companyId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.backupCheckpointId !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.verifiedBackupSha256 ?? "") ||
    typeof value.backupCreatedAt !== "string" ||
    typeof value.latestRevisionId !== "string" ||
    typeof value.latestRevisionCreatedAt !== "string" ||
    typeof value.gateLatestRevisionId !== "string" ||
    !(value.activityAnchor === null || (typeof value.activityAnchor?.id === "string" && typeof value.activityAnchor?.createdAt === "string")) ||
    value.agent === undefined ||
    value.gateAgent === undefined
  ) {
    throw new Error("invalid backup envelope");
  }
  return value as AttestedBackupEnvelope;
}
