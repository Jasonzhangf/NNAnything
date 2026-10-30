import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import {
  readBrowserInputPolicyProfile,
  readBrowserQueryRelationProfile,
  readBrowserStepPolicyProfile,
  type BrowserInputPolicyProfile,
  type BrowserQueryRelationProfile,
  type BrowserStepPolicyProfile
} from "../filters/browser-stage1-policy.js";
import {
  createZeroBrowserInputPolicyProfile,
  createZeroBrowserQueryRelationProfile,
  createZeroBrowserStepPolicyProfile,
  evaluateBrowserStage1Cascade,
  evaluateBrowserStage1HandwiredRuleControl,
  fitBrowserStage1Cascade,
  type BrowserStage1CascadeEvaluation,
  type BrowserStage1CascadeFitResult,
  type BrowserStage1HandwiredControlEvaluation,
  type BrowserStage1UnitTimingReport
} from "../training/browser-stage1-numeric.js";
import {
  buildBrowserStage1Dataset,
  partitionBrowserStage1Dataset,
  readBrowserStage1Dataset,
  validateBrowserStage1Dataset,
  type BrowserStage1Dataset,
  type BrowserStage1PartitionedDataset,
  type BrowserStage1ValidationReport
} from "../training/browser-stage1-samples.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

export const BROWSER_STAGE1_TRAINING_WORKFLOW_ID = "browser_single_action_training";
export const BROWSER_STAGE1_TRAINING_WORKFLOW_VERSION = "0.1.0.0000";

export const browserStage1TrainingOperatorNames = [
  "browser.singleAction.training.prepare",
  "browser.singleAction.training.partition",
  "browser.singleAction.training.fit",
  "browser.singleAction.training.compare",
  "browser.singleAction.training.assess",
  "browser.singleAction.training.report"
] as const;

export interface BrowserStage1ProfileBundle {
  readonly inputPolicy: BrowserInputPolicyProfile;
  readonly queryRelation: BrowserQueryRelationProfile;
  readonly stepPolicy: BrowserStepPolicyProfile;
}

export interface BrowserStage1ComparisonReport {
  readonly schemaVersion: "browser.stage1.training-report.v1";
  readonly generatedAt: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly epochs: number;
  readonly learningRate: number;
  readonly validation: BrowserStage1ValidationReport;
  readonly units: {
    readonly "B-S1.1": {
      readonly contract: string;
      readonly fitted: boolean;
      readonly calibration: string;
      readonly adoption: string;
      readonly train: BrowserStage1CascadeEvaluation["inputPolicy"];
      readonly development: BrowserStage1CascadeEvaluation["inputPolicy"];
      readonly lossHistory: readonly number[];
    };
    readonly "B-S1.2": {
      readonly contract: string;
      readonly fitted: boolean;
      readonly calibration: string;
      readonly adoption: string;
      readonly train: BrowserStage1CascadeEvaluation["queryRelation"];
      readonly development: BrowserStage1CascadeEvaluation["queryRelation"];
      readonly lossHistory: readonly number[];
    };
    readonly "B-S1.3": {
      readonly contract: string;
      readonly fitted: boolean;
      readonly calibration: string;
      readonly adoption: string;
      readonly train: BrowserStage1CascadeEvaluation["stepPolicyCascade"];
      readonly development: BrowserStage1CascadeEvaluation["stepPolicyCascade"];
      readonly lossHistory: readonly number[];
    };
  };
  readonly controls: {
    readonly zeroWeightInit: {
      readonly source: "zero_weights";
      readonly train: BrowserStage1CascadeEvaluation;
      readonly development: BrowserStage1CascadeEvaluation;
    };
    readonly priorHandwired: {
      readonly source: "handwired";
      readonly decisionIds: BrowserStage1HandwiredControlEvaluation["decisionIds"];
      readonly train: BrowserStage1HandwiredControlEvaluation;
      readonly development: BrowserStage1HandwiredControlEvaluation;
    };
    readonly candidateModel: {
      readonly source: "learned_candidate";
      readonly train: BrowserStage1CascadeEvaluation;
      readonly development: BrowserStage1CascadeEvaluation;
    };
    readonly "B-S1.3_goldUpstreamOracle": {
      readonly source: "gold_upstream_diagnostic_only";
      readonly train: BrowserStage1CascadeEvaluation["stepPolicyGoldUpstreamOracle"];
      readonly development: BrowserStage1CascadeEvaluation["stepPolicyGoldUpstreamOracle"];
    };
    readonly "B-S1.3_predictedUpstreamCascade": {
      readonly source: "predicted_upstream_cascade";
      readonly train: BrowserStage1CascadeEvaluation["stepPolicyCascade"];
      readonly development: BrowserStage1CascadeEvaluation["stepPolicyCascade"];
    };
  };
  readonly assessment: BrowserStage1AssessmentSummary;
  readonly timing: {
    readonly totalWallMs: number;
    readonly units: {
      readonly inputPolicy: BrowserStage1UnitTimingReport;
      readonly queryRelation: BrowserStage1UnitTimingReport;
      readonly stepPolicy: BrowserStage1UnitTimingReport;
      readonly "B-S1.1": BrowserStage1UnitTimingReport;
      readonly "B-S1.2": BrowserStage1UnitTimingReport;
      readonly "B-S1.3": BrowserStage1UnitTimingReport;
    };
    readonly "B-S1.1": BrowserStage1UnitTimingReport;
    readonly "B-S1.2": BrowserStage1UnitTimingReport;
    readonly "B-S1.3": BrowserStage1UnitTimingReport;
  };
}

