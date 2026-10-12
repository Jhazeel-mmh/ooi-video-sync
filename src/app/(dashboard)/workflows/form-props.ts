import { asc } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { accounts, type Account } from "@/server/db/schema";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import type { AccountOption, WorkflowFormValues } from "./workflow-form";

export const DEFAULT_WORKFLOW_VALUES: WorkflowFormValues = {
  name: "",
  enabled: true,
  onedriveAccountId: null,
  driveId: "",
  folderId: "",
  folderPath: "",
  recursive: false,
  includeExisting: false,
  sinceDate: "",
  untilDate: "",
  minSizeMb: "",
  maxSizeMb: "",
  minDurationMin: "",
  maxDurationMin: "",
  nameInclude: "",
  nameExclude: "",
  skipDuplicates: true,
  youtubeAccountId: null,
  mode: "review",
  titleTemplate: "{filename}",
  descriptionTemplate: "Grabado el {date:d 'de' MMMM 'de' yyyy}.",
  tagsTemplate: "",
  useAi: false,
  aiContext: "",
  privacyStatus: "private",
  categoryId: "22",
  playlistId: null,
  playlistTitle: null,
  madeForKids: false,
  postUploadAction: "none",
  postUploadFolderId: null,
  postUploadFolderPath: null,
  pollIntervalMin: 15,
  stableMinutes: 5,
  counter: 0,
};

function toOption(account: Account): AccountOption {
  return {
    id: account.id,
    name: account.email ? `${account.displayName} (${account.email})` : account.displayName,
    needsReauth: account.status === "needs_reauth",
  };
}

/** Shared props for the create and edit pages. Call after `requireAdmin()`. */
export function workflowFormProps() {
  const all = getDb().select().from(accounts).orderBy(asc(accounts.displayName)).all();
  return {
    onedriveAccounts: all.filter((a) => a.provider === "microsoft").map(toOption),
    youtubeAccounts: all.filter((a) => a.provider === "google").map(toOption),
    aiAvailable: Boolean(env().ANTHROPIC_API_KEY),
    timeZone: getSettings().timeZone,
  };
}
