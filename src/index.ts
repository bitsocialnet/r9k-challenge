import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type {
  ChallengeFileInput,
  ChallengeResultInput,
} from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import {
  DEFAULT_ERROR,
  optionInputs,
  parseOptions,
  type ParsedOptions,
} from "./schema.js";

const type = "text/plain";
const description =
  "Reject exact text reposts with Robot9001-style escalating temporary bans.";
const STATE_VERSION = 1;

const OriginalEntrySchema = z
  .object({
    firstSeenAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    normalizedLength: z.number().int().nonnegative(),
  })
  .strict();

const AuthorPenaltySchema = z
  .object({
    transgressions: z.number().int().nonnegative(),
    lastTransgressionAt: z.number().int().nonnegative(),
    banExpiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const CommunityStateSchema = z
  .object({
    originals: z.record(z.string(), OriginalEntrySchema),
    authors: z.record(z.string(), AuthorPenaltySchema),
  })
  .strict();

const StateFileSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    communities: z.record(z.string(), CommunityStateSchema),
  })
  .strict();

type AuthorPenalty = z.infer<typeof AuthorPenaltySchema>;
type CommunityState = z.infer<typeof CommunityStateSchema>;
type StateFile = z.infer<typeof StateFileSchema>;
type ChallengeRequest = DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

type PublicationTarget =
  | {
      kind: "comment";
      rawText: string;
      authorKey?: string;
      excludeCid?: string;
    }
  | {
      kind: "content-edit";
      rawText: string;
      authorKey?: string;
      excludeCid?: string;
    };

type R9kViolation =
  | "active-ban"
  | "missing-author"
  | "missing-text"
  | "unicode"
  | "too-short"
  | "duplicate";

const stateQueues = new Map<string, Promise<unknown>>();

type SqliteStatement = {
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  prepare: (query: string) => SqliteStatement;
};

type ExistingCommentRow = {
  cid?: string;
  title?: string | null;
  content?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const expandPath = (path: string) => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
};

const createEmptyState = (): StateFile => ({
  version: STATE_VERSION,
  communities: {},
});

const getCommunityState = (
  state: StateFile,
  communityKey: string,
): CommunityState => {
  state.communities[communityKey] ??= {
    originals: {},
    authors: {},
  };
  return state.communities[communityKey];
};

