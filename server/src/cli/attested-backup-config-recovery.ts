import { createDb } from "@paperclipai/db";
import { createReadStream, fstat } from "node:fs";
import { promisify } from "node:util";
import {
  applyAttestedBackupRecovery,
  discoverAttestedBackupRecoveryLineage,
  inspectAttestedBackupRecovery,
  releaseAttestedBackupRecoveryFence,
  type AttestedBackupRecoveryInput,
} from "../services/attested-backup-config-recovery.js";
import {
  verifySignedAttestedBackupEnvelope,
  type AttestedBackupEnvelope,
} from "../services/attested-backup-config-recovery-envelope.js";

type Mode = "discover" | "inspect" | "apply" | "release-fence";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): { mode: Mode; identifiers: Omit<AttestedBackupRecoveryInput, "backupCreatedAt" | "backupAgent" | "backupGateAgent" | "backupGateLatestRevisionId" | "backupLatestRevisionId" | "backupLatestRevisionCreatedAt" | "backupActivityAnchor"> } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new Error("invalid arguments");
    values.set(key, value);
  }
  const modeValue = values.get("--mode");
  if (modeValue !== "discover" && modeValue !== "inspect" && modeValue !== "apply" && modeValue !== "release-fence") throw new Error("invalid mode");
  const required = [
    "--operation-id",
    "--company-id",
    "--agent-id",
    "--expected-head-revision-id",
    "--cutover-revision-id",
    "--predecessor-revision-id",
    "--cutover-generation",
    "--cutover-required-patch",
    "--backup-checkpoint-id",
    "--gate-agent-id",
  ] as const;
  const discoveryRequired = ["--operation-id", "--company-id", "--agent-id", "--cutover-generation", "--cutover-required-patch"] as const;
  const releaseRequired = ["--operation-id", "--company-id", "--agent-id", "--gate-agent-id"] as const;
  const requiredForMode = modeValue === "inspect" || modeValue === "apply"
    ? required
    : modeValue === "discover" ? discoveryRequired : releaseRequired;
  if (values.size !== requiredForMode.length + 1 || requiredForMode.some((key) => !values.has(key))) throw new Error("incomplete arguments");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const read = (key: (typeof required)[number] | (typeof discoveryRequired)[number] | (typeof releaseRequired)[number]) => {
    const value = values.get(key)!;
    if (!uuid.test(value)) throw new Error("invalid opaque identifier");
    return value;
  };
  const readGeneration = (key: "--cutover-generation") => {
    const value = values.get(key)!;
    if (!/^g[0-9a-f]{24}$/.test(value)) throw new Error("invalid recovery generation");
    return value;
  };
  const readPatch = (key: "--cutover-required-patch") => {
    const value = values.get(key)!;
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("invalid recovery patch");
    return value;
  };
  return {
    mode: modeValue,
    identifiers: {
      operationId: read("--operation-id"),
      companyId: read("--company-id"),
      agentId: read("--agent-id"),
      expectedHeadRevisionId: modeValue === "inspect" || modeValue === "apply" ? read("--expected-head-revision-id") : "00000000-0000-4000-8000-000000000000",
      cutoverRevisionId: modeValue === "inspect" || modeValue === "apply" ? read("--cutover-revision-id") : "00000000-0000-4000-8000-000000000000",
      predecessorRevisionId: modeValue === "inspect" || modeValue === "apply" ? read("--predecessor-revision-id") : "00000000-0000-4000-8000-000000000000",
      cutoverGeneration: modeValue === "release-fence" ? "g000000000000000000000000" : readGeneration("--cutover-generation"),
      cutoverRequiredPatch: modeValue === "release-fence" ? "0000000000000000000000000000000000000000" : readPatch("--cutover-required-patch"),
      backupCheckpointId: modeValue === "inspect" || modeValue === "apply" ? read("--backup-checkpoint-id") : "00000000-0000-4000-8000-000000000000",
      gateAgentId: modeValue === "discover" ? "00000000-0000-4000-8000-000000000000" : read("--gate-agent-id"),
    },
  };
}

const fstatAsync = promisify(fstat);

/**
 * FD 3 is deliberately not an operator input. The reviewed root-only runner
 * creates it as a one-shot pipe after verifying and querying the backup. The
 * CLI never reads stdin, a path, environment payload, or a regular file.
 */
async function readPrivateEnvelope(): Promise<AttestedBackupEnvelope> {
  const descriptor = 3;
  const stat = await fstatAsync(descriptor).catch(() => null);
  if (!stat?.isFIFO() || process.stdin.isTTY) throw new Error("private recovery pipe required");
  const chunks: Buffer[] = [];
  const privatePipe = createReadStream("/dev/null", { fd: descriptor, autoClose: false });
  for await (const chunk of privatePipe) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  const signingSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!signingSecret) throw new Error("server signing secret unavailable");
  return verifySignedAttestedBackupEnvelope(raw, signingSecret);
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
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
    return;
  }
  if (mode === "release-fence") {
    try {
      const result = await releaseAttestedBackupRecoveryFence(db, identifiers);
      process.stdout.write(`${JSON.stringify(result)}\n`);
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
    !isRecord(envelope.gateAgent) || envelope.gateAgent.id !== identifiers.gateAgentId || envelope.gateAgent.companyId !== identifiers.companyId ||
    envelope.backupCheckpointId !== identifiers.backupCheckpointId
  ) {
    throw new Error("private backup envelope scope mismatch");
  }
  try {
    const input: AttestedBackupRecoveryInput = {
      ...identifiers,
      backupCreatedAt: envelope.backupCreatedAt,
      backupAgent: envelope.agent,
      backupGateAgent: envelope.gateAgent,
      backupGateLatestRevisionId: envelope.gateLatestRevisionId,
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
