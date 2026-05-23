import { z } from "zod";

export const DEFAULT_STATE_PATH = "~/.bitsocial-r9k-challenge-state.json";
export const DEFAULT_MINIMUM_ORIGINAL_CONTENT_LENGTH = 16;
export const DEFAULT_TRANSGRESSION_DECAY_INTERVAL_SECONDS = 24 * 60 * 60;
export const DEFAULT_PENALTY_BASE_SECONDS = 2;
export const DEFAULT_ERROR = "Rejected by Robot9001.";

export type ParsedOptions = {
  statePath: string;
  minimumOriginalContentLength: number;
  transgressionDecayIntervalSeconds: number;
  penaltyBaseSeconds: number;
  maxPenaltySeconds?: number;
  blockUnicode: boolean;
  stripBacklinks: boolean;
  requireText: boolean;
  error: string;
};

type OptionName = keyof ParsedOptions;

export type OptionInput = {
  option: OptionName;
  label: string;
  description: string;
  default: string;
  placeholder?: string;
  required?: boolean;
};

export const optionInputs = [
  {
    option: "statePath",
    label: "State path",
    description:
      "Private JSON file used to persist original text hashes and temporary Robot9001 bans.",
    default: DEFAULT_STATE_PATH,
    required: true,
  },
  {
    option: "minimumOriginalContentLength",
    label: "Minimum original text length",
    description:
      "Minimum normalized text characters required before a post can be accepted.",
    default: String(DEFAULT_MINIMUM_ORIGINAL_CONTENT_LENGTH),
    required: true,
  },
  {
    option: "transgressionDecayIntervalSeconds",
    label: "Transgression decay interval",
    description: "Seconds after which one Robot9001 transgression is forgiven.",
    default: String(DEFAULT_TRANSGRESSION_DECAY_INTERVAL_SECONDS),
    required: true,
  },
  {
    option: "penaltyBaseSeconds",
    label: "Penalty base seconds",
    description:
      "Penalty duration is this base raised to the user's transgression count.",
    default: String(DEFAULT_PENALTY_BASE_SECONDS),
    required: true,
  },
  {
    option: "maxPenaltySeconds",
    label: "Maximum penalty seconds",
    description:
      "Optional cap for the temporary ban duration. Leave empty for uncapped Robot9001 doubling.",
    default: "",
    placeholder: "2592000",
  },
  {
    option: "blockUnicode",
    label: "Block Unicode",
    description: "Reject non-ASCII text before originality checks.",
    default: "true",
    required: true,
  },
  {
    option: "stripBacklinks",
    label: "Strip backlinks",
    description:
      "Ignore numeric backlinks like >>123 while checking text originality.",
    default: "true",
    required: true,
  },
  {
    option: "requireText",
    label: "Require text",
    description: "Reject publications whose title and body contain no text.",
    default: "true",
    required: true,
  },
  {
    option: "error",
    label: "Error message",
    description: "Prefix shown when Robot9001 rejects a publication.",
    default: DEFAULT_ERROR,
    required: true,
  },
] satisfies OptionInput[];

const optionDefaults = optionInputs.reduce(
  (acc, input) => {
    acc[input.option] = input.default;
    return acc;
  },
  {} as Record<OptionName, string>,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getOptionDefault = (option: OptionName) => optionDefaults[option];

const resolveOptionString = (value: unknown, option: OptionName) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : getOptionDefault(option);
  }
  if (value === undefined || value === null) {
    return getOptionDefault(option);
  }
  return value;
};

const resolveOptionalOptionString = (value: unknown, option: OptionName) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  const resolved = resolveOptionString(value, option);
  if (typeof resolved !== "string") return resolved;
  const trimmed = resolved.trim();
  return trimmed ? trimmed : undefined;
};

const resolveOptionNumber = (value: unknown, option: OptionName) => {
  const resolved = resolveOptionString(value, option);
  if (typeof resolved === "string") return Number(resolved);
  return resolved;
};

const resolveOptionalOptionNumber = (value: unknown, option: OptionName) => {
  const resolved = resolveOptionalOptionString(value, option);
  if (typeof resolved === "string") return Number(resolved);
  return resolved;
};

const resolveOptionBoolean = (value: unknown, option: OptionName) => {
  const resolved = resolveOptionString(value, option);
  if (typeof resolved !== "string") return resolved;

  const normalized = resolved.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return resolved;
};

export const OptionsSchema: z.ZodType<ParsedOptions> = z.preprocess(
  (value) => (value && typeof value === "object" ? value : {}),
  z
    .object({
      statePath: z.preprocess(
        (value) => resolveOptionString(value, "statePath"),
        z.string().min(1),
      ),
      minimumOriginalContentLength: z.preprocess(
        (value) => resolveOptionNumber(value, "minimumOriginalContentLength"),
        z.number().int().nonnegative(),
      ),
      transgressionDecayIntervalSeconds: z.preprocess(
        (value) =>
          resolveOptionNumber(value, "transgressionDecayIntervalSeconds"),
        z.number().int().nonnegative(),
      ),
      penaltyBaseSeconds: z.preprocess(
        (value) => resolveOptionNumber(value, "penaltyBaseSeconds"),
        z.number().int().min(2),
      ),
      maxPenaltySeconds: z.preprocess(
        (value) => resolveOptionalOptionNumber(value, "maxPenaltySeconds"),
        z.number().int().positive().optional(),
      ),
      blockUnicode: z.preprocess(
        (value) => resolveOptionBoolean(value, "blockUnicode"),
        z.boolean(),
      ),
      stripBacklinks: z.preprocess(
        (value) => resolveOptionBoolean(value, "stripBacklinks"),
        z.boolean(),
      ),
      requireText: z.preprocess(
        (value) => resolveOptionBoolean(value, "requireText"),
        z.boolean(),
      ),
      error: z.preprocess(
        (value) => resolveOptionString(value, "error"),
        z.string().min(1),
      ),
    })
    .strict(),
);

export const parseOptions = (challengeSettings: unknown) => {
  const options =
    isRecord(challengeSettings) && isRecord(challengeSettings.options)
      ? challengeSettings.options
      : {};
  return OptionsSchema.safeParse(options);
};
