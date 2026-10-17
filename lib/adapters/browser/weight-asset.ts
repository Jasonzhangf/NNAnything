import { migrateBasicKindProfile, validateBasicKindConfig, type BasicKindConfig, type BasicKindProfile } from "../../filters/basic-kinds.js";
import { expectRecord } from "../../core/schema.js";

export interface BrowserWeightAsset {
  readonly profile: BasicKindProfile;
  readonly config: BasicKindConfig;
  readonly sourceLabel: string;
  readonly calibrated: false;
}

export function parseBrowserWeightAsset(raw: unknown, sourceLabel = "本地权重"): BrowserWeightAsset {
  const value = expectRecord(typeof raw === "string" ? JSON.parse(raw) : raw, "weight asset");
  if ("recommendation" in value || "assessment" in value) throw new TypeError("A training result/report is not a weight asset");
  if (value.targetOperator !== "dom.basic_kinds" || value.operatorVersion !== "0.1.0" || value.contractVersion !== 1) throw new TypeError("Unsupported weight operator or contract version");
  if (value.taskId !== "dom.basic-kinds.v1" || value.calibrated !== false) throw new TypeError("Weight task or calibration contract differs");
  const config = validateBasicKindConfig(value.compatibility);
  if (config.taskId !== value.taskId) throw new TypeError("Weight compatibility task differs");
  const profile = migrateBasicKindProfile(value.profile);
  if (value.profileId !== profile.id) throw new TypeError("Weight profileId differs from profile.id");
  return { profile, config, sourceLabel, calibrated: false };
}
