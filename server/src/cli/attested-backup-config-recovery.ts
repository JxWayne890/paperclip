import { createDb } from "@paperclipai/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, fstat } from "node:fs";
import { promisify } from "node:util";
import {
  applyAttestedBackupRecovery,
  discoverAttestedBackupRecoveryLineage,
  inspectAttestedBackupRecovery,
  type AttestedBackupRecoveryInput,
} from "../services/attested-backup-config-recovery.js";

type Mode = "discover" | "inspect" | "apply";

type BackupEnvelope = {
  version: 1;
  operationId: string;
  companyId: string;
  agentId: string;
  backupCheckpointId: string;
  verifiedBackupSha256: string;
  backupCreatedAt: string;
  latestRevisionId: string;
  latestRevisionCreatedAt: string;
  activityAnchor: { id: string; createdAt: string } | null;
  agent: unknown;
};

type SignedBackupEnvelope = {
  version: 1;
  mac: string;
  payloadBase64: string;
};

function parseArgs(argv: string[]): { mode: Mode; identifiers: Omit<AttestedBackupRecoveryInput, "backupCreatedAt" | "backupAgent" | "backupLatestRevisionId" | "backupLatestRevisionCreatedAt" | "backupActivityAnchor"> } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new Error("invalid arguments");
    values.set(key, value);
  }
  const modeValue = values.get("--mode");
  if (modeValue !== "discover" && modeValue !== "inspect" && modeValue !== "apply") throw new Error("invalid mode");
  const required = [
    "--operation-id",
    "--company-id",
    "--agent-id",
    "--expected-head-revision-id",
    "--cutover-revision-id",
    "--predecessor-revision-id",
    "--backup-checkpoint-id",
  ] as const;
  const discoveryRequired = ["--operation-id", "--company-id", "--agent-id"] as const;
  const requiredForMode = modeValue === "discover" ? discoveryRequired : required;
  if (values.size !== requiredForMode.length + 1 || requiredForMode.some((key) => !values.has(key))) throw new Error("incomplete arguments");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const read = (key: (typeof required)[number] | (typeof discoveryRequired)[number]) => {
    const value = values.get(key)!;
    if (!uuid.test(value)) throw new Error("invalid opaque identifier");
    return value;
  };
  return {
    mode: modeValue,
    identifiers: {
      operationId: read("--operation-id"),
      companyId: read("--company-id"),
      agentId: read("--agent-id"),
      expectedHeadRevisionId: modeValue === "discover" ? "00000000-0000-4000-8000-000000000000" : read("--expected-head-revision-id"),
      cutoverRevisionId: modeValue === "discover" ? "00000000-0000-4000-8000-000000000000" : read("--cutover-revision-id"),
      predecessorRevisionId: modeValue === "discover" ? "00000000-0000-4000-8000-000000000000" : read("--predecessor-revision-id"),
      backupCheckpointId: modeValue === "discover" ? "00000000-0000-4000-8000-000000000000" : read("--backup-checkpoint-id"),
    },
  };
}

const fstatAsync = promisify(fstat);

/**
 * FD 3 is deliberately not an operator input. The reviewed root-only runner
 * creates it as a one-shot pipe after verifying and querying the backup. The
 * CLI never reads stdin, a path, environment payload, or a regular file.
 */
async function readPrivateEnvelope(): Promise<BackupEnvelope> {
  const descriptor = 3;
  const stat = await fstatAsync(descriptor).catch(() => null);
  if (!stat?.isFIFO() || process.stdin.isTTY) throw new Error("private recovery pipe required");
  const chunks: Buffer[] = [];
  const privatePipe = createReadStream("/dev/null", { fd: descriptor, autoClose: false });
  for await (const chunk of privatePipe) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  if (raw.length === 0 || raw.length > 24 * 1024 * 1024) throw new Error("invalid backup input");
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
  const signingSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!signingSecret) throw new Error("server signing secret unavailable");
  const expectedMac = createHmac("sha256", signingSecret)
    .update("paperclip-attested-backup-recovery/private-pipe/v1|")
    .update(payload)
    .digest();
  const suppliedMac = Buffer.from(signed.mac, "hex");
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    throw new Error("private backup envelope authentication failed");
  }
  const value = JSON.parse(payload.toString("utf8")) as Partial<BackupEnvelope>;
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
    !(value.activityAnchor === null || (typeof value.activityAnchor?.id === "string" && typeof value.activityAnchor?.createdAt === "string")) ||
    value.agent === undefined
  ) {
    throw new Error("invalid backup envelope");
  }
  return value as BackupEnvelope;
}

async function main() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("root-only recovery runner required");
  }
  const { mode, identifiers } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("database unavailable");
  const db = createDb(databaseUrl);
  if (mode === "discover") {
    try {
      const result = await discoverAttestedBackupRecoveryLineage(db, identifiers);
      process.stdout.write(`${JSON.stringify(result)}\\n`);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
    return;
  }
  const envelope = await readPrivateEnvelope();
  if (
    envelope.operationId !== identifiers.operationId ||
    envelope.companyId !== identifiers.companyId ||
    envelope.agentId !== identifiers.agentId ||
    envelope.backupCheckpointId !== identifiers.backupCheckpointId
  ) {
    throw new Error("private backup envelope scope mismatch");
  }
  try {
    const input: AttestedBackupRecoveryInput = {
      ...identifiers,
      backupCreatedAt: envelope.backupCreatedAt,
      backupAgent: envelope.agent,
      backupLatestRevisionId: envelope.latestRevisionId,
      backupLatestRevisionCreatedAt: envelope.latestRevisionCreatedAt,
      backupActivityAnchor: envelope.activityAnchor,
    };
    const result = mode === "inspect"
      ? await inspectAttestedBackupRecovery(db, input)
      : await applyAttestedBackupRecovery(db, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

void main().catch(() => {
  // The caller only learns a non-secret failure class; logging errors here can
  // otherwise serialize backup or database values through a dependency error.
  process.stdout.write('{"status":"rejected"}\n');
  process.exitCode = 1;
});
