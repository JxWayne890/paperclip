import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignedAttestedBackupEnvelope } from "../services/attested-backup-config-recovery-envelope.ts";

const signingSecret = "test-only-signing-key";
const domain = "paperclip-attested-backup-recovery/private-pipe/v1|";

function signed(payload: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(payload));
  const mac = createHmac("sha256", signingSecret).update(domain).update(raw).digest("hex");
  return Buffer.from(JSON.stringify({ version: 1, mac, payloadBase64: raw.toString("base64") }));
}

describe("attested backup private envelope", () => {
  const payload = {
    version: 1,
    operationId: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-000000000002",
    agentId: "00000000-0000-4000-8000-000000000003",
    backupCheckpointId: "00000000-0000-4000-8000-000000000004",
    verifiedBackupSha256: "a".repeat(64),
    backupCreatedAt: "2026-07-21T15:47:25.000Z",
    latestRevisionId: "00000000-0000-4000-8000-000000000005",
    latestRevisionCreatedAt: "2026-07-21T15:30:00.000Z",
    activityAnchor: { id: "00000000-0000-4000-8000-000000000006", createdAt: "2026-07-21T15:31:00.000Z" },
    agent: { adapterConfig: { protectedField: { type: "plain", value: "fixture" } } },
  };

  it("accepts only a valid signed private payload", () => {
    expect(verifySignedAttestedBackupEnvelope(signed(payload), signingSecret).agent).toEqual(payload.agent);
  });

  it("rejects caller-provided, replayed-with-new-content, and wrong-key payloads", () => {
    expect(() => verifySignedAttestedBackupEnvelope(Buffer.from(JSON.stringify(payload)), signingSecret)).toThrow(/signed/i);
    const tampered = JSON.parse(signed(payload).toString("utf8")) as { payloadBase64: string };
    tampered.payloadBase64 = Buffer.from(JSON.stringify({ ...payload, agent: { changed: true } })).toString("base64");
    expect(() => verifySignedAttestedBackupEnvelope(Buffer.from(JSON.stringify(tampered)), signingSecret)).toThrow(/authentication/i);
    expect(() => verifySignedAttestedBackupEnvelope(signed(payload), "wrong-key")).toThrow(/authentication/i);
  });
});