export interface BrowserStage1AssessmentSummary {
  readonly mode: "zero_epoch_preparation" | "formal_training";
  readonly acceptanceStatus:
    | "NON_ACCEPTANCE_ZERO_EPOCH_PREP"
    | "TRAIN_DEV_PASSED_PENDING_RELOAD"
    | "TRAIN_DEV_AND_RELOAD_PASSED"
    | "REJECTED_TRAIN_DEV_GATE_FAILED"
    | "REJECTED_RELOAD_PARITY_FAILED";
  readonly trainDev100PercentPassed: boolean;
  readonly reloadConsistencyPassed: boolean | null;
  readonly acceptedForDownstreamEvaluation: boolean;
  readonly failedUnits: readonly string[];
  readonly unitChecks: {
    readonly "B-S1.1": {
      readonly fitted: boolean;
      readonly trainPassed: boolean;
      readonly developmentPassed: boolean;
    };
    readonly "B-S1.2": {
      readonly fitted: boolean;
      readonly trainPassed: boolean;
      readonly developmentPassed: boolean;
    };
    readonly "B-S1.3": {
      readonly fitted: boolean;
      readonly trainPassed: boolean;
      readonly developmentPassed: boolean;
    };
  };
  readonly downstreamStatus: {
    readonly reloadVerification: "pending_zero_epoch_probe" | "pending" | "passed" | "failed" | "not_run";
    readonly independentEvaluation: "not_run";
    readonly nativeAcceptance: "not_run";
  };
}

