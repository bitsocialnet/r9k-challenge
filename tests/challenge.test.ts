import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory, { normalizeRobot9000Text } from "../src/index.js";

const baseCommunity = {
  address: "random.bso",
  title: "Random",
};

type StoredCommentRow = {
  cid: string;
  title?: string | null;
  content?: string | null;
};

type SqliteStoredCommentRow = StoredCommentRow & {
  pendingApproval?: number | null;
  approved?: number | null;
  removed?: number | null;
  edit?: string | null;
};

const createRuntimeCommunity = (rows: StoredCommentRow[] = []) => {
  const all = vi.fn((excludeCid: string | null) =>
    rows.filter((row) => excludeCid === null || row.cid !== excludeCid),
  );
  const prepare = vi.fn(() => ({ all }));

  return {
    community: {
      ...baseCommunity,
      _dbHandler: {
        _db: {
          prepare,
        },
      },
    },
    all,
    prepare,
  };
};

const createSqliteCommunity = (rows: SqliteStoredCommentRow[] = []) => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE comments (
      cid TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      pendingApproval INTEGER
    );

    CREATE TABLE commentUpdates (
      cid TEXT PRIMARY KEY,
      approved INTEGER,
      removed INTEGER,
      edit TEXT
    );
  `);

  const insertComment = db.prepare(`
    INSERT INTO comments (cid, title, content, pendingApproval)
    VALUES (?, ?, ?, ?)
  `);
  const insertUpdate = db.prepare(`
    INSERT INTO commentUpdates (cid, approved, removed, edit)
    VALUES (?, ?, ?, ?)
  `);

  const insertRow = (row: SqliteStoredCommentRow) => {
    insertComment.run(
      row.cid,
      row.title ?? null,
      row.content ?? null,
      row.pendingApproval ?? null,
    );

    if (
      row.approved !== undefined ||
      row.removed !== undefined ||
      row.edit !== undefined
    ) {
      insertUpdate.run(
        row.cid,
        row.approved ?? null,
        row.removed ?? null,
        row.edit ?? null,
      );
    }
  };

  rows.forEach(insertRow);

  return {
    community: {
      ...baseCommunity,
      _dbHandler: {
        _db: db,
      },
    },
    db,
    insertRow,
  };
};

let tempDir: string;
let statePath: string;

const settings = (options: Record<string, unknown> = {}) =>
  ({
    options: {
      statePath,
      minimumOriginalContentLength: "1",
      transgressionDecayIntervalSeconds: "86400",
      ...options,
    },
  }) as CommunityChallengeSetting;

const createCommentRequest = (
  content: string,
  overrides: {
    title?: string;
    link?: string;
    authorAddress?: string;
    signaturePublicKey?: string;
  } = {},
) =>
  ({
    comment: {
      title: overrides.title,
      content,
      link: overrides.link,
      author: {
        address: overrides.authorAddress ?? "author-1",
      },
      signature: {
        publicKey: overrides.signaturePublicKey ?? "author-public-key-1",
      },
    },
  }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createContentEditRequest = (
  content: string,
  {
    commentCid = "comment-1",
    authorAddress,
    signaturePublicKey = "author-public-key-1",
  }: {
    commentCid?: string;
    authorAddress?: string;
    signaturePublicKey?: string;
  } = {},
) =>
  ({
    commentEdit: {
      commentCid,
      content,
      ...(authorAddress ? { author: { address: authorAddress } } : {}),
      signature: {
        publicKey: signaturePublicKey,
      },
    },
  }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createVoteRequest = () =>
  ({
    vote: {
      commentCid: "comment-1",
      vote: 1,
    },
  }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

let storedComments: StoredCommentRow[];

const runChallenge = async (
  request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
  optionOverrides: Record<string, unknown> = {},
  runtimeCommunity?: unknown,
) => {
  const challengeFile = ChallengeFileFactory(settings(optionOverrides));
  const result = await challengeFile.getChallenge({
    challengeSettings: settings(optionOverrides),
    challengeRequestMessage: request,
    challengeIndex: 0,
    community:
      runtimeCommunity ?? createRuntimeCommunity(storedComments).community,
  });

  // The default community acts like a node whose only challenge is Robot9000:
  // it stores every accepted comment, so a later repost is found in its
  // comments database.
  if (
    runtimeCommunity === undefined &&
    request.comment &&
    "success" in result &&
    result.success
  ) {
    storedComments.push({
      cid: `stored-${storedComments.length + 1}`,
      title: request.comment.title,
      content: request.comment.content,
    });
  }

  return result;
};

const readState = async () =>
  JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "r9k-challenge-"));
  statePath = join(tempDir, "state.json");
  storedComments = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T00:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tempDir, { force: true, recursive: true });
});

describe("Robot9000 normalization", () => {
  it("strips numeric backlinks and collapses whitespace", () => {
    expect(
      normalizeRobot9000Text(">>2   lolwut\n\n>>123", { stripBacklinks: true }),
    ).toBe("lolwut");
    expect(
      normalizeRobot9000Text(">>2   lolwut", { stripBacklinks: false }),
    ).toBe(">>2 lolwut");
  });
});

describe("Bitsocial r9k challenge package", () => {
  it("exposes Robot9000 metadata and configurable defaults", () => {
    const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
    const options = challengeFile.optionInputs?.map((input) => input.option);

    expect(challengeFile.type).toBe("text/plain");
    expect(challengeFile.description).toMatch(/Robot9000/i);
    expect(options).toContain("statePath");
    expect(options).toContain("minimumOriginalContentLength");
    expect(options).toContain("transgressionDecayIntervalSeconds");
    expect(options).toContain("penaltyBaseSeconds");
    expect(options).toContain("blockUnicode");
    expect(options).toContain("stripBacklinks");
    expect(options).toContain("requireText");
  });

  it("allows unique text and persists only the normalized text hash", async () => {
    const result = await runChallenge(createCommentRequest("unique thought"));

    expect(result).toEqual({ success: true });
    const state = await readState();
    expect(JSON.stringify(state)).not.toContain("unique thought");
    expect(JSON.stringify(state)).toContain("normalizedLength");
  });

  it("rejects exact reposts already stored in the community comments database", async () => {
    const { community, prepare } = createRuntimeCommunity([
      { cid: "old-1", content: ">>7 existing thought" },
    ]);

    const result = await runChallenge(
      createCommentRequest("existing thought"),
      {},
      community,
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Exact repost detected");
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining("FROM comments"),
    );
  });

  it("queries a real SQLite comments database during getChallenge", async () => {
    const { community, db } = createSqliteCommunity([
      { cid: "old-1", content: ">>7 database original" },
    ]);

    try {
      const result = await runChallenge(
        createCommentRequest("database original"),
        {},
        community,
      );

      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain("Exact repost detected");
    } finally {
      db.close();
    }
  });

  it("ignores SQLite rows that are unapproved, removed, or deleted", async () => {
    const { community, db } = createSqliteCommunity([
      { cid: "unapproved", content: "held back", approved: 0 },
      {
        cid: "disapproved-from-queue",
        content: "held back",
        pendingApproval: 0,
        approved: 0,
      },
      { cid: "removed", content: "held back", removed: 1 },
      {
        cid: "deleted",
        content: "held back",
        edit: JSON.stringify({ deleted: true }),
      },
    ]);

    try {
      await expect(
        runChallenge(createCommentRequest("held back"), {}, community),
      ).resolves.toEqual({ success: true });
    } finally {
      db.close();
    }
  });

  it("fails closed when the community database is unavailable", async () => {
    const result = await runChallenge(
      createCommentRequest("unique but no database"),
      {},
      baseCommunity,
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("community database is unavailable");
  });

  it("rejects exact reposts after backlink normalization", async () => {
    await expect(runChallenge(createCommentRequest("lolwut"))).resolves.toEqual(
      { success: true },
    );

    const result = await runChallenge(createCommentRequest(">>2 lolwut"));

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Exact repost detected");
    expect(result.error).toContain("Temporary ban: 2 seconds");
  });

  it("ignores media links when checking originality", async () => {
    await expect(
      runChallenge(
        createCommentRequest("same image different comment", {
          link: "https://cdn.example/a.png",
        }),
      ),
    ).resolves.toEqual({
      success: true,
    });
    await expect(
      runChallenge(
        createCommentRequest("another comment", {
          link: "https://cdn.example/a.png",
        }),
      ),
    ).resolves.toEqual({ success: true });

    const result = await runChallenge(
      createCommentRequest("same image different comment", {
        link: "https://cdn.example/b.png",
      }),
    );

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Exact repost detected");
  });

  it("combines post title and content for originality", async () => {
    await expect(
      runChallenge(createCommentRequest("body", { title: "subject" })),
    ).resolves.toEqual({ success: true });

    const result = await runChallenge(
      createCommentRequest("body", { title: "subject" }),
    );

    expect(result).toMatchObject({ success: false });
  });

  it("blocks Unicode by default", async () => {
    const result = await runChallenge(createCommentRequest("hello Кириллица"));

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Unicode is not allowed");
  });

  it("requires text and a minimum amount of normalized original content", async () => {
    await expect(
      runChallenge(
        createCommentRequest("", { link: "https://cdn.example/a.png" }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Posts require text"),
    });

    await expect(
      runChallenge(
        createCommentRequest("short", { authorAddress: "author-2" }),
        { minimumOriginalContentLength: "10" },
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("at least 10"),
    });
  });

  it("enforces active temporary bans without increasing the count again", async () => {
    await runChallenge(createCommentRequest("first"));
    await runChallenge(createCommentRequest("first"));

    const result = await runChallenge(createCommentRequest("second"));

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("temporarily banned");
    expect(result.error).toContain("2026-05-23T00:00:02.000Z");
  });

  it("doubles the penalty after each transgression", async () => {
    await runChallenge(createCommentRequest("first"));
    await runChallenge(createCommentRequest("first"));

    vi.setSystemTime(new Date("2026-05-23T00:00:03Z"));

    await runChallenge(createCommentRequest("second"));
    const result = await runChallenge(createCommentRequest("second"));

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Temporary ban: 4 seconds");
    expect(result.error).toContain("transgression 2");
  });

  it("decays the transgression count over time", async () => {
    await runChallenge(createCommentRequest("first"));
    await runChallenge(createCommentRequest("first"), {
      transgressionDecayIntervalSeconds: "10",
    });

    vi.setSystemTime(new Date("2026-05-23T00:00:12Z"));

    await runChallenge(createCommentRequest("second"), {
      transgressionDecayIntervalSeconds: "10",
    });
    const result = await runChallenge(createCommentRequest("second"), {
      transgressionDecayIntervalSeconds: "10",
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("Temporary ban: 2 seconds");
    expect(result.error).toContain("transgression 1");
  });

  it("checks content edits and bypasses non-text publications", async () => {
    const ownEditCommunity = createRuntimeCommunity([
      { cid: "comment-1", content: "edited text" },
    ]).community;
    const duplicateEditCommunity = createRuntimeCommunity([
      { cid: "comment-2", content: "edited text" },
    ]).community;

    await expect(
      runChallenge(
        createContentEditRequest("edited text"),
        {},
        ownEditCommunity,
      ),
    ).resolves.toEqual({ success: true });
    await expect(
      runChallenge(
        createContentEditRequest("edited text", {
          signaturePublicKey: "author-public-key-2",
        }),
        {},
        duplicateEditCommunity,
      ),
    ).resolves.toMatchObject({ success: false });
    await expect(runChallenge(createVoteRequest())).resolves.toEqual({
      success: true,
    });
  });
});

describe("Robot9000 originality reservations", () => {
  const reservationSeconds = 10 * 60;
  const advanceSeconds = (seconds: number) =>
    vi.setSystemTime(new Date(Date.now() + seconds * 1000));
  const communityState = async () =>
    (
      (await readState()) as {
        communities: Record<
          string,
          { originals: Record<string, unknown>; authors: object }
        >;
      }
    ).communities[baseCommunity.address];

  it("lets the same author retry text whose publication was never stored", async () => {
    // Another challenge failed after Robot9000 allowed the text, so the node
    // stored nothing and the author sends the same text again.
    const { community, db } = createSqliteCommunity();

    try {
      await expect(
        runChallenge(createCommentRequest("abandoned text"), {}, community),
      ).resolves.toEqual({ success: true });
      await expect(
        runChallenge(createCommentRequest("abandoned text"), {}, community),
      ).resolves.toEqual({ success: true });
      expect((await communityState()).authors).toEqual({});
    } finally {
      db.close();
    }
  });

  it("rejects other authors while the text is reserved and frees it after the reservation expires", async () => {
    const { community, db } = createSqliteCommunity();

    try {
      await expect(
        runChallenge(createCommentRequest("in flight text"), {}, community),
      ).resolves.toEqual({ success: true });

      const raced = await runChallenge(
        createCommentRequest("in flight text", { authorAddress: "author-2" }),
        {},
        community,
      );
      expect(raced).toMatchObject({ success: false });
      expect(raced.error).toContain("Exact repost detected");

      advanceSeconds(reservationSeconds);

      await expect(
        runChallenge(
          createCommentRequest("in flight text", { authorAddress: "author-3" }),
          {},
          community,
        ),
      ).resolves.toEqual({ success: true });
    } finally {
      db.close();
    }
  });

  it("prunes expired reservations from the state file", async () => {
    await runChallenge(createCommentRequest("old reservation"));
    expect(Object.keys((await communityState()).originals)).toHaveLength(1);

    advanceSeconds(reservationSeconds);
    await runChallenge(
      createCommentRequest("new reservation", { authorAddress: "author-2" }),
    );

    expect(Object.keys((await communityState()).originals)).toHaveLength(1);
  });

  it("reads state files whose reservations have no author", async () => {
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const now = Math.floor(Date.now() / 1000);
    const entry = (seenAt: number) => ({
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      normalizedLength: 10,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        communities: {
          [baseCommunity.address]: {
            originals: {
              [hash("stale text")]: entry(now - reservationSeconds),
              [hash("fresh text")]: entry(now),
            },
            authors: {},
          },
        },
      }),
    );

    await expect(
      runChallenge(createCommentRequest("stale text")),
    ).resolves.toEqual({ success: true });
    await expect(
      runChallenge(
        createCommentRequest("fresh text", { authorAddress: "author-2" }),
      ),
    ).resolves.toMatchObject({ success: false });
  });

  it("lets an author restore their own comment's earlier text through an edit", async () => {
    const { community, db, insertRow } = createSqliteCommunity();
    const editRequest = (content: string) =>
      createContentEditRequest(content, {
        commentCid: "comment-1",
        authorAddress: "author-1",
      });

    try {
      await expect(
        runChallenge(createCommentRequest("first version"), {}, community),
      ).resolves.toEqual({ success: true });
      insertRow({ cid: "comment-1", content: "first version" });

      await expect(
        runChallenge(editRequest("second version"), {}, community),
      ).resolves.toEqual({ success: true });
      db.prepare("INSERT INTO commentUpdates (cid, edit) VALUES (?, ?)").run(
        "comment-1",
        JSON.stringify({ content: "second version" }),
      );

      await expect(
        runChallenge(editRequest("first version"), {}, community),
      ).resolves.toEqual({ success: true });
      expect((await communityState()).authors).toEqual({});
    } finally {
      db.close();
    }
  });

  it("frees the text of a removed comment once its reservation expires", async () => {
    const { community, db, insertRow } = createSqliteCommunity();

    try {
      await expect(
        runChallenge(createCommentRequest("removed text"), {}, community),
      ).resolves.toEqual({ success: true });
      insertRow({ cid: "comment-1", content: "removed text", removed: 1 });

      advanceSeconds(reservationSeconds);

      await expect(
        runChallenge(
          createCommentRequest("removed text", { authorAddress: "author-2" }),
          {},
          community,
        ),
      ).resolves.toEqual({ success: true });
    } finally {
      db.close();
    }
  });

  it("keeps text waiting for approval protected from its author and others", async () => {
    // The node stored the comment in its approval queue. Approving a second
    // copy later would publish the same text twice.
    const { community, db, insertRow } = createSqliteCommunity();

    try {
      await expect(
        runChallenge(createCommentRequest("queued text"), {}, community),
      ).resolves.toEqual({ success: true });
      insertRow({
        cid: "comment-1",
        content: "queued text",
        pendingApproval: 1,
      });

      const resent = await runChallenge(
        createCommentRequest("queued text"),
        {},
        community,
      );
      expect(resent).toMatchObject({ success: false });
      expect(resent.error).toContain("Exact repost detected");

      advanceSeconds(reservationSeconds);

      const reposted = await runChallenge(
        createCommentRequest("queued text", { authorAddress: "author-2" }),
        {},
        community,
      );
      expect(reposted).toMatchObject({ success: false });
      expect(reposted.error).toContain("Exact repost detected");
    } finally {
      db.close();
    }
  });

  it("keeps a comment's edited text protected through the database scan", async () => {
    const { community, db } = createSqliteCommunity([
      {
        cid: "comment-1",
        content: "original wording",
        edit: JSON.stringify({ content: "edited wording" }),
      },
    ]);

    try {
      const result = await runChallenge(
        createCommentRequest("edited wording", { authorAddress: "author-2" }),
        {},
        community,
      );
      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain("Exact repost detected");
    } finally {
      db.close();
    }
  });
});
