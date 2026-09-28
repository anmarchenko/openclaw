import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheReadOptions = {
  cache: boolean;
  latest?: boolean;
  projection?: "full" | "list";
  /** Stream full JSON once, retaining prompt snapshots only for selected rows. Never cached. */
  retainFullEntry?: (sessionKey: string, entry: SessionEntry) => boolean;
  /** Topology admits metadata first; its worker owns participant hydration. Never cache this view. */
  deferParticipants?: true;
};

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type SessionSharingEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "updatedAt"
  | "lifecycleRevision"
  | "archivedAt"
  | "visibility"
  | "incognito"
  | "createdActor"
  | "owner"
  | "sandbox"
  | "spawnedBy"
  | "parentSessionKey"
  | "sessionStartedAt"
>;

export function projectSessionSharingEntry(entry: SessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    archivedAt: entry.archivedAt,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    owner: entry.owner
      ? {
          ...entry.owner,
          actor: { ...entry.owner.actor },
          assignedBy: entry.owner.assignedBy ? { ...entry.owner.assignedBy } : undefined,
        }
      : undefined,
    sandbox: entry.sandbox,
    spawnedBy: entry.spawnedBy,
    parentSessionKey: entry.parentSessionKey,
    sessionStartedAt: entry.sessionStartedAt,
  };
}

/** Activity timestamps do not change the policy or incarnation held by an admitted reader. */
export function sessionSharingEntriesEqual(left: SessionSharingEntry, right: unknown) {
  if (!isRecord(right)) {
    return false;
  }
  const { updatedAt: _leftActivity, ...leftPolicy } = left;
  const { updatedAt: _rightActivity, ...rightPolicy } = right;
  return isDeepStrictEqual(leftPolicy, rightPolicy);
}

export type SessionEntryPlaceholder = Readonly<{ sessionId: string }>;

export type SessionTranscriptInitializationPublication = {
  kind: "session-transcript-initialized";
  sessionKey: string;
  placeholder?: SessionEntryPlaceholder;
};

const creationBrand = Symbol("sessionEntryCreation");
export type SessionEntryCreationOperation = Readonly<{ [creationBrand]: true }>;

/** Allocate an opaque token; the publication owner's WeakMap alone grants live custody. */
export function createSessionEntryCreationOperation(): SessionEntryCreationOperation {
  return Object.freeze({ [creationBrand]: true });
}