export function assessBrowserStage1TrainingReport(
  report: Omit<BrowserStage1ComparisonReport, "assessment"> & { readonly assessment?: BrowserStage1AssessmentSummary }
): BrowserStage1AssessmentSummary {
  const isZeroEpochPrep = report.epochs <= 0;
  const u1 = report.units["B-S1.1"];
  const u2 = report.units["B-S1.2"];
  const u3 = report.units["B-S1.3"];

  const u1TrainPass = u1.train.total === 80 && u1.train.correct === 80;
  const u1DevPass = u1.development.total === 32 && u1.development.correct === 32;
  const u2TrainPass = u2.train.total === 120 && u2.train.correct === 120;
  const u2DevPass = u2.development.total === 48 && u2.development.correct === 48;
  const u3TrainPass = u3.train.total === 120 && u3.train.correct === 120;
  const u3DevPass = u3.development.total === 48 && u3.development.correct === 48;

  const failedUnits: string[] = [];
  if (!isZeroEpochPrep) {
    if (!u1.fitted || !u1TrainPass || !u1DevPass) failedUnits.push("B-S1.1");
    if (!u2.fitted || !u2TrainPass || !u2DevPass) failedUnits.push("B-S1.2");
    if (!u3.fitted || !u3TrainPass || !u3DevPass) failedUnits.push("B-S1.3");
  }

  const allFitted = u1.fitted && u2.fitted && u3.fitted;
  const all100Percent =
    u1TrainPass && u1DevPass && u2TrainPass && u2DevPass && u3TrainPass && u3DevPass;

  if (isZeroEpochPrep) {
    return {
      mode: "zero_epoch_preparation",
      acceptanceStatus: "NON_ACCEPTANCE_ZERO_EPOCH_PREP",
      trainDev100PercentPassed: false,
      reloadConsistencyPassed: null,
      acceptedForDownstreamEvaluation: false,
      failedUnits: [],
      unitChecks: {
        "B-S1.1": { fitted: u1.fitted, trainPassed: u1TrainPass, developmentPassed: u1DevPass },
        "B-S1.2": { fitted: u2.fitted, trainPassed: u2TrainPass, developmentPassed: u2DevPass },
        "B-S1.3": { fitted: u3.fitted, trainPassed: u3TrainPass, developmentPassed: u3DevPass }
      },
      downstreamStatus: {
        reloadVerification: "pending_zero_epoch_probe",
        independentEvaluation: "not_run",
        nativeAcceptance: "not_run"
      }
    };
  }

  const trainDevPassed = Boolean(report.validation?.ok) && allFitted && all100Percent && failedUnits.length === 0;
  return {
    mode: "formal_training",
    acceptanceStatus: trainDevPassed
      ? "TRAIN_DEV_PASSED_PENDING_RELOAD"
      : "REJECTED_TRAIN_DEV_GATE_FAILED",
    trainDev100PercentPassed: trainDevPassed,
    reloadConsistencyPassed: null,
    acceptedForDownstreamEvaluation: false,
    failedUnits,
    unitChecks: {
      "B-S1.1": { fitted: u1.fitted, trainPassed: u1TrainPass, developmentPassed: u1DevPass },
      "B-S1.2": { fitted: u2.fitted, trainPassed: u2TrainPass, developmentPassed: u2DevPass },
      "B-S1.3": { fitted: u3.fitted, trainPassed: u3TrainPass, developmentPassed: u3DevPass }
    },
    downstreamStatus: {
      reloadVerification: trainDevPassed ? "pending" : "not_run",
      independentEvaluation: "not_run",
      nativeAcceptance: "not_run"
    }
  };
}

export interface BrowserStage1TrainingBundle {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly nodeOrder: readonly string[];
  readonly dataset: BrowserStage1Dataset;
  readonly partitioned: BrowserStage1PartitionedDataset;
  readonly initialProfiles: BrowserStage1ProfileBundle;
  readonly fittedProfiles: BrowserStage1ProfileBundle;
  readonly fitted: {
    readonly inputPolicy: boolean;
    readonly queryRelation: boolean;
    readonly stepPolicy: boolean;
  };
  readonly report: BrowserStage1ComparisonReport;
  readonly artifactPaths?: {
    readonly inputPolicyPath: string;
    readonly queryRelationPath: string;
    readonly stepPolicyPath: string;
    readonly samplesPath: string;
    readonly reportPath: string;
  };
}

export interface RunBrowserStage1TrainingOptions {
  readonly dataset?: BrowserStage1Dataset;
  readonly samplesPath?: string;
  readonly initialProfiles?: Partial<BrowserStage1ProfileBundle>;
  readonly handwiredRoot?: string;
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly outputRoot?: string;
}

const port = (name: string, eventType: string, validate: (value: unknown) => unknown) => ({
  name,
  schemaId: eventType,
  eventType,
  validate
});

const REQUEST_PORT = port(
  "training_request",
  "browser.single-action.training.request.v1",
  (v) => v
);
const SAMPLES_PORT = port(
  "samples",
  "browser.single-action.training.samples.v1",
  (v) => readBrowserStage1Dataset(v)
);
const PARTITIONS_PORT = port(
  "partitions",
  "browser.single-action.training.partitions.v1",
  (v) => v
);
const CANDIDATE_PORT = port(
  "candidate",
  "browser.single-action.training.candidate.v1",
  (v) => v
);
const COMPARISON_PORT = port(
  "comparison",
  "browser.single-action.training.comparison.v1",
  (v) => v
);
const ASSESSMENT_PORT = port(
  "assessment",
  "browser.single-action.training.assessment.v1",
  (v) => v
);
const RESULT_PORT = port(
  "training_result",
  "browser.single-action.training.result.v1",
  (v) => v
);