const readState = async (statePath: string): Promise<StateFile> => {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = StateFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      throw new Error(`Invalid Robot9001 state file: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return createEmptyState();
    throw error;
  }
};

const writeState = async (statePath: string, state: StateFile) => {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
};

const withState = async <T>(
  statePath: string,
  task: (state: StateFile) => Promise<T>,
): Promise<T> => {
  const previous = stateQueues.get(statePath) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const state = await readState(statePath);
      const result = await task(state);
      await writeState(statePath, state);
      return result;
    });
  const queued = run.catch(() => undefined);
  stateQueues.set(statePath, queued);

  try {
    return await run;
  } finally {
    if (stateQueues.get(statePath) === queued) {
      stateQueues.delete(statePath);
    }
  }
};

export const normalizeRobot9001Text = (
  text: string,
  { stripBacklinks }: Pick<ParsedOptions, "stripBacklinks">,
) => {
  const withoutBacklinks = stripBacklinks
    ? text.replace(/(^|\s)>>\d+\b/g, " ")
    : text;
  return withoutBacklinks.replace(/\s+/g, " ").trim();
};

const hasNonAscii = (text: string) => /[^\x00-\x7F]/.test(text);

const makeError = (options: ParsedOptions, message: string) =>
  `${options.error || DEFAULT_ERROR} ${message}`;

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp * 1000).toISOString();

const reject = (
  options: ParsedOptions,
  message: string,
): ChallengeResultInput => ({
  success: false,
  error: makeError(options, message),
});

const allow = (): ChallengeResultInput => ({ success: true });

const getRequestText = (
  request: ChallengeRequest,
): PublicationTarget | undefined => {
  if (isRecord(request.comment)) {
    const { comment } = request;
    const parts = [
      stringValue(comment.title),
      stringValue(comment.content),
    ].filter((part): part is string => part !== undefined);
    return {
      kind: "comment",
      rawText: parts.join("\n"),
      authorKey: getAuthorKey(comment),
      excludeCid: stringValue(comment.cid),
    };
  }

  if (
    isRecord(request.commentEdit) &&
    typeof request.commentEdit.content === "string"
  ) {
    return {
      kind: "content-edit",
      rawText: request.commentEdit.content,
      authorKey: getAuthorKey(request.commentEdit),
      excludeCid: stringValue(request.commentEdit.commentCid),
    };
  }

  return undefined;
};

const getAuthorKey = (publication: Record<string, unknown>) => {
  if (isRecord(publication.author)) {
    const address = stringValue(publication.author.address);
    if (address) return `author-address:${address}`;

    const publicKey = stringValue(publication.author.publicKey);
    if (publicKey) return `author-public-key:${publicKey}`;
  }

  if (isRecord(publication.signature)) {
    const publicKey = stringValue(publication.signature.publicKey);
    if (publicKey) return `signature-public-key:${publicKey}`;
  }

  return undefined;
};

const decayPenalty = (
  penalty: AuthorPenalty | undefined,
  now: number,
  intervalSeconds: number,
): AuthorPenalty | undefined => {
  if (!penalty) return undefined;

  const activeBan =
    typeof penalty.banExpiresAt === "number" && penalty.banExpiresAt > now;
  if (intervalSeconds === 0 || penalty.transgressions === 0) {
    return activeBan ? penalty : { ...penalty, banExpiresAt: undefined };
  }

  const elapsed = Math.max(0, now - penalty.lastTransgressionAt);
  const decayCount = Math.floor(elapsed / intervalSeconds);
  if (decayCount === 0)
    return activeBan ? penalty : { ...penalty, banExpiresAt: undefined };

  const transgressions = Math.max(0, penalty.transgressions - decayCount);
  if (transgressions === 0 && !activeBan) return undefined;

  return {
    transgressions,
    lastTransgressionAt:
      penalty.lastTransgressionAt + decayCount * intervalSeconds,
    banExpiresAt: activeBan ? penalty.banExpiresAt : undefined,
  };
};

const getPenaltySeconds = (transgressions: number, options: ParsedOptions) => {
  const penaltySeconds = options.penaltyBaseSeconds ** transgressions;
  if (options.maxPenaltySeconds !== undefined)
    return Math.min(penaltySeconds, options.maxPenaltySeconds);
  return penaltySeconds;
};

const registerViolation = ({
  communityState,
  authorKey,
  now,
  options,
}: {
  communityState: CommunityState;
  authorKey: string;
  now: number;
  options: ParsedOptions;
}) => {
  const decayed = decayPenalty(
    communityState.authors[authorKey],
    now,
    options.transgressionDecayIntervalSeconds,
  );
  const transgressions = (decayed?.transgressions ?? 0) + 1;
  const penaltySeconds = getPenaltySeconds(transgressions, options);
  const banExpiresAt = now + penaltySeconds;

  communityState.authors[authorKey] = {
    transgressions,
    lastTransgressionAt: now,
    banExpiresAt,
  };

  return { transgressions, penaltySeconds, banExpiresAt };
};

const getViolationMessage = ({
  violation,
  normalizedLength,
  minimumOriginalContentLength,
  banExpiresAt,
  penaltySeconds,
  transgressions,
}: {
  violation: R9kViolation;
  normalizedLength?: number;
  minimumOriginalContentLength?: number;
  banExpiresAt?: number;
  penaltySeconds?: number;
  transgressions?: number;
}) => {
  if (violation === "active-ban") {
    return `You are temporarily banned from posting until ${formatTimestamp(banExpiresAt ?? 0)}.`;
  }
  if (violation === "missing-author") {
    return "The author identity could not be verified for Robot9001 enforcement.";
  }
  if (violation === "missing-text") {
    return "Posts require text.";
  }
  if (violation === "unicode") {
    return "Unicode is not allowed on this board.";
  }
  if (violation === "too-short") {
    return `Posts require at least ${minimumOriginalContentLength ?? 0} original text characters after normalization; this post has ${normalizedLength ?? 0}.`;
  }

  const penalty =
    penaltySeconds === 1 ? "1 second" : `${penaltySeconds ?? 0} seconds`;
  return `Exact repost detected. Temporary ban: ${penalty} (transgression ${transgressions ?? 0}).`;
};

const isSqliteDatabase = (value: unknown): value is SqliteDatabase =>
  isRecord(value) && typeof value.prepare === "function";

const getCommunityDatabase = (community: unknown) => {
  if (!isRecord(community) || !isRecord(community._dbHandler)) return undefined;
  const db = community._dbHandler._db;
  return isSqliteDatabase(db) ? db : undefined;
};

const isExistingCommentRow = (row: unknown): row is ExistingCommentRow =>
  isRecord(row) &&
  (row.cid === undefined || typeof row.cid === "string") &&
  (row.title === undefined ||
    row.title === null ||
    typeof row.title === "string") &&
  (row.content === undefined ||
    row.content === null ||
    typeof row.content === "string");

const getStoredCommentText = (row: ExistingCommentRow) =>
  [row.title ?? undefined, row.content ?? undefined]
    .filter((part): part is string => part !== undefined)
    .join("\n");

const queryExistingCommentRows = (
  db: SqliteDatabase,
  excludeCid: string | undefined,
) =>
  db
    .prepare(
      `
      SELECT c.cid, c.title, c.content
      FROM comments c
      LEFT JOIN commentUpdates cu ON cu.cid = c.cid
      WHERE (? IS NULL OR c.cid != ?)
        AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
        AND COALESCE(cu.approved, 1) != 0
        AND (cu.removed IS NULL OR cu.removed IS NOT 1)
        AND (
            cu.edit IS NULL
            OR json_extract(cu.edit, '$.deleted') IS NULL
            OR json_extract(cu.edit, '$.deleted') != 1
        )
      ORDER BY c.rowid ASC
      `,
    )
    .all(excludeCid ?? null, excludeCid ?? null)
    .filter(isExistingCommentRow);

const communityDatabaseHasOriginal = ({
  db,
  target,
  normalizedText,
  options,
}: {
  db: SqliteDatabase;
  target: PublicationTarget;
  normalizedText: string;
  options: ParsedOptions;
}) =>
  queryExistingCommentRows(db, target.excludeCid).some(
    (row) =>
      normalizeRobot9001Text(getStoredCommentText(row), options) ===
      normalizedText,
  );

const checkOriginality = async ({
  target,
  communityKey,
  db,
  options,
}: {
  target: PublicationTarget;
  communityKey: string;
  db: SqliteDatabase;
  options: ParsedOptions;
}): Promise<ChallengeResultInput> => {
  const normalizedText = normalizeRobot9001Text(target.rawText, options);
  const statePath = expandPath(options.statePath);
  const now = nowSeconds();

  return withState(statePath, async (state) => {
    const communityState = getCommunityState(state, communityKey);

    if (!target.authorKey) {
      return reject(
        options,
        getViolationMessage({ violation: "missing-author" }),
      );
    }

    const currentPenalty = decayPenalty(
      communityState.authors[target.authorKey],
      now,
      options.transgressionDecayIntervalSeconds,
    );
    if (currentPenalty) {
      communityState.authors[target.authorKey] = currentPenalty;
    } else {
      delete communityState.authors[target.authorKey];
    }

    if (currentPenalty?.banExpiresAt && currentPenalty.banExpiresAt > now) {
      return reject(
        options,
        getViolationMessage({
          violation: "active-ban",
          banExpiresAt: currentPenalty.banExpiresAt,
        }),
      );
    }

    const violation = getTextViolation({
      rawText: target.rawText,
      normalizedText,
      options,
    });
    if (violation) {
      const penalty = registerViolation({
        communityState,
        authorKey: target.authorKey,
        now,
        options,
      });
      return reject(
        options,
        `${getViolationMessage({
          violation,
          normalizedLength: normalizedText.length,
          minimumOriginalContentLength: options.minimumOriginalContentLength,
        })} Temporary ban: ${penalty.penaltySeconds} seconds (transgression ${penalty.transgressions}).`,
      );
    }

    const normalizedHash = sha256(normalizedText);
    if (
      communityState.originals[normalizedHash] ||
      communityDatabaseHasOriginal({ db, target, normalizedText, options })
    ) {
      const penalty = registerViolation({
        communityState,
        authorKey: target.authorKey,
        now,
        options,
      });
      return reject(
        options,
        getViolationMessage({
          violation: "duplicate",
          penaltySeconds: penalty.penaltySeconds,
          transgressions: penalty.transgressions,
          banExpiresAt: penalty.banExpiresAt,
        }),
      );
    }

    communityState.originals[normalizedHash] = {
      firstSeenAt: now,
      lastSeenAt: now,
      normalizedLength: normalizedText.length,
    };

    return allow();
  });
};

const getTextViolation = ({
  rawText,
  normalizedText,
  options,
}: {
  rawText: string;
  normalizedText: string;
  options: ParsedOptions;
}): R9kViolation | undefined => {
  if (options.requireText && rawText.trim().length === 0) return "missing-text";
  if (options.blockUnicode && hasNonAscii(rawText)) return "unicode";
  if (normalizedText.length < options.minimumOriginalContentLength)
    return "too-short";
  return undefined;
};

const getCommunityKey = (community: unknown) => {
  if (!isRecord(community)) return "unknown-community";
  return (
    stringValue(community.address) ??
    stringValue(community.name) ??
    stringValue(community.title) ??
    "unknown-community"
  );
};

const getChallenge = async ({
  challengeRequestMessage,
  community,
  challengeSettings,
}: {
  challengeRequestMessage: ChallengeRequest;
  community: unknown;
  challengeSettings: unknown;
}): Promise<ChallengeResultInput> => {
  const parsedOptions = parseOptions(challengeSettings);
  if (!parsedOptions.success) {
    return {
      success: false,
      error: `${DEFAULT_ERROR} Invalid options: ${parsedOptions.error.message}`,
    };
  }

  const target = getRequestText(challengeRequestMessage);
  if (!target) return allow();

  const db = getCommunityDatabase(community);
  if (!db) {
    return reject(
      parsedOptions.data,
      "Robot9001 community database is unavailable.",
    );
  }

  try {
    return await checkOriginality({
      target,
      communityKey: getCommunityKey(community),
      db,
      options: parsedOptions.data,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown state error";
    return reject(
      parsedOptions.data,
      `Robot9001 state unavailable: ${message}`,
    );
  }
};

function ChallengeFileFactory(_challengeSettings: unknown): ChallengeFileInput {
  return { getChallenge, optionInputs, type, description };
}

export default ChallengeFileFactory;