export function createBrowserStage1TrainingNodes(
  options: RunBrowserStage1TrainingOptions = {},
  wallStartMs: number = performance.now()
): readonly NodeDefinition[] {
  const initialProfiles: BrowserStage1ProfileBundle = {
    inputPolicy: options.initialProfiles?.inputPolicy
      ? readBrowserInputPolicyProfile(options.initialProfiles.inputPolicy)
      : createZeroBrowserInputPolicyProfile(),
    queryRelation: options.initialProfiles?.queryRelation
      ? readBrowserQueryRelationProfile(options.initialProfiles.queryRelation)
      : createZeroBrowserQueryRelationProfile(),
    stepPolicy: options.initialProfiles?.stepPolicy
      ? readBrowserStepPolicyProfile(options.initialProfiles.stepPolicy)
      : createZeroBrowserStepPolicyProfile()
  };

  const node = (
    name: string,
    inputPorts: readonly NodeDefinition["inputPorts"][number][],
    outputPort: NodeDefinition["outputPort"],
    effects: readonly string[],
    execute: NodeDefinition["execute"]
  ): NodeDefinition =>
    Object.freeze({
      operator: `browser.singleAction.training.${name}`,
      version: "0.1.0.0000",
      inputPorts,
      outputPort,
      effects,
      execute
    });

  return Object.freeze([
    node("prepare", [REQUEST_PORT], SAMPLES_PORT, [], async (context) => {
      let dataset: BrowserStage1Dataset;
      if (options.dataset) {
        dataset = readBrowserStage1Dataset(options.dataset);
      } else if (options.samplesPath) {
        const raw = JSON.parse(await fs.readFile(options.samplesPath, "utf8")) as unknown;
        dataset = readBrowserStage1Dataset(raw);
      } else {
        dataset = buildBrowserStage1Dataset();
      }
      return context.emit(dataset);
    }),

    node("partition", [SAMPLES_PORT], PARTITIONS_PORT, [], (context) => {
      const dataset = readBrowserStage1Dataset(context.inputs[0]!.payload);
      const partitioned = partitionBrowserStage1Dataset(dataset);
      return context.emit(partitioned);
    }),

    node("fit", [PARTITIONS_PORT], CANDIDATE_PORT, ["filesystem.read"], async (context) => {
      const partitioned = context.inputs[0]!.payload as BrowserStage1PartitionedDataset;
      const fitResult = await fitBrowserStage1Cascade(partitioned.train, {
        epochs: options.epochs ?? 200,
        learningRate: options.learningRate ?? 0.1,
        initialProfiles,
        ...(options.handwiredRoot ? { handwiredRoot: options.handwiredRoot } : {})
      });
      return context.emit(fitResult);
    }),

    node("compare", [PARTITIONS_PORT, CANDIDATE_PORT], COMPARISON_PORT, [], async (context) => {
      const partitioned = context.inputs[0]!.payload as BrowserStage1PartitionedDataset;
      const fitResult = context.inputs[1]!.payload as BrowserStage1CascadeFitResult;

      const evalTrain = evaluateBrowserStage1Cascade(
        partitioned.train,
        fitResult.profiles,
        "learned_candidate"
      );
      const evalDev = evaluateBrowserStage1Cascade(
        partitioned.development,
        fitResult.profiles,
        "learned_candidate"
      );

      const zeroProfiles: BrowserStage1ProfileBundle = {
        inputPolicy: createZeroBrowserInputPolicyProfile(),
        queryRelation: createZeroBrowserQueryRelationProfile(),
        stepPolicy: createZeroBrowserStepPolicyProfile()
      };
      const zeroTrain = evaluateBrowserStage1Cascade(
        partitioned.train,
        zeroProfiles,
        "zero_weights"
      );
      const zeroDev = evaluateBrowserStage1Cascade(
        partitioned.development,
        zeroProfiles,
        "zero_weights"
      );

      const handwiredTrain = evaluateBrowserStage1HandwiredRuleControl(partitioned.train);
      const handwiredDev = evaluateBrowserStage1HandwiredRuleControl(partitioned.development);

      const effectiveEpochs = options.epochs ?? 200;

      const timingUnits = {
        inputPolicy: {
          ...fitResult.timing.inputPolicy,
          evaluationMs: evalTrain.evaluationMs.inputPolicy + evalDev.evaluationMs.inputPolicy
        },
        queryRelation: {
          ...fitResult.timing.queryRelation,
          evaluationMs: evalTrain.evaluationMs.queryRelation + evalDev.evaluationMs.queryRelation
        },
        stepPolicy: {
          ...fitResult.timing.stepPolicy,
          evaluationMs: evalTrain.evaluationMs.stepPolicy + evalDev.evaluationMs.stepPolicy
        }
      };

      const validation = validateBrowserStage1Dataset(partitioned.dataset);
      const unassessedReport: Omit<BrowserStage1ComparisonReport, "assessment"> = {
        schemaVersion: "browser.stage1.training-report.v1",
        generatedAt: new Date().toISOString(),
        workflowId: BROWSER_STAGE1_TRAINING_WORKFLOW_ID,
        workflowVersion: BROWSER_STAGE1_TRAINING_WORKFLOW_VERSION,
        epochs: effectiveEpochs,
        learningRate: options.learningRate ?? 0.1,
        validation,
        units: {
          "B-S1.1": {
            contract: fitResult.profiles.inputPolicy.contract,
            fitted: fitResult.fitted.inputPolicy,
            calibration: fitResult.profiles.inputPolicy.calibration,
            adoption: fitResult.profiles.inputPolicy.adoption,
            train: evalTrain.inputPolicy,
            development: evalDev.inputPolicy,
            lossHistory: fitResult.lossHistory.inputPolicy
          },
          "B-S1.2": {
            contract: fitResult.profiles.queryRelation.contract,
            fitted: fitResult.fitted.queryRelation,
            calibration: fitResult.profiles.queryRelation.calibration,
            adoption: fitResult.profiles.queryRelation.adoption,
            train: evalTrain.queryRelation,
            development: evalDev.queryRelation,
            lossHistory: fitResult.lossHistory.queryRelation
          },
          "B-S1.3": {
            contract: fitResult.profiles.stepPolicy.contract,
            fitted: fitResult.fitted.stepPolicy,
            calibration: fitResult.profiles.stepPolicy.calibration,
            adoption: fitResult.profiles.stepPolicy.adoption,
            train: evalTrain.stepPolicyCascade,
            development: evalDev.stepPolicyCascade,
            lossHistory: fitResult.lossHistory.stepPolicy
          }
        },
        controls: {
          zeroWeightInit: {
            source: "zero_weights",
            train: zeroTrain,
            development: zeroDev
          },
          priorHandwired: {
            source: "handwired",
            decisionIds: handwiredTrain.decisionIds,
            train: handwiredTrain,
            development: handwiredDev
          },
          candidateModel: {
            source: "learned_candidate",
            train: evalTrain,
            development: evalDev
          },
          "B-S1.3_goldUpstreamOracle": {
            source: "gold_upstream_diagnostic_only",
            train: evalTrain.stepPolicyGoldUpstreamOracle,
            development: evalDev.stepPolicyGoldUpstreamOracle
          },
          "B-S1.3_predictedUpstreamCascade": {
            source: "predicted_upstream_cascade",
            train: evalTrain.stepPolicyCascade,
            development: evalDev.stepPolicyCascade
          }
        },
        timing: {
          totalWallMs: performance.now() - wallStartMs,
          units: {
            ...timingUnits,
            "B-S1.1": timingUnits.inputPolicy,
            "B-S1.2": timingUnits.queryRelation,
            "B-S1.3": timingUnits.stepPolicy
          },
          "B-S1.1": timingUnits.inputPolicy,
          "B-S1.2": timingUnits.queryRelation,
          "B-S1.3": timingUnits.stepPolicy
        }
      };

      return context.emit({
        partitioned,
        initialProfiles,
        fittedProfiles: fitResult.profiles,
        fitted: fitResult.fitted,
        unassessedReport
      });
    }),

    node("assess", [COMPARISON_PORT], ASSESSMENT_PORT, [], (context) => {
      const comparison = context.inputs[0]!.payload as {
        readonly partitioned: BrowserStage1PartitionedDataset;
        readonly initialProfiles: BrowserStage1ProfileBundle;
        readonly fittedProfiles: BrowserStage1ProfileBundle;
        readonly fitted: {
          readonly inputPolicy: boolean;
          readonly queryRelation: boolean;
          readonly stepPolicy: boolean;
        };
        readonly unassessedReport: Omit<BrowserStage1ComparisonReport, "assessment">;
      };
      const assessment = assessBrowserStage1TrainingReport(comparison.unassessedReport);
      const report: BrowserStage1ComparisonReport = {
        ...comparison.unassessedReport,
        assessment
      };
      return context.emit({
        partitioned: comparison.partitioned,
        initialProfiles: comparison.initialProfiles,
        fittedProfiles: comparison.fittedProfiles,
        fitted: comparison.fitted,
        report
      });
    }),

    node("report", [ASSESSMENT_PORT], RESULT_PORT, ["filesystem.write"], async (context) => {
      const stage = context.inputs[0]!.payload as {
        readonly partitioned: BrowserStage1PartitionedDataset;
        readonly initialProfiles: BrowserStage1ProfileBundle;
        readonly fittedProfiles: BrowserStage1ProfileBundle;
        readonly fitted: {
          readonly inputPolicy: boolean;
          readonly queryRelation: boolean;
          readonly stepPolicy: boolean;
        };
        readonly report: BrowserStage1ComparisonReport;
      };

      let artifactPaths: BrowserStage1TrainingBundle["artifactPaths"];
      if (options.outputRoot) {
        const weightsDir = path.join(options.outputRoot, "weights");
        await fs.mkdir(weightsDir, { recursive: true });
        const inputPolicyPath = path.join(options.outputRoot, "input-policy.json");
        const queryRelationPath = path.join(options.outputRoot, "query-relation.json");
        const stepPolicyPath = path.join(options.outputRoot, "step-policy.json");
        const samplesPath = path.join(options.outputRoot, "samples.json");
        const reportPath = path.join(options.outputRoot, "report.json");

        const inputJson = `${JSON.stringify(stage.fittedProfiles.inputPolicy, null, 2)}\n`;
        const relationJson = `${JSON.stringify(stage.fittedProfiles.queryRelation, null, 2)}\n`;
        const stepJson = `${JSON.stringify(stage.fittedProfiles.stepPolicy, null, 2)}\n`;

        await fs.writeFile(inputPolicyPath, inputJson, "utf8");
        await fs.writeFile(queryRelationPath, relationJson, "utf8");
        await fs.writeFile(stepPolicyPath, stepJson, "utf8");
        await fs.writeFile(path.join(weightsDir, "input-policy.json"), inputJson, "utf8");
        await fs.writeFile(path.join(weightsDir, "query-relation.json"), relationJson, "utf8");
        await fs.writeFile(path.join(weightsDir, "step-policy.json"), stepJson, "utf8");
        await fs.writeFile(
          samplesPath,
          `${JSON.stringify(stage.partitioned.dataset, null, 2)}\n`,
          "utf8"
        );
        await fs.writeFile(
          reportPath,
          `${JSON.stringify(stage.report, null, 2)}\n`,
          "utf8"
        );
        artifactPaths = {
          inputPolicyPath,
          queryRelationPath,
          stepPolicyPath,
          samplesPath,
          reportPath
        };
      }

      const bundle: BrowserStage1TrainingBundle = {
        workflowId: BROWSER_STAGE1_TRAINING_WORKFLOW_ID,
        workflowVersion: BROWSER_STAGE1_TRAINING_WORKFLOW_VERSION,
        nodeOrder: ["prepare", "partition", "fit", "compare", "assess", "report"],
        dataset: stage.partitioned.dataset,
        partitioned: stage.partitioned,
        initialProfiles: stage.initialProfiles,
        fittedProfiles: stage.fittedProfiles,
        fitted: stage.fitted,
        report: stage.report,
        ...(artifactPaths ? { artifactPaths } : {})
      };
      return context.emit(bundle);
    })
  ]);
}

const configPath = fileURLToPath(
  new URL("../../workflows/browser-single-action-training.workflow.json", import.meta.url)
);
const allowedRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

export async function runBrowserStage1Training(
  options: RunBrowserStage1TrainingOptions = {}
): Promise<BrowserStage1TrainingBundle> {
  const wallStartMs = performance.now();
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserStage1TrainingNodes(options, wallStartMs),
    grantedEffects: ["filesystem.read", "filesystem.write"]
  });
  const runId = randomUUID();
  const result = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId,
      eventId: `${runId}:input`,
      port: "training_request",
      type: "browser.single-action.training.request.v1",
      payload: {
        epochs: options.epochs ?? 200,
        learningRate: options.learningRate ?? 0.1
      }
    })
  );
  if (result.status === "failed") {
    throw new Error(`Browser Stage 1 training workflow failed: ${result.error.message}`);
  }
  return result.outputEvent.payload as BrowserStage1TrainingBundle;
}

export const runBrowserStage1TrainingWorkflow = runBrowserStage1Training;

